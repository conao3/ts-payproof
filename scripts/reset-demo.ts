import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import * as z from "zod"
import { MongoClient } from "mongodb"
import { readConfig } from "../apps/api/src/config.ts"
import { prepareLiveDemo } from "./prepare-live-demo.ts"

const appUrl = "http://127.0.0.1:5173/"
const slideUrl = "http://127.0.0.1:4174/?v=v10-player-keys#2"
const directory = resolve(".claude-dev/scratch/live-demo")
const statePath = resolve(directory, "presenter-windows-unprocessed.json")
const roleSchema = z.enum(["operator", "approver"])
const windowSchema = z.object({
  role: roleSchema,
  contextId: z.string().min(1),
  targetId: z.string().min(1),
  windowId: z.number(),
  operatorSlide: z.object({ targetId: z.string().min(1) }).optional(),
})
type PresenterWindow = z.infer<typeof windowSchema>
const targetSchema = z.object({
  targetId: z.string(),
  type: z.string(),
  url: z.string(),
  browserContextId: z.string().optional(),
})

async function healthy(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error("Required demo service is unavailable")
  if (url.endsWith("/health")) {
    const health = z.object({ ready: z.literal(true) }).safeParse(await response.json())
    if (!health.success) throw new Error("Required demo service is not ready")
  }
}

async function connectBrowser() {
  const status: unknown = JSON.parse(
    execFileSync("chrome-devtools", ["profile", "get-profile-status", "--profile", "conao3"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  )
  const profile = z
    .object({ Status: z.literal("ready"), Port: z.number().int().min(1).max(65535) })
    .parse(status)
  const response = await fetch(`http://127.0.0.1:${profile.Port}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  })
  const version = z.object({ webSocketDebuggerUrl: z.string() }).parse(await response.json())
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome connection timed out")), 5_000)
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer)
        resolveOpen()
      },
      { once: true },
    )
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        reject(new Error("Chrome connection failed"))
      },
      { once: true },
    )
  })
  let sequence = 0
  const pending = new Map<
    number,
    {
      resolve: (result: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      method: string
    }
  >()
  ws.addEventListener("message", ({ data }) => {
    const result = z
      .object({
        id: z.number().optional(),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .safeParse(JSON.parse(String(data)))
    if (!result.success || result.data.id === undefined) return
    const request = pending.get(result.data.id)
    if (!request) return
    pending.delete(result.data.id)
    clearTimeout(request.timer)
    if (result.data.error) request.reject(new Error(`Chrome operation failed: ${request.method}`))
    else request.resolve(result.data.result)
  })
  function call(
    method: "Target.createBrowserContext",
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ browserContextId: string }>
  function call(
    method: "Target.createTarget",
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ targetId: string }>
  function call(
    method: "Target.attachToTarget",
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ sessionId: string }>
  function call(
    method: "Browser.getWindowForTarget",
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ windowId: number }>
  function call(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>
  function call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const id = ++sequence
    return new Promise<unknown>((resolveCall, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Chrome operation timed out: ${method}`))
      }, 15_000)
      pending.set(id, { resolve: resolveCall, reject, timer, method })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    }).then((result) => {
      if (method === "Target.createBrowserContext")
        return z.object({ browserContextId: z.string().min(1) }).parse(result)
      if (method === "Target.createTarget")
        return z.object({ targetId: z.string().min(1) }).parse(result)
      if (method === "Target.attachToTarget")
        return z.object({ sessionId: z.string().min(1) }).parse(result)
      if (method === "Browser.getWindowForTarget")
        return z.object({ windowId: z.number() }).parse(result)
      return result
    })
  }
  async function evaluate(sessionId: string, expression: string): Promise<unknown> {
    const result = z
      .object({
        result: z.object({ value: z.unknown().optional() }),
        exceptionDetails: z.unknown().optional(),
      })
      .parse(
        await call(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        ),
      )
    if (result.exceptionDetails) throw new Error("Presenter page did not reach the expected state")
    return result.result.value
  }
  async function until(sessionId: string, expression: string) {
    const ready = await evaluate(
      sessionId,
      `(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expression})return true;await new Promise(r=>setTimeout(r,100))}return false})()`,
    )
    if (ready !== true) throw new Error("Presenter page did not become ready")
  }
  return { call, evaluate, until, close: () => ws.close() }
}

async function restoreWindows(fixture: Awaited<ReturnType<typeof prepareLiveDemo>>) {
  const config = readConfig()
  const browser = await connectBrowser()
  const createdContexts: string[] = []
  try {
    let saved: PresenterWindow[] = []
    try {
      const state: unknown = JSON.parse(await readFile(statePath, "utf8"))
      saved = z.object({ windows: z.array(windowSchema) }).parse(state).windows
    } catch {
      /* Missing/stale local metadata causes fresh isolated windows, never tab discovery by title. */
    }
    const targets = z
      .object({ targetInfos: z.array(targetSchema) })
      .parse(await browser.call("Target.getTargets")).targetInfos
    const windows = []
    const usedContexts = new Set<string>()
    for (const role of roleSchema.options) {
      const response = await fetch("http://127.0.0.1:4100/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", origin: config.APP_ORIGIN },
        body: JSON.stringify({
          query: "mutation Login($key:String!){login(accessKey:$key){role}}",
          variables: {
            key: role === "operator" ? config.OPERATOR_ACCESS_KEY : config.APPROVER_ACCESS_KEY,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const login = z
        .object({ data: z.object({ login: z.object({ role: z.literal(role) }) }) })
        .safeParse(await response.json())
      const cookie = response.headers.get("set-cookie")?.split(";")[0]
      if (!login.success || !cookie) throw new Error("Presenter authentication failed")
      const queueResponse = await fetch("http://127.0.0.1:4100/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", origin: config.APP_ORIGIN, cookie },
        body: JSON.stringify({ query: "query { invoices { id } }" }),
        signal: AbortSignal.timeout(10_000),
      })
      const queue = z
        .object({ data: z.object({ invoices: z.array(z.object({ id: z.string() })) }) })
        .parse(await queueResponse.json()).data.invoices
      const present = queue.some((item) => item.id === fixture.invoiceId)
      if (!present) throw new Error("Fresh demo invoice is missing from the queue")
      const candidate = saved.find((item) => item.role === role)
      const previous =
        candidate &&
        targets.find(
          (target) =>
            target.targetId === candidate.targetId &&
            target.type === "page" &&
            target.browserContextId === candidate.contextId &&
            target.url === appUrl,
        )
      const reusable = previous && candidate && !usedContexts.has(candidate.contextId)
      let contextId: string, targetId: string, slideId: string | undefined
      if (reusable) {
        contextId = candidate.contextId
        targetId = candidate.targetId
        if (role === "operator") {
          const oldSlide = targets.find(
            (target) =>
              target.targetId === candidate.operatorSlide?.targetId &&
              target.browserContextId === contextId &&
              target.url.startsWith("http://127.0.0.1:4174/"),
          )
          slideId = oldSlide?.targetId
        }
      } else {
        contextId = (
          await browser.call("Target.createBrowserContext", {
            disposeOnDetach: false,
          })
        ).browserContextId
        createdContexts.push(contextId)
        if (role === "operator")
          slideId = (
            await browser.call("Target.createTarget", {
              url: slideUrl,
              browserContextId: contextId,
              newWindow: true,
            })
          ).targetId
        targetId = (
          await browser.call("Target.createTarget", {
            url: "about:blank",
            browserContextId: contextId,
            newWindow: role === "approver",
          })
        ).targetId
      }
      usedContexts.add(contextId)
      const session = (
        await browser.call("Target.attachToTarget", {
          targetId,
          flatten: true,
        })
      ).sessionId
      await browser.call("Network.enable", {}, session)
      await browser.call(
        "Network.setCookie",
        {
          name: "payproof_session",
          value: cookie.slice(cookie.indexOf("=") + 1),
          url: appUrl,
          httpOnly: true,
          sameSite: "Strict",
        },
        session,
      )
      await browser.call("Page.enable", {}, session)
      await browser.call("Page.navigate", { url: appUrl }, session)
      const rowSelector = `.invoice-row[data-invoice-id="${fixture.invoiceId}"]`
      await browser.until(
        session,
        `Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`,
      )
      await browser.evaluate(
        session,
        `document.querySelector(${JSON.stringify(rowSelector)}).click()`,
      )
      await browser.until(
        session,
        `document.querySelector('.invoice-row.selected')?.getAttribute('data-invoice-id')===${JSON.stringify(fixture.invoiceId)} && document.querySelector('.invoice-row.selected')?.textContent.includes('Ready to process')`,
      )
      const expectedIdentity = role === "operator" ? "Finance operator" : "Payment approver"
      const validRole = await browser.evaluate(
        session,
        `document.querySelector('.identity')?.innerText.includes(${JSON.stringify(expectedIdentity)})`,
      )
      if (!validRole) throw new Error("Presenter role did not match its isolated window")
      const title = `PayProof — ${role} — ${fixture.invoiceNumber}`
      await browser.evaluate(session, `document.title=${JSON.stringify(title)}`)
      const window = await browser.call("Browser.getWindowForTarget", {
        targetId,
      })
      if (!reusable)
        await browser.call("Browser.setWindowBounds", {
          windowId: window.windowId,
          bounds: {
            left: role === "operator" ? 20 : 60,
            top: role === "operator" ? 20 : 60,
            width: 1440,
            height: 1000,
            windowState: "normal",
          },
        })
      if (role === "operator") {
        if (!slideId)
          slideId = (
            await browser.call("Target.createTarget", {
              url: slideUrl,
              browserContextId: contextId,
              newWindow: false,
            })
          ).targetId
        const slideSession = (
          await browser.call("Target.attachToTarget", {
            targetId: slideId,
            flatten: true,
          })
        ).sessionId
        await browser.call("Page.navigate", { url: slideUrl }, slideSession)
        await browser.until(slideSession, "window.pitchDiagnostics?.slide===1")
        const slideWindow = await browser.call("Browser.getWindowForTarget", {
          targetId: slideId,
        })
        if (slideWindow.windowId !== window.windowId)
          throw new Error("Slide and operator app are in different windows")
      }
      windows.push({
        role,
        contextId,
        targetId,
        windowId: window.windowId,
        title,
        invoiceId: fixture.invoiceId,
        invoiceNumber: fixture.invoiceNumber,
        url: appUrl,
        reused: Boolean(reusable),
        selectedInvoiceId: fixture.invoiceId,
        ...(slideId
          ? {
              operatorSlide: {
                targetId: slideId,
                url: slideUrl,
                windowId: window.windowId,
                initialSlide: "Demo",
              },
            }
          : {}),
      })
    }
    const operator = windows.find((window) => window.role === "operator")
    if (!operator?.operatorSlide) throw new Error("Operator slide was not prepared")
    await browser.call("Target.activateTarget", { targetId: operator.operatorSlide.targetId })
    await mkdir(directory, { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify(
        {
          chromeProfile: "conao3",
          independentContexts: true,
          headed: true,
          fixtureStatus: fixture.status,
          fixtureRevision: fixture.revision,
          fixtureLedgerCount: fixture.fixtureLedgerCount,
          fixtureId: fixture.invoiceId,
          invoiceNumber: fixture.invoiceNumber,
          operatorSlideForeground: true,
          windows,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    return windows.map(({ role, windowId, reused }) => ({ role, windowId, reused }))
  } catch (error) {
    // Only contexts created by this run are disposable; existing user/presenter tabs are left intact.
    for (const browserContextId of createdContexts)
      await browser.call("Target.disposeBrowserContext", { browserContextId }).catch(() => {})
    throw error
  } finally {
    browser.close()
  }
}

async function confirmFreshFixture(fixture: Awaited<ReturnType<typeof prepareLiveDemo>>) {
  const config = readConfig()
  const client = new MongoClient(config.MONGODB_URI)
  const ledger = new MongoClient(z.string().min(1).parse(process.env.PAYMENT_MONGODB_URI))
  try {
    await Promise.all([client.connect(), ledger.connect()])
    const invoice = await client
      .db(config.MONGODB_DB)
      .collection<{ _id: string; status: string; revision: number; proposal: unknown }>("invoices")
      .findOne({ _id: fixture.invoiceId })
    if (
      !invoice ||
      invoice.status !== "received" ||
      invoice.revision !== 0 ||
      invoice.proposal !== null
    )
      throw new Error("Prepared invoice changed before reset finished")
    const ledgerCount = await ledger
      .db(z.string().min(1).parse(process.env.PAYMENT_MONGODB_DB))
      .collection("mock_payments")
      .countDocuments({ invoiceId: fixture.invoiceId })
    if (ledgerCount !== 0) throw new Error("Prepared invoice unexpectedly has a payment")
  } finally {
    await Promise.all([client.close(), ledger.close()])
  }
}

let fixture: Awaited<ReturnType<typeof prepareLiveDemo>> | undefined
try {
  for (const url of [
    "http://127.0.0.1:4100/health",
    "http://127.0.0.1:4101/health",
    appUrl,
    slideUrl,
  ])
    await healthy(url)
  fixture = await prepareLiveDemo({ unprocessed: true })
  console.log(`Fresh demo: ${fixture.invoiceNumber} (${fixture.invoiceId})`)
  console.log("Ready to process: revision 0; no payment; no model call has run.")
  const windows = await restoreWindows(fixture)
  await confirmFreshFixture(fixture)
  console.log(
    JSON.stringify(
      {
        ready: true,
        invoiceNumber: fixture.invoiceNumber,
        invoiceId: fixture.invoiceId,
        windows,
        firstAction: "Open the operator app and click Run invoice agent",
        slide: slideUrl,
        app: appUrl,
        manifestPath: fixture.manifestPath,
      },
      null,
      2,
    ),
  )
} catch {
  console.error(
    "Demo reset did not complete. Existing history and ledger were not deleted or rewound.",
  )
  if (fixture) {
    console.error(
      `Fresh received invoice remains: ${fixture.invoiceNumber} (${fixture.invoiceId}). Manifest: ${fixture.manifestPath}`,
    )
    console.error(
      `Manual recovery: open ${appUrl} in separate operator and approver profiles; refresh and select the newest New invoice / Email received / Ready to process item. Open ${slideUrl} in the operator window. Do not click Run invoice agent until the demonstration.`,
    )
  } else
    console.error(
      "No fresh demo was confirmed. Check the existing application/pitch services and .env; the script does not start servers.",
    )
  process.exitCode = 1
}

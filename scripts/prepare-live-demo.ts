import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { MongoClient } from "mongodb"
import * as z from "zod"
import { readConfig } from "../apps/api/src/config.ts"

export async function prepareLiveDemo({ unprocessed = false } = {}) {
  const config = readConfig()
  const started = performance.now()
  let cookie = ""
  const endpoint = "http://127.0.0.1:4100/api/graphql"
  async function request(query: string, variables: unknown) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: config.APP_ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) throw new Error(`Demo preparation failed (HTTP ${response.status})`)
    const result: unknown = await response.json()
    const envelope = z
      .object({
        data: z.record(z.string(), z.unknown()).nullish(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(result)
    if (envelope.errors?.length)
      throw new Error(envelope.errors.map((entry) => entry.message).join("; "))
    if (query.includes("mutation Login")) {
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? ""
      if (!cookie) throw new Error("Demo preparation did not receive an authenticated session")
    }
    return envelope.data
  }

  await request("mutation Login($key: String!) { login(accessKey: $key) { id role } }", {
    key: config.OPERATOR_ACCESS_KEY,
  })
  const invoiceNumber = `LIVE-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`
  const email = `From: urgent-accounts@cedarsupply-payments.example\nSubject: ${invoiceNumber}, bank details changed\n\nSupplier: Cedar Supply Co.\nInvoice: ${invoiceNumber}\nAmount: CAD 4,800.00\nRequested account: CA-DEMO-999-7719\nPlease use this new bank account for this invoice.\nThis is a dedicated synthetic live-demo fixture. No real funds or supplier communication.`
  const created = z
    .object({ submitInvoiceEmail: z.object({ id: z.uuid(), revision: z.number().int() }) })
    .parse(
      await request(
        "mutation Prepare($email: String!, $key: String!) { submitInvoiceEmail(email: $email, idempotencyKey: $key) { id revision } }",
        { email, key: randomUUID() },
      ),
    ).submitInvoiceEmail
  const fields = "id revision status proposal { invoiceNumber amountCents beneficiaryAccount }"
  const extracted = unprocessed
    ? null
    : z
        .object({
          runInvoiceAgent: z.object({
            id: z.uuid(),
            revision: z.number().int(),
            status: z.literal("awaiting_verification"),
            proposal: z.object({
              invoiceNumber: z.literal(invoiceNumber),
              amountCents: z.literal(480000),
              beneficiaryAccount: z.literal("CA-DEMO-999-7719"),
            }),
          }),
        })
        .parse(
          await request(
            `mutation Extract($id: ID!, $revision: Int!) { runInvoiceAgent(invoiceId: $id, expectedRevision: $revision) { ${fields} } }`,
            { id: created.id, revision: created.revision },
          ),
        ).runInvoiceAgent
  const invoice =
    extracted ??
    z
      .object({
        invoice: z.object({
          id: z.uuid(),
          revision: z.literal(0),
          status: z.literal("received"),
          proposal: z.null(),
        }),
      })
      .parse(
        await request(`query Prepared($id: ID!) { invoice(id: $id) { ${fields} } }`, {
          id: created.id,
        }),
      ).invoice
  const ledgerClient = new MongoClient(z.string().min(1).parse(process.env.PAYMENT_MONGODB_URI))
  await ledgerClient.connect()
  let ledgerCount: number
  try {
    ledgerCount = await ledgerClient
      .db(z.string().min(1).parse(process.env.PAYMENT_MONGODB_DB))
      .collection("mock_payments")
      .countDocuments({ invoiceId: invoice.id })
  } finally {
    await ledgerClient.close()
  }
  if (ledgerCount !== 0) throw new Error("A newly prepared fixture unexpectedly has a payment")
  const record = {
    invoiceId: invoice.id,
    invoiceNumber,
    revision: invoice.revision,
    status: invoice.status,
    fixtureLedgerCount: ledgerCount,
    mode: unprocessed ? "unprocessed" : "held",
    nextAction: unprocessed
      ? "Select the newly received invoice and click Run invoice agent to extract it and show the changed-account hold."
      : "Record independent verification using the separate approver.",
    preparationSeconds: Math.round((performance.now() - started) / 100) / 10,
    humanVerificationText: `Synthetic roleplay: called saved Alex Chen at 555-0142 and confirmed ${invoiceNumber}, CAD 4,800.00, destination ending 7719.`,
    reset:
      "Run pnpm demo:prepare --unprocessed for a fresh received LIVE- invoice, or pnpm demo:prepare for a held invoice. Previous invoices and ledger records are retained.",
  }
  const directory = resolve(".claude-dev/scratch/live-demo")
  await mkdir(directory, { recursive: true })
  const path = resolve(directory, `${invoiceNumber}.json`)
  await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 })
  return { ...record, manifestPath: path }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(
    JSON.stringify(
      await prepareLiveDemo({ unprocessed: process.argv.includes("--unprocessed") }),
      null,
      2,
    ),
  )
}

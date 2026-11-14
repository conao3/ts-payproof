import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { MongoClient } from "mongodb"
import * as z from "zod"
import { readConfig } from "../apps/api/src/config.ts"

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
const invoice = z
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
  preparationSeconds: Math.round((performance.now() - started) / 100) / 10,
  humanVerificationText: `Synthetic roleplay: called saved Alex Chen at 555-0142 and confirmed ${invoiceNumber}, CAD 4,800.00, destination ending 7719.`,
  reset:
    "Run pnpm demo:prepare again to create a fresh LIVE- invoice. Previous invoices and ledger records are retained.",
}
const directory = resolve(".claude-dev/scratch/live-demo")
await mkdir(directory, { recursive: true })
const path = resolve(directory, `${invoiceNumber}.json`)
await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ...record, manifestPath: path }, null, 2))

import * as z from "zod"
import type { Actor, Invoice, Payment } from "../../../packages/core/src/model.ts"
import { assertRole, paymentHash } from "../../../packages/core/src/model.ts"
import type { Store } from "./store.ts"
import type { Config } from "./config.ts"

const paymentSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  operationId: z.string(),
  invoiceId: z.string(),
  payloadHash: z.string(),
  amountCents: z.number().int(),
  currency: z.literal("CAD"),
  beneficiaryAccount: z.string(),
  receipt: z.string(),
  recordedAt: z.string(),
})
const fields =
  "id tenant operationId invoiceId payloadHash amountCents currency beneficiaryAccount receipt recordedAt"
async function request(config: Config, query: string, variables: unknown): Promise<unknown> {
  const response = await fetch(config.MOCK_PAYMENT_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payproof-payment-key": config.PAYMENT_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok)
    throw new Error(`Simulated payment service unavailable (HTTP ${response.status})`)
  const result = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    })
    .parse(await response.json())
  if (result.errors?.length) throw new Error("Simulated payment service rejected the instruction")
  return result.data
}
export async function lookupPayment(
  config: Config,
  tenant: string,
  operationId: string,
): Promise<Payment | null> {
  const raw = await request(
    config,
    `query Receipt($tenant: String!, $operationId: ID!) { payment(tenant: $tenant, operationId: $operationId) { ${fields} } }`,
    { tenant, operationId },
  )
  const result = z.object({ payment: paymentSchema.nullable() }).parse(raw)
  return result.payment ? { ...result.payment, _id: result.payment.id } : null
}
export async function recordPayment(config: Config, invoice: Invoice): Promise<Payment> {
  const raw = await request(
    config,
    `mutation Record($input: PaymentInput!) { recordPayment(input: $input) { ${fields} } }`,
    {
      input: {
        tenant: invoice.tenant,
        operationId: invoice.operationId,
        invoiceId: invoice._id,
        payloadHash: paymentHash(invoice),
        amountCents: invoice.proposal!.amountCents,
        currency: invoice.proposal!.currency,
        beneficiaryAccount: invoice.proposal!.beneficiaryAccount,
      },
    },
  )
  const result = z.object({ recordPayment: paymentSchema }).parse(raw)
  return { ...result.recordPayment, _id: result.recordPayment.id }
}
export async function dispatchPayment(
  store: Store,
  config: Config,
  operator: Actor,
  invoiceId: string,
  revision: number,
): Promise<Invoice> {
  assertRole(operator, ["operator"])
  await store.principal(operator)
  const agent = store.agentFor(operator)
  const invoice = await store.claimDispatch(agent, invoiceId, revision)
  if (invoice.status === "paid") return invoice
  if (!invoice.operationId) throw new Error("No authorized payment operation exists")
  try {
    let payment = await lookupPayment(config, invoice.tenant, invoice.operationId)
    if (!payment) {
      try {
        payment = await recordPayment(config, invoice)
      } catch {
        payment = await lookupPayment(config, invoice.tenant, invoice.operationId)
      }
    }
    if (!payment)
      throw new Error(
        "Payment result is uncertain. Retry to verify the same operation; a new payment will not be created",
      )
    return await store.finishDispatch(agent, invoice, payment)
  } catch (error) {
    await store.audit(
      agent,
      invoiceId,
      "DISPATCH_UNCERTAIN",
      "Awaiting independent confirmation from simulated ledger. The same operation ID will be reused",
    )
    throw error
  }
}

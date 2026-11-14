import { randomUUID } from "node:crypto"
import type { Db } from "mongodb"
import * as z from "zod"
import type { Payment } from "../../../packages/core/src/model.ts"

export const paymentInputSchema = z.object({
  tenant: z.string().min(1).max(100),
  operationId: z.uuid(),
  invoiceId: z.uuid(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  amountCents: z.number().int().positive().max(100_000_000),
  currency: z.literal("CAD"),
  beneficiaryAccount: z.string().min(6).max(100),
})
export type PaymentInput = z.infer<typeof paymentInputSchema>
export function samePayment(existing: Payment, input: PaymentInput): boolean {
  return (
    existing.tenant === input.tenant &&
    existing.operationId === input.operationId &&
    existing.invoiceId === input.invoiceId &&
    existing.payloadHash === input.payloadHash &&
    existing.amountCents === input.amountCents &&
    existing.currency === input.currency &&
    existing.beneficiaryAccount === input.beneficiaryAccount
  )
}
export function createPaymentService(db: Db) {
  const payments = db.collection<Payment>("mock_payments")
  async function find(tenant: string, operationId: string): Promise<Payment | null> {
    return payments.findOne({ _id: `${tenant}:${operationId}`, tenant })
  }
  async function record(raw: unknown): Promise<Payment> {
    const input = paymentInputSchema.parse(raw)
    const previous = await find(input.tenant, input.operationId)
    if (previous) {
      if (!samePayment(previous, input))
        throw new Error("Operation ID is already bound to different payment details")
      return previous
    }
    const payment: Payment = {
      ...input,
      _id: `${input.tenant}:${input.operationId}`,
      receipt: "SIM-" + randomUUID(),
      recordedAt: new Date().toISOString(),
    }
    try {
      await payments.insertOne(payment)
      return payment
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 11000) {
        const concurrent = await find(input.tenant, input.operationId)
        if (concurrent && samePayment(concurrent, input)) return concurrent
      }
      throw error
    }
  }
  return { find, record }
}

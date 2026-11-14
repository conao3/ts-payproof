import { createHash } from "node:crypto"
import * as z from "zod"

export const proposalSchema = z.object({
  vendorId: z.string().min(1),
  invoiceNumber: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((value) => value.toUpperCase()),
  amountCents: z.number().int().positive().max(100_000_000),
  currency: z.literal("CAD"),
  beneficiaryAccount: z
    .string()
    .trim()
    .min(6)
    .max(100)
    .transform((value) => value.toUpperCase()),
  reason: z.string().min(1).max(2000),
})
export type Proposal = z.infer<typeof proposalSchema>
export type Role = "operator" | "approver" | "agent"
export type Actor = { id: string; tenant: string; role: Role }
export type Vendor = {
  _id: string
  tenant: string
  name: string
  account: string
  contactRef: string
  contactName: string
  contactPhone: string
  revision: number
  fence: number
}
export type Principal = Actor & {
  _id: string
  enabled: boolean
  policyRevision: number
  fence: number
}
export type AuditEvent = {
  id: string
  at: string
  actor: string
  kind: string
  reason: string
  revision: number
}
export type InvoiceStatus =
  | "received"
  | "extracting"
  | "awaiting_verification"
  | "awaiting_approval"
  | "approved"
  | "dispatching"
  | "paid"
  | "cancelled"
  | "extraction_failed"
export type Verification = {
  actorId: string
  at: string
  contactRef: string
  evidence: string
  payloadHash: string
}
export type Approval = { actorId: string; at: string; payloadHash: string }
export type Payment = {
  _id: string
  tenant: string
  operationId: string
  invoiceId: string
  payloadHash: string
  amountCents: number
  currency: "CAD"
  beneficiaryAccount: string
  receipt: string
  recordedAt: string
}
export type Invoice = {
  _id: string
  tenant: string
  submissionKey: string
  sourceEmail: string
  sourceHash: string
  createdAt: string
  updatedAt: string
  revision: number
  status: InvoiceStatus
  proposal: Proposal | null
  vendor: Vendor | null
  policyRevision: number
  verification: Verification | null
  approval: Approval | null
  operationId: string | null
  payment: Payment | null
  events: AuditEvent[]
  error: string | null
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function paymentHash(invoice: Invoice): string {
  if (!invoice.proposal || !invoice.vendor) throw new Error("Invoice has no payment proposal")
  return digest([
    invoice.tenant,
    invoice._id,
    invoice.revision,
    invoice.sourceHash,
    invoice.proposal.vendorId,
    invoice.vendor.revision,
    invoice.proposal.invoiceNumber,
    invoice.proposal.amountCents,
    invoice.proposal.currency,
    invoice.proposal.beneficiaryAccount,
    invoice.policyRevision,
  ])
}

export function accountChanged(invoice: Invoice): boolean {
  return Boolean(
    invoice.proposal &&
    invoice.vendor &&
    invoice.proposal.beneficiaryAccount !== invoice.vendor.account,
  )
}

export function assertRole(actor: Actor, roles: Role[]): void {
  if (!roles.includes(actor.role))
    throw new Error("This identity does not have permission for that action")
}

export function assertCanApprove(invoice: Invoice, actor: Actor, expectedHash: string): string {
  assertRole(actor, ["approver"])
  if (actor.tenant !== invoice.tenant) throw new Error("Invoice not found")
  if (!["awaiting_verification", "awaiting_approval"].includes(invoice.status))
    throw new Error("Invoice is not awaiting approval")
  const hash = paymentHash(invoice)
  if (expectedHash !== hash) throw new Error("Payment details changed. Review them again")
  if (
    accountChanged(invoice) &&
    (!invoice.verification || invoice.verification.payloadHash !== hash)
  )
    throw new Error("Independent verification with the saved contact is required")
  return hash
}

export function assertDispatchable(invoice: Invoice, actor: Actor): string {
  assertRole(actor, ["agent"])
  if (actor.tenant !== invoice.tenant) throw new Error("Invoice not found")
  if (invoice.status !== "approved") throw new Error("Payment is not approved")
  const hash = paymentHash(invoice)
  if (invoice.approval?.payloadHash !== hash)
    throw new Error("Approval does not cover these payment details")
  if (accountChanged(invoice) && invoice.verification?.payloadHash !== hash)
    throw new Error("Verification does not cover these payment details")
  return hash
}

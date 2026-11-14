import { describe, expect, it } from "vite-plus/test"
import {
  accountChanged,
  assertCanApprove,
  assertDispatchable,
  paymentHash,
  proposalSchema,
  type Actor,
  type Invoice,
} from "../src/model.ts"
const approver: Actor = { id: "approver-1", tenant: "maple-ridge", role: "approver" }
const agent: Actor = { id: "agent-1", tenant: "maple-ridge", role: "agent" }
function invoice(): Invoice {
  return {
    _id: "invoice-1",
    tenant: "maple-ridge",
    submissionKey: "submit-1",
    sourceEmail: "Invoice email",
    sourceHash: "source-1",
    createdAt: "2026-11-14T15:00:00Z",
    updatedAt: "2026-11-14T15:00:00Z",
    revision: 1,
    status: "awaiting_approval",
    proposal: {
      vendorId: "cedar",
      invoiceNumber: "CS-1108",
      amountCents: 480000,
      currency: "CAD",
      beneficiaryAccount: "CA-DEMO-999-7719",
      reason: "Requested account change",
    },
    vendor: {
      _id: "cedar",
      tenant: "maple-ridge",
      name: "Cedar Supply",
      account: "CA-DEMO-001-0042",
      contactRef: "saved-contact",
      contactName: "Alex",
      contactPhone: "+1-416-555-0142",
      revision: 1,
      fence: 0,
    },
    policyRevision: 1,
    verification: null,
    approval: null,
    operationId: null,
    payment: null,
    events: [],
    error: null,
  }
}
function verified(): Invoice {
  const i = invoice()
  i.verification = {
    actorId: approver.id,
    at: i.createdAt,
    contactRef: "saved-contact",
    evidence: "Confirmed with the saved supplier phone number",
    payloadHash: paymentHash(i),
  }
  return i
}
function approved(): Invoice {
  const i = verified()
  i.approval = { actorId: approver.id, at: i.createdAt, payloadHash: paymentHash(i) }
  i.status = "approved"
  return i
}
describe("payment authority is bound to the actual instruction", () => {
  it("blocks a changed account until a human records independent verification", () => {
    const i = invoice()
    expect(accountChanged(i)).toBe(true)
    expect(() => assertCanApprove(i, approver, paymentHash(i))).toThrow("Independent verification")
    expect(assertCanApprove(verified(), approver, paymentHash(verified()))).toHaveLength(64)
  })
  it("requires a human approver even when the saved account matches", () => {
    const i = invoice()
    i.proposal!.beneficiaryAccount = i.vendor!.account
    expect(accountChanged(i)).toBe(false)
    expect(assertCanApprove(i, approver, paymentHash(i))).toHaveLength(64)
    expect(() => assertCanApprove(i, agent, paymentHash(i))).toThrow("permission")
  })
  it("rejects a human or another tenant claiming agent execution authority", () => {
    const i = approved()
    expect(() => assertDispatchable(i, approver)).toThrow("permission")
    expect(() => assertDispatchable(i, { ...agent, tenant: "another-business" })).toThrow(
      "not found",
    )
  })
  it.each(["amount", "account", "invoice", "source", "policy", "supplier"])(
    "invalidates an earlier approval after %s changes",
    (field) => {
      const i = approved()
      if (field === "amount") i.proposal!.amountCents += 10000
      if (field === "account") i.proposal!.beneficiaryAccount = "CA-DEMO-999-8820"
      if (field === "invoice") i.revision += 1
      if (field === "source") i.sourceHash = "new-source"
      if (field === "policy") i.policyRevision += 1
      if (field === "supplier") i.vendor!.revision += 1
      expect(() => assertDispatchable(i, agent)).toThrow("Approval does not cover")
    },
  )
  it("does not authorize an unapproved or cancelled invoice", () => {
    const i = verified()
    expect(() => assertDispatchable(i, agent)).toThrow("not approved")
    i.status = "cancelled"
    expect(() => assertDispatchable(i, agent)).toThrow("not approved")
  })
  it("allows the verified and approved exact instruction", () => {
    const i = approved()
    expect(assertDispatchable(i, agent)).toBe(i.approval!.payloadHash)
  })
  it("rejects invalid financial output and normalizes identifiers before uniqueness checks", () => {
    const proposal = invoice().proposal!
    expect(
      proposalSchema.parse({
        ...proposal,
        invoiceNumber: " cs-1108 ",
        beneficiaryAccount: " ca-demo-999-7719 ",
      }),
    ).toEqual(proposal)
    expect(() => proposalSchema.parse({ ...proposal, amountCents: 1.5 })).toThrow()
    expect(() => proposalSchema.parse({ ...proposal, amountCents: -100 })).toThrow()
    expect(() => proposalSchema.parse({ ...proposal, currency: "USD" })).toThrow()
  })
})

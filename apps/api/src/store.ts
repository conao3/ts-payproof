import { randomUUID } from "node:crypto"
import { MongoClient, type Db, type ClientSession } from "mongodb"
import type {
  Actor,
  AuditEvent,
  Invoice,
  Principal,
  Proposal,
  Vendor,
  Payment,
} from "../../../packages/core/src/model.ts"
import {
  accountChanged,
  assertCanApprove,
  assertDispatchable,
  assertRole,
  digest,
  paymentHash,
} from "../../../packages/core/src/model.ts"

export const demoTenant = "maple-ridge"
export function event(actor: Actor, kind: string, reason: string, revision: number): AuditEvent {
  return { id: randomUUID(), at: new Date().toISOString(), actor: actor.id, kind, reason, revision }
}

export async function initializeDatabase(db: Db): Promise<void> {
  for (const name of ["principals", "vendors", "invoices", "security_events"]) {
    if (!(await db.listCollections({ name }).hasNext())) await db.createCollection(name)
  }
  await db.command({
    collMod: "invoices",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["tenant", "revision", "status", "events", "sourceHash"],
        properties: {
          tenant: { bsonType: "string" },
          revision: { bsonType: "number", minimum: 0 },
          status: {
            enum: [
              "received",
              "extracting",
              "awaiting_verification",
              "awaiting_approval",
              "approved",
              "dispatching",
              "paid",
              "cancelled",
              "extraction_failed",
            ],
          },
          events: { bsonType: "array" },
        },
      },
    },
    validationLevel: "strict",
    validationAction: "error",
  })
  await db.collection("invoices").createIndex({ tenant: 1, submissionKey: 1 }, { unique: true })
  await db
    .collection("invoices")
    .createIndex(
      { tenant: 1, "proposal.vendorId": 1, "proposal.invoiceNumber": 1 },
      { unique: true, partialFilterExpression: { "proposal.invoiceNumber": { $type: "string" } } },
    )
  await db.collection("vendors").createIndex({ tenant: 1, name: 1 }, { unique: true })
  await db.collection("security_events").createIndex({ at: 1 })
}

export async function seedDatabase(db: Db): Promise<void> {
  for (const role of ["operator", "approver", "agent"] as const) {
    const principal: Principal = {
      _id: `${demoTenant}-${role}`,
      id: `${demoTenant}-${role}`,
      tenant: demoTenant,
      role,
      enabled: true,
      policyRevision: 1,
      fence: 0,
    }
    await db
      .collection<Principal>("principals")
      .updateOne({ _id: principal._id }, { $setOnInsert: principal }, { upsert: true })
  }
  const vendors: Vendor[] = [
    {
      _id: "cedar-supply",
      tenant: demoTenant,
      name: "Cedar Supply Co.",
      account: "CA-DEMO-001-0042",
      contactRef: "cedar-finance",
      contactName: "Alex Chen · Accounts",
      contactPhone: "+1 (416) 555-0142",
      revision: 1,
      fence: 0,
    },
    {
      _id: "northline-electric",
      tenant: demoTenant,
      name: "Northline Electric",
      account: "CA-DEMO-002-0086",
      contactRef: "northline-finance",
      contactName: "Sam Patel · Office",
      contactPhone: "+1 (416) 555-0186",
      revision: 1,
      fence: 0,
    },
  ]
  for (const vendor of vendors)
    await db
      .collection<Vendor>("vendors")
      .updateOne({ _id: vendor._id }, { $setOnInsert: vendor }, { upsert: true })
}

export function createStore(client: MongoClient, db: Db) {
  const invoices = db.collection<Invoice>("invoices")
  const vendors = db.collection<Vendor>("vendors")
  const principals = db.collection<Principal>("principals")
  async function principal(actor: Actor, session?: ClientSession): Promise<Principal> {
    const p = await principals.findOne(
      { _id: actor.id, tenant: actor.tenant, role: actor.role, enabled: true },
      { session },
    )
    if (!p) throw new Error("This identity is disabled or unavailable")
    return p
  }
  async function get(actor: Actor, id: string, session?: ClientSession): Promise<Invoice> {
    await principal(actor, session)
    const invoice = await invoices.findOne({ _id: id, tenant: actor.tenant }, { session })
    if (!invoice) throw new Error("Invoice not found")
    return invoice
  }
  async function deny(actor: Actor, id: string | null, reason: string): Promise<void> {
    const current = id ? await invoices.findOne({ _id: id, tenant: actor.tenant }) : null
    const entry = event(actor, "ACTION_DENIED", reason, current?.revision ?? 0)
    if (current) {
      const result = await invoices.updateOne(
        { _id: current._id, tenant: actor.tenant },
        { $push: { events: entry } },
      )
      if (result.matchedCount) return
    }
    await db
      .collection("security_events")
      .insertOne({ ...entry, tenant: actor.tenant, targetId: id })
  }
  async function submit(
    actor: Actor,
    sourceEmail: string,
    submissionKey: string,
  ): Promise<Invoice> {
    assertRole(actor, ["operator"])
    const p = await principal(actor)
    const existing = await invoices.findOne({ tenant: actor.tenant, submissionKey })
    if (existing) {
      if (existing.sourceHash !== digest(sourceEmail))
        throw new Error("Submission key is already bound to different email content")
      return existing
    }
    const now = new Date().toISOString()
    const invoice: Invoice = {
      _id: randomUUID(),
      tenant: actor.tenant,
      submissionKey,
      sourceEmail,
      sourceHash: digest(sourceEmail),
      createdAt: now,
      updatedAt: now,
      revision: 0,
      status: "received",
      proposal: null,
      vendor: null,
      policyRevision: p.policyRevision,
      verification: null,
      approval: null,
      operationId: null,
      payment: null,
      events: [event(actor, "EMAIL_RECEIVED", "Invoice email received for review", 0)],
      error: null,
    }
    try {
      await invoices.insertOne(invoice)
      return invoice
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 11000) {
        const concurrent = await invoices.findOne({ tenant: actor.tenant, submissionKey })
        if (concurrent && concurrent.sourceHash === invoice.sourceHash) return concurrent
      }
      throw error
    }
  }
  async function startExtraction(actor: Actor, id: string, revision: number): Promise<Invoice> {
    assertRole(actor, ["operator"])
    const current = await get(actor, id)
    const updated = await invoices.findOneAndUpdate(
      {
        _id: id,
        tenant: actor.tenant,
        revision,
        status: { $in: ["received", "extraction_failed"] },
      },
      {
        $set: { status: "extracting", updatedAt: new Date().toISOString(), error: null },
        $push: {
          events: event(
            actor,
            "AGENT_STARTED",
            "Delegated invoice lookup and payment proposal to PayProof agent",
            current.revision,
          ),
        },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error("Invoice changed or another agent is already processing it")
    return updated
  }
  async function lookupVendor(actor: Actor, name: string): Promise<Vendor | null> {
    await principal(actor)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return vendors.findOne({
      tenant: actor.tenant,
      $or: [{ _id: name }, { name: { $regex: escaped, $options: "i" } }],
    })
  }
  async function audit(actor: Actor, id: string, kind: string, reason: string): Promise<void> {
    const current = await get(actor, id)
    await invoices.updateOne(
      { _id: id, tenant: actor.tenant },
      { $push: { events: event(actor, kind, reason, current.revision) } },
    )
  }
  async function propose(actor: Actor, id: string, proposal: Proposal): Promise<Invoice> {
    assertRole(actor, ["agent"])
    const p = await principal(actor)
    const vendor = await vendors.findOne({ _id: proposal.vendorId, tenant: actor.tenant })
    if (!vendor)
      throw new Error("Supplier must match a saved vendor. Email cannot create a trusted supplier")
    const before = await get(actor, id)
    const revision = before.revision + 1
    const changed = proposal.beneficiaryAccount !== vendor.account
    const updated = await invoices.findOneAndUpdate(
      { _id: id, tenant: actor.tenant, revision: before.revision, status: "extracting" },
      {
        $set: {
          proposal,
          vendor,
          revision,
          policyRevision: p.policyRevision,
          status: changed ? "awaiting_verification" : "awaiting_approval",
          verification: null,
          approval: null,
          updatedAt: new Date().toISOString(),
        },
        $push: {
          events: event(
            actor,
            changed ? "BANK_CHANGE_BLOCKED" : "APPROVAL_REQUIRED",
            changed
              ? "Destination differs from the saved supplier account. Independent verification is required; email contact details are not trusted"
              : "Saved supplier account matches. Human approval is still required",
            revision,
          ),
        },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error("Invoice state changed while the agent was working")
    return updated
  }
  async function extractionFailed(actor: Actor, id: string, message: string): Promise<void> {
    await invoices.updateOne(
      { _id: id, tenant: actor.tenant, status: "extracting" },
      {
        $set: { status: "extraction_failed", error: message },
        $push: { events: event(actor, "AGENT_FAILED", message, 0) },
      },
    )
  }
  async function verify(
    actor: Actor,
    id: string,
    revision: number,
    contactRef: string,
    evidence: string,
  ): Promise<Invoice> {
    assertRole(actor, ["approver"])
    const invoice = await get(actor, id)
    if (!invoice.vendor || contactRef !== invoice.vendor.contactRef)
      throw new Error("Use the saved supplier contact, not contact details from the email")
    if (invoice.revision !== revision || invoice.status !== "awaiting_verification")
      throw new Error("Invoice is not awaiting verification at this revision")
    const hash = paymentHash(invoice)
    const verification = {
      actorId: actor.id,
      at: new Date().toISOString(),
      contactRef,
      evidence,
      payloadHash: hash,
    }
    const updated = await invoices.findOneAndUpdate(
      { _id: id, tenant: actor.tenant, revision, status: "awaiting_verification" },
      {
        $set: { verification, status: "awaiting_approval", updatedAt: new Date().toISOString() },
        $push: { events: event(actor, "INDEPENDENTLY_VERIFIED", evidence, revision) },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error("Invoice changed. Verify the current details")
    return updated
  }
  async function approve(
    actor: Actor,
    id: string,
    revision: number,
    payloadHash: string,
  ): Promise<Invoice> {
    const invoice = await get(actor, id)
    const hash = assertCanApprove(invoice, actor, payloadHash)
    const updated = await invoices.findOneAndUpdate(
      { _id: id, tenant: actor.tenant, revision, status: "awaiting_approval" },
      {
        $set: {
          approval: { actorId: actor.id, at: new Date().toISOString(), payloadHash: hash },
          status: "approved",
          updatedAt: new Date().toISOString(),
        },
        $push: {
          events: event(
            actor,
            "PAYMENT_APPROVED",
            `Approval bound to CAD ${(invoice.proposal!.amountCents / 100).toFixed(2)}, destination and invoice revision ${revision}`,
            revision,
          ),
        },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error("Invoice changed or was already approved")
    return updated
  }
  async function revise(
    actor: Actor,
    id: string,
    revision: number,
    amountCents: number,
    beneficiaryAccount: string,
  ): Promise<Invoice> {
    assertRole(actor, ["operator"])
    const invoice = await get(actor, id)
    if (
      !invoice.proposal ||
      !invoice.vendor ||
      ["dispatching", "paid", "cancelled", "extracting"].includes(invoice.status)
    )
      throw new Error("This invoice cannot be revised")
    const proposal = { ...invoice.proposal, amountCents, beneficiaryAccount }
    const updated = await invoices.findOneAndUpdate(
      { _id: id, tenant: actor.tenant, revision, status: invoice.status },
      {
        $set: {
          proposal,
          revision: revision + 1,
          verification: null,
          approval: null,
          status:
            beneficiaryAccount === invoice.vendor.account
              ? "awaiting_approval"
              : "awaiting_verification",
          updatedAt: new Date().toISOString(),
        },
        $push: {
          events: event(
            actor,
            "APPROVAL_INVALIDATED",
            "Payment details revised. Any earlier verification and approval no longer authorize payment",
            revision + 1,
          ),
        },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error("Invoice changed. Reload before editing")
    return updated
  }
  async function cancel(actor: Actor, id: string, revision: number): Promise<Invoice> {
    assertRole(actor, ["operator", "approver"])
    await get(actor, id)
    const updated = await invoices.findOneAndUpdate(
      {
        _id: id,
        tenant: actor.tenant,
        revision,
        status: {
          $in: [
            "received",
            "extracting",
            "awaiting_verification",
            "awaiting_approval",
            "approved",
            "extraction_failed",
          ],
        },
      },
      {
        $set: { status: "cancelled", updatedAt: new Date().toISOString() },
        $push: { events: event(actor, "CANCELLED", "Stopped before payment dispatch", revision) },
      },
      { returnDocument: "after" },
    )
    if (!updated)
      throw new Error(
        "Payment may already be dispatching. Check its result before taking further action",
      )
    return updated
  }
  async function claimDispatch(actor: Actor, id: string, revision: number): Promise<Invoice> {
    assertRole(actor, ["agent"])
    return client.withSession(async (session) =>
      session.withTransaction(
        async () => {
          const p = await principal(actor, session)
          const invoice = await get(actor, id, session)
          if (["dispatching", "paid"].includes(invoice.status)) return invoice
          if (invoice.revision !== revision) throw new Error("Payment revision changed")
          const hash = assertDispatchable(invoice, actor)
          if (p.policyRevision !== invoice.policyRevision)
            throw new Error("Authorization policy changed. Re-approval is required")
          const vendor = await vendors.updateOne(
            { _id: invoice.vendor!._id, tenant: actor.tenant, revision: invoice.vendor!.revision },
            { $inc: { fence: 1 } },
            { session },
          )
          const agent = await principals.updateOne(
            { _id: p._id, enabled: true, policyRevision: invoice.policyRevision },
            { $inc: { fence: 1 } },
            { session },
          )
          const approver = await principals.updateOne(
            {
              _id: invoice.approval!.actorId,
              tenant: actor.tenant,
              role: "approver",
              enabled: true,
              policyRevision: invoice.policyRevision,
            },
            { $inc: { fence: 1 } },
            { session },
          )
          if (vendor.matchedCount !== 1 || agent.matchedCount !== 1 || approver.matchedCount !== 1)
            throw new Error("Supplier or authority changed. Payment is held")
          const updated = await invoices.findOneAndUpdate(
            {
              _id: id,
              tenant: actor.tenant,
              revision,
              status: "approved",
              "approval.payloadHash": hash,
            },
            {
              $set: {
                status: "dispatching",
                operationId: randomUUID(),
                updatedAt: new Date().toISOString(),
              },
              $push: {
                events: event(
                  actor,
                  "DISPATCH_AUTHORIZED",
                  "Live policy, supplier revision, independent verification and exact approval checked before dispatch",
                  revision,
                ),
              },
            },
            { session, returnDocument: "after" },
          )
          if (!updated) throw new Error("Another operation changed the payment")
          return updated
        },
        { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
      ),
    )
  }
  async function finishDispatch(
    actor: Actor,
    invoice: Invoice,
    payment: Payment,
  ): Promise<Invoice> {
    if (
      payment.operationId !== invoice.operationId ||
      payment.invoiceId !== invoice._id ||
      payment.tenant !== invoice.tenant ||
      payment.payloadHash !== paymentHash(invoice) ||
      payment.amountCents !== invoice.proposal!.amountCents ||
      payment.beneficiaryAccount !== invoice.proposal!.beneficiaryAccount ||
      payment.currency !== "CAD"
    )
      throw new Error("Payment receipt does not match the approved instruction")
    const updated = await invoices.findOneAndUpdate(
      {
        _id: invoice._id,
        tenant: actor.tenant,
        revision: invoice.revision,
        status: "dispatching",
        operationId: invoice.operationId,
      },
      {
        $set: { status: "paid", payment, updatedAt: new Date().toISOString() },
        $push: {
          events: event(
            actor,
            "PAYMENT_CONFIRMED",
            `Simulated ledger receipt ${payment.receipt} verified against the approved payload`,
            invoice.revision,
          ),
        },
      },
      { returnDocument: "after" },
    )
    return updated ?? get(actor, invoice._id)
  }
  return {
    db,
    principal,
    get,
    deny,
    submit,
    startExtraction,
    lookupVendor,
    audit,
    propose,
    extractionFailed,
    verify,
    approve,
    revise,
    cancel,
    claimDispatch,
    finishDispatch,
    list: async (actor: Actor) => {
      await principal(actor)
      return invoices.find({ tenant: actor.tenant }).sort({ createdAt: -1 }).limit(50).toArray()
    },
    vendorList: async (actor: Actor) => {
      await principal(actor)
      return vendors.find({ tenant: actor.tenant }).toArray()
    },
    agentFor: (actor: Actor): Actor => ({
      id: `${actor.tenant}-agent`,
      tenant: actor.tenant,
      role: "agent",
    }),
    accountChanged,
  }
}
export type Store = ReturnType<typeof createStore>

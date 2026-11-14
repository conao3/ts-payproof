import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test"
import { MongoClient, type Db } from "mongodb"
import {
  createStore,
  initializeDatabase,
  seedDatabase,
  demoTenant,
  type Store,
} from "../../apps/api/src/store.ts"
import { createPaymentService } from "../../apps/mock-payment/src/service.ts"
import {
  paymentHash,
  proposalSchema,
  type Actor,
  type Invoice,
  type Principal,
  type Vendor,
} from "../../packages/core/src/model.ts"

const uri = process.env.MONGODB_URI
if (!uri) throw new Error("MONGODB_URI is required for real Atlas integration tests")
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 })
const dbName = `payproof_test_${randomUUID().replaceAll("-", "")}`
let db: Db
let store: Store
const operator: Actor = { id: `${demoTenant}-operator`, tenant: demoTenant, role: "operator" }
const approver: Actor = { id: `${demoTenant}-approver`, tenant: demoTenant, role: "approver" }
const agent: Actor = { id: `${demoTenant}-agent`, tenant: demoTenant, role: "agent" }
beforeAll(async () => {
  await client.connect()
  db = client.db(dbName)
  await initializeDatabase(db)
  await seedDatabase(db)
  store = createStore(client, db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  await client.close()
})
async function proposed(changed = true): Promise<Invoice> {
  const source = await store.submit(operator, "Synthetic invoice " + randomUUID(), randomUUID())
  await store.startExtraction(operator, source._id, 0)
  return store.propose(
    agent,
    source._id,
    proposalSchema.parse({
      vendorId: "cedar-supply",
      invoiceNumber: "TEST-" + randomUUID(),
      amountCents: 480000,
      currency: "CAD",
      beneficiaryAccount: changed ? "CA-DEMO-999-7719" : "CA-DEMO-001-0042",
      reason: "Test proposal",
    }),
  )
}
async function approved(): Promise<Invoice> {
  const i = await proposed()
  await store.verify(
    approver,
    i._id,
    i.revision,
    i.vendor!.contactRef,
    "Confirmed synthetic details using the saved supplier contact",
  )
  return store.approve(approver, i._id, i.revision, paymentHash(i))
}
describe("real Atlas authorization and concurrency", () => {
  it("holds bank changes, rejects email-supplied contacts, and requires human authority", async () => {
    const i = await proposed()
    expect(i.status).toBe("awaiting_verification")
    await expect(
      store.verify(
        approver,
        i._id,
        i.revision,
        "email-supplied-contact",
        "Called new phone number in email",
      ),
    ).rejects.toThrow("saved supplier contact")
    await expect(store.approve(approver, i._id, i.revision, paymentHash(i))).rejects.toThrow(
      "Independent verification",
    )
    await expect(
      store.verify(
        agent,
        i._id,
        i.revision,
        i.vendor!.contactRef,
        "Agent claimed self-verification",
      ),
    ).rejects.toThrow("permission")
    await expect(store.claimDispatch(agent, i._id, i.revision)).rejects.toThrow("not approved")
  })
  it("does not return a different tenant's invoice", async () => {
    const i = await proposed()
    await db.collection<Principal>("principals").insertOne({
      _id: "other-operator",
      id: "other-operator",
      tenant: "other",
      role: "operator",
      enabled: true,
      policyRevision: 1,
      fence: 0,
    })
    await expect(
      store.get({ id: "other-operator", tenant: "other", role: "operator" }, i._id),
    ).rejects.toThrow("not found")
  })
  it("invalidates exact approval and verification when an operator amends details", async () => {
    const i = await approved()
    const revised = await store.revise(
      operator,
      i._id,
      i.revision,
      490000,
      i.proposal!.beneficiaryAccount,
    )
    expect(revised.approval).toBeNull()
    expect(revised.verification).toBeNull()
    expect(revised.status).toBe("awaiting_verification")
    await expect(store.claimDispatch(agent, i._id, i.revision)).rejects.toThrow("revision changed")
    expect(await db.collection("mock_payments").countDocuments()).toBe(0)
  })
  it("grants one approval and uses a single operation ID for concurrent dispatches", async () => {
    const i = await proposed(false)
    const approvals = await Promise.allSettled([
      store.approve(approver, i._id, i.revision, paymentHash(i)),
      store.approve(approver, i._id, i.revision, paymentHash(i)),
    ])
    expect(approvals.filter((x) => x.status === "fulfilled")).toHaveLength(1)
    const dispatched = await Promise.all([
      store.claimDispatch(agent, i._id, i.revision),
      store.claimDispatch(agent, i._id, i.revision),
    ])
    expect(dispatched[0].operationId).toBe(dispatched[1].operationId)
    const payment = createPaymentService(db)
    const d = dispatched[0]
    const input = {
      tenant: d.tenant,
      operationId: d.operationId!,
      invoiceId: d._id,
      payloadHash: paymentHash(d),
      amountCents: d.proposal!.amountCents,
      currency: "CAD" as const,
      beneficiaryAccount: d.proposal!.beneficiaryAccount,
    }
    const results = await Promise.all([payment.record(input), payment.record(input)])
    expect(results[0].receipt).toBe(results[1].receipt)
    expect(
      await db.collection("mock_payments").countDocuments({ operationId: d.operationId }),
    ).toBe(1)
    await expect(payment.record({ ...input, amountCents: 490000 })).rejects.toThrow(
      "different payment",
    )
    const confirmed = await store.finishDispatch(agent, d, results[0])
    expect(confirmed.status).toBe("paid")
    expect((await store.claimDispatch(agent, i._id, i.revision)).operationId).toBe(d.operationId)
  })
  it("rejects a supplier revision change before an approved payment dispatches", async () => {
    const i = await approved()
    await db
      .collection<Vendor>("vendors")
      .updateOne({ _id: i.vendor!._id }, { $inc: { revision: 1 } })
    await expect(store.claimDispatch(agent, i._id, i.revision)).rejects.toThrow(
      "Supplier or authority changed",
    )
    expect((await store.get(operator, i._id)).status).toBe("approved")
  })
  it("rejects duplicate invoice numbers after whitespace and case normalization", async () => {
    const i = await proposed()
    const second = await store.submit(
      operator,
      "Duplicate invoice email " + randomUUID(),
      randomUUID(),
    )
    await store.startExtraction(operator, second._id, 0)
    const proposal = proposalSchema.parse({
      ...i.proposal,
      invoiceNumber: " " + i.proposal!.invoiceNumber.toLowerCase() + " ",
    })
    await expect(store.propose(agent, second._id, proposal)).rejects.toMatchObject({ code: 11000 })
  })
  it("resolves cancellation and dispatch races to one valid state", async () => {
    const i = await approved()
    const result = await Promise.allSettled([
      store.cancel(operator, i._id, i.revision),
      store.claimDispatch(agent, i._id, i.revision),
    ])
    const current = await store.get(operator, i._id)
    expect(["cancelled", "dispatching"]).toContain(current.status)
    expect(result.some((x) => x.status === "fulfilled")).toBe(true)
    if (current.status === "cancelled") expect(current.operationId).toBeNull()
  })
})

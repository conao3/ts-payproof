import { readFileSync } from "node:fs"
import * as z from "zod"
import type { Actor } from "../../../packages/core/src/model.ts"
import { accountChanged, paymentHash } from "../../../packages/core/src/model.ts"
import type { Resolvers } from "./generated/resolvers.ts"
import { equalSecret, signSession } from "./auth.ts"
import type { Config } from "./config.ts"
import type { Store } from "./store.ts"
import { demoTenant } from "./store.ts"
import { runAgent } from "./agent.ts"
import { dispatchPayment } from "./payment-client.ts"

export type GraphQLContext = { actor: Actor | null; session: (value: string | null) => void }
export const typeDefs = readFileSync("schema.graphql", "utf8")
const idSchema = z.uuid()
const revisionSchema = z.number().int().nonnegative()
const viewer = (actor: Actor) => ({
  id: actor.id,
  role: actor.role,
  organization: "Maple Ridge Construction",
})
export function createResolvers(store: Store, config: Config): Resolvers {
  async function identity(context: GraphQLContext): Promise<Actor> {
    if (!context.actor) throw new Error("Sign in to continue")
    const p = await store.principal(context.actor)
    return { id: p.id, tenant: p.tenant, role: p.role }
  }
  async function action<T>(
    context: GraphQLContext,
    id: string,
    operation: (actor: Actor) => Promise<T>,
  ): Promise<T> {
    const actor = await identity(context)
    idSchema.parse(id)
    try {
      return await operation(actor)
    } catch (error) {
      const reason =
        error instanceof z.ZodError
          ? "Request failed input validation"
          : error instanceof Error
            ? error.message
            : "Action failed"
      await store.deny(actor, id, reason)
      throw new Error(reason, { cause: error })
    }
  }

  return {
    Invoice: {
      id: (i) => i._id,
      paymentHash: (i) => (i.proposal && i.vendor ? paymentHash(i) : null),
      accountChanged: (i) => accountChanged(i),
    },
    Vendor: { id: (v) => v._id },
    Payment: { id: (p) => p._id },
    Query: {
      viewer: async (_, __, context) => (context.actor ? viewer(await identity(context)) : null),
      invoices: async (_, __, context) => store.list(await identity(context)),
      invoice: (_, args, context) => action(context, args.id, (actor) => store.get(actor, args.id)),
      vendors: async (_, __, context) => store.vendorList(await identity(context)),
    },
    Mutation: {
      login: async (_, args, context) => {
        const key = z.string().min(16).max(300).parse(args.accessKey)
        const role = equalSecret(key, config.OPERATOR_ACCESS_KEY)
          ? "operator"
          : equalSecret(key, config.APPROVER_ACCESS_KEY)
            ? "approver"
            : null
        if (!role) throw new Error("That access key is not valid")
        const actor: Actor = { id: `${demoTenant}-${role}`, tenant: demoTenant, role }
        await store.principal(actor)
        context.session(signSession(actor, config.SESSION_SIGNING_KEY))
        return viewer(actor)
      },
      logout: (_, __, context) => {
        context.session(null)
        return true
      },
      submitInvoiceEmail: async (_, args, context) => {
        const actor = await identity(context)
        return store.submit(
          actor,
          z.string().min(20).max(30_000).parse(args.email),
          z.string().min(10).max(100).parse(args.idempotencyKey),
        )
      },
      runInvoiceAgent: (_, args, context) =>
        action(context, args.invoiceId, (actor) =>
          runAgent(
            store,
            config,
            actor,
            args.invoiceId,
            revisionSchema.parse(args.expectedRevision),
          ),
        ),
      recordIndependentVerification: (_, args, context) =>
        action(context, args.invoiceId, (actor) =>
          store.verify(
            actor,
            args.invoiceId,
            revisionSchema.parse(args.expectedRevision),
            z.string().min(1).max(100).parse(args.contactRef),
            z.string().min(15).max(2000).parse(args.evidence),
          ),
        ),
      approvePayment: (_, args, context) =>
        action(context, args.invoiceId, (actor) =>
          store.approve(
            actor,
            args.invoiceId,
            revisionSchema.parse(args.expectedRevision),
            z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(args.payloadHash),
          ),
        ),
      dispatchPayment: (_, args, context) =>
        action(context, args.invoiceId, (actor) =>
          dispatchPayment(
            store,
            config,
            actor,
            args.invoiceId,
            revisionSchema.parse(args.expectedRevision),
          ),
        ),
      cancelPayment: (_, args, context) =>
        action(context, args.invoiceId, (actor) =>
          store.cancel(actor, args.invoiceId, revisionSchema.parse(args.expectedRevision)),
        ),
      revisePayment: (_, args, context) =>
        action(context, args.invoiceId, (actor) =>
          store.revise(
            actor,
            args.invoiceId,
            revisionSchema.parse(args.expectedRevision),
            z.number().int().positive().max(100_000_000).parse(args.amountCents),
            z
              .string()
              .trim()
              .min(6)
              .max(100)
              .transform((value) => value.toUpperCase())
              .parse(args.beneficiaryAccount),
          ),
        ),
    },
  }
}

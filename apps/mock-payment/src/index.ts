import { MongoClient } from "mongodb"
import { serve } from "@hono/node-server"
import { ApolloServer } from "@apollo/server"
import { startServerAndCreateHonoHandler } from "@conao3/apollo-server-integration-hono"
import { Hono } from "hono"
import * as z from "zod"
import { equalSecret } from "../../api/src/auth.ts"
import { createPaymentService } from "./service.ts"

const config = z
  .object({
    PAYMENT_MONGODB_URI: z.string().min(1),
    PAYMENT_MONGODB_DB: z.string().min(1),
    PAYMENT_API_KEY: z.string().min(32),
  })
  .parse(process.env)
const client = new MongoClient(config.PAYMENT_MONGODB_URI)
await client.connect()
const db = client.db(config.PAYMENT_MONGODB_DB)
await db.command({ ping: 1 })
if (!(await db.listCollections({ name: "mock_payments" }).hasNext()))
  await db.createCollection("mock_payments")
const service = createPaymentService(db)
const typeDefs = `type Payment { id: ID!, tenant: String!, operationId: ID!, invoiceId: ID!, payloadHash: String!, amountCents: Int!, currency: String!, beneficiaryAccount: String!, receipt: String!, recordedAt: String! } input PaymentInput { tenant: String!, operationId: ID!, invoiceId: ID!, payloadHash: String!, amountCents: Int!, currency: String!, beneficiaryAccount: String! } type Query { payment(tenant: String!, operationId: ID!): Payment } type Mutation { recordPayment(input: PaymentInput!): Payment! }`
const app = new Hono()
app.get("/health", async (c) => {
  await db.command({ ping: 1 })
  return c.json({ service: "simulated-payment", ready: true })
})
app.use("/api/graphql", async (c, next) => {
  if (!equalSecret(c.req.header("x-payproof-payment-key") ?? "", config.PAYMENT_API_KEY))
    return c.json({ error: "Unauthorized" }, 401)
  return await next()
})
app.on(
  ["GET", "POST"],
  "/api/graphql",
  startServerAndCreateHonoHandler(
    new ApolloServer({
      typeDefs,
      resolvers: {
        Payment: { id: (p: { _id: string }) => p._id },
        Query: {
          payment: (_: unknown, args: { tenant: string; operationId: string }) =>
            service.find(args.tenant, args.operationId),
        },
        Mutation: {
          recordPayment: (_: unknown, args: { input: unknown }) => service.record(args.input),
        },
      },
    }),
  ),
)
serve({ fetch: app.fetch, port: 4101, hostname: "127.0.0.1" })
console.log("Simulated payment ledger listening on http://127.0.0.1:4101")

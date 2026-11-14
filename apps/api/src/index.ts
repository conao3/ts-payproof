import { MongoClient } from "mongodb"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { ApolloServer } from "@apollo/server"
import { startServerAndCreateHonoHandler } from "@conao3/apollo-server-integration-hono"
import { Hono } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { readConfig } from "./config.ts"
import { createStore, initializeDatabase, seedDatabase } from "./store.ts"
import { readSession } from "./auth.ts"
import { createResolvers, typeDefs, type GraphQLContext } from "./graphql.ts"
import { preserveHonoHeaders } from "./http-handler.ts"
import { createVoiceRoutes } from "./voice-http.ts"

const config = readConfig()
const client = new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 })
await client.connect()
const db = client.db(config.MONGODB_DB)
await db.command({ ping: 1 })
await initializeDatabase(db)
await seedDatabase(db)
const store = createStore(client, db)
const app = new Hono()
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin")
  if (origin && origin !== new URL(config.APP_ORIGIN).origin)
    return c.json({ error: "Origin not allowed" }, 403)
  c.header("Cache-Control", "no-store")
  c.header("X-Content-Type-Options", "nosniff")
  return await next()
})
app.get("/health", async (c) => {
  await db.command({ ping: 1 })
  return c.json({ ready: true, storage: "MongoDB Atlas", payment: "simulated" })
})
const graphqlHandler = startServerAndCreateHonoHandler(
  new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers: createResolvers(store, config),
    includeStacktraceInErrorResponses: false,
    introspection: true,
  }),
  {
    context: async ({ c }) => ({
      actor: readSession(getCookie(c, "payproof_session"), config.SESSION_SIGNING_KEY),
      session: (value) => {
        if (value)
          setCookie(c, "payproof_session", value, {
            httpOnly: true,
            secure: new URL(config.APP_ORIGIN).protocol === "https:",
            sameSite: "Strict",
            path: "/",
            maxAge: 8 * 60 * 60,
          })
        else deleteCookie(c, "payproof_session", { path: "/" })
      },
    }),
  },
)
app.on(["GET", "POST"], "/api/graphql", preserveHonoHeaders(graphqlHandler))
app.route("/api/voice", createVoiceRoutes({ principal: store.principal, get: store.get }, config))
app.use("/*", serveStatic({ root: "./dist/web" }))
app.get("*", serveStatic({ path: "./dist/web/index.html" }))
serve({ fetch: app.fetch, port: 4100, hostname: "127.0.0.1" })
console.log("PayProof listening on http://127.0.0.1:4100")

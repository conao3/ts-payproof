import { expect, it } from "vite-plus/test"
import { Hono } from "hono"
import { setCookie } from "hono/cookie"
import { ApolloServer } from "@apollo/server"
import { startServerAndCreateHonoHandler } from "@conao3/apollo-server-integration-hono"
import { preserveHonoHeaders } from "../src/http-handler.ts"
it("preserves a session cookie set during a GraphQL resolver", async () => {
  const server = new ApolloServer<{ complete: () => void }>({
    typeDefs: "type Query { ready: Boolean! } type Mutation { login: Boolean! }",
    resolvers: {
      Query: { ready: () => true },
      Mutation: {
        login: (_parent, _args, context) => {
          context.complete()
          return true
        },
      },
    },
  })
  const app = new Hono()
  app.on(
    ["GET", "POST"],
    "/api/graphql",
    preserveHonoHeaders(
      startServerAndCreateHonoHandler(server, {
        context: async ({ c }) => ({
          complete: () =>
            setCookie(c, "session-test", "synthetic-test-session", {
              httpOnly: true,
              sameSite: "Strict",
              path: "/",
            }),
        }),
      }),
    ),
  )
  try {
    const response = await app.request("/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "mutation { login }" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { login: true } })
    expect(response.headers.get("set-cookie")).toContain("session-test=synthetic-test-session")
    expect(response.headers.get("set-cookie")).toContain("HttpOnly")
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict")
  } finally {
    await server.stop()
  }
})

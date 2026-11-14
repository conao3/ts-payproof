import type { MiddlewareHandler } from "hono"
export function preserveHonoHeaders(handler: MiddlewareHandler): MiddlewareHandler {
  return async (context, next) => {
    const response = await handler(context, next)
    if (!response) throw new Error("GraphQL handler did not return a response")
    return context.newResponse(response.body, response)
  }
}

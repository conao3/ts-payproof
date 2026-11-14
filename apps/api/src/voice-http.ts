import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { bodyLimit } from "hono/body-limit"
import * as z from "zod"
import { readSession } from "./auth.ts"
import type { Config } from "./config.ts"
import { voiceStatus } from "./elevenlabs.ts"
import { answerVoiceQuestion, type VoiceStore } from "./voice.ts"

export function createVoiceRoutes(
  store: VoiceStore,
  config: Config,
  fetcher: typeof fetch = fetch,
) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    const origin = c.req.header("origin")
    if (origin && origin !== new URL(config.APP_ORIGIN).origin)
      return c.json({ error: "Origin not allowed" }, 403)
    const actor = readSession(getCookie(c, "payproof_session"), config.SESSION_SIGNING_KEY)
    if (!actor) return c.json({ error: "Sign in to ask about this invoice" }, 401)
    try {
      await store.principal(actor)
    } catch {
      return c.json({ error: "This identity is disabled or unavailable" }, 403)
    }
    return await next()
  })
  app.get("/status", (c) => c.json(voiceStatus(config)))
  app.post("/query", bodyLimit({ maxSize: 2_100_000 }), async (c) => {
    const actor = readSession(getCookie(c, "payproof_session"), config.SESSION_SIGNING_KEY)!
    try {
      let invoiceId: string
      let input: { question?: string; audio?: File }
      if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
        const body = await c.req.formData()
        invoiceId = z.uuid().parse(body.get("invoiceId"))
        const audio = body.get("audio")
        if (
          !(audio instanceof File) ||
          audio.size === 0 ||
          audio.size > 2_000_000 ||
          !/^(audio\/(webm|ogg|mp4|mpeg|wav)|video\/webm)(;|$)/.test(audio.type)
        )
          return c.json({ error: "Upload an audio recording under 2 MB" }, 400)
        input = { audio }
      } else {
        const body = z
          .object({ invoiceId: z.uuid(), question: z.string().trim().min(2).max(1000) })
          .strict()
          .parse(await c.req.json())
        invoiceId = body.invoiceId
        input = { question: body.question }
      }
      return c.json(await answerVoiceQuestion(store, config, actor, invoiceId, input, fetcher))
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json(
          { error: "The voice request or provider response was invalid. Try again" },
          400,
        )
      const message = error instanceof Error ? error.message : "Voice questions are unavailable"
      return c.json(
        { error: message },
        message.includes("not found") || message.includes("identity") ? 403 : 503,
      )
    }
  })
  return app
}

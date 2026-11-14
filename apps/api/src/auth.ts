import { createHmac, timingSafeEqual } from "node:crypto"
import * as z from "zod"
import type { Actor } from "../../../packages/core/src/model.ts"

const sessionSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  role: z.enum(["operator", "approver"]),
  exp: z.number(),
})
export function equalSecret(a: string, b: string): boolean {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}
export function signSession(actor: Actor, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ ...actor, exp: Date.now() + 8 * 60 * 60 * 1000 }),
  ).toString("base64url")
  return payload + "." + createHmac("sha256", secret).update(payload).digest("base64url")
}
export function readSession(token: string | undefined, secret: string): Actor | null {
  if (!token) return null
  const [payload, signature, extra] = token.split(".")
  if (!payload || !signature || extra) return null
  if (!equalSecret(signature, createHmac("sha256", secret).update(payload).digest("base64url")))
    return null
  try {
    const value = sessionSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()))
    return value.exp > Date.now() ? { id: value.id, tenant: value.tenant, role: value.role } : null
  } catch {
    return null
  }
}

import { expect, it } from "vite-plus/test"
import { readSession, signSession } from "../src/auth.ts"
const secret = "unit-test-only-secret-do-not-use-in-production"
it("rejects a forged approver role and a token signed with another key", () => {
  const operator = { id: "maple-ridge-operator", tenant: "maple-ridge", role: "operator" as const }
  const token = signSession(operator, secret)
  expect(readSession(token, secret)).toEqual(operator)
  const [payload, signature] = token.split(".")
  const forged = JSON.parse(Buffer.from(payload!, "base64url").toString())
  forged.role = "approver"
  expect(
    readSession(
      Buffer.from(JSON.stringify(forged)).toString("base64url") + "." + signature,
      secret,
    ),
  ).toBeNull()
  expect(readSession(token, "another-secret")).toBeNull()
  expect(readSession(undefined, secret)).toBeNull()
})

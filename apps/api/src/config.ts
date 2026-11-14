import * as z from "zod"

const configSchema = z.object({
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  MOCK_PAYMENT_API_URL: z.url(),
  PAYMENT_API_KEY: z.string().min(32),
  SESSION_SIGNING_KEY: z.string().min(32),
  OPERATOR_ACCESS_KEY: z.string().min(16),
  APPROVER_ACCESS_KEY: z.string().min(16),
  APP_ORIGIN: z.url(),
})
export type Config = z.infer<typeof configSchema>
export function readConfig(): Config {
  const config = configSchema.parse(process.env)
  if (config.OPERATOR_ACCESS_KEY === config.APPROVER_ACCESS_KEY)
    throw new Error("Operator and approver access keys must differ")
  return config
}

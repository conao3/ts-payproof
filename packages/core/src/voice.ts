import * as z from "zod"

export const voiceEvidenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  revision: z.number().int(),
  at: z.string().nullable(),
})
export type VoiceEvidence = z.infer<typeof voiceEvidenceSchema>

export const voiceStatusSchema = z.object({
  transcription: z.boolean(),
  speech: z.boolean(),
  message: z.string().nullable(),
})
export type VoiceStatus = z.infer<typeof voiceStatusSchema>

export const voiceAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
  invoiceId: z.string(),
  revision: z.number().int(),
  observedAt: z.string(),
  evidence: z.array(voiceEvidenceSchema),
  audioBase64: z.string().nullable(),
  speechError: z.string().nullable(),
})
export type VoiceAnswer = z.infer<typeof voiceAnswerSchema>

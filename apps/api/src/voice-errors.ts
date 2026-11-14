export class VoiceResponseError extends Error {
  readonly stage: "transcription" | "explanation"
  readonly code: string
  readonly status: 422 | 502
  readonly issues: { code: string; path: PropertyKey[] }[]

  constructor(
    stage: "transcription" | "explanation",
    code: string,
    message: string,
    status: 422 | 502 = 502,
    issues: { code: string; path: PropertyKey[] }[] = [],
  ) {
    super(message)
    this.stage = stage
    this.code = code
    this.status = status
    this.issues = issues
  }
}

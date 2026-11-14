import * as z from "zod"
import type { Config } from "./config.ts"
import type { VoiceStatus } from "../../../packages/core/src/voice.ts"

export function voiceStatus(config: Config): VoiceStatus {
  const transcription = Boolean(config.ELEVENLABS_API_KEY)
  const speech = transcription && Boolean(config.ELEVENLABS_VOICE_ID)
  return {
    transcription,
    speech,
    message: !transcription
      ? "ElevenLabs voice is not configured. You can still type a question."
      : !speech
        ? "Speech playback needs an ElevenLabs voice ID. Questions still return text and evidence."
        : null,
  }
}

export function createElevenLabs(config: Config, fetcher: typeof fetch = fetch) {
  async function transcribe(audio: File): Promise<string> {
    if (!config.ELEVENLABS_API_KEY) throw new Error("ElevenLabs transcription is not configured")
    const form = new FormData()
    form.set("model_id", config.ELEVENLABS_STT_MODEL ?? "scribe_v2")
    form.set("file", audio)
    form.set("tag_audio_events", "false")
    const response = await fetcher("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": config.ELEVENLABS_API_KEY },
      body: form,
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) throw new Error(`ElevenLabs transcription failed (HTTP ${response.status})`)
    return z.object({ text: z.string().trim().min(2).max(1000) }).parse(await response.json()).text
  }

  async function speak(text: string): Promise<string> {
    if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_VOICE_ID)
      throw new Error("ElevenLabs speech playback is not configured")
    const response = await fetcher(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.ELEVENLABS_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: config.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2",
        }),
        signal: AbortSignal.timeout(45_000),
      },
    )
    if (!response.ok) throw new Error(`ElevenLabs speech playback failed (HTTP ${response.status})`)
    if (!(response.headers.get("content-type") ?? "").startsWith("audio/"))
      throw new Error("ElevenLabs did not return audio")
    const audio = await response.arrayBuffer()
    if (audio.byteLength > 2_000_000 || audio.byteLength === 0)
      throw new Error("ElevenLabs audio response has an invalid size")
    return Buffer.from(audio).toString("base64")
  }

  return { transcribe, speak }
}

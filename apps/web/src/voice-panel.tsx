import { useEffect, useRef, useState } from "react"
import { Button, Label, TextField, Input } from "react-aria-components"
import { Mic, Square, Volume2 } from "lucide-react"
import type { VoiceAnswer, VoiceStatus } from "../../../packages/core/src/voice.ts"
import { voiceAnswerSchema, voiceStatusSchema } from "../../../packages/core/src/voice.ts"
import * as z from "zod"

export function VoicePanel({ invoiceId }: { invoiceId: string }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState<VoiceAnswer | null>(null)
  const [error, setError] = useState("")
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const answerAudio = useRef<HTMLAudioElement | null>(null)
  const request = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void fetch("/api/voice/status", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Voice status is unavailable. Sign in again if needed")
        const value = voiceStatusSchema.parse(await response.json())
        if (mounted.current) setStatus(value)
      })
      .catch((reason: unknown) => {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : "Voice is unavailable")
      })
    return () => {
      mounted.current = false
      request.current?.abort()
      answerAudio.current?.pause()
      if (timer.current) clearTimeout(timer.current)
      if (recorder.current?.state === "recording") recorder.current.stop()
      stream.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    const player = answerAudio.current
    if (!player || !answer?.audioBase64) return undefined
    let active = true
    void player.play().then(
      () => {
        if (!active) player.pause()
        else setPlaybackBlocked(false)
      },
      () => {
        if (active) setPlaybackBlocked(true)
      },
    )
    return () => {
      active = false
      player.pause()
    }
  }, [answer])

  function clearAnswer() {
    answerAudio.current?.pause()
    setPlaybackBlocked(false)
    setAnswer(null)
  }

  async function playAnswer() {
    try {
      await answerAudio.current?.play()
      if (mounted.current) setPlaybackBlocked(false)
    } catch {
      if (mounted.current) setPlaybackBlocked(true)
    }
  }

  async function ask(audio?: File) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const sequence = ++requestSequence.current
    setBusy(true)
    setError("")
    clearAnswer()
    try {
      const form = new FormData()
      if (audio) {
        form.set("invoiceId", invoiceId)
        form.set("audio", audio)
      }
      const response = await fetch("/api/voice/query", {
        method: "POST",
        credentials: "same-origin",
        headers: audio ? {} : { "content-type": "application/json" },
        body: audio ? form : JSON.stringify({ invoiceId, question }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(150_000)]),
      })
      const body: unknown = await response.json()
      if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(body).error)
      const value = voiceAnswerSchema.parse(body)
      if (mounted.current && sequence === requestSequence.current) {
        setQuestion(value.question)
        setAnswer(value)
      }
    } catch (reason) {
      if (mounted.current && sequence === requestSequence.current && !controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "Could not answer this question")
    } finally {
      if (mounted.current && sequence === requestSequence.current) setBusy(false)
    }
  }

  function stopRecording() {
    if (timer.current) clearTimeout(timer.current)
    if (recorder.current?.state === "recording") recorder.current.stop()
    stream.current?.getTracks().forEach((track) => track.stop())
    setRecording(false)
  }

  async function startRecording() {
    if (startingRef.current || recorder.current?.state === "recording") return
    startingRef.current = true
    setStarting(true)
    clearAnswer()
    setError("")
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setError(
          "Recording requires a supported browser on HTTPS or localhost. You can type instead",
        )
        return
      }
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) {
        stream.current.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      )
      const current = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined)
      recorder.current = current
      const chunks: Blob[] = []
      current.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      current.onstop = () => {
        stream.current?.getTracks().forEach((track) => track.stop())
        if (!mounted.current) return
        setRecording(false)
        const type = current.mimeType || "audio/webm"
        void ask(
          new File(chunks, type.includes("mp4") ? "question.mp4" : "question.webm", { type }),
        )
      }
      current.start()
      setRecording(true)
      timer.current = setTimeout(stopRecording, 20_000)
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop())
      setError("Microphone access was not available. You can type your question instead")
    } finally {
      startingRef.current = false
      if (mounted.current) setStarting(false)
    }
  }

  return (
    <section className="voice-panel" aria-label="Ask about this invoice">
      <div className="section-title">
        <h2>
          <Volume2 size={18} /> Ask about this invoice
        </h2>
        <span className="voice-read-only">Read only</span>
      </div>
      <p className="instruction">
        Ask why it is held, who approved it, or what happened after an amendment.
      </p>
      <div className="voice-question">
        <TextField
          value={question}
          onChange={setQuestion}
          isDisabled={busy || recording || starting}
        >
          <Label>Your question</Label>
          <Input placeholder="Why is this payment held?" maxLength={1000} />
        </TextField>
        <Button
          className="secondary"
          isDisabled={busy || starting || !status?.transcription}
          onPress={() => (recording ? stopRecording() : void startRecording())}
        >
          {recording ? <Square size={15} /> : <Mic size={16} />}
          {starting ? "Opening microphone…" : recording ? "Stop and ask" : "Record question"}
        </Button>
        <Button
          className="primary"
          isDisabled={busy || recording || starting || question.trim().length < 2}
          onPress={() => void ask()}
        >
          Ask
        </Button>
      </div>
      <p className="voice-boundary">
        Voice explains evidence. Verification, approval and payment stay in the existing controls.
        Recording stops after 20 seconds.
      </p>
      {status?.message && <p className="voice-notice">{status.message}</p>}
      {recording && (
        <p role="status" className="voice-notice">
          Recording your question…
        </p>
      )}
      {busy && (
        <p role="status" className="voice-notice">
          Reading the current invoice and its Atlas evidence…
        </p>
      )}
      {error && (
        <p role="alert" className="voice-error">
          {error}
        </p>
      )}
      {answer && (
        <div className="voice-answer" aria-live="polite">
          <p className="voice-answer-text">{answer.answer}</p>
          {answer.audioBase64 && (
            <audio
              ref={answerAudio}
              onPlay={() => setPlaybackBlocked(false)}
              controls
              aria-label="Spoken audit answer"
              src={`data:audio/mpeg;base64,${answer.audioBase64}`}
            />
          )}
          {playbackBlocked && (
            <div className="voice-notice">
              <p>Automatic playback was blocked. Play the answer below.</p>
              <Button className="secondary" onPress={() => void playAnswer()}>
                <Volume2 size={16} /> Play answer
              </Button>
            </div>
          )}
          {answer.speechError && <p className="voice-notice">{answer.speechError}</p>}
          <div className="voice-evidence-heading">
            Supporting Atlas records{" "}
            <span>
              revision {answer.revision} · {new Date(answer.observedAt).toLocaleTimeString()}
            </span>
          </div>
          <ul className="voice-evidence">
            {answer.evidence.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
                <span>
                  revision {item.revision}
                  {item.at ? ` · ${new Date(item.at).toLocaleString()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

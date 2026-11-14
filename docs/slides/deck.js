const W = 1920,
  H = 1080,
  HOLD = 4
const slides = [
  {
    title: "Fake payment details. Real business risk.",
    kind: "problem",
    duration: 8,
    lines: ["A supplier email", "New payment details", "Where will the money go?"],
  },
  {
    title: "The agent stops the bank change.",
    video: "hold.mp4",
    lines: ["Saved account", "0042", "Requested account", "7719"],
    note: "The email cannot approve its own request.",
  },
  {
    title: "A person checks the saved contact.",
    video: "review.mp4",
    lines: ["Saved supplier contact", "Alex Chen", "Check the change", "Approve this payment"],
    note: "The person has a separate account.",
  },
  {
    title: "A change cancels the old approval.",
    video: "change.mp4",
    lines: ["4,800 → 4,900", "Previous approval", "Payment revision changed"],
    note: "The server checks before any payment.",
  },
  {
    title: "A new approval allows the action.",
    video: "payment.mp4",
    lines: ["CAD 4,800", "New approval", "One simulated payment"],
    note: "The receipt must match the approved details.",
  },
  {
    title: "Atlas keeps the proof of each action.",
    kind: "features",
    duration: 8,
    lines: ["Hold bank changes", "Approve the exact payment", "Keep the full decision trail"],
  },
]
const canvas = document.querySelector("#screen"),
  video = document.querySelector("#video")
const source = document.createElement("canvas")
source.width = W
source.height = H
const ctx = source.getContext("2d")
const diag = (window.pitchDiagnostics = {
  renderer: "initializing",
  slide: 0,
  phase: "active",
  loops: 0,
  restarts: 0,
  gpuFrames: 0,
  errors: [],
  holdSeconds: HOLD,
  videoTime: 0,
})
let loadController
let index = 0,
  start = performance.now(),
  holdAt = null,
  loading = false,
  token = 0,
  renderer,
  prevFrame = 0
function issue(e) {
  diag.errors.push(String(e))
  console.warn("Pitch:", e)
}
async function initRenderer() {
  if (!new URLSearchParams(location.search).has("canvas") && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) throw Error("No WebGPU adapter")
      const device = await adapter.requestDevice()
      const context = canvas.getContext("webgpu")
      if (!context) throw Error("No WebGPU canvas")
      const format = navigator.gpu.getPreferredCanvasFormat()
      context.configure({ device, format, alphaMode: "opaque" })
      const shader = device.createShaderModule({
        code: `@group(0) @binding(0) var image:texture_2d<f32>; @vertex fn vs(@builtin(vertex_index) n:u32)->@builtin(position) vec4f { var p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));return vec4f(p[n],0.,1.); } @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {return textureLoad(image,vec2i(p.xy),0);}`,
      })
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      })
      const texture = device.createTexture({
        size: [W, H],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }],
      })
      device.addEventListener("uncapturederror", (e) => {
        issue(e.error)
        fallback()
      })
      void device.lost.then((info) => {
        issue("WebGPU device lost: " + info.message)
        fallback()
      })
      diag.renderer = "webgpu"
      diag.adapter = adapter.info?.description || adapter.info?.device || "available"
      renderer = () => {
        device.queue.copyExternalImageToTexture({ source }, { texture }, [W, H])
        const enc = device.createCommandEncoder()
        const pass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.draw(3)
        pass.end()
        device.queue.submit([enc.finish()])
        diag.gpuFrames++
      }
      return
    } catch (e) {
      issue(e)
    }
  }
  fallback()
}
function fallback() {
  if (diag.renderer === "canvas2d") return
  let c = canvas
  if (canvas.getContext("2d") === null) {
    c = document.createElement("canvas")
    c.width = W
    c.height = H
    c.id = "fallback"
    c.setAttribute("aria-label", "PayProof presentation")
    canvas.replaceWith(c)
  }
  const out = c.getContext("2d")
  diag.renderer = "canvas2d"
  renderer = () => out.drawImage(source, 0, 0)
}
function text(s, x, y, size = 42, color = "#193e35", weight = 400) {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px Arial,sans-serif`
  ctx.fillText(s, x, y)
}
function wrap(s, x, y, max, size = 40, color = "#193e35", weight = 400) {
  const words = s.split(" ")
  let currentLine = ""
  ctx.font = `${weight} ${size}px Arial,sans-serif`
  for (const word of words) {
    const next = currentLine ? currentLine + " " + word : word
    if (ctx.measureText(next).width > max && currentLine) {
      text(currentLine, x, y, size, color, weight)
      y += size * 1.3
      currentLine = word
    } else currentLine = next
  }
  text(currentLine, x, y, size, color, weight)
  return y + size * 1.3
}
function line(x1, y1, x2, y2, color = "#799489", width = 4) {
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}
function arrow(x, y, width) {
  line(x, y, x + width, y)
  line(x + width - 16, y - 12, x + width, y)
  line(x + width - 16, y + 12, x + width, y)
}
async function select(n, restart = false) {
  const next = Math.max(0, Math.min(slides.length - 1, n))
  if (next === index && !restart && diag.ready) return
  loadController?.abort()
  loadController = new AbortController()
  const t = ++token
  index = next
  diag.slide = index
  holdAt = null
  diag.phase = "active"
  start = performance.now()
  video.pause()
  video.removeAttribute("src")
  video.load()
  loading = false
  document.querySelector("#title").textContent = slides[index].title
  document.querySelector("#source").hidden = index !== 0
  location.hash = String(index + 1)
  if (restart) diag.restarts++
  const slide = slides[index]
  if (slide.video) {
    loading = true
    video.src = "media/" + slide.video
    video.muted = true
    video.addEventListener(
      "loadeddata",
      async () => {
        if (t !== token) return
        try {
          video.currentTime = 0
          await video.play()
          if (t === token) {
            loading = false
            start = performance.now()
          }
        } catch (e) {
          if (t === token) {
            loading = false
            issue("Video playback: " + e)
          }
        }
      },
      { once: true, signal: loadController.signal },
    )
    video.addEventListener(
      "error",
      () => {
        if (t === token) {
          loading = false
          issue("Video failed: " + slide.video)
        }
      },
      { once: true, signal: loadController.signal },
    )
  }
  diag.ready = true
}
window.addEventListener("keydown", (e) => {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown"].includes(e.key)) return
  e.preventDefault()
  if (e.repeat) return
  if (e.key === "ArrowRight") void select(index + 1)
  else if (e.key === "ArrowLeft") void select(index - 1)
  else void select(index, true)
})
window.addEventListener("pointerdown", () => {
  if (slides[index].video && video.paused && !holdAt) video.play().catch(issue)
})
function draw(now) {
  const slide = slides[index]
  const duration = slide.video
    ? Number.isFinite(video.duration)
      ? video.duration
      : 10
    : slide.duration
  let active = slide.video ? video.currentTime : (now - start) / 1000
  if (!loading && active >= duration - 0.05 && holdAt === null) {
    holdAt = now
    video.pause()
    diag.phase = "hold"
  }
  const hold = holdAt === null ? 0 : (now - holdAt) / 1000
  if (hold >= HOLD) {
    diag.loops++
    void select(index, true)
  }
  const elapsed = holdAt === null ? active : duration + hold
  diag.phase = loading ? "loading" : holdAt === null ? "active" : "hold"
  diag.videoTime = video.currentTime
  diag.elapsed = elapsed
  diag.duration = duration
  diag.remaining = Math.max(0, duration + HOLD - elapsed)
  ctx.fillStyle = "#f5f8f5"
  ctx.fillRect(0, 0, W, H)
  text(slide.title, 64, 120, 65, "#193e35", 700)
  if (slide.kind === "problem") {
    text("About CAD 3.5M", 80, 295, 100, "#193e35", 700)
    text("recovered in one Quebec payment-redirection case", 80, 372, 44)
    text("Construction firms are among the common targets.", 80, 450, 36, "#587269")
    const boxes = [
      { x: 80, t: "Fake email", sub: "New payment details" },
      { x: 710, t: "New account", sub: "Requested destination changed" },
      { x: 1340, t: "Payment at risk", sub: "Check before sending" },
    ]
    boxes.forEach((b, i) => {
      ctx.fillStyle = i === 1 ? "#f1dfc3" : "#dbe8e0"
      ctx.fillRect(b.x, 550, 500, 200)
      text(b.t, b.x + 30, 615, 42, "#193e35", 700)
      wrap(b.sub, b.x + 30, 688, 430, 33)
      if (i < 2) arrow(b.x + 520, 650, 90)
    })
    const p = Math.min(1, active / 6)
    ctx.fillStyle = "#b77724"
    ctx.beginPath()
    ctx.arc(130 + 1530 * p, 800, 12, 0, Math.PI * 2)
    ctx.fill()
    text("CAFC advice: check bank changes through a trusted contact.", 80, 925, 39)
    text("PayProof puts that check before the payment.", 80, 995, 35, "#587269")
  } else if (slide.kind === "features") {
    text("Agents You Can Audit", 80, 205, 34, "#587269")
    const layers = [
      { x: 80, title: "Who can act?", line1: "Saved identities", line2: "Human + agent roles" },
      {
        x: 710,
        title: "What is allowed?",
        line1: "Policy + exact approval",
        line2: "Invoice amount + account",
      },
      {
        x: 1340,
        title: "What happened?",
        line1: "State + audit trail",
        line2: "Actor, reason + receipt",
      },
    ]
    layers.forEach((b, i) => {
      ctx.fillStyle = "#dbe8e0"
      ctx.fillRect(b.x, 290, 500, 300)
      text(b.title, b.x + 28, 355, 41, "#193e35", 700)
      wrap(b.line1, b.x + 28, 447, 440, 37)
      wrap(b.line2, b.x + 28, 525, 440, 30, "#587269")
      if (i < 2) arrow(b.x + 520, 440, 90)
    })
    ctx.fillStyle = "#193e35"
    ctx.fillRect(80, 680, 1760, 110)
    text(
      "Before dispatch: live permissions + the exact approved details",
      115,
      750,
      43,
      "#f5f8f5",
      600,
    )
    text("1 simulated ledger entry", 80, 890, 38, "#193e35", 700)
    text("13 recorded actions", 1070, 890, 38)
    disclosure()
  } else {
    ctx.fillStyle = "#fff"
    ctx.fillRect(64, 224, 1270, 714)
    if (video.readyState >= 2) ctx.drawImage(video, 64, 224, 1270, 714)
    else text("Preparing the demo…", 130, 570, 38)
    line(1370, 224, 1370, 938)
    const x = 1425
    if (index === 1) {
      text(slide.lines[0], x, 335, 30, "#587269")
      text(slide.lines[1], x, 415, 68, "#193e35", 700)
      text(slide.lines[2], x, 545, 30, "#587269")
      text(slide.lines[3], x, 625, 68, "#a66b20", 700)
    }
    if (index === 2) {
      text("Saved contact", x, 325, 32, "#587269")
      text("Alex Chen", x, 400, 46, "#193e35", 700)
      text("↓", x + 150, 510, 48, "#799489")
      wrap("Human check", x, 610, 400, 42)
      wrap("Exact payment approval", x, 735, 400, 42, "#193e35", 700)
    }
    if (index === 3) {
      text("4,800 → 4,900", x, 375, 46, "#193e35", 700)
      text("Previous approval", x, 505, 33, "#587269")
      line(x, 493, x + 295, 493, "#587269", 3)
      line(x, 570, 1835, 570, "#bc893e", 3)
      wrap("“Payment revision changed”", x, 650, 400, 37, "#a66b20")
    }
    if (index === 4) {
      text("CAD 4,800", x, 345, 50, "#193e35", 700)
      text("New approval", x, 490, 38)
      text("↓", x + 150, 590, 48, "#799489")
      wrap("One simulated payment", x, 700, 400, 42, "#193e35", 700)
    }
    text(slide.note, 64, 1018, 31, "#587269")
  }
  ctx.fillStyle = "#799489"
  ctx.fillRect(0, 0, W, 6)
  ctx.fillStyle = "#b6d19b"
  ctx.fillRect(0, 0, W * Math.max(0, 1 - elapsed / (duration + HOLD)), 6)
  try {
    renderer?.()
  } catch (e) {
    issue(e)
    fallback()
    renderer?.()
  }
}
function disclosure() {
  text("Real LLM + Atlas", 80, 980, 28, "#587269")
  text(
    "Synthetic business data and verification · Simulated payments · Recorded demo, waits omitted",
    80,
    1035,
    27,
    "#587269",
  )
}
window.payproofDeck = {
  select: (n) => select(n),
  restart: () => select(index, true),
  slides: slides.map((s) => s.title),
  diagnostics: diag,
  render: () => draw(performance.now()),
}
await initRenderer()
await select(Math.max(0, Math.min(5, Number(location.hash.slice(1) || 1) - 1)), true)
function frame(now) {
  if (now - prevFrame > 30) {
    draw(now)
    prevFrame = now
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

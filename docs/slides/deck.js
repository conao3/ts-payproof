const W = 1920,
  H = 1080,
  HOLD = 4
const slides = [
  {
    topic: "The business risk",
    title: "Fake bank changes put real business payments at risk.",
    support: "CAFC recommends checking bank changes through a trusted contact.",
    kind: "problem",
    duration: 8,
  },
  {
    topic: "Stop before payment",
    title: "PayProof holds new bank details until a person checks them.",
    support: "An email can request a new account. It cannot change saved details.",
    video: "hold.mp4",
  },
  {
    topic: "Independent human approval",
    title: "Only a separate person can approve the exact payment.",
    support: "A saved contact checks the change; a separate approver decides.",
    video: "review.mp4",
  },
  {
    topic: "Approval follows the details",
    title: "Changing the payment removes the old approval.",
    support: "The server rejects the old approval before any payment can run.",
    video: "change.mp4",
  },
  {
    topic: "Execute the approved action",
    title: "The agent records only the payment a person approved.",
    support: "Fresh approval, one ledger entry, and a receipt that matches.",
    video: "payment.mp4",
  },
  {
    topic: "Agents You Can Audit",
    title: "Atlas links permission to each action and its result.",
    support: "Saved identities, exact approval, and an audit trail stay connected.",
    kind: "features",
    duration: 8,
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
  text(slide.topic, 64, 68, 30, "#587269")
  wrap(slide.title, 64, 156, 1792, 64, "#193e35", 700)
  text(slide.support, 64, 333, 40, "#193e35")
  if (slide.kind === "problem") {
    text("About CAD 3.5M", 64, 500, 94, "#193e35", 700)
    wrap("recovered in a payment-redirection case at one Quebec business.", 64, 578, 900, 40)
    wrap("CAFC also lists construction firms as common targets.", 64, 740, 900, 40)
    text("The case's industry was not stated.", 64, 922, 38, "#587269")
    const flow = [
      { y: 410, title: "Fake email", detail: "A criminal acts as a known contact." },
      { y: 590, title: "New bank details", detail: "The email asks for another account." },
      { y: 770, title: "Business payment", detail: "Check the change before sending." },
    ]
    flow.forEach((item, i) => {
      ctx.fillStyle = i === 1 ? "#f1dfc3" : "#dbe8e0"
      ctx.fillRect(1060, item.y, 796, 140)
      text(item.title, 1090, item.y + 51, 42, "#193e35", 700)
      text(item.detail, 1090, item.y + 109, 38)
      if (i < 2) text("↓", 1420, item.y + 177, 42, "#799489")
    })
    text("Source: Canadian Anti-Fraud Centre, May 13, 2026", 64, 1035, 28, "#587269")
  } else if (slide.kind === "features") {
    const layers = [
      { x: 64, title: "Who can act?", a: "Saved identities", b: "Human and agent roles" },
      {
        x: 700,
        title: "What is allowed?",
        a: "Policy + exact approval",
        b: "Amount, account, revision",
      },
      { x: 1336, title: "What happened?", a: "State + audit events", b: "Actor, reason, receipt" },
    ]
    layers.forEach((layer, i) => {
      ctx.fillStyle = "#dbe8e0"
      ctx.fillRect(layer.x, 430, 520, 340)
      text(layer.title, layer.x + 28, 495, 40, "#193e35", 700)
      text(layer.a, layer.x + 28, 590, 38)
      text(layer.b, layer.x + 28, 675, 38)
      if (i === 2) text("13 actions · 1 mock entry", layer.x + 28, 744, 38)
      if (i < 2) arrow(layer.x + 536, 600, 78)
    })
    ctx.fillStyle = "#193e35"
    ctx.fillRect(64, 815, 1792, 80)
    text(
      "Before action, the server checks live authority and the approved details.",
      94,
      870,
      40,
      "#f5f8f5",
      600,
    )
    text("Permission before action. Evidence after action.", 64, 965, 40, "#193e35", 700)
    disclosure()
  } else {
    ctx.fillStyle = "#fff"
    ctx.fillRect(64, 410, 960, 540)
    if (video.readyState >= 2) ctx.drawImage(video, 64, 410, 960, 540)
    else text("Preparing the demo…", 130, 650, 38)
    line(1052, 410, 1052, 965)
    const x = 1090
    if (index === 1) {
      text("Saved supplier account", x, 460, 40)
      text("0042", x, 548, 72, "#193e35", 700)
      text("Requested by the email", x, 650, 40)
      text("7719", x, 738, 72, "#a66b20", 700)
      line(x, 790, 1856, 790)
      text("Payment is on hold.", x, 856, 44, "#193e35", 700)
      text("A separate person must check the account.", x, 930, 38)
    }
    if (index === 2) {
      text("Saved supplier contact: Alex Chen", x, 470, 40)
      text("Independent check of the change", x, 572, 40)
      text("↓", x + 340, 652, 42, "#799489")
      text("Separate approver account", x, 730, 42, "#193e35", 700)
      text("CAD 4,800 → account ending 7719", x, 812, 40)
      text("The demo check is a role-play.", x, 930, 38, "#a66b20")
    }
    if (index === 3) {
      text("CAD 4,800 → 4,900", x, 498, 60, "#193e35", 700)
      text("Previous approval", x, 612, 42, "#587269")
      line(x, 598, x + 343, 598, "#587269", 3)
      text("Approval removed", x, 720, 44, "#193e35", 700)
      text("“Payment revision changed”", x, 820, 40, "#a66b20")
      text("New details need new approval.", x, 930, 38)
    }
    if (index === 4) {
      text("New approval: CAD 4,800", x, 470, 44, "#193e35", 700)
      text("Destination: account ending 7719", x, 550, 40)
      text("↓", x + 340, 630, 42, "#799489")
      text("One simulated ledger entry", x, 710, 44, "#193e35", 700)
      text("Receipt matches this payment.", x, 812, 40)
      text("A separate HTTP service records it.", x, 930, 38)
    }
    disclosure()
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
  text(
    "Real LLM + Atlas · Synthetic data and human check · Simulated payment · Recorded demo",
    64,
    1035,
    28,
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

const W = 1920,
  H = 1080,
  HOLD = 4
const slides = [
  {
    title: "Fake bank changes put real business payments at risk.",
    support: "CAFC recommends checking bank changes through a trusted contact.",
    kind: "problem",
    duration: 8,
  },
  {
    title: "PayProof holds new bank details until a person checks them.",
    support: "An email can request a new account. It cannot change saved details.",
    video: "hold.mp4",
  },
  {
    title: "Only a separate person can approve the exact payment.",
    support: "A saved contact checks the change; a separate approver decides.",
    video: "review.mp4",
  },
  {
    title: "Changing the payment removes the old approval.",
    support: "",
    video: "change.mp4",
  },
  {
    title: "The agent records only the payment a person approved.",
    support: "Fresh approval, one ledger entry, and a receipt that matches.",
    video: "payment.mp4",
  },
  {
    title: "Atlas links permission to each action and its result.",
    support: "The server checks live permissions and approved details before each action.",
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
function paragraph(value, x, top, width, size = 40, color = "#193e35", weight = 400) {
  ctx.font = `${weight} ${size}px Arial,sans-serif`
  const metrics = ctx.measureText("Mg")
  const ascent = metrics.actualBoundingBoxAscent
  const descent = metrics.actualBoundingBoxDescent
  const rows = []
  let row = ""
  for (const word of value.split(" ")) {
    const next = row ? row + " " + word : word
    if (ctx.measureText(next).width > width && row) {
      rows.push(row)
      row = word
    } else row = next
  }
  if (row) rows.push(row)
  rows.forEach((content, i) =>
    text(content, x, top + ascent + i * size * 1.18, size, color, weight),
  )
  return top + ascent + Math.max(0, rows.length - 1) * size * 1.18 + descent
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
  const titleEnd = paragraph(slide.title, 64, 48, 1792, 64, "#193e35", 700)
  const supportEnd = slide.support
    ? paragraph(slide.support, 64, titleEnd + 28, 1792, 40)
    : titleEnd
  const bodyTop = supportEnd + 34
  if (slide.kind === "problem") {
    let y = paragraph("About CAD 3.5M", 64, bodyTop + 12, 900, 94, "#193e35", 700)
    y = paragraph(
      "recovered in a payment-redirection case at one Quebec business.",
      64,
      y + 26,
      890,
      40,
    )
    y = paragraph("CAFC also lists construction firms as common targets.", 64, y + 52, 890, 40)
    const flow = [
      { title: "Fake email", detail: "A criminal acts as a known contact." },
      { title: "New bank details", detail: "The email asks for another account." },
      { title: "Business payment", detail: "Check the change before sending." },
    ]
    flow.forEach((item, i) => {
      const top = bodyTop + 12 + i * 208
      ctx.fillStyle = i === 1 ? "#f1dfc3" : "#dbe8e0"
      ctx.fillRect(1040, top, 816, 160)
      const end = paragraph(item.title, 1070, top + 24, 756, 44, "#193e35", 700)
      paragraph(item.detail, 1070, end + 18, 756, 38)
      if (i < 2) text("↓", 1420, top + 198, 42, "#799489")
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
      ctx.fillRect(layer.x, bodyTop, 520, 380)
      let end = paragraph(layer.title, layer.x + 28, bodyTop + 32, 464, 44, "#193e35", 700)
      end = paragraph(layer.a, layer.x + 28, end + 46, 464, 40)
      paragraph(layer.b, layer.x + 28, end + 34, 464, 38)
      if (i < 2) arrow(layer.x + 536, bodyTop + 190, 78)
    })
    const evidenceEnd = paragraph(
      "13 recorded actions → 1 simulated ledger entry.",
      64,
      bodyTop + 432,
      1792,
      44,
      "#193e35",
      700,
    )
    paragraph(
      "Synthetic supplier check. Simulated payment.",
      64,
      evidenceEnd + 54,
      1792,
      38,
      "#587269",
    )
  } else {
    const videoTop = bodyTop
    ctx.fillStyle = "#fff"
    ctx.fillRect(64, videoTop, 1280, 720)
    if (video.readyState >= 2) ctx.drawImage(video, 64, videoTop, 1280, 720)
    else text("Preparing the demo…", 130, videoTop + 320, 38)
    const x = 1392,
      width = 464
    let y = videoTop + 18
    if (index === 1) {
      y = paragraph("Saved supplier account", x, y, width, 40)
      y = paragraph("0042", x, y + 22, width, 72, "#193e35", 700)
      y = paragraph("Requested by the email", x, y + 42, width, 40)
      y = paragraph("7719", x, y + 22, width, 72, "#a66b20", 700)
      y = paragraph("Payment is on hold.", x, y + 44, width, 44, "#193e35", 700)
      paragraph("A separate person must check the account.", x, y + 30, width, 38)
    }
    if (index === 2) {
      y = paragraph("Saved contact: Alex Chen", x, y, width, 40)
      y = paragraph("Independent check of the change", x, y + 34, width, 40)
      text("↓", x + 200, y + 54, 42, "#799489")
      y = paragraph("Separate approver account", x, y + 94, width, 44, "#193e35", 700)
      y = paragraph("CAD 4,800 · account ending 7719", x, y + 32, width, 40)
      paragraph("Approval applies to these exact details.", x, y + 36, width, 38)
    }
    if (index === 3) {
      y = paragraph("CAD 4,800 → 4,900", x, y, width, 60, "#193e35", 700)
      const approvalTop = y + 38
      y = paragraph("Previous approval", x, approvalTop, width, 40, "#587269")
      ctx.font = "400 40px Arial,sans-serif"
      line(
        x,
        approvalTop + 17,
        x + ctx.measureText("Previous approval").width,
        approvalTop + 17,
        "#587269",
        3,
      )
      y = paragraph("“Payment revision changed”", x, y + 52, width, 40, "#a66b20")
      paragraph("New details need new approval.", x, y + 46, width, 38)
    }
    if (index === 4) {
      y = paragraph("New approval: CAD 4,800", x, y, width, 44, "#193e35", 700)
      y = paragraph("Account ending 7719", x, y + 26, width, 40)
      text("↓", x + 200, y + 56, 42, "#799489")
      y = paragraph("One simulated ledger entry", x, y + 96, width, 44, "#193e35", 700)
      y = paragraph("Receipt matches this payment.", x, y + 38, width, 40)
      paragraph("A separate HTTP service records it.", x, y + 34, width, 38)
    }
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

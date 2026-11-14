const W = 1920,
  H = 1080
const slides = [
  { title: "PayProof — Overview", kind: "video" },
  { title: "Demo", kind: "demo" },
  {
    title: "Summary: PayProof checks actions with Atlas evidence.",
    support: "The server applies the rules. Atlas keeps the trusted data and decisions.",
    kind: "features",
  },
]
const canvas = document.querySelector("#screen"),
  video = document.querySelector("#video")
const source = document.createElement("canvas")
source.width = W
source.height = H
const ctx = source.getContext("2d")
const mongoLogo = new Image()
const logoReady = new Promise((resolve) => {
  mongoLogo.addEventListener("load", () => resolve(true), { once: true })
  mongoLogo.addEventListener("error", () => resolve(false), { once: true })
  mongoLogo.src = new URL("assets/mongodb-wordmark.svg", import.meta.url).href
})
const diag = (window.pitchDiagnostics = {
  renderer: "initializing",
  slide: 0,
  phase: "active",
  loops: 0,
  restarts: 0,
  gpuFrames: 0,
  errors: [],
  holdSeconds: 0,
  videoTime: 0,
})
let index = 0,
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

const videoPanel = document.querySelector("#video-panel")
const playButton = document.querySelector("#play")
const videoSource = new URLSearchParams(location.search).get("video") || "media/demo.mp4"
video.src = videoSource
video.muted = false
video.volume = 1
document.addEventListener("visibilitychange", () => {
  if (document.hidden) video.pause()
})
video.addEventListener("error", () => issue("Video could not load: " + videoSource))
async function togglePlayback() {
  if (index !== 0) return
  if (!video.paused) {
    video.pause()
    return
  }
  try {
    await video.play()
  } catch (error) {
    issue("Video playback: " + error)
  }
}
playButton.addEventListener("click", () => {
  void togglePlayback()
})
video.addEventListener("play", () => {
  playButton.hidden = true
  diag.phase = "playing"
})
video.addEventListener("pause", () => {
  playButton.hidden = false
  diag.phase = video.ended ? "ended" : "paused"
})
video.addEventListener("ended", () => {
  playButton.hidden = false
  playButton.textContent = "Replay overview"
  diag.phase = "ended"
})
function select(n, restart = false) {
  const next = Math.max(0, Math.min(slides.length - 1, n))
  if (next === index && !restart && diag.ready) return
  video.pause()
  index = next
  diag.slide = index
  diag.phase = "paused"
  if (index === 0) {
    video.currentTime = 0
    playButton.textContent = "Play overview · sound on"
    playButton.hidden = false
  }
  if (restart) diag.restarts++
  videoPanel.hidden = index !== 0
  document.querySelector("#title").textContent = slides[index].title
  location.hash = String(index + 1)
  diag.ready = true
  draw()
}
window.addEventListener("keydown", (event) => {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", " ", "Spacebar"].includes(event.key)) return
  if (event.target instanceof HTMLVideoElement && event.key === " ") return
  event.preventDefault()
  if (event.repeat) return
  if (event.key === "ArrowRight") select(index + 1)
  else if (event.key === "ArrowLeft") select(index - 1)
  else if (event.key === "ArrowDown") select(index, true)
  else void togglePlayback()
})
function draw() {
  const slide = slides[index]
  ctx.fillStyle = "#f5f8f5"
  ctx.fillRect(0, 0, W, H)
  if (slide.kind === "demo") {
    text("Demo", 120, 400, 150, "#193e35", 700)
    text("Switch to the app", 128, 540, 54)
    text("Ctrl + Tab", 128, 628, 44, "#587269")
  } else if (slide.kind === "features") {
    const titleEnd = paragraph(slide.title, 64, 48, 1792, 64, "#193e35", 700)
    const supportEnd = paragraph(slide.support, 64, titleEnd + 28, 1792, 40)
    const bodyTop = supportEnd + 34
    const top = bodyTop + 12
    const node = (x, y, width, height, title, detail, strong = false) => {
      ctx.fillStyle = strong ? "#d7e8dc" : "#e3ebe6"
      ctx.fillRect(x, y, width, height)
      const end = paragraph(title, x + 28, y + 26, width - 56, strong ? 48 : 44, "#193e35", 700)
      paragraph(detail, x + 28, end + 24, width - 56, 38)
    }
    node(64, top, 520, 280, "Email → LLM", "Extract supplier, amount and requested account.")
    node(
      700,
      top,
      570,
      280,
      "PayProof server",
      "Compare and hold. Check roles, latest revision and approval before action.",
      true,
    )
    node(1420, top, 436, 280, "HTTP payment", "One simulated ledger entry. Return a receipt.")
    arrow(600, top + 140, 84)
    arrow(1286, top + 122, 118)
    line(1404, top + 176, 1286, top + 176)
    line(1302, top + 164, 1286, top + 176)
    line(1302, top + 188, 1286, top + 176)
    const lower = top + 380
    node(
      700,
      lower,
      570,
      214,
      "Separate human",
      "Use a saved supplier contact. Approve the exact payment.",
    )
    line(985, top + 296, 985, lower - 16)
    line(973, top + 312, 985, top + 296)
    line(997, top + 312, 985, top + 296)
    line(973, lower - 32, 985, lower - 16)
    line(997, lower - 32, 985, lower - 16)
    ctx.fillStyle = "#d7e8dc"
    ctx.fillRect(64, lower, 520, 320)
    if (mongoLogo.complete && mongoLogo.naturalWidth)
      ctx.drawImage(mongoLogo, 96, lower + 24, 250, (250 * 278) / 1102)
    else text("MongoDB", 96, lower + 75, 44, "#193e35", 700)
    let storeEnd = paragraph("Atlas data store", 96, lower + 114, 456, 44, "#193e35", 700)
    storeEnd = paragraph("Identities · suppliers", 96, storeEnd + 22, 456, 38)
    paragraph("Approvals · state · audit", 96, storeEnd + 20, 456, 38)
    ctx.strokeStyle = "#799489"
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(684, top + 220)
    ctx.lineTo(640, top + 220)
    ctx.lineTo(640, lower + 160)
    ctx.lineTo(600, lower + 160)
    ctx.stroke()
    line(616, lower + 148, 600, lower + 160)
    line(616, lower + 172, 600, lower + 160)
    line(668, top + 208, 684, top + 220)
    line(668, top + 232, 684, top + 220)
    const resultEnd = paragraph(
      "The server verifies the receipt, then saves state and audit in Atlas.",
      64,
      lower + 352,
      1792,
      40,
    )
    paragraph(
      "Synthetic supplier check. Simulated payment.",
      64,
      resultEnd + 32,
      1792,
      38,
      "#587269",
    )
  }
  diag.videoTime = video.currentTime
  diag.muted = video.muted
  try {
    renderer?.()
  } catch (error) {
    issue(error)
    fallback()
    renderer?.()
  }
}
window.payproofDeck = {
  select,
  restart: () => select(index, true),
  slides: slides.map((slide) => slide.title),
  diagnostics: diag,
  render: draw,
  play: togglePlayback,
}
diag.logoLoaded = await logoReady
await initRenderer()
select(Math.max(0, Math.min(2, Number(location.hash.slice(1) || 1) - 1)), true)
function frame(now) {
  if (now - prevFrame > 30) {
    draw()
    prevFrame = now
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

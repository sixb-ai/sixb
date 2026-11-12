// Pictures a canvas's boards, in a sandbox, as the render worker runs it: the version's files in
// <site>, each board's page served as the frame serves it, with the kit and the runtime under
// __sixb/, and what its queries return under __sixb/queries/, as the runtime reads them with no app
// around it. Only those files are served, from 127.0.0.1. Chromium, through the agent image's
// Playwright, opens each board at its own size, a few at once, and in each theme the reader sees it
// in takes its picture, full size as PNG and at most `smallWidth` wide as WebP, into <out>. A board
// whose page did not load whole is not pictured, as a broken picture would stay. It writes one line
// of JSON: { pictures, unpictured, stalls }, or { skipped: "no_browser" }, or { failed }.
//
//   node picture.cjs <site> <out> <deadline in ms>
//
// <out> holds boards.json, the boards and their sizes, and themes.json, the themes by name.

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const [site, out, deadline] = process.argv.slice(2)
const DEADLINE_MS = Number(deadline) || 240_000
/** The most one step waits on a board: its load, its theme, its picture. */
const STEP_MS = 10_000
/** How many boards open at once, each in a browser context of its own. */
const LANES = 4
/** How much of a board is pictured, from its top. */
const MAX_HEIGHT = 4000
/** How a small picture's WebP is encoded: as sharp as text needs at its size, by eye. */
const SMALL_QUALITY = 0.85
const PROTOCOL = "sixb-frame/1"
const PAGE_OPTIONS = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, reducedMotion: "reduce" }
const QUERY_PATH = /^\/__sixb\/queries\/([a-z0-9][a-z0-9-]{0,63})\.json$/
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
}

const found = { pictures: [], unpictured: [], stalls: [] }

class Stalled extends Error {}

/** `promise`, or a {@link Stalled} naming `what` once it has taken `ms`. */
function within(what, promise, ms = STEP_MS) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Stalled(`${what} did not respond within ${ms / 1000} seconds`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function isStall(error) {
  return error instanceof Stalled || error?.name === "TimeoutError"
}

function loadPlaywright() {
  for (const candidate of [process.env.SIXB_PLAYWRIGHT, "/opt/sixb/js/node_modules/playwright"]) {
    if (!candidate) continue
    try {
      return require(candidate)
    } catch {
      // The next candidate, then none.
    }
  }
  return null
}

/**
 * Serves the site and nothing outside it. A query is served with the status its answer says,
 * from queries.json beside the answers: a failed one with its error.
 */
function serve(root) {
  const statusesFile = path.join(root, "__sixb", "queries.json")
  const statuses = fs.existsSync(statusesFile) ? JSON.parse(fs.readFileSync(statusesFile, "utf8")) : {}
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://board").pathname)
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end()
      return
    }
    const file = path.resolve(root, `.${pathname}`)
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end()
      return
    }
    const query = QUERY_PATH.exec(pathname)?.[1]
    const status = query && Object.hasOwn(statuses, query) ? statuses[query] : 200
    const type = TYPES[path.extname(file).toLowerCase()]
    response.writeHead(status, type ? { "content-type": type } : {}).end(fs.readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

/** A board's tab, with what failed to load since it last loaded: a picture of it would show it broken. */
function openTab(page, stepOf) {
  const failures = []
  const local = (url) => url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, "")
  page.on("requestfailed", (request) => failures.push(`${local(request.url())} did not load`))
  page.on("response", (response) => {
    if (response.status() >= 400 && !QUERY_PATH.test(new URL(response.url()).pathname)) {
      failures.push(`${local(response.url())} did not load (${response.status()})`)
    }
  })
  const load = async (url) => {
    failures.length = 0
    await page
      .goto(url, { waitUntil: "load", timeout: 15_000 })
      .catch((error) => failures.push(`the board did not finish loading: ${error.message}`))
    // Each theme is pictured as it settles, not on its way there.
    await within(
      stepOf(),
      page.addStyleTag({
        content: "*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; }",
      })
    ).catch(() => {})
    await within("the board's fonts", page.evaluate(() => document.fonts?.ready)).catch(() => {})
  }
  const settle = () =>
    within(stepOf(), page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
  const send = (method, params) =>
    within(
      stepOf(),
      page.evaluate(({ protocol, method, params }) => window.postMessage({ protocol, id: 0, method, params }, "*"), {
        protocol: PROTOCOL,
        method,
        params,
      })
    )
  return { page, load, settle, send, failures }
}

/** A blank page where small pictures are encoded, apart from every board's scripts. */
let encoder

/** A picture at most `width` wide, its aspect kept, as WebP in `file`: encoded by the browser. */
async function shrink(browser, png, width, file) {
  encoder ??= within("the browser", browser.newContext()).then((context) => within("the browser", context.newPage()))
  const page = await encoder
  const webp = await within(
    "a small picture",
    page.evaluate(
      async ({ data, width, quality }) => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        const scale = Math.min(1, width / image.naturalWidth)
        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext("2d")
        context.imageSmoothingQuality = "high"
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise((done) => canvas.toBlob(done, "image/webp", quality))
        if (blob?.type !== "image/webp") throw new Error("this browser does not encode WebP")
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ""
        for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
        return btoa(binary)
      },
      { data: png.toString("base64"), width, quality: SMALL_QUALITY }
    )
  )
  fs.writeFileSync(file, Buffer.from(webp, "base64"))
}

async function picture(browser, port) {
  const boards = JSON.parse(fs.readFileSync(path.join(out, "boards.json"), "utf8"))
  const themes = JSON.parse(fs.readFileSync(path.join(out, "themes.json"), "utf8"))
  const names = Object.keys(themes)
  const waiting = [...boards]
  fs.mkdirSync(path.join(out, "boards"), { recursive: true })

  const open = async () => {
    const context = await within("the browser", browser.newContext(PAGE_OPTIONS))
    let step = "the canvas"
    const tab = openTab(await within("the browser", context.newPage()), () => step)
    return { ...tab, context, at: (next) => (step = next) }
  }

  const pictureBoard = async (tab, board) => {
    tab.at(`board '${board.id}'`)
    await tab.page.setViewportSize({ width: board.w, height: Math.min(board.h, MAX_HEIGHT) })
    await tab.load(`http://127.0.0.1:${port}/${board.file.split("/").map(encodeURIComponent).join("/")}`)

    const pictures = []
    for (const name of names) {
      tab.at(`board '${board.id}' in ${name} mode`)
      await tab.send("theme", themes[name])
      await tab.settle()
      const full = path.join(out, "boards", `${board.id}.${name}.png`)
      const png = await tab.page.screenshot({ path: full, timeout: STEP_MS })
      const small = path.join(out, "boards", `${board.id}.${name}.small.webp`)
      await shrink(browser, png, board.smallWidth, small)
      pictures.push(
        { board: board.id, theme: name, size: "full", path: full, bytes: png.length },
        { board: board.id, theme: name, size: "small", path: small, bytes: fs.statSync(small).size }
      )
    }
    // A page that did not load whole is pictured broken, and its picture would stay: none is kept,
    // and the board keeps its outline until it loads.
    if (tab.failures.length > 0) {
      found.unpictured.push({ board: board.id, reason: tab.failures[0] })
      return
    }
    found.pictures.push(...pictures)
  }

  const lane = async () => {
    let tab = await open()
    for (let board = waiting.shift(); board; board = waiting.shift()) {
      try {
        await pictureBoard(tab, board)
      } catch (error) {
        if (!isStall(error)) throw error
        found.stalls.push({ board: board.id, message: error.message })
        // Its page may be frozen and keep its context from closing: exiting kills both.
        void within("the browser", tab.context.close(), 5_000).catch(() => {})
        tab = await open()
      }
    }
    await within("the browser", tab.context.close(), 5_000).catch(() => {})
  }

  await Promise.all(Array.from({ length: Math.min(LANES, boards.length) }, lane))
}

async function main() {
  const playwright = loadPlaywright()
  if (!playwright) return { skipped: "no_browser" }
  const root = path.resolve(site)
  const server = await serve(root)
  let browser
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.SIXB_CHROMIUM ? { executablePath: process.env.SIXB_CHROMIUM } : {}),
    })
  } catch {
    server.close()
    return { skipped: "no_browser" }
  }
  try {
    await within("the boards", picture(browser, server.address().port), DEADLINE_MS)
  } catch (error) {
    if (!isStall(error)) throw error
    // What was pictured so far is kept; the boards it did not reach keep their outlines.
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
  return found
}

main().then(
  (report) => process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0)),
  (error) => {
    const report = { failed: String(error?.message ?? error).slice(0, 500) }
    process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0))
  }
)

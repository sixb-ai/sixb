// The Agent's layout check, run in the sandbox by publish_artifact: it serves a deck, a page, or a
// canvas's boards as the API serves its frame, with the kit and the runtime, and opens them in the
// sandbox's headless Chromium. A deck shows at 1280×720 with each slide filling the page, and every
// slide is measured in each of its themes with the layout probe and screenshot in the first. A page
// loads at 1280px and at a phone's 390px, is measured whole in each theme, its top 4000px, and
// screenshot at each width. A canvas's boards load each at its own size, four at a time, measured
// as a page is and screenshot as boards/<id>.png; a board boards.json marks `pictured` also in
// each other theme, as boards/<id>.<theme>.png, and each of its pictures for readers also at most
// `smallWidth` wide, as boards/<id>.<theme>.small.webp. With overview.html, the
// whole canvas as it opens is screenshot as overview.png. It writes one line of JSON:
// { layout, slides, problems, errors, screenshots, previews, stalls, overview?, stopped? } or
// { skipped }.
//
//   node check.cjs <directory> <output directory> <library directory> <deadline in ms> <layout>
//
// The library holds what the worker installs beside this script: deck.css, page.css, runtime.js,
// probe.js. The output directory holds entries.json, each page the check opens by its path, with
// the kit and runtime in it; boards.json, a canvas's boards and their sizes; overview.html and
// overview.json, a canvas's page of itself and the window it opens in; files.json,
// the paths the version publishes: only those are served, since the reader gets only those; and
// themes.json, the themes the reader sees it in: Sixb's light and dark, or the mode its
// theme.json pins, with its tokens; and queries.json, the version's queries by name with the
// status each is served with, its answer in queries/<name>.json: the page reads them at
// __sixb/queries/<name>.json, as the runtime does with no app around it.
//
// A deck or a page can stop answering, with a script that never yields or a font that never
// loads, and a browser outlives a node that is killed. So every wait on the page is bounded, and
// when one runs out, or the deadline passes, the check reports what it found so far and exits:
// Playwright kills the browser it launched when node exits.
"use strict"

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const [deck, out, lib, deadline, layout = "deck"] = process.argv.slice(2)
const DEADLINE_MS = Number(deadline) || 100_000
/** The most one step waits on the page: its fonts, a slide's measure, a screenshot. */
const STEP_MS = 10_000
const PROTOCOL = "sixb-frame/1"
/** The frame's own files, served from the library as the API serves them beside a version's. */
const FRAME_FILES = new Set(["/__sixb/deck.css", "/__sixb/page.css", "/__sixb/runtime.js"])
/** Where the runtime reads a query when it is opened on its own. */
const QUERY_PATH = /^\/__sixb\/queries\/([a-z0-9][a-z0-9-]{0,63})\.json$/
/** The widths a page is checked at: a laptop's, and a phone's. */
const VIEWS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]
/** How much of a page the check measures and shows, from its top. */
const PAGE_HEIGHT = 4000
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

/** How many of a canvas's boards the check opens at once, each in a browser context of its own. */
const LANES = 4
/** A laptop's width, and reduced motion: what animates in is measured and shown where it lands. */
const PAGE_OPTIONS = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
}
const NOUN = { canvas: "the canvas", page: "the page" }[layout] ?? "the deck"

/** What the check has found so far, which a check that stops early reports. */
const found = {
  layout,
  slides: 0,
  problems: [],
  errors: [],
  screenshots: [],
  // A canvas's: each board's picture in each theme the reader sees it in, the boards that stopped
  // answering, and the whole canvas as it opens.
  previews: [],
  stalls: [],
  overview: undefined,
}
/** A canvas's boards by their place in it: its lanes finish in any order. */
let boardOrder = new Map()
const byBoard = (left, right) =>
  (boardOrder.get(left.board) ?? 0) - (boardOrder.get(right.board) ?? 0)
const findings = () => ({
  ...found,
  errors: [...new Set(found.errors)].slice(0, 10),
  problems: [...found.problems].sort(byBoard),
  screenshots: [...found.screenshots].sort(
    (left, right) => byBoard({ board: shotBoard(left) }, { board: shotBoard(right) })
  ),
  previews: [...found.previews].sort(byBoard),
})
const shotBoard = (file) => path.basename(file, ".png")

let reported = false
/** Writes the report, then exits once it is written. */
function report(result, code = 0) {
  if (reported) return process.exit(code)
  reported = true
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code))
}

class Stalled extends Error {}

/** `promise`, or a {@link Stalled} naming `what` once it has taken `ms`. */
function within(what, promise, ms = STEP_MS) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Stalled(`${what} did not respond within ${ms / 1000} seconds`)),
        ms
      )
    }),
  ]).finally(() => clearTimeout(timer))
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

/** A stall: a bound of the check's, or one of Playwright's, ran out. */
function isStall(error) {
  return error instanceof Stalled || error?.name === "TimeoutError"
}

/**
 * A page the check opens, with what it reports of loading listened for, and the ways to drive it,
 * each bounded and named after the step `stepOf` says it is at.
 */
function openTab(page, stepOf) {
  const { errors } = found
  page.on("pageerror", (error) => errors.push(error.message))
  // A file that fails names itself; Chromium's console line for it does not.
  const local = (url) => url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, "")
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text())
    }
  })
  page.on("requestfailed", (request) => errors.push(`${local(request.url())} did not load`))
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${local(response.url())} did not load (${response.status()})`)
    }
  })

  // A font or a library from a CDN may be out of reach; the entry is measured as it loaded.
  const load = async (url) => {
    await page
      .goto(url, { waitUntil: "load", timeout: 15_000 })
      .catch((error) => errors.push(`${NOUN} did not finish loading: ${error.message}`))
    // Each theme is measured as it settles, not on its way there.
    await within(
      stepOf(),
      page.addStyleTag({
        content: "*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; }",
      })
    ).catch(() => {})
    await within(`${NOUN}'s fonts`, page.evaluate(() => document.fonts?.ready)).catch(() => {})
  }
  const settle = () =>
    within(
      stepOf(),
      page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    )
  const send = (method, params) =>
    within(
      stepOf(),
      page.evaluate(
        ({ protocol, method, params }) =>
          window.postMessage({ protocol, id: 0, method, params }, "*"),
        { protocol: PROTOCOL, method, params }
      )
    )
  return { page, load, settle, send }
}

/**
 * A canvas's boards, each at its own size in each theme, a few at once. Each lane is a browser
 * context of its own, so a board that stops answering costs only its lane, which goes on in a new
 * one. A board's first theme is screenshot as boards/<id>.png; a board marked `pictured`, which
 * the reader sees as a picture until they open it, in every theme, the others as
 * boards/<id>.<theme>.png. Then the whole canvas as it opens, when overview.html says how. Returns
 * whether a board stalled.
 */
async function checkCanvas(browser, port, probe, themes) {
  const boards = JSON.parse(fs.readFileSync(path.join(out, "boards.json"), "utf8"))
  boardOrder = new Map(boards.map((board, index) => [board.id, index]))
  fs.mkdirSync(path.join(out, "boards"), { recursive: true })

  const names = Object.keys(themes)
  const waiting = [...boards]
  let stalled = false

  const open = async () => {
    const context = await within("the browser", browser.newContext(PAGE_OPTIONS))
    let step = NOUN
    const tab = openTab(await within("the browser", context.newPage()), () => step)
    return { ...tab, context, at: (next) => (step = next) }
  }

  const checkBoard = async (tab, board) => {
    tab.at(`board '${board.id}'`)
    await tab.page.setViewportSize({ width: board.w, height: Math.min(board.h, PAGE_HEIGHT) })
    await tab.load(`http://127.0.0.1:${port}/${board.file.split("/").map(encodeURIComponent).join("/")}`)

    for (const [index, name] of names.entries()) {
      const step = tab.at(`board '${board.id}' in ${name} mode`)
      await tab.send("theme", themes[name])
      await tab.settle()
      for (const problem of await within(step, tab.page.evaluate(`(${probe})("page")`))) {
        found.problems.push({ ...problem, board: board.id, theme: name })
      }

      if (index > 0 && !board.pictured) continue
      const file = path.join(out, "boards", index === 0 ? `${board.id}.png` : `${board.id}.${name}.png`)
      const png = await tab.page.screenshot({ path: file, timeout: STEP_MS })
      if (index === 0) found.screenshots.push(file)
      if (!board.pictured) continue

      const small = path.join(out, "boards", `${board.id}.${name}.small.webp`)
      await shrink(browser, png, board.smallWidth, small)
      found.previews.push(
        { board: board.id, theme: name, size: "full", path: file, bytes: png.length },
        { board: board.id, theme: name, size: "small", path: small, bytes: fs.statSync(small).size }
      )
    }
  }

  const lane = async () => {
    let tab = await open()
    for (let board = waiting.shift(); board; board = waiting.shift()) {
      try {
        await checkBoard(tab, board)
      } catch (error) {
        if (!isStall(error)) throw error
        stalled = true
        found.stalls.push({
          board: board.id,
          message: error instanceof Stalled ? error.message : `board '${board.id}' did not respond in time`,
        })
        // Its page may be frozen and keep its context from closing: exiting kills both.
        void within("the browser", tab.context.close(), 5_000).catch(() => {})
        tab = await open()
      }
    }
    await within("the browser", tab.context.close(), 5_000).catch(() => {})
  }

  await Promise.all(Array.from({ length: Math.min(LANES, boards.length) }, lane))
  await overview(browser)
  return stalled
}

/** How a small picture's WebP is encoded: as sharp as text needs at its size, by eye. */
const SMALL_QUALITY = 0.85
/** A blank page where small pictures are encoded, apart from every board's scripts. */
let encoder

/**
 * A board's screenshot at most `width` wide, its aspect kept, as WebP in `file`: what a canvas
 * shows when it draws the board small. Encoded by the browser's own canvas.
 */
async function shrink(browser, png, width, file) {
  encoder ??= within("the browser", browser.newContext()).then((context) =>
    within("the browser", context.newPage())
  )
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
        for (let at = 0; at < bytes.length; at += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
        }
        return btoa(binary)
      },
      { data: png.toString("base64"), width, quality: SMALL_QUALITY }
    )
  )
  fs.writeFileSync(file, Buffer.from(webp, "base64"))
}

/**
 * overview.html, the whole canvas as the app opens it with each board its picture, screenshot
 * as overview.png at the size overview.json gives. One that fails leaves the check as it is.
 */
async function overview(browser) {
  const html = path.join(out, "overview.html")
  if (!fs.existsSync(html)) return

  const viewport = JSON.parse(fs.readFileSync(path.join(out, "overview.json"), "utf8"))
  let context
  try {
    context = await within("the overview", browser.newContext({ viewport, deviceScaleFactor: 1 }))
    const page = await within("the overview", context.newPage())
    await page.goto(pathToFileURL(html).href, { waitUntil: "load", timeout: 15_000 })
    const file = path.join(out, "overview.png")
    await page.screenshot({ path: file, timeout: STEP_MS })
    found.overview = file
  } catch {
    // Without its overview, the Agent still has each board's screenshot.
  } finally {
    if (context) await within("the browser", context.close(), 5_000).catch(() => {})
  }
}

function serve() {
  // Each page the check opens, with the kit and the runtime in it, by its path in the version.
  const entries = JSON.parse(fs.readFileSync(path.join(out, "entries.json"), "utf8"))
  const published = new Set(JSON.parse(fs.readFileSync(path.join(out, "files.json"), "utf8")))
  const queries = fs.existsSync(path.join(out, "queries.json"))
    ? JSON.parse(fs.readFileSync(path.join(out, "queries.json"), "utf8"))
    : {}
  const root = path.resolve(deck)
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://deck").pathname)
    let body = null
    let file = null
    let status = 200
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end()
      return
    }
    const entry = entries[pathname === "/" ? "index.html" : pathname.slice(1)]
    const query = QUERY_PATH.exec(pathname)?.[1]
    if (entry) file = path.join(out, entry)
    else if (FRAME_FILES.has(pathname)) file = path.join(lib, pathname.slice("/__sixb/".length))
    else if (query && Object.hasOwn(queries, query)) {
      file = path.join(out, "queries", `${query}.json`)
      status = queries[query]
    } else if (published.has(pathname.slice(1))) file = path.join(root, pathname.slice(1))
    try {
      if (file) body = fs.readFileSync(file)
    } catch {
      body = null
    }
    if (body === null) {
      response.writeHead(404).end()
      return
    }
    const type = TYPES[path.extname(file).toLowerCase()]
    response.writeHead(status, type ? { "content-type": type } : {}).end(body)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

async function main() {
  const playwright = loadPlaywright()
  if (!playwright) return { skipped: "no_browser" }
  const probe = fs.readFileSync(path.join(lib, "probe.js"), "utf8")
  const themes = JSON.parse(fs.readFileSync(path.join(out, "themes.json"), "utf8"))
  const server = await serve()
  let browser
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.SIXB_CHROMIUM ? { executablePath: process.env.SIXB_CHROMIUM } : {}),
    })
  } catch (error) {
    server.close()
    return { skipped: "no_browser", detail: String(error?.message ?? error).slice(0, 300) }
  }
  let step = NOUN
  let stalled = false
  const { port } = server.address()
  try {
    if (layout === "canvas") {
      stalled = await checkCanvas(browser, port, probe, themes)
      return findings()
    }
    const { page, load, settle, send } = openTab(
      await browser.newPage(PAGE_OPTIONS),
      () => step
    )
    const { problems, screenshots } = found
    if (layout === "page") {
      for (const view of VIEWS) {
        step = `the page at ${view.width}px`
        await page.setViewportSize({ width: view.width, height: view.height })
        await load(`http://127.0.0.1:${port}/index.html`)
        for (const [index, name] of Object.keys(themes).entries()) {
          step = `the page at ${view.width}px in ${name} mode`
          await send("theme", themes[name])
          await settle()
          // The page in one view, up to its cut: the probe judges only what the viewport shows.
          const height = await within(
            step,
            page.evaluate(() => document.documentElement.scrollHeight)
          )
          await page.setViewportSize({
            width: view.width,
            height: Math.max(view.height, Math.min(PAGE_HEIGHT, height)),
          })
          await settle()
          for (const problem of await within(step, page.evaluate(`(${probe})("page")`))) {
            problems.push({ ...problem, view: view.name, theme: name })
          }
          if (index === 0) {
            const file = path.join(out, `${view.name}.png`)
            await page.screenshot({ path: file, timeout: STEP_MS })
            screenshots.push(file)
          }
          await page.setViewportSize({ width: view.width, height: view.height })
        }
      }
      return findings()
    }
    await load(`http://127.0.0.1:${port}/index.html#sixb-fill`)
    found.slides = await within(
      step,
      page.evaluate(() => document.querySelectorAll("section.slide").length)
    )
    for (const [index, name] of Object.keys(themes).entries()) {
      step = `the deck in ${name} mode`
      await send("theme", themes[name])
      for (let slide = 1; slide <= found.slides; slide++) {
        step = `slide ${slide} in ${name} mode`
        await send("goto", { slide })
        await page.waitForFunction(
          (slide) => document.querySelectorAll("section.slide")[slide - 1]?.hasAttribute("data-current"),
          slide,
          { timeout: 5_000 }
        )
        await settle()
        for (const problem of await within(step, page.evaluate(`(${probe})(${slide})`))) {
          problems.push({ ...problem, slide, theme: name })
        }
        for (const problem of await photoContrast(page, slide, step)) {
          problems.push({ ...problem, slide, theme: name })
        }
        if (index === 0) {
          const file = path.join(out, `slide-${String(slide).padStart(2, "0")}.png`)
          await page.screenshot({ path: file, timeout: STEP_MS })
          screenshots.push(file)
        }
      }
    }
    return findings()
  } catch (error) {
    // Playwright's own timeouts, for a slide that never shows or a screenshot never taken, are
    // stalls too.
    if (!isStall(error)) throw error
    stalled = true
    return {
      ...findings(),
      stopped: error instanceof Stalled ? error.message : `${step} did not respond in time`,
    }
  } finally {
    // A page that stalled may not let its browser close; exiting kills it.
    if (!stalled) await within("the browser", browser.close(), 5_000).catch(() => {})
    server.close()
  }
}

/**
 * Text over a photo, which the probe cannot judge from styles: each text whose center sits over
 * an image is hidden, the slide is shot without it, and the pixels under its box are read. The
 * text fails when the darker or lighter tenth of them, whichever is worse, is under WCAG AA
 * against its color.
 */
async function photoContrast(page, slide, step) {
  try {
    return await readPhotoContrast(page, slide, step)
  } catch (error) {
    // A stall stops the check as the probe's would; any other failure only skips this slide.
    if (error instanceof Stalled || error?.name === "TimeoutError") throw error
    return []
  }
}

async function readPhotoContrast(page, slide, step) {
  const candidates = await within(
    step,
    page.evaluate((slide) => {
      const root = document.querySelectorAll("section.slide")[slide - 1]
      if (!root) return []
      const found = []
      for (const element of root.querySelectorAll("*")) {
        const own = Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== ""
        )
        if (!own || element.closest("svg")) continue
        const rect = element.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) continue
        const style = getComputedStyle(element)
        if (style.visibility === "hidden" || Number(style.opacity) === 0) continue
        const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        const under = stack.slice(Math.max(0, stack.indexOf(element)))
        let photo = false
        for (const node of under) {
          if (/^(img|picture|video|canvas)$/i.test(node.tagName)) { photo = true; break }
          if (node === element) continue
          // A solid box between the text and the photo, such as a panel, is the probe's to judge.
          const color = getComputedStyle(node).backgroundColor
          const alpha = color.startsWith("rgba") ? Number(color.split(",")[3]?.replace(")", "")) : color === "transparent" ? 0 : 1
          if (alpha >= 0.99 && !node.contains(root.querySelector("img, picture, video, canvas"))) break
        }
        if (!photo) continue
        const size = Number.parseFloat(style.fontSize)
        const bold = Number.parseInt(style.fontWeight, 10) >= 700
        element.setAttribute("data-sixb-photo-text", String(found.length))
        found.push({
          index: found.length,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          color: style.color,
          large: size >= 24 || (bold && size >= 18.66),
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
          selector: [element.tagName.toLowerCase(), ...Array.from(element.classList).slice(0, 2)].join("."),
        })
      }
      return found
    }, slide)
  )
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const hide = await page.addStyleTag({
    content: "[data-sixb-photo-text] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }",
  })
  let shot
  try {
    shot = await within(step, page.screenshot({ type: "png", timeout: STEP_MS }))
  } finally {
    await hide.evaluate((node) => node.remove()).catch(() => {})
    await page.evaluate(() => {
      for (const node of document.querySelectorAll("[data-sixb-photo-text]")) node.removeAttribute("data-sixb-photo-text")
    }).catch(() => {})
  }
  return within(
    step,
    page.evaluate(
      async ({ data, candidates, slide }) => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        const canvas = document.createElement("canvas")
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext("2d", { willReadFrequently: true })
        context.drawImage(image, 0, 0)
        const parse = (color) => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          return Array.from(context.getImageData(0, 0, 1, 1).data)
        }
        const channel = (value) => {
          const c = value / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        }
        const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        const hex = (rgb) => `#${rgb.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`
        const box = document.querySelectorAll("section.slide")[slide - 1].getBoundingClientRect()
        const problems = []
        for (const candidate of candidates) {
          const { x, y, width, height } = candidate.rect
          const left = Math.max(0, Math.floor(x))
          const top = Math.max(0, Math.floor(y))
          const right = Math.min(canvas.width, Math.ceil(x + width))
          const bottom = Math.min(canvas.height, Math.ceil(y + height))
          if (right <= left || bottom <= top) continue
          const pixels = context.getImageData(left, top, right - left, bottom - top).data
          const step = Math.max(1, Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 4000)))
          const samples = []
          for (let row = 0; row < bottom - top; row += step) {
            for (let column = 0; column < right - left; column += step) {
              const at = (row * (right - left) + column) * 4
              samples.push([pixels[at], pixels[at + 1], pixels[at + 2]])
            }
          }
          if (samples.length === 0) continue
          const [r, g, b, a] = parse(candidate.color)
          const text = luminance([r, g, b])
          // The tenth of the area that reads worst stands for the text's background.
          const scored = samples
            .map((sample) => ({ sample, contrast: ratio(text, luminance(sample)) }))
            .sort((p, q) => p.contrast - q.contrast)
          const worst = scored[Math.floor(scored.length * 0.1)]
          const needed = candidate.large ? 3 : 4.5
          if (a / 255 >= 0.5 && worst.contrast < needed) {
            problems.push({
              code: "contrast",
              rect: {
                x: Math.round(x - box.left),
                y: Math.round(y - box.top),
                width: Math.round(width),
                height: Math.round(height),
              },
              text: candidate.text,
              selector: candidate.selector,
              ratio: Math.round(worst.contrast * 100) / 100,
              colors: [hex([r, g, b]), `${hex(worst.sample)} in the photo`],
            })
          }
        }
        return problems
      },
      { data: shot.toString("base64"), candidates, slide }
    )
  )
}

setTimeout(
  () =>
    report({
      ...findings(),
      stopped: `the check took longer than ${Math.round(DEADLINE_MS / 1000)} seconds`,
    }),
  DEADLINE_MS
).unref()

main().then(
  (result) => report(result),
  (error) => report({ failed: String(error?.stack ?? error).slice(0, 1000) }, 1)
)

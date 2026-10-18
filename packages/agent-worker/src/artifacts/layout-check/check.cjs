// The Agent's layout check, run in the sandbox by publish_artifact: it serves a deck or a page as
// the API serves its frame, with the kit and the runtime, and opens it in the sandbox's headless
// Chromium. A deck shows at 1280×720 with each slide filling the page, and every slide is
// measured in each of its themes with the layout probe and screenshot in the first. A page loads at
// 1280px and at a phone's 390px, is measured whole in each theme, its top 4000px, and screenshot
// at each width. It writes one line of JSON:
// { layout, slides, problems, errors, screenshots, stopped? } or { skipped }.
//
//   node check.cjs <directory> <output directory> <library directory> <deadline in ms> <layout>
//
// The library holds what the worker installs beside this script: deck.css, page.css, runtime.js,
// probe.js. The output directory holds entry.html, the entry with the kit and runtime; files.json,
// the paths the version publishes: only those are served, since the reader gets only those; and
// themes.json, the themes the reader sees it in: Sixb's light and dark, or the mode its
// theme.json pins, with its tokens.
//
// A deck or a page can stop answering, with a script that never yields or a font that never
// loads, and a browser outlives a node that is killed. So every wait on the page is bounded, and
// when one runs out, or the deadline passes, the check reports what it found so far and exits:
// Playwright kills the browser it launched when node exits.
"use strict"

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const [deck, out, lib, deadline, layout = "deck"] = process.argv.slice(2)
const DEADLINE_MS = Number(deadline) || 100_000
/** The most one step waits on the page: its fonts, a slide's measure, a screenshot. */
const STEP_MS = 10_000
const PROTOCOL = "sixb-frame/1"
/** The frame's own files, served from the library as the API serves them beside a version's. */
const FRAME_FILES = new Set(["/__sixb/deck.css", "/__sixb/page.css", "/__sixb/runtime.js"])
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

/** What the check has found so far, which a check that stops early reports. */
const found = { layout, slides: 0, problems: [], errors: [], screenshots: [] }
const findings = () => ({ ...found, errors: [...new Set(found.errors)].slice(0, 10) })

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

function serve() {
  const entry = fs.readFileSync(path.join(out, "entry.html"))
  const published = new Set(JSON.parse(fs.readFileSync(path.join(out, "files.json"), "utf8")))
  const root = path.resolve(deck)
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://deck").pathname)
    let body = null
    let file = null
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end()
      return
    }
    if (pathname === "/" || pathname === "/index.html") body = entry
    else if (FRAME_FILES.has(pathname)) file = path.join(lib, pathname.slice("/__sixb/".length))
    else if (published.has(pathname.slice(1))) file = path.join(root, pathname.slice(1))
    try {
      if (file) body = fs.readFileSync(file)
    } catch {
      body = null
    }
    if (body === null) {
      response.writeHead(404).end()
      return
    }
    const type = TYPES[path.extname(file ?? "index.html").toLowerCase()]
    response.writeHead(200, type ? { "content-type": type } : {}).end(body)
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
  const noun = layout === "page" ? "the page" : "the deck"
  let step = noun
  let stalled = false
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    const { errors, problems, screenshots } = found
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
    const { port } = server.address()
    // A font or a library from a CDN may be out of reach; the entry is measured as it loaded.
    const load = async (url) => {
      await page
        .goto(url, { waitUntil: "load", timeout: 15_000 })
        .catch((error) => errors.push(`${noun} did not finish loading: ${error.message}`))
      await within(`${noun}'s fonts`, page.evaluate(() => document.fonts?.ready)).catch(() => {})
    }
    const settle = () =>
      within(
        step,
        page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      )
    const send = (method, params) =>
      within(
        step,
        page.evaluate(
          ({ protocol, method, params }) =>
            window.postMessage({ protocol, id: 0, method, params }, "*"),
          { protocol: PROTOCOL, method, params }
        )
      )
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
    if (!(error instanceof Stalled) && error?.name !== "TimeoutError") throw error
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

// The Agent's layout check, run in the sandbox by publish_artifact: it serves a deck as the API
// serves its frame, with the kit and the runtime, opens it in the sandbox's headless Chromium at
// 1280×720 with each slide filling the page, measures every slide in Sixb's light and dark
// themes with the layout probe, and screenshots every slide in light. It writes one line of JSON:
// { slides, problems, errors, screenshots } or { skipped }.
//
//   node check.cjs <deck directory> <output directory> <library directory>
//
// The library holds what the worker installs beside this script: kit.css, runtime.js, probe.js,
// themes.json; the output directory holds entry.html, the deck's entry with the kit and runtime.
"use strict"

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const [deck, out, lib] = process.argv.slice(2)
const PROTOCOL = "sixb-frame/1"
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

function finish(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
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
    else if (pathname === "/__sixb/kit.css") file = path.join(lib, "kit.css")
    else if (pathname === "/__sixb/runtime.js") file = path.join(lib, "runtime.js")
    else {
      const resolved = path.resolve(root, `.${pathname}`)
      if (resolved.startsWith(`${root}${path.sep}`)) file = resolved
    }
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
  if (!playwright) return finish({ skipped: "no_browser" })
  const probe = fs.readFileSync(path.join(lib, "probe.js"), "utf8")
  const themes = JSON.parse(fs.readFileSync(path.join(lib, "themes.json"), "utf8"))
  const server = await serve()
  let browser
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.SIXB_CHROMIUM ? { executablePath: process.env.SIXB_CHROMIUM } : {}),
    })
  } catch (error) {
    server.close()
    return finish({ skipped: "no_browser", detail: String(error?.message ?? error).slice(0, 300) })
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    const errors = []
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
    // A font or a library from a CDN may be out of reach; the deck is measured as it loaded.
    await page
      .goto(`http://127.0.0.1:${port}/index.html#sixb-fill`, { waitUntil: "load", timeout: 15_000 })
      .catch((error) => errors.push(`the deck did not finish loading: ${error.message}`))
    await page.evaluate(() => document.fonts?.ready).catch(() => {})
    const slides = await page.evaluate(() => document.querySelectorAll("section.slide").length)
    const send = (method, params) =>
      page.evaluate(
        ({ protocol, method, params }) =>
          window.postMessage({ protocol, id: 0, method, params }, "*"),
        { protocol: PROTOCOL, method, params }
      )
    const problems = []
    const screenshots = []
    for (const name of ["light", "dark"]) {
      await send("theme", themes[name])
      for (let slide = 1; slide <= slides; slide++) {
        await send("goto", { slide })
        await page.waitForFunction(
          (slide) => document.querySelectorAll("section.slide")[slide - 1]?.hasAttribute("data-current"),
          slide,
          { timeout: 5_000 }
        )
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        for (const problem of await page.evaluate(`(${probe})(${slide})`)) {
          problems.push({ ...problem, slide, theme: name })
        }
        if (name === "light") {
          const file = path.join(out, `slide-${String(slide).padStart(2, "0")}.png`)
          await page.screenshot({ path: file })
          screenshots.push(file)
        }
      }
    }
    finish({ slides, problems, errors: [...new Set(errors)].slice(0, 10), screenshots })
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
}

main().catch((error) => {
  finish({ failed: String(error?.stack ?? error).slice(0, 1000) })
  process.exitCode = 1
})

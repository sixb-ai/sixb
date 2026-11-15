// Prints a designed document to PDF, in a sandbox, as the render worker runs it: the version's
// files in <directory>, its document.html served as the frame serves it, with the kit and the
// runtime under __sixb/. Only those files are served, from 127.0.0.1. Chromium, through the agent
// image's Playwright, opens it, waits for its fonts to load and its images to decode, and prints
// it in print media on the paper its @page rule sets, with its backgrounds. It writes one line of
// JSON: { pages, pdf } with the PDF in base64, { skipped: "no_browser" }, or { failed }.
//
//   node print.cjs <directory> <deadline in ms> <most bytes>

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const [directory, deadline, most] = process.argv.slice(2)
const DEADLINE_MS = Number(deadline) || 100_000
const MAX_BYTES = Number(most) || 64 * 1024 * 1024
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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

/** Bounds a step, naming it when it runs out. */
function within(what, promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Serves the directory and nothing outside it. */
function serve(root) {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://document").pathname)
    const file = path.resolve(root, `.${pathname}`)
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end()
      return
    }
    const type = TYPES[path.extname(file).toLowerCase()]
    response.writeHead(200, type ? { "content-type": type } : {}).end(fs.readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

/** How many pages a PDF Chromium printed holds: its page objects, which it never compresses. */
function pdfPages(bytes) {
  return (bytes.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
}

async function main() {
  const playwright = loadPlaywright()
  if (!playwright) return { skipped: "no_browser" }
  const root = path.resolve(directory)
  const server = await serve(root)
  let browser
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.SIXB_CHROMIUM ? { executablePath: process.env.SIXB_CHROMIUM } : {}),
      // Linux's font hinting distorts the advances of embedded fonts in a vector PDF, opening
      // gaps inside words and changing where lines wrap.
      args: ["--font-render-hinting=none"],
    })
  } catch {
    server.close()
    return { skipped: "no_browser" }
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await within(
      "the document",
      page.goto(`http://127.0.0.1:${server.address().port}/document.html`, { waitUntil: "load" }),
      DEADLINE_MS / 2
    )
    // An image that does not decode prints as it shows.
    await within(
      "the document's fonts and images",
      page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})))
      }),
      DEADLINE_MS / 4
    )
    await page.emulateMedia({ media: "print" })
    const pdf = await within(
      "the PDF",
      page.pdf({ printBackground: true, preferCSSPageSize: true }),
      DEADLINE_MS / 2
    )
    if (pdf.byteLength > MAX_BYTES) {
      return { failed: `the PDF is ${pdf.byteLength} bytes, past the ${MAX_BYTES} kept` }
    }
    return { pages: pdfPages(pdf), pdf: pdf.toString("base64") }
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
}

main().then(
  (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
  (error) => {
    process.stdout.write(`${JSON.stringify({ failed: String(error?.message ?? error).slice(0, 500) })}\n`)
  }
)

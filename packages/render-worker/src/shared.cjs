// What the render worker's scripts share, in a sandbox: the image's Playwright and its browser,
// a server for the files a render opens and nothing else, bounds on each step, what failed to load,
// and the one line of JSON each writes as its report.

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

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

/** What a frame's `sixb.query` reads, which a render serves with the status its answer says. */
const QUERY_PATH = /^\/__sixb\/queries\/([a-z0-9][a-z0-9-]{0,63})\.json$/

class Stalled extends Error {}

/** `promise`, or a {@link Stalled} naming `what` once it has taken `ms`. */
function within(what, promise, ms) {
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

/** Chromium through the image's Playwright, or null when the sandbox has neither. */
async function launch(args = []) {
  let playwright = null
  for (const candidate of [process.env.SIXB_PLAYWRIGHT, "/opt/sixb/js/node_modules/playwright"]) {
    if (!candidate) continue
    try {
      playwright = require(candidate)
      break
    } catch {
      // The next candidate, then none.
    }
  }
  if (!playwright) return null
  try {
    return await playwright.chromium.launch({
      headless: true,
      ...(process.env.SIXB_CHROMIUM ? { executablePath: process.env.SIXB_CHROMIUM } : {}),
      args,
    })
  } catch {
    return null
  }
}

/**
 * Serves `root` and nothing outside it, from 127.0.0.1. A query is served with the status its
 * answer says, from `__sixb/queries.json` beside the answers: a failed one with its error.
 */
function serve(root) {
  const statusesFile = path.join(root, "__sixb", "queries.json")
  const statuses = fs.existsSync(statusesFile) ? JSON.parse(fs.readFileSync(statusesFile, "utf8")) : {}
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://render").pathname)
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

/**
 * What failed to load in `page` since `reset()`: a file, a font, a stylesheet. A render of it would
 * show it broken. A query's own failure is its answer, and does not count.
 */
function failedLoads(page) {
  const failures = []
  const local = (url) => url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, "")
  page.on("requestfailed", (request) => failures.push(`${local(request.url())} did not load`))
  page.on("response", (response) => {
    if (response.status() >= 400 && !QUERY_PATH.test(new URL(response.url()).pathname)) {
      failures.push(`${local(response.url())} did not load (${response.status()})`)
    }
  })
  return {
    failures,
    reset: () => {
      failures.length = 0
    },
  }
}

/**
 * Runs `main` and writes what it returns as one line of JSON, or `{ failed }` with why it threw.
 * Then exits, so a browser process left behind cannot hold the command open.
 */
function report(main) {
  const write = (line) => process.stdout.write(`${JSON.stringify(line)}\n`, () => process.exit(0))
  main().then(write, (error) => write({ failed: String(error?.message ?? error).slice(0, 500) }))
}

module.exports = { Stalled, within, isStall, launch, serve, failedLoads, report }

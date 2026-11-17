// Pictures a canvas's boards, in a sandbox, as the render worker runs it: the version's files in
// <site>, each board's page served as the frame serves it, with the kit and the runtime under
// __sixb/, and what its queries return under __sixb/queries/, as the runtime reads them with no app
// around it. Chromium opens each board at its own size, a few at once, and in each theme the reader
// sees it in takes its picture into <out>: full size as PNG, and at most `smallWidth` wide as WebP,
// encoded from it on a blank page of the lane's own. A board whose page did not load whole is not pictured, as a broken picture
// would stay. It writes one line of JSON: { pictures, unpictured, stalls, stopped? }, stopped
// when it ran out of time before every board, or { skipped: "no_browser" }, or { failed }.
//
//   node picture.cjs <site> <out> <deadline in ms>
//
// <out> holds boards.json, the boards and their sizes, and themes.json, the themes by name.

const fs = require("node:fs")
const path = require("node:path")
const { within, isStall, launch, serve, failedLoads, report } = require("./shared.cjs")

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

const found = { pictures: [], unpictured: [], stalls: [] }

/** A board's tab, and what failed to load in it. */
async function openTab(browser) {
  const context = await within("the browser", browser.newContext(PAGE_OPTIONS), STEP_MS)
  const page = await within("the browser", context.newPage(), STEP_MS)
  return { context, page, loads: failedLoads(page) }
}

/**
 * A lane's blank page, apart from every board's scripts, that encodes a picture at most `width`
 * wide, its aspect kept, as WebP: made again after one fails.
 */
function encoder(browser) {
  let page = null
  return async (png, width) => {
    page ??= within("the browser", browser.newContext(), STEP_MS).then((context) =>
      within("the browser", context.newPage(), STEP_MS)
    )
    try {
      const encoded = await within(
        "a small picture",
        (await page).evaluate(
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
        ),
        STEP_MS
      )
      return Buffer.from(encoded, "base64")
    } catch (error) {
      const failed = page
      page = null
      void failed?.then((each) => each.context().close()).catch(() => {})
      throw error
    }
  }
}

async function pictureBoard(tab, board, port, themes, encode) {
  const { page, loads } = tab
  const step = (what) => `board '${board.id}'${what ? ` ${what}` : ""}`
  const height = Math.min(board.h, MAX_HEIGHT)
  await page.setViewportSize({ width: board.w, height })
  loads.reset()
  await page
    .goto(`http://127.0.0.1:${port}/${board.file.split("/").map(encodeURIComponent).join("/")}`, {
      waitUntil: "load",
      timeout: 15_000,
    })
    .catch((error) => loads.failures.push(`the board did not finish loading: ${error.message}`))
  // Each theme is pictured as it settles, not on its way there.
  await within(
    step(),
    page.addStyleTag({
      content: "*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; }",
    }),
    STEP_MS
  ).catch(() => {})
  await within(step("fonts"), page.evaluate(() => document.fonts?.ready), STEP_MS).catch(() => {})

  const pictures = []
  for (const [name, theme] of Object.entries(themes)) {
    const at = step(`in ${name} mode`)
    await within(
      at,
      page.evaluate(({ protocol, params }) => window.postMessage({ protocol, id: 0, method: "theme", params }, "*"), {
        protocol: PROTOCOL,
        params: theme,
      }),
      STEP_MS
    )
    await within(
      at,
      page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))),
      STEP_MS
    )
    const full = path.join(out, "boards", `${board.id}.${name}.png`)
    const png = await page.screenshot({ path: full, timeout: STEP_MS })
    const small = path.join(out, "boards", `${board.id}.${name}.small.webp`)
    const webp = await encode(png, board.smallWidth)
    fs.writeFileSync(small, webp)
    pictures.push(
      { board: board.id, theme: name, size: "full", path: full, bytes: png.length },
      { board: board.id, theme: name, size: "small", path: small, bytes: webp.length }
    )
  }
  // A page that did not load whole is pictured broken, and its picture would stay: none is kept,
  // and the board keeps its outline until it loads.
  if (loads.failures.length > 0) {
    found.unpictured.push({ board: board.id, reason: loads.failures[0] })
    return
  }
  found.pictures.push(...pictures)
}

async function picture(browser, port) {
  const boards = JSON.parse(fs.readFileSync(path.join(out, "boards.json"), "utf8"))
  const themes = JSON.parse(fs.readFileSync(path.join(out, "themes.json"), "utf8"))
  const waiting = [...boards]
  fs.mkdirSync(path.join(out, "boards"), { recursive: true })

  const lane = async () => {
    const encode = encoder(browser)
    let tab = await openTab(browser)
    for (let board = waiting.shift(); board; board = waiting.shift()) {
      try {
        await pictureBoard(tab, board, port, themes, encode)
      } catch (error) {
        // The browser gone, nothing more is pictured; any other failure costs only this board.
        if (!browser.isConnected()) throw error
        const reason = String(error?.message ?? error).slice(0, 200)
        if (isStall(error)) found.stalls.push({ board: board.id, reason })
        else found.unpictured.push({ board: board.id, reason })
        // Its page may be frozen and keep its context from closing: exiting kills both.
        void within("the browser", tab.context.close(), 5_000).catch(() => {})
        tab = await openTab(browser)
      }
    }
    await within("the browser", tab.context.close(), 5_000).catch(() => {})
  }

  await Promise.all(Array.from({ length: Math.min(LANES, boards.length) }, lane))
}

async function main() {
  const browser = await launch()
  if (!browser) return { skipped: "no_browser" }
  const server = await serve(path.resolve(site))
  try {
    await within("the boards", picture(browser, server.address().port), DEADLINE_MS)
  } catch (error) {
    if (!isStall(error)) throw error
    // What was pictured so far is kept; the boards it did not reach keep their outlines.
    found.stopped = true
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
  return found
}

report(main)

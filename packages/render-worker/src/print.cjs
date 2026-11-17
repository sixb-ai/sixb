// Prints a designed document to PDF, in a sandbox, as the render worker runs it: the version's
// files in <site>, its document.html served as the frame serves it, with the kit and the runtime
// under __sixb/. Chromium opens it, waits for its fonts to load and its images to decode, and
// prints it in print media on the paper its @page rule sets, with its backgrounds, into <pdf>. It
// writes one line of JSON: { pages, bytes, missing? } with what did not load, which the PDF shows
// without, { skipped: "no_browser" }, or { failed }.
//
//   node print.cjs <site> <pdf> <deadline in ms> <most bytes>

const fs = require("node:fs")
const path = require("node:path")
const { within, launch, serve, failedLoads, report } = require("./shared.cjs")

const [site, pdfPath, deadline, most] = process.argv.slice(2)
const DEADLINE_MS = Number(deadline) || 100_000
const MAX_BYTES = Number(most) || 64 * 1024 * 1024

/** How many pages a PDF Chromium printed holds: its page objects, which it writes uncompressed. */
function pdfPages(bytes) {
  return (bytes.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
}

async function main() {
  // Linux's font hinting distorts the advances of embedded fonts in a vector PDF, opening gaps
  // inside words and changing where lines wrap.
  const browser = await launch(["--font-render-hinting=none"])
  if (!browser) return { skipped: "no_browser" }
  const server = await serve(path.resolve(site))
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const loads = failedLoads(page)
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
    fs.writeFileSync(pdfPath, pdf)
    return {
      pages: pdfPages(pdf),
      bytes: pdf.byteLength,
      ...(loads.failures.length > 0 ? { missing: loads.failures[0] } : {}),
    }
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
}

report(main)

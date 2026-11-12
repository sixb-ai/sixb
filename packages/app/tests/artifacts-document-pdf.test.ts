import { afterAll, afterEach, describe, expect, jest, test } from "bun:test"
import { client } from "@sixb/client"
import { downloadDocumentPdf } from "../src/artifacts/pdf"
import { installDom } from "./helpers/dom"

// Downloading a designed document's PDF: the server prints it when first asked, so the download
// asks, waits while it prints, then saves it.

const browser = installDom(["document", "Node", "Element", "HTMLElement", "HTMLAnchorElement"])

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })
/** The page's link clicks, caught for the test that catches them. */
let caught: { mockRestore(): void } | undefined
afterEach(() => {
  jest.useRealTimers()
  client.setConfig({ fetch: originalConfig.fetch })
  caught?.mockRestore()
  caught = undefined
})
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

/**
 * The server: the ask for the PDF answered with `printing`, then the version read with each of
 * `reads` in turn, printable until the last says otherwise; asked again without a retry, why it
 * could not be printed. And every link the page clicked.
 */
function serve(reads: readonly ("printable" | "ready" | "failed")[]) {
  const asked: string[] = []
  const queue = [...reads]
  client.setConfig({
    fetch: (async (request: Request) => {
      const { pathname, search } = new URL(request.url)
      asked.push(`${request.method} ${pathname}${search}`)
      if (request.method === "POST") {
        return Response.json(
          search.includes("retry=true")
            ? { status: "printing" }
            : { status: "failed", reason: "This project's sandboxes have no headless browser." }
        )
      }
      return Response.json({
        artifactId: "art_pr0p0sa1x0",
        version: 2,
        pdf: queue.shift() ?? "printable",
      })
    }) as typeof fetch,
  })
  const clicked: string[] = []
  caught = jest
    .spyOn(browser.HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: { href: string; download: string }) {
      clicked.push(`${this.href} download=${JSON.stringify(this.download)}`)
    })
  return { asked, clicked }
}

/** Lets each answer in flight arrive, and what it sets off. */
async function settle() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

describe("a designed document's PDF download", () => {
  // Reproduce by saving the link at the first answer in downloadDocumentPdf: it is saved while the
  // PDF is still printing, and the server answers 404. Asking on each check instead of reading the
  // version asks the worker to print it again each time.
  test("asks once, waits until it is printed, then saves it", async () => {
    jest.useFakeTimers()
    const { asked, clicked } = serve(["printable", "ready"])

    const done = downloadDocumentPdf({ artifactId: "art_pr0p0sa1x0", version: 2 })
    await settle()
    expect(asked).toEqual(["POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf?retry=true"])
    jest.advanceTimersByTime(1_000)
    await settle()
    expect(clicked).toEqual([])

    jest.advanceTimersByTime(1_500)
    await done
    expect(asked).toEqual([
      "POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf?retry=true",
      "GET /api/artifacts/art_pr0p0sa1x0/versions/2",
      "GET /api/artifacts/art_pr0p0sa1x0/versions/2",
    ])
    expect(clicked).toEqual([
      'https://api.sixb.test/api/artifacts/art_pr0p0sa1x0/versions/2/pdf download=""',
    ])
  })

  // Reproduce by waiting only for `ready` in downloadDocumentPdf: it waits out its two minutes.
  test("stops as soon as the version says it could not be printed", async () => {
    jest.useFakeTimers()
    const { asked, clicked } = serve(["failed"])

    const done = downloadDocumentPdf({ artifactId: "art_pr0p0sa1x0", version: 2 }).catch(
      (error: unknown) => error
    )
    await settle()
    jest.advanceTimersByTime(1_000)
    const error = await done
    expect(error).toBeInstanceOf(Error)
    // The reason, for the menu to show: asked once more, without printing it again.
    expect(String(error)).toContain("This project's sandboxes have no headless browser.")
    expect(asked).toEqual([
      "POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf?retry=true",
      "GET /api/artifacts/art_pr0p0sa1x0/versions/2",
      "POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf",
    ])
    expect(clicked).toEqual([])
  })

  test("gives up when the PDF is not printed within two minutes", async () => {
    jest.useFakeTimers()
    const { clicked } = serve([])

    const done = downloadDocumentPdf({ artifactId: "art_pr0p0sa1x0", version: 2 }).catch(
      (error: unknown) => error
    )
    for (let elapsed = 0; elapsed < 125_000; elapsed += 1_000) {
      await settle()
      jest.advanceTimersByTime(1_000)
    }
    expect(await done).toBeInstanceOf(Error)
    expect(clicked).toEqual([])
  })
})

import { afterAll, afterEach, describe, expect, jest, test } from "bun:test"
import { client } from "@sixb/client"
import { DOCUMENT_PDF_WAIT_MS } from "@sixb/core/artifacts"
import { DOCUMENT_PDF_JOB } from "@sixb/core/internal/artifacts/publish"
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
 * The server: each ask for the PDF answered with each of `answers` in turn, printing once they
 * run out; and every link the page clicked.
 */
function serve(answers: readonly ("printing" | "ready" | "failed")[]) {
  const asked: string[] = []
  const queue = [...answers]
  client.setConfig({
    fetch: (async (request: Request) => {
      const { pathname, search } = new URL(request.url)
      asked.push(`${request.method} ${pathname}${search}`)
      const status = queue.shift() ?? "printing"
      return Response.json(
        status === "ready"
          ? { status, pages: 3 }
          : status === "failed"
            ? { status, reason: "No browser." }
            : { status }
      )
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
  // PDF is still printing, and the server answers 404. Asking each time with retry prints a PDF
  // that failed again and again.
  test("asks, printing again one that failed, until it is printed, then saves it", async () => {
    jest.useFakeTimers()
    const { asked, clicked } = serve(["printing", "printing", "ready"])

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
      "POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf",
      "POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf",
    ])
    expect(clicked).toEqual([
      'https://api.sixb.test/api/artifacts/art_pr0p0sa1x0/versions/2/pdf download=""',
    ])
  })

  // Reproduce by waiting only for `ready` in downloadDocumentPdf: it waits out every attempt.
  test("stops as soon as it is said it could not be printed", async () => {
    jest.useFakeTimers()
    const { asked, clicked } = serve(["printing", "failed"])

    const done = downloadDocumentPdf({ artifactId: "art_pr0p0sa1x0", version: 2 }).catch(
      (error: unknown) => error
    )
    await settle()
    jest.advanceTimersByTime(1_000)
    const error = await done
    expect(error).toBeInstanceOf(Error)
    // With why, for the menu to show.
    expect(String(error)).toContain("No browser.")
    expect(asked).toEqual([
      "POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf?retry=true",
      "POST /api/artifacts/art_pr0p0sa1x0/versions/2/pdf",
    ])
    expect(clicked).toEqual([])
  })

  // Reproduce by waiting two minutes in downloadDocumentPdf: it gives up while the render worker's
  // second attempt may still print it.
  test("gives up once the render worker has made every attempt, and not before", async () => {
    jest.useFakeTimers()
    const { clicked } = serve([])

    let stopped = false
    const done = downloadDocumentPdf({ artifactId: "art_pr0p0sa1x0", version: 2 }).catch(
      (error: unknown) => {
        stopped = true
        return error
      }
    )
    const wait = async (until: number) => {
      for (let elapsed = 0; elapsed < until; elapsed += 1_000) {
        await settle()
        jest.advanceTimersByTime(1_000)
      }
      await settle()
    }
    await wait(DOCUMENT_PDF_JOB.timeoutMs + 5_000)
    expect(stopped).toBe(false)
    await wait(DOCUMENT_PDF_WAIT_MS - DOCUMENT_PDF_JOB.timeoutMs)
    expect(await done).toBeInstanceOf(Error)
    expect(clicked).toEqual([])
  })
})

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type ArtifactFile,
  type CreateSandboxOptions,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Sandbox,
  type SandboxFactory,
  SixbHost,
} from "@sixb/core"
import { FRAME_CDN_ALLOWLIST } from "@sixb/core/internal/artifacts/frames"
import { DOCUMENT_PDF_JOB, documentPdfKey } from "@sixb/core/internal/artifacts/publish"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { failDocumentPdf, printDocumentPdf } from "../src/document-pdf"
import { RenderWorker } from "../src/worker"

const projectId = "pdfs"
const alice = { type: "user", id: "alice" } as const

/**
 * The project's sandboxes, real bash on this host, whose browser is the test: asked to print, it
 * answers with a PDF of the pages it is told to, as the print script reports one. What each print
 * was given to open is kept.
 */
class PrintingSandboxes implements Pick<SandboxFactory, "create" | "supportsRequestCredentials"> {
  readonly supportsRequestCredentials = true
  readonly created: CreateSandboxOptions[] = []
  /** The document.html each print opened, and whether the frame's kit was beside it. */
  readonly printed: { readonly html: string; readonly kit: boolean }[] = []
  destroyed = 0
  /** Resolves each time a sandbox is destroyed, which ends a job's print. */
  private onDestroy: (() => void) | undefined

  destroyedOnce(): Promise<void> {
    return new Promise((resolve) => {
      this.onDestroy = resolve
    })
  }

  constructor(
    private readonly pages: number | null = 3,
    /** What the print says did not load. */
    private readonly missing?: string
  ) {}

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.created.push(options)
    const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create()
    const run = sandbox.runCommand.bind(sandbox)
    const destroy = sandbox.destroy.bind(sandbox)

    return Object.assign(sandbox, {
      runCommand: async (...[command, args, runOptions]: Parameters<Sandbox["runCommand"]>) => {
        const script = args?.at(-1) ?? ""
        if (!script.includes("print.cjs")) return run(command, args, runOptions)

        const site = join(sandbox.workingDirectory, "document")
        this.printed.push({
          html: readFileSync(join(site, "document.html"), "utf8"),
          kit: readFileSync(join(site, "__sixb/document.css"), "utf8").length > 0,
        })
        // A sandbox without a browser says so, as the script does; one with writes the PDF.
        const pdf = `%PDF-1.7 ${this.pages} pages`
        if (this.pages !== null) writeFileSync(join(sandbox.workingDirectory, "document.pdf"), pdf)
        const report =
          this.pages === null
            ? { skipped: "no_browser" }
            : {
                pages: this.pages,
                bytes: pdf.length,
                ...(this.missing ? { missing: this.missing } : {}),
              }
        return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "", durationMs: 0 }
      },
      destroy: async () => {
        await destroy()
        this.destroyed += 1
        this.onDestroy?.()
      },
    })
  }
}

const workers: RenderWorker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
})

function setup(options: { readonly sandboxes?: PrintingSandboxes } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    storage,
    blobStorage,
    queues: new InMemoryQueues(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    ...(options.sandboxes ? { sandboxes: options.sandboxes } : {}),
  })
  const sixb = createTestSixb(host, {
    authorization: { principal: alice, groupIds: [], roleIds: [], grants: emptyGrantIndex() },
  })
  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> =>
    Promise.all(
      Object.entries(contents).map(async ([path, body]) => ({
        path,
        file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )
  const proposal = async () =>
    sixb.artifacts.create({
      kind: "document",
      title: "Harbor proposal",
      files: await put({
        "document.html":
          '<!doctype html><html><head><link rel="stylesheet" href="design.css"></head><body><h1>Proposal</h1></body></html>',
        "design.css": "@page { size: letter; margin: 0.75in }",
      }),
    })
  const job = (
    version: ArtifactVersionRecord,
    renderKey = documentPdfKey(version) ?? "",
    document?: ArtifactFile["file"]
  ) => ({
    id: "job",
    projectId,
    createdAt: new Date().toISOString(),
    availableAt: new Date().toISOString(),
    attempt: 1,
    type: "artifact.pdf.requested" as const,
    payload: {
      artifactId: version.artifactId,
      version: version.version,
      renderKey,
      ...(document ? { document } : {}),
    },
  })
  const print = (
    version: ArtifactVersionRecord,
    renderKey?: string,
    document?: ArtifactFile["file"]
  ) =>
    printDocumentPdf({
      host,
      job: job(version, renderKey, document),
      signal: new AbortController().signal,
    })
  const giveUp = (version: ArtifactVersionRecord, renderKey?: string) =>
    failDocumentPdf({ host, job: job(version, renderKey) })
  /** Prints as the job's `attempt`th try does. */
  const attempt = (version: ArtifactVersionRecord, attempt: number) =>
    printDocumentPdf({
      host,
      job: { ...job(version), attempt },
      signal: new AbortController().signal,
    })
  return { host, sixb, blobStorage, put, proposal, print, attempt, giveUp }
}

/** Waits a bounded number of event-loop turns for a condition read from storage. */
async function eventually(predicate: () => Promise<boolean>, turns = 500): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Condition not reached.")
}

describe("a designed document's PDF, printed by the render worker", () => {
  // Reproduce by enqueueing the job on the agents' lane in ArtifactsRuntime.pdf: the render worker
  // never claims it, and the PDF is never ready.
  test("is asked for on the renders lane, and printed by a running worker", async () => {
    const sandboxes = new PrintingSandboxes(2)
    const { host, sixb, proposal } = setup({ sandboxes })
    const { artifact } = await proposal()
    const worker = new RenderWorker(host)
    workers.push(worker)
    await worker.start()

    const printed = sandboxes.destroyedOnce()
    expect(await sixb.artifacts.pdf(artifact.id)).toEqual({ status: "printing" })
    await printed
    await eventually(async () => (await sixb.artifacts.pdf(artifact.id))?.status === "ready")
    expect(await sixb.artifacts.pdf(artifact.id)).toMatchObject({ status: "ready", pages: 2 })
  })

  // Reproduce by writing the version's own document.html in print(): the browser opens it without
  // the frame's kit, and the sheet's stage prints around every page.
  test("is printed in a blank sandbox that reaches only the frame's CDNs, as its frame serves it, and kept", async () => {
    const sandboxes = new PrintingSandboxes(3)
    const { sixb, blobStorage, proposal, print } = setup({ sandboxes })
    const { artifact, version } = await proposal()

    await print(version)

    expect(sandboxes.created).toEqual([
      {
        environment: {},
        network: {
          mode: "restricted",
          allow: FRAME_CDN_ALLOWLIST.map((origin) => ({ name: new URL(origin).hostname, origin })),
        },
        signal: expect.any(AbortSignal),
      },
    ])
    expect(sandboxes.printed).toHaveLength(1)
    expect(sandboxes.printed[0]?.html).toContain("__sixb/document.css")
    expect(sandboxes.printed[0]?.html).toContain('data-sixb-layout="document"')
    expect(sandboxes.printed[0]?.kit).toBe(true)
    expect(sandboxes.destroyed).toBe(1)

    const pdf = await sixb.artifacts.pdf(artifact.id)
    if (pdf?.status !== "ready") throw new Error("Expected the PDF.")
    expect(pdf.pages).toBe(3)
    expect(pdf.file).toMatchObject({
      fileName: "Harbor proposal.pdf",
      mediaType: "application/pdf",
    })
    expect(await new Response(await blobStorage.open(pdf.file.blobId)).text()).toBe(
      "%PDF-1.7 3 pages"
    )

    // Asked again, it is found: nothing prints twice.
    await print(version)
    expect(sandboxes.created).toHaveLength(1)
  })

  // Reproduce by passing no document to print() in printDocumentPdf: the browser opens the
  // version's own document.html, its fields as written.
  test("prints the document with the values whoever asked reads, written in", async () => {
    const sandboxes = new PrintingSandboxes(1)
    const { sixb, put, proposal, print } = setup({ sandboxes })
    const { artifact, version } = await proposal()
    const [filled] = await put({ "document.html": "<h1>Harbor Co</h1>" })
    if (!filled) throw new Error("Expected the filled document.")

    await print(version, documentPdfKey(version, filled.file) ?? "", filled.file)
    expect(sandboxes.printed[0]?.html).toContain("<h1>Harbor Co</h1>")
    // Kept under what it printed: the version's own markup has no PDF.
    expect(await sixb.artifacts.pdf(artifact.id, { print: false })).toEqual({ status: "printing" })
  })

  test("prints nothing for content that changed since it was asked", async () => {
    const sandboxes = new PrintingSandboxes(3)
    const { sixb, proposal, print, giveUp } = setup({ sandboxes })
    const { version } = await proposal()
    await print(version, "0".repeat(64))
    await giveUp(version, "0".repeat(64))
    expect(sandboxes.created).toEqual([])
    expect(await sixb.artifacts.pdf(version.artifactId)).toEqual({ status: "printing" })
  })

  // Reproduce by keeping only a printed PDF in printDocumentPdf: whoever waits for the PDF hears it
  // is printing until they give up.
  test("keeps why it could not be printed, so whoever waits hears it at once", async () => {
    const bare = new PrintingSandboxes(null)
    const without = setup({ sandboxes: bare })
    const { artifact, version } = await without.proposal()
    await without.print(version)
    expect(bare.destroyed).toBe(1)
    expect(await without.sixb.artifacts.pdf(artifact.id)).toEqual({
      status: "failed",
      reason:
        "This project's sandboxes have no headless browser to print with (the agent image has one).",
    })

    // The worker gave up on one that kept failing.
    const failing = setup({ sandboxes: new PrintingSandboxes(3) })
    const other = await failing.proposal()
    await failing.giveUp(other.version)
    expect(await failing.sixb.artifacts.pdf(other.artifact.id)).toEqual({
      status: "failed",
      reason: "Printing it failed. Try again in a moment.",
    })
  })

  // Reproduce by keeping what print.cjs printed whatever it says did not load: a font the CDN
  // failed to serve once is missing from the PDF for good, under a key that never changes.
  test("is printed again while a file or a font did not load, and kept so on the last attempt", async () => {
    const sandboxes = new PrintingSandboxes(2, "fonts.css did not load (503)")
    const { sixb, proposal, attempt } = setup({ sandboxes })
    const { artifact, version } = await proposal()

    const first = await attempt(version, 1).catch((error: unknown) => error)
    expect(String(first)).toContain("fonts.css did not load (503)")
    expect(await sixb.artifacts.pdf(artifact.id, { print: false })).toEqual({ status: "printing" })
    expect(sandboxes.destroyed).toBe(1)

    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await attempt(version, DOCUMENT_PDF_JOB.attempts)
    } finally {
      warn.mockRestore()
    }
    expect(await sixb.artifacts.pdf(artifact.id, { print: false })).toMatchObject({
      status: "ready",
      pages: 2,
    })
  })
})

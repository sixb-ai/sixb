import { describe, expect, test } from "bun:test"
import type { ArtifactFile, Principal, SandboxFactory } from "../src"
import { SixbHost } from "../src"
import { documentPdfKey } from "../src/artifacts/publish/pdf"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A designed document prints to PDF when someone asks: the agent worker prints it in a sandbox and
// keeps it under what it prints, its render key, which the version's next ask finds.

const alice: Principal = { type: "user", id: "alice" }

const forbidden = async (): Promise<never> => {
  throw new Error("Expected no sandbox: asking for a PDF never creates one.")
}
const sandboxes: SandboxFactory = { supportsRequestCredentials: true, create: forbidden }

const HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="design.css"></head><body><h1>Proposal</h1></body></html>'
const CSS = "@page { size: letter; margin: 0.75in }"

function setup(options: { readonly sandboxes?: boolean } = {}) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "pdfs",
    ontology: [],
    ...deps,
    ...(options.sandboxes === false ? {} : { sandboxes }),
  })
  const sixb = createTestSixb(host, {
    authorization: { principal: alice, groupIds: [], roleIds: [], grants: emptyGrantIndex() },
  })
  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> =>
    Promise.all(
      Object.entries(contents).map(async ([path, body]) => ({
        path,
        file: await deps.blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )
  const pdfFile = (body = "%PDF-1.7 proposal") =>
    deps.blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: "Proposal.pdf",
      mediaType: "application/pdf",
    })
  /** The jobs the agent worker would claim now, each done once claimed. */
  const claimable = async () => {
    const claims = await deps.queues.renders.claim({
      projectId: "pdfs",
      workerId: "test",
      limit: 10,
    })
    for (const { job, leaseId } of claims) {
      await deps.queues.renders.complete({ projectId: "pdfs", jobId: job.id, leaseId })
    }
    return claims.map(({ job }) => ({ id: job.id, type: job.type, payload: job.payload }))
  }
  const storage = () => {
    const artifacts = deps.storage.artifacts
    if (!artifacts) throw new Error("Expected artifact storage.")
    return artifacts
  }
  return { sixb, put, pdfFile, claimable, storage }
}

describe("a designed document's PDF", () => {
  // Reproduce by returning `printing` without enqueueing in ArtifactsRuntime.pdf: nobody prints it.
  test("is asked of the agent worker, then found under what it prints", async () => {
    const { sixb, put, pdfFile, claimable, storage } = setup()
    const { artifact, version } = await sixb.artifacts.create({
      kind: "document",
      title: "Proposal",
      files: await put({ "document.html": HTML, "design.css": CSS }),
    })
    const renderKey = documentPdfKey(version)
    if (!renderKey) throw new Error("Expected a designed document.")

    expect(await sixb.artifacts.pdf(artifact.id)).toEqual({ status: "printing" })
    expect(await claimable()).toEqual([
      {
        id: `art_pdf_${artifact.id}`,
        type: "artifact.pdf.requested",
        payload: { artifactId: artifact.id, version: 1, renderKey },
      },
    ])

    const file = await pdfFile()
    await storage().putPdf({ projectId: "pdfs", renderKey, file, pages: 3, createdAt: new Date() })
    expect(await sixb.artifacts.pdf(artifact.id)).toEqual({ status: "ready", file, pages: 3 })
    expect(await claimable()).toEqual([])

    // A version that holds the same files prints the same: it finds the PDF.
    await sixb.artifacts.freeze(artifact.id)
    const next = await sixb.artifacts.update(artifact.id, {
      kind: "document",
      title: "Proposal",
      files: version.files,
    })
    expect(next.version.version).toBe(2)
    expect(await sixb.artifacts.pdf(artifact.id, { version: 2 })).toMatchObject({ status: "ready" })
  })

  // Reproduce by dropping the failure check from ArtifactsRuntime.pdf: whoever asks hears it is
  // printing, forever. Dropping clearPdfFailure from requestDocumentPdf: a retry still says failed.
  test("says why it could not be printed, until asked to print it again", async () => {
    const { sixb, put, claimable, storage } = setup()
    const { artifact, version } = await sixb.artifacts.create({
      kind: "document",
      title: "Proposal",
      files: await put({ "document.html": HTML, "design.css": CSS }),
    })
    expect(await sixb.artifacts.pdf(artifact.id)).toEqual({ status: "printing" })
    await claimable()

    await storage().putPdf({
      projectId: "pdfs",
      renderKey: documentPdfKey(version) ?? "",
      failure: "It could not be printed: no browser.",
      createdAt: new Date(),
    })
    expect(await sixb.artifacts.pdf(artifact.id)).toEqual({
      status: "failed",
      reason: "It could not be printed: no browser.",
    })
    expect(await claimable()).toEqual([])

    expect(await sixb.artifacts.pdf(artifact.id, { retry: true })).toEqual({ status: "printing" })
    expect(await claimable()).toMatchObject([{ type: "artifact.pdf.requested" }])
    expect(await sixb.artifacts.pdf(artifact.id)).toEqual({ status: "printing" })
  })

  test("is printed anew once what it prints changes", async () => {
    const { sixb, put } = setup()
    const { artifact, version } = await sixb.artifacts.create({
      kind: "document",
      title: "Proposal",
      files: await put({ "document.html": HTML, "design.css": CSS }),
    })
    const changed = await sixb.artifacts.update(artifact.id, {
      kind: "document",
      title: "Proposal",
      files: await put({ "document.html": HTML, "design.css": `${CSS} h1 { color: teal }` }),
    })
    expect(documentPdfKey(changed.version)).not.toBe(documentPdfKey(version))
    expect(documentPdfKey({ ...version, files: [...version.files].reverse() })).toBe(
      documentPdfKey(version)
    )
  })

  test("is refused for a Markdown document, and where nothing prints", async () => {
    const { sixb, put } = setup()
    const markdown = await sixb.artifacts.create({
      kind: "document",
      title: "Plan",
      files: await put({ "document.md": "# Plan\n" }),
    })
    expect(
      await sixb.artifacts.pdf(markdown.artifact.id).catch((error: unknown) => error)
    ).toMatchObject({ code: "invalid_artifact" })
    expect(await sixb.artifacts.pdf("art_0000000000")).toBeNull()

    const bare = setup({ sandboxes: false })
    const designed = await bare.sixb.artifacts.create({
      kind: "document",
      title: "Proposal",
      files: await bare.put({ "document.html": HTML, "design.css": CSS }),
    })
    expect(
      await bare.sixb.artifacts.pdf(designed.artifact.id).catch((error: unknown) => error)
    ).toMatchObject({ code: "pdf_unavailable" })
    expect(await bare.claimable()).toEqual([])
  })
})

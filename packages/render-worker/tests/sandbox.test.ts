import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type BlobStorage,
  type FileRef,
  InMemoryBlobStorage,
  InMemoryStorage,
  type Sandbox,
  type SandboxNetworkPolicy,
} from "@sixb/core"
import { resolveFileDownload } from "@sixb/core/internal/blob-storage"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import {
  downloadIntoSandbox,
  inRenderSandbox,
  readSandboxFiles,
  renderApiOrigin,
  storeSandboxFile,
} from "../src/sandbox"
import { startDownloadApi } from "./download-api"

const sandboxes: Sandbox[] = []
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.destroy()))
})

/** Real bash on this host, keeping how much each command printed. */
async function sandbox() {
  const local = await new LocalSandboxFactory({ isolation: "none" }).create()
  sandboxes.push(local)
  const printed: number[] = []
  const run = local.runCommand.bind(local)
  Object.assign(local, {
    runCommand: async (...args: Parameters<Sandbox["runCommand"]>) => {
      const result = await run(...args)
      printed.push(result.stdout.length)
      return result
    },
  })
  return { sandbox: local, printed }
}

describe("files read back out of a render's sandbox", () => {
  // Reproduce by reading each file whole, in one command: the PDF's base64 is 2 MB of one
  // command's output, which a provider that keeps 1 MiB of it cuts off.
  test("come back whole, a piece at a time, no command printing a mebibyte", async () => {
    const { sandbox: local, printed } = await sandbox()
    const pdf = Buffer.alloc(1_500_000, 7)
    pdf.write("%PDF-1.7", 0)
    const small = Buffer.from("a small picture")
    writeFileSync(join(local.workingDirectory, "document.pdf"), pdf)
    writeFileSync(join(local.workingDirectory, "small.webp"), small)

    const [readPdf, readSmall, tooLarge, missing] = await readSandboxFiles(
      local,
      [
        { path: join(local.workingDirectory, "document.pdf"), bytes: pdf.length },
        { path: join(local.workingDirectory, "small.webp"), bytes: small.length },
        { path: join(local.workingDirectory, "document.pdf"), bytes: 5_000_000 },
        { path: join(local.workingDirectory, "gone.png"), bytes: 10 },
      ],
      { maxBytes: 4_000_000, signal: new AbortController().signal }
    )

    expect(Buffer.from(readPdf as Uint8Array).equals(pdf)).toBe(true)
    expect(Buffer.from(readSmall as Uint8Array).equals(small)).toBe(true)
    expect(tooLarge).toEqual({ error: "too_large" })
    expect(missing).toEqual({ error: "unreadable" })
    expect(printed.length).toBeGreaterThan(2)
    expect(Math.max(...printed)).toBeLessThan(1024 * 1024)
  })
})

async function downloadHost() {
  const host = {
    id: "renders",
    storage: new InMemoryStorage(),
    blobStorage: new InMemoryBlobStorage(),
  }
  const media = Buffer.alloc(3 * 1024 * 1024 + 7, 3)
  const file = await host.blobStorage.put({ body: media, fileName: "intro.mp4" })
  return { host, media, file }
}

describe("files a render fetches into its sandbox", () => {
  // Reproduce by writing the file in with `writeFiles`: the API serves nothing, and the worker
  // reads the whole file to write it.
  test("arrive from the API by a download URL the sandbox fetches, revoked once fetched", async () => {
    const { sandbox: local, printed } = await sandbox()
    const { host, media, file } = await downloadHost()
    const api = startDownloadApi(host)
    try {
      const path = join(local.workingDirectory, "media/intro.mp4")
      await downloadIntoSandbox(host, local, [{ path, file }], {
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        executionId: "render_job_1",
      })

      expect(readFileSync(path).equals(media)).toBe(true)
      expect(api.served.map(({ blobId }) => blobId)).toEqual([file.blobId])
      expect(Math.max(...printed)).toBeLessThan(1024)
      // Revoked: the URL serves nothing any more.
      const [served] = api.served
      expect(served && (await resolveFileDownload(host, served.token))).toBeNull()
    } finally {
      api.close()
    }
  })

  // Reproduce by fetching with `-P 1`: one file at a time, each answered alone, the API never
  // sees more than one request at once.
  test("arrive a few at a time, not one after another", async () => {
    const { sandbox: local } = await sandbox()
    const host = {
      id: "renders",
      storage: new InMemoryStorage(),
      blobStorage: new InMemoryBlobStorage(),
    }
    const recordings = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        host.blobStorage.put({ body: Buffer.alloc(1024, index), fileName: `take-${index}.mp4` })
      )
    )
    const api = startDownloadApi(host, { together: 4 })
    try {
      const files = recordings.map((file, index) => ({
        path: join(local.workingDirectory, `media/take-${index}.mp4`),
        file,
      }))
      await downloadIntoSandbox(host, local, files, {
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        executionId: "render_job_1",
      })

      for (const [index, { path }] of files.entries()) {
        expect(readFileSync(path).equals(Buffer.alloc(1024, index))).toBe(true)
      }
      expect(api.peak()).toBe(4)
    } finally {
      api.close()
    }
  })

  test("fail when a file does not arrive whole", async () => {
    const { sandbox: local } = await sandbox()
    const { host, file } = await downloadHost()
    const api = startDownloadApi(host, { truncate: true })
    try {
      const failed = await downloadIntoSandbox(
        host,
        local,
        [{ path: join(local.workingDirectory, "media/intro.mp4"), file }],
        { timeoutMs: 30_000, signal: new AbortController().signal, executionId: "render_job_1" }
      ).catch((error: unknown) => error)

      expect(String(failed)).toContain("did not arrive whole")
    } finally {
      api.close()
    }
  })

  test("need the API's origin, which the render's sandbox is opened to", async () => {
    expect(() => renderApiOrigin({})).toThrow("SIXB_API_PUBLIC_ORIGIN")

    const networks: (SandboxNetworkPolicy | undefined)[] = []
    const factory = {
      create: async (options: { readonly network?: SandboxNetworkPolicy }) => {
        networks.push(options.network)
        return { destroy: async () => {} } as unknown as Sandbox
      },
    }
    await inRenderSandbox(
      { sandboxes: factory },
      "fetches",
      {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        reach: ["http://api.example.test:3000"],
      },
      async () => null
    )

    expect(networks[0]).toMatchObject({
      mode: "restricted",
      allow: expect.arrayContaining([
        { name: "api.example.test", origin: "http://api.example.test:3000" },
      ]),
    })
  })
})

describe("a large file a render wrote", () => {
  // Reproduce by reading it with readSandboxFiles and putting the bytes: blob storage gets one
  // chunk the file's size.
  test("streams into blob storage a piece at a time, no command printing a mebibyte", async () => {
    const { sandbox: local, printed } = await sandbox()
    const video = Buffer.alloc(3 * 1024 * 1024 + 11, 5)
    writeFileSync(join(local.workingDirectory, "export.mp4"), video)
    const blobStorage = new InMemoryBlobStorage()
    const chunks: number[] = []
    const put: BlobStorage["put"] = async (input) => {
      const body = input.body as ReadableStream<Uint8Array>
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            chunks.push(chunk.byteLength)
            controller.enqueue(chunk)
          },
        })
      )
      return blobStorage.put({ ...input, body: counted })
    }

    const file: FileRef = await storeSandboxFile(
      { put },
      local,
      {
        path: join(local.workingDirectory, "export.mp4"),
        bytes: video.length,
        fileName: "export.mp4",
        mediaType: "video/mp4",
      },
      { signal: new AbortController().signal }
    )

    expect(file).toMatchObject({ sizeBytes: video.length, mediaType: "video/mp4" })
    const stored = Buffer.from(
      await new Response(await blobStorage.open(file.blobId)).arrayBuffer()
    )
    expect(stored.equals(video)).toBe(true)
    expect(Math.max(...chunks)).toBeLessThanOrEqual(512 * 1024)
    expect(Math.max(...printed)).toBeLessThan(1024 * 1024)
  })
})

import { describe, expect, test } from "bun:test"
import type {
  BlobStorage,
  CommandResult,
  RunCommandOptions,
  Sandbox,
  SandboxFileRecord,
} from "@sixb/core"
import { InMemoryBlobStorage } from "@sixb/core"
import { AgentToolArtifactBudget, createAgentToolArtifacts } from "../src/tools/artifacts"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("agent tool artifacts", () => {
  test("stores detected image bytes and materializes them under a safe sandbox path", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const sandbox = new ArtifactSandbox()
    const artifacts = createAgentToolArtifacts({
      toolName: "create_image",
      toolCallId: "../../unsafe provider call id",
      signal: new AbortController().signal,
      blobStorage,
      resolveSandbox: async () => ({ sandbox }),
    })

    const artifact = await artifacts.put({
      body: PNG_BYTES,
      fileName: "generated image.png",
    })

    expect(artifact.fileRef).toMatchObject({
      sizeBytes: PNG_BYTES.byteLength,
      fileName: "generated image.png",
      mediaType: "image/png",
    })
    expect(artifact.sandboxPath).toStartWith(`${sandbox.workingDirectory}/.sixb/agent/artifacts/`)
    expect(artifact.sandboxPath).toEndWith("-generated image.png")
    expect(artifact.sandboxPath).not.toContain("../")

    const written = sandbox.writtenFiles[0]
    expect(written?.path).toStartWith(".sixb/agent/artifacts/")
    expect(written?.path).not.toContain("..")
    expect(written?.contents).toEqual(PNG_BYTES)
    expect(
      new Uint8Array(
        await new Response(await blobStorage.open(artifact.fileRef.blobId)).arrayBuffer()
      )
    ).toEqual(PNG_BYTES)
  })

  test("rejects unsafe file names before storing or provisioning a sandbox", async () => {
    let sandboxResolutions = 0
    const sandbox = new ArtifactSandbox()
    const artifacts = createAgentToolArtifacts({
      toolName: "create_image",
      toolCallId: "call-1",
      signal: new AbortController().signal,
      blobStorage: new InMemoryBlobStorage(),
      resolveSandbox: async () => {
        sandboxResolutions += 1
        return { sandbox }
      },
    })

    for (const fileName of [
      "../generated.png",
      "/generated.png",
      "nested\\image.png",
      "bad\nname",
    ]) {
      await expect(
        artifacts.put({ body: PNG_BYTES, fileName, mediaType: "image/png" })
      ).rejects.toThrow("artifact fileName must be a single safe file name")
    }
    expect(sandboxResolutions).toBe(0)
    expect(sandbox.writtenFiles).toEqual([])
  })

  test("rejects bodies over the file limit while reading a stream", async () => {
    let sandboxResolutions = 0
    const artifacts = createAgentToolArtifacts({
      toolName: "create_file",
      toolCallId: "call-2",
      signal: new AbortController().signal,
      blobStorage: new InMemoryBlobStorage(),
      resolveSandbox: async () => {
        sandboxResolutions += 1
        return { sandbox: new ArtifactSandbox() }
      },
      fileMaxBytes: 4,
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5))
      },
    })

    await expect(artifacts.put({ body, fileName: "large.bin" })).rejects.toThrow(
      "artifact is 5 bytes and exceeds the 4-byte file limit"
    )
    expect(sandboxResolutions).toBe(0)
  })

  test("rejects a declared image type that does not match the bytes", async () => {
    let sandboxResolutions = 0
    const artifacts = createAgentToolArtifacts({
      toolName: "create_image",
      toolCallId: "call-3",
      signal: new AbortController().signal,
      blobStorage: new InMemoryBlobStorage(),
      resolveSandbox: async () => {
        sandboxResolutions += 1
        return { sandbox: new ArtifactSandbox() }
      },
    })

    await expect(
      artifacts.put({ body: PNG_BYTES, fileName: "generated.jpg", mediaType: "image/jpeg" })
    ).rejects.toThrow("artifact bytes are image/png, not the declared media type image/jpeg")
    expect(sandboxResolutions).toBe(0)
  })

  test("atomically enforces one run budget across parallel tool calls", async () => {
    const stored = new InMemoryBlobStorage()
    const uploadStarted = Promise.withResolvers<void>()
    const releaseUpload = Promise.withResolvers<void>()
    const blobStorage: BlobStorage = {
      async put(input) {
        uploadStarted.resolve()
        await releaseUpload.promise
        return stored.put(input)
      },
      open: (blobId) => stored.open(blobId),
      stat: (blobId) => stored.stat(blobId),
    }
    const budget = new AgentToolArtifactBudget(6)
    const sandbox = new ArtifactSandbox()
    const createPublisher = (toolCallId: string) =>
      createAgentToolArtifacts({
        toolName: "create_file",
        toolCallId,
        signal: new AbortController().signal,
        blobStorage,
        budget,
        fileMaxBytes: 10,
        resolveSandbox: async () => ({ sandbox }),
      })

    const first = createPublisher("parallel-1").put({
      body: new Uint8Array(4),
      fileName: "first.bin",
    })
    await uploadStarted.promise
    await expect(
      createPublisher("parallel-2").put({
        body: new Uint8Array(4),
        fileName: "second.bin",
      })
    ).rejects.toThrow("artifacts exceed the 6-byte run limit")

    releaseUpload.resolve()
    await expect(first).resolves.toMatchObject({ fileRef: { sizeBytes: 4 } })
    expect(budget.reservedBytes).toBe(4)
    expect(sandbox.writtenFiles).toHaveLength(1)
  })

  test("propagates cancellation into an upload and releases its run reservation", async () => {
    const uploadStarted = Promise.withResolvers<void>()
    let receivedSignal: AbortSignal | undefined
    const blobStorage: BlobStorage = {
      put(input) {
        receivedSignal = input.signal
        uploadStarted.resolve()
        return new Promise((_, reject) => {
          const rejectOnAbort = () => reject(input.signal?.reason)
          input.signal?.addEventListener("abort", rejectOnAbort, { once: true })
        })
      },
      async open() {
        throw new Error("unused")
      },
      async stat() {
        return null
      },
    }
    const abort = new AbortController()
    const budget = new AgentToolArtifactBudget(10)
    const sandbox = new ArtifactSandbox()
    const artifacts = createAgentToolArtifacts({
      toolName: "create_file",
      toolCallId: "cancelled-upload",
      signal: abort.signal,
      blobStorage,
      budget,
      resolveSandbox: async () => ({ sandbox }),
    })

    const upload = artifacts.put({ body: new Uint8Array(4), fileName: "cancelled.bin" })
    await uploadStarted.promise
    const reason = new Error("stop upload")
    abort.abort(reason)

    await expect(upload).rejects.toBe(reason)
    expect(receivedSignal).toBe(abort.signal)
    expect(budget.reservedBytes).toBe(0)
    expect(sandbox.writtenFiles).toEqual([])
  })
})

class ArtifactSandbox implements Sandbox {
  readonly id = "artifact-sandbox"
  readonly provider = "test"
  readonly workingDirectory = "/workspace"
  readonly status = "running"
  readonly writtenFiles: SandboxFileRecord[] = []

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    this.writtenFiles.push(...files)
  }

  async runCommand(
    _command: string,
    _args?: readonly string[],
    _options?: RunCommandOptions
  ): Promise<CommandResult> {
    throw new Error("runCommand is not used by artifact publishing tests")
  }

  async stop(): Promise<void> {}

  async destroy(): Promise<void> {}
}

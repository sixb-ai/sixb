import { describe, expect, test } from "bun:test"
import type {
  CommandResult,
  JsonValue,
  RunCommandOptions,
  Sandbox,
  SandboxFileRecord,
} from "@sixb/core"
import { InMemoryBlobStorage } from "@sixb/core"
import type { ModelTool } from "@sixb/core/models"
import type { PreparedAgentAttachmentContext } from "../src/attachments"
import { AgentSandboxFileRegistry } from "../src/sandbox-file-registry"
import { createAgentToolArtifacts } from "../src/tools/artifacts"
import { createViewFileTool } from "../src/tools/view-file"

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  )
)

describe("view_file tool", () => {
  test("reuses a FileRef registered by another tool without republishing it", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await blobStorage.put({
      body: PNG_BYTES,
      fileName: "generated.png",
      mediaType: "image/png",
    })
    const sandbox = new ViewFileSandbox()
    const registry = new AgentSandboxFileRegistry()
    const artifactPath = `${sandbox.workingDirectory}/.sixb/agent/artifacts/generated.png`
    registry.register(artifactPath, fileRef)
    let publications = 0
    const viewFile = executableViewFileTool(
      createViewFileTool({
        resolveSandbox: async () => ({ sandbox }),
        attachments: emptyAttachments(),
        registry,
        artifactsForToolCall: () => {
          publications += 1
          throw new Error("Known files must not be republished.")
        },
        toolResultToModelOutput: unusedToolResultProjection,
      })
    )

    const output = await viewFile.execute({ path: artifactPath })

    expect(output).toMatchObject({
      kind: "agentToolResult",
      content: [
        { type: "text", text: expect.stringContaining("Prepared image") },
        { type: "file", fileRef },
      ],
    })
    expect(JSON.stringify(output)).not.toContain(artifactPath)
    expect(publications).toBe(0)
    expect(sandbox.commands).toHaveLength(0)
  })

  test("rereads and republishes a mutable bash-created image", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const sandbox = new ViewFileSandbox()
    sandbox.files.set(`${sandbox.workingDirectory}/scratch/bash-image.bin`, PNG_BYTES)
    const registry = new AgentSandboxFileRegistry()
    let publications = 0
    const viewFile = executableViewFileTool(
      createViewFileTool({
        resolveSandbox: async () => ({ sandbox }),
        attachments: emptyAttachments(),
        registry,
        artifactsForToolCall: ({ toolCallId, signal }) => {
          publications += 1
          return createAgentToolArtifacts({
            toolName: "view_file",
            toolCallId,
            signal,
            blobStorage,
            resolveSandbox: async () => ({ sandbox }),
          })
        },
        toolResultToModelOutput: unusedToolResultProjection,
      })
    )

    const first = await viewFile.execute({ path: "scratch/bash-image.bin" })
    const updatedBytes = Uint8Array.from([...PNG_BYTES, 0])
    sandbox.files.set(`${sandbox.workingDirectory}/scratch/bash-image.bin`, updatedBytes)
    const second = await viewFile.execute({ path: "scratch/bash-image.bin" })

    expect(first).toMatchObject({
      kind: "agentToolResult",
      content: [
        { type: "text" },
        { type: "file", fileRef: { fileName: "bash-image.bin", mediaType: "image/png" } },
      ],
    })
    expect(second).toMatchObject({
      kind: "agentToolResult",
      content: [
        { type: "text" },
        {
          type: "file",
          fileRef: {
            fileName: "bash-image.bin",
            mediaType: "image/png",
            sizeBytes: updatedBytes.byteLength,
          },
        },
      ],
    })
    expect(second).not.toEqual(first)
    expect(publications).toBe(2)
    expect(sandbox.commands).toHaveLength(2)
    expect(sandbox.writtenFiles.some((file) => file.path.includes(".sixb/agent/artifacts/"))).toBe(
      true
    )
  })

  test("returns clear metadata for formats that cannot be rendered as images", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await blobStorage.put({
      body: new TextEncoder().encode("%PDF-1.7\n"),
      fileName: "report.pdf",
      mediaType: "application/pdf",
    })
    const sandbox = new ViewFileSandbox()
    const registry = new AgentSandboxFileRegistry()
    const path = `${sandbox.workingDirectory}/report.pdf`
    registry.register(path, fileRef)
    const viewFile = executableViewFileTool(
      createViewFileTool({
        resolveSandbox: async () => ({ sandbox }),
        attachments: emptyAttachments(),
        registry,
        artifactsForToolCall: () => {
          throw new Error("unused")
        },
        toolResultToModelOutput: unusedToolResultProjection,
      })
    )

    const output = await viewFile.execute({ path })

    expect(JSON.stringify(output)).toContain("application/pdf")
    expect(JSON.stringify(output)).toContain("Prepared file")
    expect(JSON.stringify(output)).not.toContain(path)
  })

  test("registers a current sandbox path when reusing a prepared attachment", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await blobStorage.put({
      body: PNG_BYTES,
      fileName: "historical.png",
      mediaType: "image/png",
    })
    const sandbox = new ViewFileSandbox()
    const relativePath = ".sixb/agent/attachments/message-1/0-historical.png"
    const absolutePath = `${sandbox.workingDirectory}/${relativePath}`
    const attachments: PreparedAgentAttachmentContext = {
      ...emptyAttachments(),
      sandboxFiles: [{ key: "file", path: relativePath, bytes: PNG_BYTES, fileRef }],
    }
    const registry = new AgentSandboxFileRegistry()
    const viewFile = executableViewFileTool(
      createViewFileTool({
        resolveSandbox: async () => ({ sandbox }),
        attachments,
        registry,
        artifactsForToolCall: () => {
          throw new Error("Prepared files must not be republished.")
        },
        toolResultToModelOutput: unusedToolResultProjection,
      })
    )

    await viewFile.execute({ path: relativePath })

    expect(registry.pathFor(fileRef)).toBe(absolutePath)
    expect(sandbox.commands).toHaveLength(0)
  })

  test("keeps distinct paths for references with identical bytes and different metadata", () => {
    const registry = new AgentSandboxFileRegistry()
    const digest = `sha256:${"a".repeat(64)}` as const
    const blobId = `blob_${"a".repeat(64)}`
    const first = { blobId, digest, sizeBytes: 1, fileName: "first.png", mediaType: "image/png" }
    const second = { blobId, digest, sizeBytes: 1, fileName: "second.png", mediaType: "image/png" }

    registry.register("/workspace/first.png", first)
    registry.register("/workspace/second.png", second)

    expect(registry.pathFor(first)).toBe("/workspace/first.png")
    expect(registry.pathFor(second)).toBe("/workspace/second.png")
  })

  test("rejects paths outside the sandbox before reading them", async () => {
    const sandbox = new ViewFileSandbox()
    const viewFile = executableViewFileTool(
      createViewFileTool({
        resolveSandbox: async () => ({ sandbox }),
        attachments: emptyAttachments(),
        registry: new AgentSandboxFileRegistry(),
        artifactsForToolCall: () => {
          throw new Error("unused")
        },
        toolResultToModelOutput: unusedToolResultProjection,
      })
    )

    await expect(viewFile.execute({ path: "../../etc/passwd" })).rejects.toThrow(
      "path must stay inside the sandbox working directory"
    )
    expect(sandbox.commands).toHaveLength(0)
  })
})

function unusedToolResultProjection(): { readonly type: "text"; readonly value: string } {
  return { type: "text", value: "unused" }
}

function executableViewFileTool(definition: ModelTool<{ readonly path: string }>): {
  execute(input: { readonly path: string }): Promise<JsonValue>
} {
  return {
    execute: (input) =>
      definition.execute(definition.parseInput(input), {
        toolCallId: "view-call-1",
        callId: "view-model-call-1",
        signal: new AbortController().signal,
      }),
  }
}

function emptyAttachments(): PreparedAgentAttachmentContext {
  return {
    entries: [],
    promptTextByPartKey: new Map(),
    modelFileDataByPartKey: new Map(),
    sandboxFiles: [],
    manifestJson: JSON.stringify({ attachments: [] }),
  }
}

class ViewFileSandbox implements Sandbox {
  readonly id = "view-file-sandbox"
  readonly provider = "test"
  readonly status = "running"
  readonly workingDirectory = "/workspace"
  readonly files = new Map<string, Uint8Array>()
  readonly commands: Array<{ readonly command: string; readonly args: readonly string[] }> = []
  readonly writtenFiles: SandboxFileRecord[] = []

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    this.writtenFiles.push(...files)
    for (const file of files) {
      const path = file.path.startsWith("/") ? file.path : `${this.workingDirectory}/${file.path}`
      this.files.set(
        path,
        typeof file.contents === "string"
          ? new TextEncoder().encode(file.contents)
          : new Uint8Array(file.contents)
      )
    }
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.commands.push({ command, args })
    const encodedPath = options.env?.SIXB_VIEW_FILE_PATH_B64
    const path = encodedPath ? Buffer.from(encodedPath, "base64").toString("utf-8") : ""
    const bytes = this.files.get(path)
    if (!bytes) {
      return { exitCode: 2, stdout: "", stderr: "missing", durationMs: 1 }
    }
    return {
      exitCode: 0,
      stdout: `${bytes.byteLength}\n${Buffer.from(bytes).toString("base64")}`,
      stderr: "",
      durationMs: 1,
    }
  }

  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

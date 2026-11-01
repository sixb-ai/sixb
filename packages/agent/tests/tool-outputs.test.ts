import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type AgentToolResult,
  type CommandResult,
  type FileRef,
  InMemoryBlobStorage,
  type RunCommandOptions,
  type Sandbox,
  type SandboxFileRecord,
} from "@sixb/core"
import type { JsonValue, ModelTool, ModelToolOutput } from "@sixb/core/models"
import { exec } from "@sixb/core/sandboxes"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { SANDBOX_CONTEXT_DIRECTORY } from "../src/run-sandbox"
import type { AgentSandboxHandle } from "../src/sandbox-handle"
import { type BashToolOutput, createBashTool } from "../src/tools/bash"
import { createReadTool, type ReadToolOutput } from "../src/tools/read"
import { AgentFileBudget } from "../src/tools/tool-files"
import {
  readSavedToolOutputs,
  TOOL_OUTPUT_FILE_MIN_BYTES,
  ToolOutputFiles,
} from "../src/tools/tool-outputs"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("tool outputs too large for the context", () => {
  // Reproduce: return `tools` as they are from ToolOutputFiles.wrap; the model then reads the
  // command's whole output, and its part keeps it all. Keep the whole output in keptOutput; the
  // part then holds 229 KB.
  test("reach the model as a preview, the whole output a stored file the agent reads in pieces", async () => {
    const { root, handle, blobs, files } = await harness()
    const [bash] = files.wrap([createBashTool(async () => handle)])
    const read = createReadTool(async () => handle)

    // 40,000 lines, about 230 KB.
    const output = await bash!.execute({ command: "seq 1 40000" }, context("call_seq"))
    const modelOutput = await bash!.toModelOutput!(output, context("call_seq"))

    const lines = Array.from({ length: 40_000 }, (_, index) => `${index + 1}\n`).join("")
    const path = ".sixb/agent/tool-outputs/call_seq.txt"
    expect(await readFile(join(root, path), "utf8")).toBe(lines)

    // The part keeps a bounded copy, and the stored file holds every byte.
    const kept = output as unknown as BashToolOutput
    expect(kept).toMatchObject({ exitCode: 0, stdoutTruncated: true })
    expect(kept.stdout.length).toBeLessThanOrEqual(20_000)
    const file = files.fileOf("call_seq")
    expect(file?.path).toBe("tool-outputs/call_seq.txt")
    expect(await new Response(await blobs.open(file!.fileRef.blobId)).text()).toBe(lines)

    const notice = String(modelOutput.value)
    expect(modelOutput.type).toBe("text")
    expect(notice).toStartWith(
      `<tool_output_file sandboxPath="${path}" sizeBytes="${lines.length}" lines="40000">`
    )
    expect(notice).toContain("Exit code: 0.")
    expect(notice).toContain("\n1\n2\n3\n")
    expect(notice).toContain("\n39999\n40000\n</tool_output_file>")
    expect(Buffer.byteLength(notice)).toBeLessThan(2_600)

    // The read tool pages through it by lines.
    const piece = (await read.execute(
      read.parseInput({ path, offset: 20_001, limit: 3 }),
      context("call_read")
    )) as unknown as ReadToolOutput
    expect(piece).toMatchObject({ content: "20001\n20002\n20003", nextOffset: 20_004 })
  })

  test("of a project tool are saved indented, its output kept as its author returned it", async () => {
    const { root, files } = await harness()
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ name: `row ${index}`, id: index }))
    const result = { rows }
    const [tool] = files.wrap([jsonTool("list_rows", result)])

    const output = await run(tool!, "call_rows")
    const modelOutput = await tool!.toModelOutput!(output, context("call_rows"))

    expect(output).toBe(result)
    const saved = await readFile(join(root, ".sixb/agent/tool-outputs/call_rows.txt"), "utf8")
    expect(saved).toBe(`${JSON.stringify(result, null, 2)}\n`)
    expect(modelOutput).toMatchObject({ type: "text" })
    expect(String(modelOutput.value)).not.toContain("Exit code")
  })

  // Reproduce: drop the round-trip check in indentedJsonText; the file then holds the large id
  // as 12345678901234567000.
  test("of a command keep its compact JSON indented, unless indenting would change a value", async () => {
    const { root, files } = await harness()
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ id: index, name: `row ${index}` }))
    const compact = JSON.stringify({ rows })
    const exact = compact.replace('"id":0,', '"id":12345678901234567890,')
    const command = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", durationMs: 1 })
    const save = async (toolCallId: string, stdout: string) => {
      const [bash] = files.wrap([jsonTool("bash", command(stdout))])
      await run(bash!, toolCallId)
      return readFile(join(root, `.sixb/agent/tool-outputs/${toolCallId}.txt`), "utf8")
    }

    expect(await save("call_compact", compact)).toBe(`${JSON.stringify({ rows }, null, 2)}\n`)
    expect(await save("call_exact", exact)).toBe(`${exact}\n`)
  })

  test("under the threshold reach the model and the part as they did", async () => {
    const { root, files } = await harness()
    const small = { text: "x".repeat(TOOL_OUTPUT_FILE_MIN_BYTES - 20) }
    const projected: ModelToolOutput = { type: "text", value: "projected" }
    const [plain, projecting] = files.wrap([
      jsonTool("plain", small),
      { ...jsonTool("projecting", small), toModelOutput: () => projected },
    ])

    const output = await run(plain!, "call_plain")
    expect(output).toBe(small)
    // The same value: the loop then stores no second copy as what the model read.
    expect((await plain!.toModelOutput!(output, context("call_plain"))).value).toBe(output)
    expect(await projecting!.toModelOutput!(output, context("call_projecting"))).toBe(projected)
    expect(files.fileOf("call_plain")).toBeUndefined()
    await expect(stat(join(root, ".sixb/agent/tool-outputs"))).rejects.toThrow()
  })

  // Reproduce: drop the FILE_READERS check in ToolOutputFiles.wrap; read and view_file are then
  // wrapped, and a 50 KiB page of a saved output would be saved to yet another file.
  test("from the readers are never saved to another file", async () => {
    const { handle, files } = await harness()
    const read = createReadTool(async () => handle)
    const viewFile = { ...jsonTool("view_file", null) }

    const wrapped = files.wrap([read, viewFile])

    expect(wrapped[0]).toBe(read)
    expect(wrapped[1]).toBe(viewFile)
  })

  test("of a file-aware result keep its files, which its tool projects after the notice", async () => {
    const { blobs, files } = await harness()
    const fileRef = await blobs.put({
      body: new TextEncoder().encode("a,b\n"),
      fileName: "rows.csv",
      mediaType: "text/csv",
    })
    const result: AgentToolResult = {
      kind: "agentToolResult",
      content: [
        { type: "text", text: "y".repeat(40_000) },
        { type: "file", fileRef },
      ],
    }
    const seen: unknown[] = []
    const [tool] = files.wrap([
      {
        ...jsonTool("report", result as unknown as JsonValue),
        toModelOutput: (output) => {
          seen.push(output)
          return { type: "text", value: "projected" }
        },
      },
    ])

    await tool!.toModelOutput!(await run(tool!, "call_report"), context("call_report"))

    expect(seen).toHaveLength(1)
    const projected = seen[0] as AgentToolResult
    expect((projected.content[0] as { text: string }).text).toStartWith("<tool_output_file")
    expect(projected.content[1]).toEqual({ type: "file", fileRef })
  })

  test("that cannot be saved reach the model as their part keeps them", async () => {
    const { handle, blobs } = await harness()
    const failing: AgentSandboxHandle = {
      ...handle,
      sandbox: Object.assign(Object.create(handle.sandbox), {
        writeFiles: async () => {
          throw new Error("[test] disk full")
        },
      }),
    }
    const files = new ToolOutputFiles({
      sandbox: async () => failing,
      blobStorage: blobs,
      budget: new AgentFileBudget(),
    })
    const stdout = "z".repeat(40_000)
    const [bash] = files.wrap([
      jsonTool("bash", { exitCode: 0, stdout, stderr: "", durationMs: 1 }),
    ])
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      const output = await run(bash!, "call_big")
      const modelOutput = await bash!.toModelOutput!(output, context("call_big"))

      // A command's streams bounded, as before outputs went to files.
      expect(output).toMatchObject({ stdoutTruncated: true })
      expect(modelOutput).toEqual({ type: "json", value: output })
      expect(files.fileOf("call_big")).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("saved tool outputs in a later run", () => {
  // Reproduce: return [] from readSavedToolOutputs; nothing is written back.
  test("are read from their stored files, newest first, as far as their budget goes", async () => {
    const blobs = new InMemoryBlobStorage()
    const stored = async (text: string) =>
      blobs.put({
        body: new TextEncoder().encode(text),
        fileName: "out.txt",
        mediaType: "text/plain",
      })
    // Each claims 9 MiB: three fit the 32 MiB budget, the oldest does not.
    const claimed = async (text: string) => ({
      ...(await stored(text)),
      sizeBytes: 9 * 1024 * 1024,
    })
    const parts = await Promise.all(
      [0, 1, 2, 3].map(async (index) =>
        toolCall(`call_${index}`, await claimed(`output ${index}\n`))
      )
    )
    const gone = toolCall("call_gone", {
      ...(await stored("gone\n")),
      blobId: "blob_missing",
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      const saved = await readSavedToolOutputs({
        messages: [message([...parts.slice(0, 2)]), message([...parts.slice(2), gone])],
        contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
        blobStorage: blobs,
      })

      expect(
        saved.map((output) => [output.path, new TextDecoder().decode(output.contents)])
      ).toEqual([
        [".sixb/agent/tool-outputs/call_3.txt", "output 3\n"],
        [".sixb/agent/tool-outputs/call_2.txt", "output 2\n"],
        [".sixb/agent/tool-outputs/call_1.txt", "output 1\n"],
      ])
      // The one whose file is gone is left out, and says so.
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

function jsonTool(name: string, output: JsonValue): ModelTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    parseInput: (value) => value,
    execute: async () => output,
    errorText: () => "failed",
  }
}

function run(tool: ModelTool, toolCallId: string): Promise<JsonValue> {
  return tool.execute({}, context(toolCallId))
}

function context(toolCallId: string) {
  return { signal: new AbortController().signal, callId: "model-call", toolCallId }
}

function message(parts: AgentMessageRecord["parts"]): AgentMessageRecord {
  return { id: "msg_1", parts } as unknown as AgentMessageRecord
}

function toolCall(toolCallId: string, fileRef: FileRef): AgentMessageRecord["parts"][number] {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "bash",
    input: {},
    state: "output-available",
    output: {},
    modelOutput: { type: "text", value: "<tool_output_file" },
    outputFile: { fileRef, path: `tool-outputs/${toolCallId}.txt` },
  }
}

/** A sandbox in a temporary directory, its blob storage, and the run's saved outputs. */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "sixb-tool-outputs-"))
  roots.push(root)
  const handle: AgentSandboxHandle = {
    sandbox: new LocalSandbox(root),
    contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
  }
  const blobs = new InMemoryBlobStorage()
  const files = new ToolOutputFiles({
    sandbox: async () => handle,
    blobStorage: blobs,
    budget: new AgentFileBudget(),
  })
  return { root, handle, blobs, files }
}

/** Runs commands in a temporary directory, and writes files there. */
class LocalSandbox implements Sandbox {
  readonly id = "tool-outputs-test"
  readonly provider = "test"
  readonly status = "running" as const

  constructor(readonly workingDirectory: string) {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    return exec({
      argv: [command, ...args],
      cwd: this.workingDirectory,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(options.env ?? {}) },
      timeoutMs: options.timeout,
      signal: options.signal,
    })
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    for (const file of files) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.contents)
    }
  }

  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

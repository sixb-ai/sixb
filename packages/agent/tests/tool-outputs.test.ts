import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type AgentToolResult,
  type CommandResult,
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
import { createBashTool } from "../src/tools/bash"
import { createReadTool, type ReadToolOutput } from "../src/tools/read"
import {
  replayedToolOutputs,
  TOOL_OUTPUT_FILE_MIN_BYTES,
  toolOutputPath,
  withToolOutputFiles,
} from "../src/tools/tool-outputs"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("tool outputs too large for the context", () => {
  // Reproduce: return `tools` as they are from withToolOutputFiles; the model then reads the
  // command's whole output.
  test("reach the model as a preview, the whole output in a file the agent reads in pieces", async () => {
    const { root, handle } = await localSandbox()
    const [bash] = withToolOutputFiles([createBashTool(async () => handle)], async () => handle)
    const read = createReadTool(async () => handle)

    // 40,000 lines, about 230 KB.
    const output = await bash!.execute({ command: "seq 1 40000" }, context("call_seq"))
    const modelOutput = await bash!.toModelOutput!(output, context("call_seq"))

    const path = toolOutputPath(SANDBOX_CONTEXT_DIRECTORY, "call_seq")
    const saved = await readFile(join(root, path), "utf8")
    const lines = Array.from({ length: 40_000 }, (_, index) => `${index + 1}\n`).join("")
    expect(saved).toBe(lines)

    expect(modelOutput.type).toBe("text")
    const notice = String(modelOutput.value)
    expect(
      notice.startsWith(
        `<tool_output_file sandboxPath="${path}" sizeBytes="${saved.length}" lines="40000">`
      )
    ).toBe(true)
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

  test("are saved from a project tool's JSON indented, its keys sorted, so each value has a line", async () => {
    const { root, handle } = await localSandbox()
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ name: `row ${index}`, id: index }))
    const [tool] = withToolOutputFiles([jsonTool("list_rows", { rows })], async () => handle)

    const modelOutput = await tool!.toModelOutput!(await run(tool!), context("call_rows"))

    const saved = await readFile(join(root, toolOutputPath(".sixb/agent", "call_rows")), "utf8")
    expect(JSON.parse(saved)).toEqual({ rows })
    expect(saved.split("\n")[3]).toBe('      "id": 0,')
    expect(modelOutput).toMatchObject({ type: "text" })
    expect(String(modelOutput.value)).not.toContain("Exit code")
  })

  // Reproduce: drop the round-trip check in indentedJsonText; the file then holds the large id
  // as 12345678901234567000.
  test("of a command keep its compact JSON indented, unless indenting would change a value", async () => {
    const { root, handle } = await localSandbox()
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ id: index, name: `row ${index}` }))
    const compact = JSON.stringify({ rows })
    const exact = compact.replace('"id":0,', '"id":12345678901234567890,')
    const command = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", durationMs: 1 })
    const save = async (toolCallId: string, stdout: string) => {
      const [bash] = withToolOutputFiles([jsonTool("bash", command(stdout))], async () => handle)
      await bash!.toModelOutput!(command(stdout), context(toolCallId))
      return readFile(join(root, toolOutputPath(SANDBOX_CONTEXT_DIRECTORY, toolCallId)), "utf8")
    }

    expect(await save("call_compact", compact)).toBe(`${JSON.stringify({ rows }, null, 2)}\n`)
    expect(await save("call_exact", exact)).toBe(`${exact}\n`)
  })

  test("under the threshold reach the model as they did", async () => {
    const { root, handle } = await localSandbox()
    const small = { text: "x".repeat(TOOL_OUTPUT_FILE_MIN_BYTES - 20) }
    const projected: ModelToolOutput = { type: "text", value: "projected" }
    const [plain, projecting] = withToolOutputFiles(
      [
        jsonTool("plain", small),
        { ...jsonTool("projecting", small), toModelOutput: () => projected },
      ],
      async () => handle
    )

    const output = await run(plain!)
    // The same value: the loop then stores no second copy as what the model read.
    expect((await plain!.toModelOutput!(output, context("call_plain"))).value).toBe(output)
    expect(await projecting!.toModelOutput!(output, context("call_projecting"))).toBe(projected)
    await expect(stat(join(root, ".sixb/agent/tool-outputs"))).rejects.toThrow()
  })

  // Reproduce: drop the FILE_READERS check in withToolOutputFiles; read and view_file are then
  // wrapped, and a 50 KiB page of a saved output would be saved to yet another file.
  test("from the readers are never saved to another file", async () => {
    const { handle } = await localSandbox()
    const read = createReadTool(async () => handle)
    const viewFile = { ...jsonTool("view_file", null) }

    const wrapped = withToolOutputFiles([read, viewFile], async () => handle)

    expect(wrapped[0]).toBe(read)
    expect(wrapped[1]).toBe(viewFile)
  })

  test("of a file-aware result keep its files, which its tool projects after the notice", async () => {
    const { handle } = await localSandbox()
    const fileRef = await new InMemoryBlobStorage().put({
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
    const tool: ModelTool = {
      ...jsonTool("report", result as unknown as JsonValue),
      toModelOutput: (output) => {
        seen.push(output)
        return { type: "text", value: "projected" }
      },
    }

    await withToolOutputFiles([tool], async () => handle)[0]!.toModelOutput!(
      result as unknown as JsonValue,
      context("call_report")
    )

    expect(seen).toHaveLength(1)
    const projected = seen[0] as AgentToolResult
    expect(projected.content[0]).toMatchObject({ type: "text" })
    expect((projected.content[0] as { text: string }).text).toStartWith("<tool_output_file")
    expect(projected.content[1]).toEqual({ type: "file", fileRef })
  })

  test("reach the model whole when the sandbox cannot take the file", async () => {
    const { handle } = await localSandbox()
    const failing: AgentSandboxHandle = {
      ...handle,
      sandbox: Object.assign(Object.create(handle.sandbox), {
        writeFiles: async () => {
          throw new Error("[test] disk full")
        },
      }),
    }
    const output = { text: "z".repeat(40_000) }
    const [tool] = withToolOutputFiles([jsonTool("big", output)], async () => failing)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      expect(await tool!.toModelOutput!(output, context("call_big"))).toEqual({
        type: "json",
        value: output,
      })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("saved tool outputs in a later run", () => {
  // Reproduce: drop sortedKeys from outputText; the stored copy, its keys in jsonb's order, then
  // gives another file, which no longer matches what its notice names, and nothing is written.
  test("are written again from the stored output, whatever key order storage keeps", async () => {
    const { root, handle } = await localSandbox()
    const output = {
      title: "Rows",
      rows: Array.from({ length: 2_000 }, (_, id) => ({ name: `r${id}`, id })),
    }
    const [tool] = withToolOutputFiles([jsonTool("list_rows", output)], async () => handle)
    const modelOutput = await tool!.toModelOutput!(output, context("call_rows"))
    const path = toolOutputPath(SANDBOX_CONTEXT_DIRECTORY, "call_rows")
    const saved = await readFile(join(root, path), "utf8")

    const stored = {
      title: "Rows",
      rows: output.rows.map(({ name, id }) => ({ id, name })),
    }
    const replayed = replayedToolOutputs(
      [
        message([
          toolCall("call_rows", "list_rows", stored, String(modelOutput.value)),
          // A notice naming a file this output does not give: written by nothing.
          toolCall(
            "call_other",
            "list_rows",
            stored,
            String(modelOutput.value)
              .replace("call_rows", "call_other")
              .replace(/lines="\d+"/, 'lines="1"')
          ),
          toolCall("call_small", "list_rows", { rows: [] }, "<tool_output_file"),
        ]),
      ],
      SANDBOX_CONTEXT_DIRECTORY
    )

    expect(replayed).toEqual([{ path, contents: saved }])
  })

  test("are written newest first, as far as their budget goes", () => {
    const big = "w".repeat(9 * 1024 * 1024)
    const parts = [0, 1, 2, 3].map((index) =>
      toolCall(`call_${index}`, "big", { text: big }, noticeFor(`call_${index}`, { text: big }))
    )

    const replayed = replayedToolOutputs([message(parts)], SANDBOX_CONTEXT_DIRECTORY)

    expect(replayed.map((output) => output.path)).toEqual([
      toolOutputPath(SANDBOX_CONTEXT_DIRECTORY, "call_3"),
      toolOutputPath(SANDBOX_CONTEXT_DIRECTORY, "call_2"),
      toolOutputPath(SANDBOX_CONTEXT_DIRECTORY, "call_1"),
    ])
  })
})

/** The opening of the notice a call's output gets, as the tool would write it. */
function noticeFor(toolCallId: string, output: { readonly text: string }): string {
  const contents = `${JSON.stringify(output, null, 2)}\n`
  const lines = contents.split("\n").length - 1
  return `<tool_output_file sandboxPath="${toolOutputPath(SANDBOX_CONTEXT_DIRECTORY, toolCallId)}" sizeBytes="${Buffer.byteLength(contents)}" lines="${lines}">`
}

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

async function run(tool: ModelTool): Promise<JsonValue> {
  return tool.execute({}, context("call_run"))
}

function context(toolCallId: string) {
  return { signal: new AbortController().signal, callId: "model-call", toolCallId }
}

function message(parts: AgentMessageRecord["parts"]): AgentMessageRecord {
  return { id: "msg_1", parts } as unknown as AgentMessageRecord
}

function toolCall(
  toolCallId: string,
  toolName: string,
  output: JsonValue,
  modelText: string
): AgentMessageRecord["parts"][number] {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    input: {},
    state: "output-available",
    output,
    modelOutput: { type: "text", value: modelText },
  }
}

/** A sandbox that runs commands in a temporary directory, and writes files there. */
async function localSandbox(): Promise<{
  readonly root: string
  readonly handle: AgentSandboxHandle
}> {
  const root = await mkdtemp(join(tmpdir(), "sixb-tool-outputs-"))
  roots.push(root)
  return {
    root,
    handle: { sandbox: new LocalSandbox(root), contextDirectory: SANDBOX_CONTEXT_DIRECTORY },
  }
}

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

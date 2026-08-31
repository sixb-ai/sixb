import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandResult, RunCommandOptions, Sandbox, SandboxFileRecord } from "@sixb/core"
import type { ModelTool } from "@sixb/core/models"
import { exec } from "@sixb/core/sandboxes"
import { createReadTool, type ReadToolInput, type ReadToolOutput } from "../src/read-tool"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("read tool", () => {
  test("reads and continues through the line cap", async () => {
    const { root, read } = await createHarness()
    const lines = Array.from({ length: 2_002 }, (_, index) => `line ${index + 1}`)
    await writeFile(join(root, "large.txt"), lines.join("\n"))

    const first = await read({ path: "large.txt", limit: 5_000 })
    expect(first).toMatchObject({
      path: "large.txt",
      startLine: 1,
      endLine: 2_000,
      truncated: true,
      nextOffset: 2_001,
    })
    expect(first.content.split("\n")).toEqual(lines.slice(0, 2_000))

    await expect(read({ path: "large.txt", offset: first.nextOffset })).resolves.toEqual({
      path: "large.txt",
      content: lines.slice(2_000).join("\n"),
      startLine: 2_001,
      endLine: 2_002,
      truncated: false,
    })
  })

  test("stops before the byte cap without splitting a line", async () => {
    const { root, read } = await createHarness()
    const firstLine = "a".repeat(30_000)
    const secondLine = "😀".repeat(10_000)
    await writeFile(join(root, "wide.txt"), `${firstLine}\n${secondLine}\nlast`)

    await expect(read({ path: "wide.txt" })).resolves.toEqual({
      path: "wide.txt",
      content: firstLine,
      startLine: 1,
      endLine: 1,
      truncated: true,
      nextOffset: 2,
    })
    await expect(read({ path: "wide.txt", offset: 2 })).resolves.toEqual({
      path: "wide.txt",
      content: `${secondLine}\nlast`,
      startLine: 2,
      endLine: 3,
      truncated: false,
    })
  })

  test("accepts an exact 50 KiB line and rejects a larger one", async () => {
    const { root, read } = await createHarness()
    await writeFile(join(root, "exact.txt"), "x".repeat(50 * 1024))
    await writeFile(join(root, "too-wide.txt"), "x".repeat(50 * 1024 + 1))

    expect((await read({ path: "exact.txt" })).content).toHaveLength(50 * 1024)
    await expect(read({ path: "too-wide.txt" })).rejects.toThrow(
      "line 1 of 'too-wide.txt' exceeds the 50 KiB read limit"
    )
  })

  test("handles empty files and rejects offsets past the end", async () => {
    const { root, read } = await createHarness()
    await writeFile(join(root, "empty.txt"), "")
    await writeFile(join(root, "one.txt"), "one\n")

    await expect(read({ path: "empty.txt" })).resolves.toEqual({
      path: "empty.txt",
      content: "",
      startLine: 1,
      endLine: 1,
      truncated: false,
    })
    await expect(read({ path: "one.txt", offset: 2 })).rejects.toThrow(
      "offset 2 is beyond the end of 'one.txt'"
    )
  })

  test("rejects binary and invalid UTF-8 content", async () => {
    const { root, read } = await createHarness()
    await writeFile(join(root, "nul.bin"), new Uint8Array([65, 0, 66]))
    await writeFile(join(root, "invalid.bin"), new Uint8Array([65, 0xff, 66]))

    await expect(read({ path: "nul.bin" })).rejects.toThrow("is binary, not UTF-8 text")
    await expect(read({ path: "invalid.bin" })).rejects.toThrow("is binary, not UTF-8 text")
  })

  test("decodes wrapped Base64 output without a sandbox tr dependency", async () => {
    const encoded = Buffer.from("one\ntwo")
      .toString("base64")
      .replace(/(.{4})/g, "$1\n")
    const { read } = await createHarness(undefined, commandResult({ stdout: ` \t${encoded}\r\n` }))

    await expect(read({ path: "file.txt" })).resolves.toEqual({
      path: "file.txt",
      content: "one\ntwo",
      startLine: 1,
      endLine: 2,
      truncated: false,
    })
  })

  test("reports missing sandbox image commands clearly", async () => {
    for (const [exitCode, command] of [
      [15, "realpath"],
      [16, "tail"],
      [17, "head"],
      [18, "base64"],
    ] as const) {
      const { read } = await createHarness(undefined, commandResult({ exitCode }))
      await expect(read({ path: "file.txt" })).rejects.toThrow(
        `sandbox image is missing '${command}'`
      )
    }
  })

  test("confines reads to the working directory while allowing internal symlinks", async () => {
    const { root, read } = await createHarness()
    const outside = await tempRoot()
    await writeFile(join(root, "inside.txt"), "inside")
    await writeFile(join(outside, "outside.txt"), "outside")
    await symlink(join(root, "inside.txt"), join(root, "inside-link.txt"))
    await symlink(join(outside, "outside.txt"), join(root, "escape.txt"))

    expect((await read({ path: "inside-link.txt" })).content).toBe("inside")
    await expect(read({ path: "escape.txt" })).rejects.toThrow(
      "resolves outside the sandbox working directory"
    )
    await expect(read({ path: "../outside.txt" })).rejects.toThrow(
      "path must stay within the sandbox working directory"
    )
    await expect(read({ path: join(root, "inside.txt") })).rejects.toThrow(
      "path must be a non-empty relative path"
    )
  })

  test("passes unusual paths as command arguments and reports file errors clearly", async () => {
    const { root, read, sandbox } = await createHarness()
    const path = "notes/$draft 'one'.txt"
    await mkdir(join(root, "notes"))
    await writeFile(join(root, path), "safe")

    expect((await read({ path })).content).toBe("safe")
    expect(sandbox.commands.at(-1)?.args.slice(3, 4)).toEqual([path])
    await expect(read({ path: "notes" })).rejects.toThrow("is a directory, not a file")
    await expect(read({ path: "missing.txt" })).rejects.toThrow("does not exist")
    await expect(read({ path: "safe", offset: 0 })).rejects.toThrow(
      "offset must be a positive integer"
    )
    await expect(read({ path: "safe", limit: 1.5 })).rejects.toThrow(
      "limit must be a positive integer"
    )
  })

  test("reports missing files when realpath accepts a missing final component", async () => {
    const shimRoot = await tempRoot()
    await writeFile(join(shimRoot, "realpath"), "#!/bin/sh\nprintf '%s\\n' \"$1\"\n", {
      mode: 0o755,
    })
    const path = [shimRoot, process.env.PATH].filter(Boolean).join(":")
    const { read } = await createHarness({ PATH: path })

    // GNU realpath permits a missing final component by default. Removing READ_SCRIPT's explicit
    // existence check reproduces the Linux regression: this becomes "not a regular file."
    await expect(read({ path: "missing.txt" })).rejects.toThrow("does not exist")
  })

  test("uses the run environment without writes and forwards cancellation", async () => {
    const { root, read, sandbox } = await createHarness({ SIXB_RUN_ID: "run-1" })
    await writeFile(join(root, "file.txt"), "content")
    await read({ path: "file.txt" })

    expect(sandbox.commands[0]?.options.env).toEqual({ SIXB_RUN_ID: "run-1" })
    expect(sandbox.commands[0]?.options.timeout).toBe(30_000)
    expect(sandbox.commands[0]?.options.signal).toBeInstanceOf(AbortSignal)
    expect(sandbox.commands[0]?.args[1]).not.toContain("/dev/null")
    expect(sandbox.commands[0]?.args[1]).not.toContain("tr -d")
    for (const command of ["realpath", "tail", "head", "base64"]) {
      expect(sandbox.commands[0]?.args[1]).toContain(`command -v ${command}`)
    }

    const controller = new AbortController()
    const reason = new Error("cancelled")
    controller.abort(reason)
    await expect(read({ path: "file.txt" }, controller.signal)).rejects.toBe(reason)
  })
})

interface RecordedCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunCommandOptions
}

class TestSandbox implements Sandbox {
  readonly id = "read-test"
  readonly provider = "test"
  readonly status = "running" as const
  readonly commands: RecordedCommand[] = []

  constructor(
    readonly workingDirectory: string,
    private readonly result?: CommandResult
  ) {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.commands.push({ command, args, options })
    if (this.result) return this.result
    return exec({
      argv: [command, ...args],
      cwd: options.cwd ?? this.workingDirectory,
      env: { ...hostEnv(), ...(options.env ?? {}) },
      timeoutMs: options.timeout,
      signal: options.signal,
    })
  }

  async writeFiles(_files: readonly SandboxFileRecord[]): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

async function createHarness(
  env?: Readonly<Record<string, string>>,
  result?: CommandResult
): Promise<{
  readonly root: string
  readonly sandbox: TestSandbox
  readonly read: (input: ReadToolInput, signal?: AbortSignal) => Promise<ReadToolOutput>
}> {
  const root = await tempRoot()
  const sandbox = new TestSandbox(root, result)
  const definition = createReadTool(() => Promise.resolve({ sandbox, env }))
  const execute = executableTool(definition)
  return {
    root,
    sandbox,
    read: (input, signal = new AbortController().signal) => execute(input, signal),
  }
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, ...overrides }
}

function executableTool(
  definition: ModelTool<ReadToolInput>
): (input: ReadToolInput, signal: AbortSignal) => Promise<ReadToolOutput> {
  return async (input, signal) =>
    (await definition.execute(definition.parseInput(input), {
      signal,
      callId: "read-model-call",
      toolCallId: "read-tool-call",
    })) as unknown as ReadToolOutput
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sixb-read-tool-"))
  roots.push(root)
  return root
}

function hostEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

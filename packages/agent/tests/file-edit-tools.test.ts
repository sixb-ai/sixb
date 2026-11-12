import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandResult, RunCommandOptions, Sandbox, SandboxFileRecord } from "@sixb/core"
import type { ModelTool } from "@sixb/core/models"
import { exec } from "@sixb/core/sandboxes"
import { SANDBOX_CONTEXT_DIRECTORY } from "../src/run-sandbox"
import { createEditTool } from "../src/tools/edit"
import { FileReadLedger } from "../src/tools/file-writes"
import { createReadTool } from "../src/tools/read"
import { createWriteTool } from "../src/tools/write"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("edit", () => {
  // Reproduce: drop assertReadAsIs from edit; it then edits files it never read, and writes over
  // a change made after its read.
  test("changes only a file the run read, as it read it", async () => {
    const { root, read, edit } = await harness()
    await writeFile(join(root, "app.ts"), "const retries = 3\n")

    expect(await failure(edit({ path: "app.ts", old_string: "3", new_string: "5" }))).toBe(
      "[SixbAgent] edit: read 'app.ts' with the read tool before changing it."
    )

    await read({ path: "app.ts" })
    await writeFile(join(root, "app.ts"), "const retries = 4\n")
    expect(await failure(edit({ path: "app.ts", old_string: "4", new_string: "5" }))).toBe(
      "[SixbAgent] edit: 'app.ts' changed since you read it. Read it again, then make your change."
    )

    await read({ path: "app.ts" })
    expect(await edit({ path: "app.ts", old_string: "4", new_string: "5" })).toEqual({
      path: "app.ts",
      replaced: 1,
      diff: "@@ -1,1 +1,1 @@\n-const retries = 4\n+const retries = 5\n",
      added: 1,
      removed: 1,
    })
    // Its own write counts as read: the next edit needs no read in between.
    await edit({ path: "app.ts", old_string: "retries", new_string: "attempts" })
    expect(await readFile(join(root, "app.ts"), "utf8")).toBe("const attempts = 5\n")
  })

  test("keeps the file's mode and its line endings", async () => {
    const { root, read, edit } = await harness()
    const path = join(root, "run.sh")
    await writeFile(path, "#!/bin/sh\r\necho one\r\n")
    await chmod(path, 0o755)

    await read({ path: "run.sh" })
    await edit({ path: "run.sh", old_string: "echo one\n", new_string: "echo two\n" })

    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\r\necho two\r\n")
    expect((await stat(path)).mode & 0o777).toBe(0o755)
  })

  test("refuses what is not a file it may change", async () => {
    const { root, edit } = await harness()
    const outside = await tempRoot()
    await writeFile(join(outside, "secret.txt"), "x")
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"))

    expect(await failure(edit({ path: "missing.ts", old_string: "a", new_string: "b" }))).toBe(
      "[SixbAgent] edit: 'missing.ts' does not exist. Create it with write."
    )
    expect(await failure(edit({ path: "link.txt", old_string: "x", new_string: "y" }))).toBe(
      "[SixbAgent] edit: 'link.txt' resolves outside the working directory and the run's context directory."
    )
    await mkdir(join(root, "dir"))
    expect(await failure(edit({ path: "dir", old_string: "a", new_string: "b" }))).toBe(
      "[SixbAgent] edit: 'dir' is a directory, not a file."
    )
  })
})

describe("write", () => {
  test("creates a file and its folders, and replaces one only after reading it", async () => {
    const { root, read, write } = await harness()

    expect(await write({ path: "src/new/file.ts", content: "a\nb\n" })).toEqual({
      path: "src/new/file.ts",
      created: true,
      lines: 2,
      bytes: 4,
    })
    // What it wrote it may replace.
    await write({ path: "src/new/file.ts", content: "c" })
    expect(await readFile(join(root, "src/new/file.ts"), "utf8")).toBe("c")

    await writeFile(join(root, "notes.md"), "kept\n")
    expect(await failure(write({ path: "notes.md", content: "lost" }))).toBe(
      "[SixbAgent] write: read 'notes.md' with the read tool before changing it."
    )
    await read({ path: "notes.md" })
    expect(await write({ path: "notes.md", content: "new" })).toMatchObject({ created: false })
  })

  test("never writes outside the working directory and the context directory", async () => {
    const { root, write } = await harness()
    const outside = await tempRoot()
    await symlink(outside, join(root, "escape"))

    for (const path of ["../outside.txt", "escape/file.txt", join(outside, "abs.txt")]) {
      expect(await failure(write({ path, content: "x" }))).toBe(
        `[SixbAgent] write: '${path}' resolves outside the working directory and the run's context directory.`
      )
    }
    await write({ path: `${SANDBOX_CONTEXT_DIRECTORY}/out/report.md`, content: "ok" })
    expect(await readFile(join(root, SANDBOX_CONTEXT_DIRECTORY, "out/report.md"), "utf8")).toBe(
      "ok"
    )
  })

  // Reproduce: send the contents in one environment variable; a file past 128 KiB of base64 then
  // fails on Linux, where one variable is capped there.
  test("writes a file larger than one command's environment, byte for byte", async () => {
    const { root, write } = await harness()
    const content = Array.from(
      { length: 6_000 },
      (_, index) => `line ${index} ${"é".repeat(30)}`
    ).join("\n")
    expect(Buffer.byteLength(content)).toBeGreaterThan(300_000)

    await write({ path: "big.txt", content })

    expect(await readFile(join(root, "big.txt"), "utf8")).toBe(content)
  })
})

class TestSandbox implements Sandbox {
  readonly id = "test"
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

async function harness() {
  const root = await tempRoot()
  const sandbox = new TestSandbox(root)
  const handle = async () => ({ sandbox, contextDirectory: SANDBOX_CONTEXT_DIRECTORY })
  const ledger = new FileReadLedger()
  return {
    root,
    read: executable(createReadTool(handle, ledger)),
    edit: executable(createEditTool(handle, ledger)),
    write: executable(createWriteTool(handle, ledger)),
  }
}

function executable<TInput>(tool: ModelTool<TInput>) {
  return (input: unknown) =>
    tool.execute(tool.parseInput(input), {
      signal: new AbortController().signal,
      callId: "call",
      toolCallId: "tool-call",
    })
}

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => new Error("expected a failure"),
    (caught: unknown) => caught
  )
  return error instanceof Error ? error.message : String(error)
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sixb-file-edit-"))
  roots.push(root)
  return root
}

function hostEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

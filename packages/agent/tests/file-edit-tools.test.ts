import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandResult, RunCommandOptions, Sandbox, SandboxFileRecord } from "@sixb/core"
import type { JsonValue, ModelMessage, ModelTool } from "@sixb/core/models"
import { exec } from "@sixb/core/sandboxes"
import { createAgentContextGuard } from "../src/context-guard"
import { SANDBOX_CONTEXT_DIRECTORY } from "../src/run-sandbox"
import { createEditTool } from "../src/tools/edit"
import { SeenFiles } from "../src/tools/file-writes"
import { createReadTool } from "../src/tools/read"
import { createWriteTool } from "../src/tools/write"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("edit", () => {
  // Reproduce: put back the read check edit had ("read 'app.ts' with the read tool before changing
  // it"). Each run starts with nothing read, so a turn then cannot edit a file an earlier one read.
  test("needs no read: old_string must match the file as it is", async () => {
    const { root, edit } = await harness()
    await writeFile(join(root, "app.ts"), "const retries = 3\n")

    expect(await edit({ path: "app.ts", old_string: "3", new_string: "5" })).toEqual({
      path: "app.ts",
      replaced: 1,
      diff: "@@ -1,1 +1,1 @@\n-const retries = 3\n+const retries = 5\n",
      added: 1,
      removed: 1,
    })
    expect(await failure(edit({ path: "app.ts", old_string: "3", new_string: "4" }))).toBe(
      "[SixbAgent] edit: old_string matches nothing in the file. Read the file again and copy the text exactly."
    )
  })

  // Reproduce: drop the note from edit; it then changes a file that holds changes the model has
  // not seen, and says nothing of them. Drop `&& !stale` from it, and write then replaces the file.
  test("says when the file changed since the model read it", async () => {
    const { root, read, edit, write } = await harness()
    await writeFile(join(root, "app.ts"), "const retries = 3\nconst delay = 1\n")
    await read({ path: "app.ts" })
    await writeFile(join(root, "app.ts"), "const retries = 3\nconst delay = 2\n")

    expect(await edit({ path: "app.ts", old_string: "= 3", new_string: "= 5" })).toMatchObject({
      replaced: 1,
      note: "The edit was applied, but 'app.ts' had changed since you last read or changed it, so it holds changes you have not seen. Read it before an edit that depends on what is around this one.",
    })
    // The next edit starts from the version this one left, but the model has still not seen all of it.
    expect(await edit({ path: "app.ts", old_string: "= 5", new_string: "= 6" })).not.toHaveProperty(
      "note"
    )
    expect(await failure(write({ path: "app.ts", content: "lost\n" }))).toBe(notSeenWhole("app.ts"))
  })

  // Reproduce: run edit's body outside seenFiles.change. Both edits then pass the commit's check,
  // and one is lost or the file left torn: on this sandbox, every time.
  test("two edits of one file in one step both land", async () => {
    const { root, sandbox, read, edit } = await harness()
    await writeFile(join(root, "pr.ts"), 'prop("state")\nprop("headRef")\n')
    await read({ path: "pr.ts" })

    const results = await Promise.all([
      edit({ path: "pr.ts", old_string: '"state"', new_string: '"status"' }),
      edit({ path: "pr.ts", old_string: '"headRef"', new_string: '"headBranch"' }),
    ])

    expect(await readFile(join(root, "pr.ts"), "utf8")).toBe('prop("status")\nprop("headBranch")\n')
    expect(sandbox.mostRunning).toBe(1)
    for (const result of results) expect(result).not.toHaveProperty("note")
  })

  // Reproduce: drop the expected fingerprint from the commit, and the edit writes over the change;
  // pass it the real path, and the error names a path the model never wrote.
  test("leaves a file that changes while it is being edited as it is", async () => {
    const { root, sandbox, edit } = await harness()
    const path = join(root, "app.ts")
    await writeFile(path, "const retries = 3\n")
    // Another process writes the file between the edit's load and its commit.
    sandbox.afterCommand = async () => {
      sandbox.afterCommand = undefined
      await writeFile(path, "const retries = 3 // tuned\n")
    }

    expect(await failure(edit({ path: "app.ts", old_string: "3", new_string: "5" }))).toBe(
      "[SixbAgent] edit: 'app.ts' changed while your edit was being saved, so nothing was written. Try again."
    )
    expect(await readFile(path, "utf8")).toBe("const retries = 3 // tuned\n")
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
  test("creates a file and its folders, and replaces one only as the model saw it", async () => {
    const { root, read, edit, write } = await harness()

    expect(await write({ path: "src/new/file.ts", content: "a\nb\n" })).toEqual({
      path: "src/new/file.ts",
      created: true,
      lines: 2,
      bytes: 4,
    })
    // What it wrote it has seen whole.
    await write({ path: "src/new/file.ts", content: "c" })
    expect(await readFile(join(root, "src/new/file.ts"), "utf8")).toBe("c")

    await writeFile(join(root, "notes.md"), "one\ntwo\n")
    expect(await failure(write({ path: "notes.md", content: "lost" }))).toBe(
      notSeenWhole("notes.md")
    )
    await read({ path: "notes.md" })
    // Its own edit of a file it saw whole leaves it seen whole.
    await edit({ path: "notes.md", old_string: "two", new_string: "2" })
    expect(await write({ path: "notes.md", content: "new\n" })).toMatchObject({ created: false })

    await writeFile(join(root, "notes.md"), "changed\n")
    expect(await failure(write({ path: "notes.md", content: "lost" }))).toBe(
      "[SixbAgent] write: 'notes.md' changed since you last read or changed it. Read all of it again first."
    )
  })

  // Reproduce: run write's body outside seenFiles.change. It then loads the file beside the edit,
  // and the two commits race.
  test("takes its turn after an edit of the same step", async () => {
    const { root, sandbox, read, edit, write } = await harness()
    await writeFile(join(root, "app.ts"), "const retries = 3\n")
    await read({ path: "app.ts" })

    await Promise.all([
      edit({ path: "app.ts", old_string: "3", new_string: "5" }),
      write({ path: "app.ts", content: "const attempts = 5\n" }),
    ])

    expect(await readFile(join(root, "app.ts"), "utf8")).toBe("const attempts = 5\n")
    expect(sandbox.mostRunning).toBe(1)
  })

  // Reproduce: record every read as whole in read.ts. A 20-line read then lets write replace all
  // of a 148-line page, as it did in a repository turn.
  test("never replaces a file the model saw only part of", async () => {
    const { root, read, edit, write } = await harness()
    const page = Array.from({ length: 148 }, (_, index) => `line ${index + 1}`).join("\n")
    await writeFile(join(root, "page.tsx"), `${page}\n`)
    const refused = notSeenWhole("page.tsx")

    await read({ path: "page.tsx", limit: 20 })
    expect(await failure(write({ path: "page.tsx", content: "new\n" }))).toBe(refused)
    // Reads that leave a gap after line 20 still leave lines unseen.
    await read({ path: "page.tsx", offset: 30 })
    expect(await failure(write({ path: "page.tsx", content: "new\n" }))).toBe(refused)
    // An edit shows the model only the lines it changes.
    await edit({ path: "page.tsx", old_string: "line 1\n", new_string: "line one\n" })
    expect(await failure(write({ path: "page.tsx", content: "new\n" }))).toBe(refused)
  })

  // Reproduce: let recordRead keep `through` or `whole` across versions; a look at part of a file
  // that changed then counts the whole of the old version as seen.
  test("counts reads that follow on from line 1 to the last, of one version", async () => {
    const { root, read, write } = await harness()
    const lines = (count: number) =>
      `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`
    await writeFile(join(root, "big.ts"), lines(30))

    await read({ path: "big.ts", limit: 20 })
    await read({ path: "big.ts", offset: 21 })
    // A later look at part of the version it saw whole leaves it seen whole.
    await read({ path: "big.ts", offset: 5, limit: 2 })
    expect(await write({ path: "big.ts", content: lines(40) })).toMatchObject({ created: false })

    // Seen whole, changed, then seen only in part: not seen whole.
    await read({ path: "big.ts" })
    await writeFile(join(root, "big.ts"), lines(50))
    await read({ path: "big.ts", offset: 40 })
    expect(await failure(write({ path: "big.ts", content: "new\n" }))).toBe(notSeenWhole("big.ts"))
  })

  // Reproduce: drop the onReadCut call in ContextGuard.reduce, or return at once from
  // SeenFiles.recordCut. A read the guard cut to its first lines then lets write replace all 1,640.
  test("never replaces a file whose read the context guard cut", async () => {
    const { root, seenFiles, read, write } = await harness()
    const lines = Array.from({ length: 1_640 }, (_, index) => `doc line ${index + 1}`)
    await writeFile(join(root, "doc.txt"), `${lines.join("\n")}\n`)
    const page = await read({ path: "doc.txt" }, "call_1")

    let shownThrough = 0
    const guard = createAgentContextGuard({
      // The page is about 8,000 tokens at 3 bytes a token: past this 5,000-token limit.
      budget: {
        windowTokens: 21_384,
        inputBudgetTokens: 5_000,
        reserveTokens: 16_384,
        keepRecentTokens: 2_000,
        source: "model",
        bytesPerToken: 3,
      },
      tools: [],
      onReadCut: (toolCallId, line) => {
        shownThrough = line
        seenFiles.recordCut(toolCallId, line)
      },
    })
    await guard.prepareStep({
      stepIndex: 0,
      messages: readStep("doc.txt", "call_1", page),
      steps: [],
      model: { providerId: "mock", modelId: "model" } as never,
      signal: new AbortController().signal,
    })

    expect(shownThrough).toBeGreaterThan(0)
    expect(shownThrough).toBeLessThan(1_640)
    expect(await failure(write({ path: "doc.txt", content: "new\n" }))).toBe(
      notSeenWhole("doc.txt")
    )

    // The read the cut names shows the rest: the model has then seen all of it.
    await read({ path: "doc.txt", offset: shownThrough + 1 }, "call_2")
    expect(await write({ path: "doc.txt", content: "new\n" })).toMatchObject({ created: false })
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
  /** The most commands that ran at once. */
  mostRunning = 0
  /** Runs after a command, before its caller sees the result. */
  afterCommand: (() => Promise<void>) | undefined
  #running = 0

  constructor(readonly workingDirectory: string) {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.mostRunning = Math.max(this.mostRunning, ++this.#running)
    try {
      const result = await exec({
        argv: [command, ...args],
        cwd: options.cwd ?? this.workingDirectory,
        env: { ...hostEnv(), ...(options.env ?? {}) },
        timeoutMs: options.timeout,
        signal: options.signal,
      })
      await this.afterCommand?.()
      return result
    } finally {
      this.#running -= 1
    }
  }

  async writeFiles(_files: readonly SandboxFileRecord[]): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/** One run's tools, over a new folder. */
async function harness() {
  const root = await tempRoot()
  const sandbox = new TestSandbox(root)
  const handle = async () => ({ sandbox, contextDirectory: SANDBOX_CONTEXT_DIRECTORY })
  const seenFiles = new SeenFiles()
  return {
    root,
    sandbox,
    seenFiles,
    read: executable(createReadTool(handle, seenFiles)),
    edit: executable(createEditTool(handle, seenFiles)),
    write: executable(createWriteTool(handle, seenFiles)),
  }
}

function notSeenWhole(path: string): string {
  return `[SixbAgent] write: you have not seen all of '${path}', and write replaces it whole: read the whole file first, or change part of it with edit.`
}

function executable<TInput>(tool: ModelTool<TInput>) {
  return (input: unknown, toolCallId = "tool-call") =>
    tool.execute(tool.parseInput(input), {
      signal: new AbortController().signal,
      callId: "call",
      toolCallId,
    })
}

/** A step whose one call read `path`, its result not yet read by the model. */
function readStep(path: string, toolCallId: string, page: JsonValue): ModelMessage[] {
  return [
    { role: "system", content: "You read." },
    { role: "user", content: [{ type: "text", text: `Read ${path}.` }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "read", input: { path } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "read",
          output: { type: "json", value: page },
        },
      ],
    },
  ]
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

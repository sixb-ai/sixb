import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandResult, RunCommandOptions, Sandbox, SandboxFileRecord } from "@sixb/core"
import { exec } from "@sixb/core/sandboxes"
import { type AcquiredRunSandbox, acquireRunSandbox, type RunSandbox } from "../src/run-sandbox"
import {
  readWorkspaceInstructions,
  WORKSPACE_INSTRUCTIONS_MAX_BYTES,
} from "../src/workspace-instructions"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("workspace instructions", () => {
  test("are none in a folder without any", async () => {
    const root = await tempRoot()
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await read(root)).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("are the folder's AGENTS.md", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "AGENTS.md"), "# Agents\n\nUse Bun.\n")

    expect(await read(root)).toEqual([{ path: "AGENTS.md", text: "# Agents\n\nUse Bun.\n" }])
  })

  test("are its CLAUDE.md when it has no AGENTS.md", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "CLAUDE.md"), "Use Bun.\n")

    expect(await read(root)).toEqual([{ path: "CLAUDE.md", text: "Use Bun.\n" }])
  })

  test("are its AGENTS.md alone when it has both", async () => {
    // Regression proof: swap the names in the script's loop; CLAUDE.md is then read instead.
    const root = await tempRoot()
    await writeFile(join(root, "AGENTS.md"), "From AGENTS.md\n")
    await writeFile(join(root, "CLAUDE.md"), "From CLAUDE.md\n")

    expect(await read(root)).toEqual([{ path: "AGENTS.md", text: "From AGENTS.md\n" }])
  })

  test.each([
    "directory",
    "file",
  ] as const)("are each folder's from the repository's root down, whose .git is a %s", async (kind) => {
    // Regression proof: drop the reverse in parseRecords; the working directory's file then comes
    // first, and the root's, which it refines, last.
    const outside = await tempRoot()
    const repository = join(outside, "acme")
    const workingDirectory = join(repository, "packages", "web")
    await mkdir(workingDirectory, { recursive: true })
    // A worktree's .git is a file that names its repository.
    if (kind === "directory") await mkdir(join(repository, ".git"))
    else await writeFile(join(repository, ".git"), "gitdir: /elsewhere/.git/worktrees/acme\n")
    await writeFile(join(outside, "AGENTS.md"), "Outside the repository.\n")
    await writeFile(join(repository, "AGENTS.md"), "The repository's.\n")
    await writeFile(join(repository, "packages", "CLAUDE.md"), "The packages'.\n")
    await writeFile(join(workingDirectory, "AGENTS.md"), "The web app's.\n")

    expect(await read(workingDirectory)).toEqual([
      { path: "../../AGENTS.md", text: "The repository's.\n" },
      { path: "../CLAUDE.md", text: "The packages'.\n" },
      { path: "AGENTS.md", text: "The web app's.\n" },
    ])
  })

  test("are the working directory's alone outside a repository", async () => {
    // Regression proof: start the script's root at / rather than the working directory; with no
    // .git found, the parent's file is then read too.
    const outside = await tempRoot()
    const workingDirectory = join(outside, "notes")
    await mkdir(workingDirectory)
    await writeFile(join(outside, "AGENTS.md"), "The parent's.\n")
    await writeFile(join(workingDirectory, "AGENTS.md"), "The folder's.\n")

    expect(await read(workingDirectory)).toEqual([{ path: "AGENTS.md", text: "The folder's.\n" }])
  })

  test("are cut at the size limit after a whole line, and say where they go on", async () => {
    // Regression proof: drop the cut in boundedFiles; the files then come whole, 40 KiB.
    const repository = await tempRoot()
    const workingDirectory = join(repository, "web")
    await mkdir(join(repository, ".git"))
    await mkdir(workingDirectory)
    const line = `${"x".repeat(99)}\n`
    const lines = (count: number) => line.repeat(count)
    // 20,000 bytes, then 20,000 more: the second crosses the limit in its 128th line.
    await writeFile(join(repository, "AGENTS.md"), lines(200))
    await writeFile(join(workingDirectory, "AGENTS.md"), lines(200))

    const files = await read(workingDirectory)

    const kept = Math.floor((WORKSPACE_INSTRUCTIONS_MAX_BYTES - 20_000) / line.length)
    expect(files).toEqual([
      { path: "../AGENTS.md", text: lines(200) },
      { path: "AGENTS.md", text: lines(kept), continuesAtLine: kept + 1 },
    ])
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0)
    expect(total).toBeLessThanOrEqual(WORKSPACE_INSTRUCTIONS_MAX_BYTES)
  })

  test("keep a small file whole after one cut at the limit, when it fits in what is left", async () => {
    // Regression proof: spend the whole budget on a cut in boundedFiles (remaining = 0); the web
    // app's file then comes empty, cut at its first byte.
    const repository = await tempRoot()
    const workingDirectory = join(repository, "web")
    await mkdir(join(repository, ".git"))
    await mkdir(workingDirectory)
    const line = `${"x".repeat(99)}\n`
    // 40,000 bytes: cut after 327 lines, which leave 68 bytes.
    await writeFile(join(repository, "AGENTS.md"), line.repeat(400))
    await writeFile(join(workingDirectory, "AGENTS.md"), "Use Bun.\n")

    const files = await read(workingDirectory)

    const kept = Math.floor(WORKSPACE_INSTRUCTIONS_MAX_BYTES / line.length)
    expect(files).toEqual([
      { path: "../AGENTS.md", text: line.repeat(kept), continuesAtLine: kept + 1 },
      { path: "AGENTS.md", text: "Use Bun.\n" },
    ])
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0)
    expect(total).toBeLessThanOrEqual(WORKSPACE_INSTRUCTIONS_MAX_BYTES)
  })

  test("are cut between two characters when a line crosses the limit", async () => {
    // Regression proof: cut at the limit itself; the last character is then split, the text is
    // not UTF-8, and the file is left out.
    const root = await tempRoot()
    // One line, an odd byte before two-byte characters: the limit falls inside one of them.
    await writeFile(join(root, "AGENTS.md"), `a${"é".repeat(WORKSPACE_INSTRUCTIONS_MAX_BYTES)}`)

    expect(await read(root)).toEqual([
      {
        path: "AGENTS.md",
        text: `a${"é".repeat(WORKSPACE_INSTRUCTIONS_MAX_BYTES / 2 - 1)}`,
        continuesAtLine: 1,
      },
    ])
  })

  test("leave out a file that is not text, and keep the others", async () => {
    const repository = await tempRoot()
    const workingDirectory = join(repository, "web")
    await mkdir(join(repository, ".git"))
    await mkdir(workingDirectory)
    await writeFile(join(repository, "AGENTS.md"), new Uint8Array([0x55, 0x00, 0xff]))
    await writeFile(join(workingDirectory, "AGENTS.md"), "Use Bun.\n")
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await read(workingDirectory)).toEqual([{ path: "AGENTS.md", text: "Use Bun.\n" }])
      expect(warn).toHaveBeenCalledWith(
        "[SixbAgent] Could not read the workspace's instruction files:",
        "'../AGENTS.md' is binary, not UTF-8 text."
      )
    } finally {
      warn.mockRestore()
    }
  })

  test.each([
    ["fails", { exitCode: 1, stdout: "", stderr: "bash: not found", durationMs: 1 }],
    ["times out", { exitCode: 137, stdout: "", stderr: "", durationMs: 1, timedOut: true }],
    [
      "prints garbage",
      { exitCode: 0, stdout: "\u0000\u0001 not a record", stderr: "", durationMs: 1 },
    ],
  ] as const)("are none, with a warning, when the command %s", async (_, result) => {
    // Regression proof: throw from readWorkspaceInstructions instead of warning; the run's
    // acquisition then fails with it.
    const root = await tempRoot()
    const sandbox = new FolderSandbox(root, async () => result)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await readWorkspaceInstructions(sandbox, root)).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toBe(
        "[SixbAgent] Could not read the workspace's instruction files:"
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("are none, with a warning, when the sandbox throws", async () => {
    const root = await tempRoot()
    const failure = new Error("[test] The sandbox is gone.")
    const sandbox = new FolderSandbox(root, async () => {
      throw failure
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await readWorkspaceInstructions(sandbox, root)).toEqual([])
      expect(warn).toHaveBeenCalledWith(
        "[SixbAgent] Could not read the workspace's instruction files:",
        failure
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("are read with a bound, and stop with the run", async () => {
    const root = await tempRoot()
    const sandbox = new FolderSandbox(root)
    const controller = new AbortController()

    await readWorkspaceInstructions(sandbox, root, controller.signal)

    expect(sandbox.commands).toHaveLength(1)
    expect(sandbox.commands[0]?.options).toMatchObject({
      cwd: root,
      timeout: 5_000,
      signal: controller.signal,
    })
  })

  test("are none, without a warning, when the run stops while they are read", async () => {
    const root = await tempRoot()
    const controller = new AbortController()
    const sandbox = new FolderSandbox(root, async () => {
      controller.abort()
      throw new Error("[test] aborted")
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await readWorkspaceInstructions(sandbox, root, controller.signal)).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  describe("acquiring the run's sandbox", () => {
    function runSandbox(acquired: AcquiredRunSandbox, waitBeforeModel = true): RunSandbox {
      return { waitBeforeModel, contextDirectory: "/run-files", acquire: async () => acquired }
    }

    test("carries a described workspace's files in its prompt context", async () => {
      // Regression proof: acquire with sandbox.acquire() again in run-environment's
      // createConversationAgentEnvironment; the computer's turn in worker.test.ts then has no
      // <workspace_instructions>.
      const root = await tempRoot()
      await writeFile(join(root, "AGENTS.md"), "Use Bun.\n")
      const sandbox = new FolderSandbox(root)

      const acquired = await acquireRunSandbox(
        runSandbox({ sandbox, promptContext: { workingDirectory: root, retention: "computer" } })
      )

      expect(acquired.promptContext).toEqual({
        workingDirectory: root,
        retention: "computer",
        instructions: [{ path: "AGENTS.md", text: "Use Bun.\n" }],
      })
    })

    test.each([
      ["a blank sandbox", undefined, true],
      ["a workspace the prompt does not wait for", "computer", false],
    ] as const)("reads nothing in %s", async (_, retention, waitBeforeModel) => {
      // Regression proof: drop the guard in acquireRunSandbox; each of these runs the command.
      const root = await tempRoot()
      await writeFile(join(root, "AGENTS.md"), "Use Bun.\n")
      const sandbox = new FolderSandbox(root)
      const acquired: AcquiredRunSandbox = {
        sandbox,
        ...(retention ? { promptContext: { workingDirectory: root, retention } } : {}),
      }

      expect(await acquireRunSandbox(runSandbox(acquired, waitBeforeModel))).toBe(acquired)
      expect(sandbox.commands).toEqual([])
    })
  })
})

function read(workingDirectory: string) {
  return readWorkspaceInstructions(new FolderSandbox(workingDirectory), workingDirectory)
}

interface RecordedCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunCommandOptions
}

/** Runs commands in a real bash in a folder, as a computer's sandbox does, unless told otherwise. */
class FolderSandbox implements Sandbox {
  readonly id = "folder"
  readonly provider = "test"
  readonly status = "running" as const
  readonly commands: RecordedCommand[] = []

  constructor(
    readonly workingDirectory: string,
    private readonly answer?: () => Promise<CommandResult>
  ) {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.commands.push({ command, args, options })
    if (this.answer) return this.answer()

    return exec({
      argv: [command, ...args],
      cwd: options.cwd ?? this.workingDirectory,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: options.timeout,
      signal: options.signal,
    })
  }

  async writeFiles(_files: readonly SandboxFileRecord[]): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/** A real path: the script names folders by their physical path. */
async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-workspace-instructions-")))
  roots.push(root)
  return root
}

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { CommandResult, RunCommandOptions, Sandbox, SandboxFileRecord } from "@sixb/core"
import type { JsonValue, ModelTool } from "@sixb/core/models"
import { exec } from "@sixb/core/sandboxes"
import { SANDBOX_CONTEXT_DIRECTORY } from "../src/run-sandbox"
import { SEARCH_SCRIPT_SOURCE } from "../src/search-script"
import { createGlobTool } from "../src/tools/glob"
import { createGrepTool } from "../src/tools/grep"

const roots: string[] = []
const context = { signal: new AbortController().signal, callId: "call", toolCallId: "tool-call" }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("glob", () => {
  test("finds files by name, one path per line", async () => {
    const { glob } = await harness({
      ".gitignore": "dist/\n",
      "README.md": "",
      "docs/guide.md": "",
      "dist/bundle.md": "",
      ".github/notes.md": "",
      "node_modules/pkg/README.md": "",
    })

    expect(await glob.text({ pattern: "*.md" })).toBe("README.md\ndocs/guide.md")
    expect(await glob.text({ pattern: ".github/*.md" })).toBe(".github/notes.md")
    expect(await glob.text({ pattern: "*.md", path: "node_modules" })).toBe(
      "node_modules/pkg/README.md"
    )
    expect(await glob.text({ pattern: "*.txt" })).toBe("No files found")
  })

  test("says when more files match than it lists", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [`f${String(index).padStart(3, "0")}.txt`, ""])
    )
    const { glob } = await harness(files)

    const output = await glob.run({ pattern: "*.txt" })
    expect(output).toMatchObject({ pattern: "*.txt", path: ".", truncated: true })
    expect((await glob.text({ pattern: "*.txt" })).split("\n").slice(-3)).toEqual([
      "f099.txt",
      "",
      "(100 files shown, more match: narrow the pattern or the path)",
    ])
  })

  test("takes a path of 'null' or 'undefined' as no path, and refuses a file", async () => {
    const { glob } = await harness({ "a.ts": "" })

    expect(await glob.run({ pattern: "*.ts", path: "null" })).toEqual({
      pattern: "*.ts",
      path: ".",
      files: ["a.ts"],
      truncated: false,
    })
    expect(await glob.text({ pattern: "*.ts", path: "undefined" })).toBe("a.ts")
    expect(await failure(glob.run({ pattern: "*", path: "a.ts" }))).toBe(
      "[SixbAgent] glob: 'a.ts' is a file: read it, or grep it."
    )
    expect(await failure(glob.run({ pattern: "*", path: "missing" }))).toBe(
      "[SixbAgent] glob: 'missing' does not exist."
    )
    expect(await failure(glob.run({ pattern: "*", extra: true }))).toBe(
      "[SixbAgent] glob: input has an unknown property 'extra'."
    )
  })

  // Reproduce: drop the two pattern checks in parseGlobInput; each pattern then finds nothing,
  // and the model reads "No files found".
  test("refuses an absolute pattern and one ending in /, which would find nothing", async () => {
    const { root, glob } = await harness({ "src/a.ts": "" })

    expect(await failure(glob.run({ pattern: `${root}/src/**/*.ts` }))).toBe(
      "[SixbAgent] glob: pattern is relative to path: pass the folder as path and the rest as pattern."
    )
    for (const pattern of ["src/", "src/**/"]) {
      expect(await failure(glob.run({ pattern }))).toBe(
        "[SixbAgent] glob: glob finds files: drop the trailing /, or read the folder."
      )
    }
    expect(await glob.text({ pattern: "**/*.ts", path: join(root, "src") })).toBe("src/a.ts")
  })
})

describe("grep", () => {
  test("finds text grouped by file, with line numbers and what each file holds more", async () => {
    const { grep } = await harness({
      "src/config.ts": `const retries = 3\n${"retries\n".repeat(25)}`,
      ".github/ci.yml": "retries: 2\n",
      "notes.md": "nothing here\n",
    })

    const text = await grep.text({ pattern: "retries", include: "*.{ts,yml}" })
    expect(text.split("\n").slice(0, 5)).toEqual([
      ".github/ci.yml",
      "  1: retries: 2",
      "",
      "src/config.ts",
      "  1: const retries = 3",
    ])
    expect(text.split("\n").slice(-2)).toEqual(["  20: retries", "  … 6 more in this file"])
    expect(await grep.text({ pattern: "absent" })).toBe("No matches")
  })

  test("says when more lines match than it shows", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`f${index}.txt`, "match\n".repeat(20)])
    )
    const { grep } = await harness(files)

    expect(await grep.run({ pattern: "match" })).toMatchObject({
      files: 5,
      truncated: true,
    })
    expect((await grep.text({ pattern: "match" })).split("\n").at(-1)).toBe(
      "(100 matching lines shown, more match: narrow the pattern, the path or include)"
    )
  })

  test("ignores case unless asked, searches literal text, and explains an invalid pattern", async () => {
    const { grep } = await harness({ "a.ts": "Retry(3)\nretry(4)\n" })

    expect(await grep.text({ pattern: "retry" })).toBe("a.ts\n  1: Retry(3)\n  2: retry(4)")
    expect(await grep.text({ pattern: "Retry" })).toBe("a.ts\n  1: Retry(3)")
    expect(await grep.text({ pattern: "retry(4", literal: true })).toBe("a.ts\n  2: retry(4)")

    const invalid = await failure(grep.run({ pattern: "retry(4" }))
    expect(invalid).toStartWith("[SixbAgent] grep: Invalid pattern: ")
    expect(invalid).toEndWith(". Pass literal: true to search the text as written.")
  })

  // Reproduce: drop file_binary and file_too_large from SEARCH_ERROR_CODES in sandbox-search.ts;
  // the model then reads "An error occurred." and cannot tell why.
  test("says why a file named as the path is not searched", async () => {
    const { root, grep } = await harness({ "image.png": "needle\0rest" })
    await writeFile(join(root, "big.log"), `needle\n${"x".repeat(10 * 1024 * 1024)}`)

    expect(await failure(grep.run({ pattern: "needle", path: "image.png" }))).toBe(
      "[SixbAgent] grep: 'image.png' is binary, or not UTF-8 text: grep searches text."
    )
    expect(await failure(grep.run({ pattern: "needle", path: "big.log" }))).toBe(
      "[SixbAgent] grep: 'big.log' is over 10 MiB: search it with bash."
    )
  })

  // Reproduce: search the folder of a file named as the path; b.ts then matches too.
  test("searches a file named as the path alone", async () => {
    const { grep } = await harness({ "src/a.ts": "needle\n", "src/b.ts": "needle\n" })

    expect(await grep.text({ pattern: "needle", path: "src/a.ts" })).toBe("src/a.ts\n  1: needle")
  })
})

describe("glob and grep confinement", () => {
  // Reproduce: leave contextDirectory out of the request in runSandboxSearch; the run's own files
  // then show in a search of the working directory.
  test("leave the run's context directory out, unless the search starts in it", async () => {
    const { grep, glob } = await harness({
      "notes.md": "zebra quartz\n",
      [`${SANDBOX_CONTEXT_DIRECTORY}/memory/MEMORY.md`]: "zebra quartz\n",
    })

    expect(await grep.text({ pattern: "zebra quartz" })).toBe("notes.md\n  1: zebra quartz")
    expect(await grep.text({ pattern: "zebra quartz", path: SANDBOX_CONTEXT_DIRECTORY })).toBe(
      `${SANDBOX_CONTEXT_DIRECTORY}/memory/MEMORY.md\n  1: zebra quartz`
    )
    expect(await glob.text({ pattern: "memory/*.md", path: SANDBOX_CONTEXT_DIRECTORY })).toBe(
      `${SANDBOX_CONTEXT_DIRECTORY}/memory/MEMORY.md`
    )
  })

  test("search a computer's context directory, outside the folder, by its absolute path", async () => {
    const runFiles = await tempRoot({ "memory/MEMORY.md": "zebra quartz\n" })
    const { grep } = await harness({ "notes.md": "zebra quartz\n" }, { contextDirectory: runFiles })

    expect(await grep.text({ pattern: "zebra quartz", path: runFiles })).toBe(
      `${join(runFiles, "memory/MEMORY.md")}\n  1: zebra quartz`
    )
  })

  // Reproduce: drop the root check in the engine's resolveScope; these paths are then searched.
  test("refuse a path outside the run's folders, through a link too", async () => {
    const outside = await tempRoot({ "secret.txt": "zebra quartz\n" })
    const { root, grep, glob } = await harness({})
    await symlink(outside, join(root, "escape"))

    for (const path of [outside, "escape", "escape/secret.txt", ".."]) {
      expect(await failure(grep.run({ pattern: "zebra", path }))).toBe(
        `[SixbAgent] grep: '${path}' resolves outside the working directory and the run's context directory.`
      )
    }
    expect(await failure(glob.run({ pattern: "*", path: "escape" }))).toBe(
      "[SixbAgent] glob: 'escape' resolves outside the working directory and the run's context directory."
    )
  })

  // Reproduce: drop the login-shell `exec "$BASH" -lc …` from RUN_SEARCH; with neither Bun nor
  // Node on this shell's PATH, the search then fails. Proven only where /usr/bin and /bin hold no
  // node.
  test("find Bun or Node in a login shell when this shell's PATH has neither", async () => {
    // The Bun running the tests may be named bun.exe (the npm package's binary): the login shell
    // gets it as `bun`, as an installed Bun is.
    const bin = await tempRoot({})
    await symlink(process.execPath, join(bin, "bun"))
    const home = await tempRoot({ ".bash_profile": `export PATH="${bin}:$PATH"\n` })
    const { glob } = await harness({ "a.ts": "" }, { env: { PATH: "/usr/bin:/bin", HOME: home } })

    expect(await glob.text({ pattern: "*.ts" })).toBe("a.ts")
  })
})

describe("glob and grep failures", () => {
  // Reproduce: drop the readable check from RUN_SEARCH; Bun or Node then fails on the missing
  // module, and the model reads only an exit code.
  test("say when the run has no search script", async () => {
    const { glob } = await harness({ "a.ts": "" }, { installed: false })

    expect(await failure(glob.run({ pattern: "*.ts" }))).toBe(
      "[SixbAgent] glob: The search could not run in this sandbox (the run has no search script): use bash with find and grep instead."
    )
  })

  // Reproduce: throw AgentToolExecutionError for every failure in runSandboxSearch, as it once
  // did; the model then reads "An error occurred." and retries the same call.
  test("tell the model how to go on when the search cannot finish or cannot run", async () => {
    const result = { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }
    const cases: readonly [Partial<CommandResult>, string, string][] = [
      [
        { exitCode: 143, timedOut: true },
        "grep: The search took too long: narrow the path, simplify the pattern, or pass literal: true.",
        "glob: The search took too long: narrow the path or the pattern.",
      ],
      [
        {
          exitCode: 2,
          stderr:
            '{"error":{"code":"runtime_unavailable","message":"The search needs Bun or Node.js."}}\n',
        },
        "grep: The search could not run in this sandbox (the search script needs Bun or Node.js): use bash with find and grep instead.",
        "glob: The search could not run in this sandbox (the search script needs Bun or Node.js): use bash with find and grep instead.",
      ],
      [
        { exitCode: 1, stderr: "Error: Cannot find module '/w/.sixb/agent/lib/search.mjs'\n" },
        "grep: The search could not run in this sandbox (the search script exited with code 1): use bash with find and grep instead.",
        "glob: The search could not run in this sandbox (the search script exited with code 1): use bash with find and grep instead.",
      ],
      [
        { stdout: "not json\n" },
        "grep: The search could not run in this sandbox (its output could not be read): use bash with find and grep instead.",
        "glob: The search could not run in this sandbox (its output could not be read): use bash with find and grep instead.",
      ],
      [
        { stdout: '{"unexpected":true}\n' },
        "grep: The search could not run in this sandbox (its output could not be read): use bash with find and grep instead.",
        "glob: The search could not run in this sandbox (its output could not be read): use bash with find and grep instead.",
      ],
    ]

    for (const [answer, grepError, globError] of cases) {
      const sandbox = new TestSandbox(tmpdir())
      sandbox.runCommand = async () => ({ ...result, ...answer })
      const handle = async () => ({ sandbox, contextDirectory: SANDBOX_CONTEXT_DIRECTORY })

      const grep = searchTool(createGrepTool(handle))
      const glob = searchTool(createGlobTool(handle))
      expect(await failure(grep.run({ pattern: "needle" }))).toBe(`[SixbAgent] ${grepError}`)
      expect(await failure(glob.run({ pattern: "*.ts" }))).toBe(`[SixbAgent] ${globError}`)
    }
  })
})

class TestSandbox implements Sandbox {
  readonly id = "test"
  readonly provider = "test"
  readonly status = "running" as const

  constructor(
    readonly workingDirectory: string,
    private readonly env: Readonly<Record<string, string>> = {}
  ) {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    return exec({
      argv: [command, ...args],
      cwd: options.cwd ?? this.workingDirectory,
      env: { ...hostEnv(), ...this.env, ...(options.env ?? {}) },
      timeoutMs: options.timeout,
      signal: options.signal,
    })
  }

  async writeFiles(_files: readonly SandboxFileRecord[]): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/**
 * A working directory holding `files`, with the run's search script installed in its context
 * directory as a run installs it.
 */
async function harness(
  files: Readonly<Record<string, string>>,
  options: {
    readonly contextDirectory?: string
    readonly env?: Readonly<Record<string, string>>
    /** Default: true. */
    readonly installed?: boolean
  } = {}
) {
  const root = await tempRoot(files)
  const contextDirectory = options.contextDirectory ?? SANDBOX_CONTEXT_DIRECTORY
  const contextRoot = resolve(root, contextDirectory)
  if (options.installed !== false) {
    await mkdir(join(contextRoot, "lib"), { recursive: true })
    await writeFile(join(contextRoot, "lib", "search.mjs"), SEARCH_SCRIPT_SOURCE)
  }

  const sandbox = new TestSandbox(root, options.env)
  const handle = async () => ({ sandbox, contextDirectory })
  return {
    root,
    glob: searchTool(createGlobTool(handle)),
    grep: searchTool(createGrepTool(handle)),
  }
}

function searchTool<TInput>(tool: ModelTool<TInput>) {
  const run = async (input: unknown) => tool.execute(tool.parseInput(input), context)
  return {
    run,
    async text(input: unknown): Promise<string> {
      const output = (await run(input)) as JsonValue
      const projected = await tool.toModelOutput?.(output, context)
      if (projected?.type !== "text") throw new Error("expected a text output")
      return projected.value
    },
  }
}

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => new Error("expected a failure"),
    (caught: unknown) => caught
  )
  return error instanceof Error ? error.message : String(error)
}

async function tempRoot(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-search-tools-")))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return root
}

function hostEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

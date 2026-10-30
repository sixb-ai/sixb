import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type CliHelp,
  CliUsageError,
  parseCliArgs,
  ROOT_HELP,
  ROOT_HELP_GROUPS,
} from "../src/lib/command-line"
import { runLocalInstanceCommand } from "../src/lib/instance-command"
import { builtAppOutdir, hasBuiltApp, resolveProductionPaths } from "../src/lib/production"
import { renderHelp } from "../src/ui"
import { FAST_CLI_TIMEOUT_MS, runCliToCompletion } from "./shared/cli-process"
import { runInProcess } from "./shared/in-process"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Runs `sixb` in its own process, from the repository root. */
function runCli(args: readonly string[]) {
  return runCliToCompletion({
    cmd: ["bun", resolve(import.meta.dir, "..", "src", "index.tsx"), ...args],
    cwd: resolve(import.meta.dir, "..", "..", ".."),
    timeoutMs: FAST_CLI_TIMEOUT_MS,
  })
}

function helpFor(path: readonly string[]): CliHelp {
  const parsed = parseCliArgs([...path, "--help"])
  if (parsed.kind !== "help") throw new Error(`Expected help for 'sixb ${path.join(" ")}'.`)
  return parsed.help
}

function usageError(args: readonly string[]): CliUsageError {
  try {
    parseCliArgs(args)
  } catch (error) {
    if (error instanceof CliUsageError) return error
    throw error
  }
  throw new Error(`Expected 'sixb ${args.join(" ")}' to be a usage error.`)
}

describe("sixb command line", () => {
  test("lists every command in root help, grouped, and leaves options to each command", async () => {
    const help = await runInProcess(() => renderHelp(ROOT_HELP))
    // One line: the help pads each label to a column and wraps long summaries.
    const output = help.output.replace(/\s+/g, " ")

    for (const command of ["api", "app", "scheduler", "orchestrator", "rules", "worker <type>"]) {
      expect(output).toContain(command)
    }
    expect(output).toContain("action-runs")
    expect(output).toContain("workflow-runs")
    expect(output).toContain("sync, agent, pipeline, projection, workflow")
    expect(output).not.toContain("--concurrency <value>")
    // A command added without a group would land in "More".
    expect(ROOT_HELP_GROUPS.map((group) => group.title)).not.toContain("More")
    expect(ROOT_HELP_GROUPS.flatMap((group) => group.items)).toHaveLength(ROOT_HELP.commands.length)

    const worker = await runInProcess(() => renderHelp(helpFor(["worker"])))
    const workerOutput = worker.output.replace(/\s+/g, " ")
    expect(workerOutput).toContain("--concurrency <value>")
    expect(workerOutput).toContain("--subagent-concurrency-per-run <count>")
    expect(workerOutput).not.toContain("--type <type>")
    expect(workerOutput).not.toContain("--worker <type>")
  })

  test("serves a command's own help without running it", () => {
    for (const group of ["profile", "token", "service-account", "db", "lake"]) {
      expect(parseCliArgs([group])).toMatchObject({ kind: "help", help: { path: [group] } })
    }
    expect(parseCliArgs(["service-account", "token"])).toMatchObject({
      kind: "help",
      help: { usage: "sixb service-account token <list|create|revoke> <service-account-id>" },
    })
    for (const args of [
      ["token", "create", "--help"],
      ["help", "token", "create"],
    ]) {
      expect(parseCliArgs(args)).toMatchObject({
        kind: "help",
        help: { path: ["token", "create"] },
      })
    }
    expect(parseCliArgs(["api", "--help"])).toMatchObject({ kind: "help", help: { path: ["api"] } })
  })

  // Reproduce: render the root help whatever the path in `renderHelp` (src/ui/index.tsx).
  test("renders a command's own help, not the root help", async () => {
    const parsed = parseCliArgs(["service-account", "token"])
    if (parsed.kind !== "help") throw new Error("Expected help.")

    const help = await runInProcess(() => renderHelp(parsed.help))

    expect(help.output).toContain(
      "sixb service-account token <list|create|revoke> <service-account-id>"
    )
    expect(help.output).not.toContain("Real-time digital twin framework")
  })

  test.each([
    // Removed commands stay removed.
    [["start"], "Unknown command 'start'"],
    [["auth", "status"], "Unknown command 'auth'"],
    [["create", "my-project"], "Unknown command 'create'"],
    [["status", "--unknown-option"], "Unknown option '--unknown-option'"],
    [["status", "--profile"], "--profile requires a value"],
    [["status", "--profile", "one", "--profile", "two"], "--profile may only be provided once"],
    [["profile", "list", "--unknown-option"], "Unknown option '--unknown-option'"],
    [
      ["status", "--api-url", "http://localhost:3002", "--profile", "local"],
      "--api-url and --profile cannot be used together",
    ],
    [["token", "create"], "Missing required --name <name>"],
    [["init", "--unknown-option"], "Unknown option '--unknown-option'"],
    [["worker"], "Invalid arguments for 'worker'"],
    [["worker", "--type", "pipeline"], "Unknown option '--type'"],
    [["worker", "sync", "--concurrency"], "--concurrency requires a value"],
    [["worker-group", "sync", "--concurrency"], "--concurrency requires a value"],
  ])("rejects %j before running a command", (args, message) => {
    const error = usageError(args)

    expect(error.exitCode).toBe(2)
    expect(error.message).toContain(message)
  })

  test("shows the worker types when the type is missing", () => {
    expect(usageError(["worker"]).help.usage).toContain("<sync|agent|pipeline|projection|workflow>")
  })

  test("keeps the whole value of an equals-form option", () => {
    // Splitting on every `=` truncates this to 3, which passes validation and starts the worker.
    expect(parseCliArgs(["worker", "sync", "--concurrency=3=4"])).toMatchObject({
      options: { concurrency: "3=4" },
    })
  })

  // The process boundary: scripts read the error from stderr and the exit code.
  test.concurrent("emits structured errors when a management command requests JSON", async () => {
    const result = await runCli(["profile", "list", "--unknown-option", "--json"])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "invalid_arguments",
        message: "Unknown option '--unknown-option' for 'profile list'.",
        hint: "sixb profile list",
      },
    })
  })

  // Reproduce: render the help without `error.message` in src/index.tsx's catch.
  test.concurrent("prints a usage error above the command's help", async () => {
    const result = await runCli(["status", "--unknown-option"])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain("Unknown option '--unknown-option' for 'status'.")
    expect(result.stdout).toContain("sixb status")
    expect(result.stderr).toBe("")
  })

  // Reproduce: pass `concurrency: undefined` to runWorker in src/index.tsx, or skip
  // `renderCliError` in its catch.
  test.concurrent("hands a command its flags, and prints the failure it throws", async () => {
    const entry = resolve(import.meta.dir, "fixtures", "valid-project", "sixb.config.ts")
    const result = await runCli(["worker", "sync", "--entry", entry, "--concurrency=3=4"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Invalid worker concurrency '3=4'")
    expect(result.stderr).toBe("")
  })

  test("gives instance commands the shared usage contract, and their help without a profile", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
    const missingConfig = join(tmpdir(), "sixb-cli-no-config")
    try {
      const conflict = await runInProcess(() =>
        runLocalInstanceCommand([
          "project",
          "show",
          "--api-url",
          "http://localhost:3002",
          "--profile",
          "local",
        ])
      )
      expect(conflict.exitCode).toBe(2)
      expect(conflict.output).toBe("")
      expect(JSON.parse(conflict.stderr)).toEqual({
        error: {
          code: "invalid_arguments",
          message: "--api-url and --profile cannot be used together.",
        },
      })

      const help = await runInProcess(() => {
        process.env.XDG_CONFIG_HOME = missingConfig
        return runLocalInstanceCommand([
          "objects",
          "get",
          "Customer",
          "alice",
          "--profile",
          "missing",
          "--help",
        ])
      })
      expect(help.exitCode).toBeUndefined()
      expect(help.stderr).toBe("")
      expect(help.output).toContain("Usage:")
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("production asset paths", () => {
  test("requires both ordinary and shared shells for a built custom app", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-production-app-"))
    tempDirs.push(tempDir)

    expect(await hasBuiltApp(tempDir)).toBe(false)
    await writeFile(join(tempDir, "index.html"), "ordinary")
    expect(await hasBuiltApp(tempDir)).toBe(false)
    await writeFile(join(tempDir, "shared-index.html"), "shared")
    expect(await hasBuiltApp(tempDir)).toBe(true)
  })

  test("resolves default .sixb/dist assets from the source project root", async () => {
    const projectRoot = resolve(import.meta.dir, "fixtures", "valid-project")
    const paths = await resolveProductionPaths(join(projectRoot, ".sixb", "dist", "sixb.config.js"))

    expect(paths.projectRoot).toBe(projectRoot)
    expect(paths.buildOutdir).toBe(join(projectRoot, ".sixb", "dist"))
    expect(builtAppOutdir(paths.buildOutdir)).toBe(join(projectRoot, ".sixb", "dist", "app"))
  })

  test("resolves custom build assets next to the built entry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-production-"))
    tempDirs.push(tempDir)
    const outdir = join(tempDir, "dist")
    await mkdir(join(outdir, "app"), { recursive: true })

    const paths = await resolveProductionPaths(join(outdir, "sixb.config.js"))

    expect(paths.projectRoot).toBe(outdir)
    expect(paths.buildOutdir).toBe(outdir)
    expect(builtAppOutdir(paths.buildOutdir)).toBe(join(outdir, "app"))
  })
})

import { afterEach, describe, expect, test } from "bun:test"
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

    for (const command of ["serve <role>", "dev", "build", "check", "deploy"]) {
      expect(output).toContain(command)
    }
    expect(output).not.toContain("--concurrency <value>")
    // A command added without a group would land in "More".
    expect(ROOT_HELP_GROUPS.map((group) => group.title)).not.toContain("More")
    // Every command, and `sixb` alone, which opens the app.
    const items = ROOT_HELP_GROUPS.flatMap((group) => group.items)
    expect(items).toHaveLength(ROOT_HELP.commands.length + 1)
    expect(items[0]).toMatchObject({ label: "(no command)" })

    const worker = await runInProcess(() => renderHelp(helpFor(["serve", "worker"])))
    const workerOutput = worker.output.replace(/\s+/g, " ")
    expect(workerOutput).toContain("--concurrency <value>")
    expect(workerOutput).toContain("--subagent-concurrency-per-run <count>")
    expect(workerOutput).not.toContain("--type <type>")
    expect(workerOutput).not.toContain("--worker <type>")
  })

  test("serves a command's own help without running it", () => {
    for (const group of ["serve", "db", "lake"]) {
      expect(parseCliArgs([group])).toMatchObject({ kind: "help", help: { path: [group] } })
    }
    for (const args of [
      ["serve", "api", "--help"],
      ["help", "serve", "api"],
    ]) {
      expect(parseCliArgs(args)).toMatchObject({
        kind: "help",
        help: { path: ["serve", "api"] },
      })
    }
  })

  // Reproduce: render the root help whatever the path in `renderHelp` (src/ui/index.tsx).
  test("renders a command's own help, not the root help", async () => {
    const serveHelp = parseCliArgs(["serve"])
    if (serveHelp.kind !== "help") throw new Error("Expected help.")

    const help = await runInProcess(() => renderHelp(serveHelp.help))

    expect(help.output).toContain(
      "sixb serve <api|app|orchestrator|rules|worker|worker-group> [options]"
    )
    expect(help.output).not.toContain("Real-time digital twin framework")
  })

  test.each([
    // Removed commands stay removed.
    [["start"], "Unknown command 'start'"],
    [["auth", "status"], "Unknown command 'auth'"],
    [["create", "my-project"], "Unknown command 'create'"],
    [["init", "--unknown-option"], "Unknown option '--unknown-option'"],
    [["serve", "worker"], "Invalid arguments for 'serve worker'"],
    [["serve", "worker", "--type", "pipeline"], "Unknown option '--type'"],
    [["serve", "worker", "sync", "--concurrency"], "--concurrency requires a value"],
    [["serve", "worker-group", "sync", "--concurrency"], "--concurrency requires a value"],
  ])("rejects %j before running a command", (args, message) => {
    const error = usageError(args)

    expect(error.exitCode).toBe(2)
    expect(error.message).toContain(message)
  })

  test("shows the worker types when the type is missing", () => {
    expect(usageError(["serve", "worker"]).help.usage).toContain(
      "<sync|agent|pipeline|projection|workflow>"
    )
  })

  test("keeps the whole value of an equals-form option", () => {
    // Splitting on every `=` truncates this to 3, which passes validation and starts the worker.
    expect(parseCliArgs(["serve", "worker", "sync", "--concurrency=3=4"])).toMatchObject({
      options: { concurrency: "3=4" },
    })
  })

  // The process boundary: scripts read the error from stderr and the exit code.
  test.concurrent("emits structured errors when a management command requests JSON", async () => {
    const result = await runCli(["deploy", "status", "--unknown-option", "--json"])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "invalid_arguments",
        message: "Unknown option '--unknown-option' for 'deploy status'.",
        hint: "sixb deploy status",
      },
    })
  })

  // Reproduce: render the help without `error.message` in src/index.tsx's catch.
  test.concurrent("prints a usage error above the command's help", async () => {
    const result = await runCli(["init", "--unknown-option"])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain("Unknown option '--unknown-option' for 'init'.")
    expect(result.stdout).toContain("sixb init")
    expect(result.stderr).toBe("")
  })

  // Reproduce: pass `concurrency: undefined` to runWorker in src/index.tsx, or skip
  // `renderCliError` in its catch.
  test.concurrent("hands a command its flags, and prints the failure it throws", async () => {
    const entry = resolve(import.meta.dir, "fixtures", "valid-project", "sixb.config.ts")
    const result = await runCli(["serve", "worker", "sync", "--entry", entry, "--concurrency=3=4"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Invalid worker concurrency '3=4'")
    expect(result.stderr).toBe("")
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

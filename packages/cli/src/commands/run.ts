import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { checkStorageSchema } from "@sixb/core"
import { listProjectModules } from "@sixb/core/internal/bootstrap"
import { bindScript } from "@sixb/core/internal/runtime"
import { loadDeployConfig } from "../lib/deploy-config"
import { headCommit } from "../lib/deploy-source"
import { SixbCliError } from "../lib/errors"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { stopSixbProviders } from "../lib/runtime"
import { withTask } from "../ui"
import { glyph, tone } from "../ui/theme"

export interface RunScriptOptions {
  readonly script: string
  /** Everything after the script's path, passed to it untouched. */
  readonly args: readonly string[]
  readonly entry?: string
  readonly deployed?: boolean
  readonly yes?: boolean
  readonly cwd?: string
}

/**
 * `sixb run`: calls a script's default export with the project's SDK, here or, with `deployed`, on
 * the deployment. Resolves with the exit code the command should end with.
 */
export async function runScriptCommand(options: RunScriptOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd()
  if (options.deployed && options.entry) {
    throw new SixbCliError("[SixbRun] --entry applies to a run here, not to a deployed one.", {
      remediation: "The deployment runs with the configuration it was deployed with.",
    })
  }
  const script = await projectScript(cwd, options.script)
  return options.deployed ? runOnDeployment(cwd, script, options) : runHere(cwd, script, options)
}

interface ProjectScript {
  readonly file: string
  /** Relative to the project, with forward slashes: what the execution records. */
  readonly path: string
}

async function projectScript(cwd: string, script: string): Promise<ProjectScript> {
  const file = resolve(cwd, script)
  const entry = await stat(file).catch(() => null)
  if (!entry?.isFile()) throw new SixbCliError(`[SixbRun] No script at ${script}.`)

  const path = relative(cwd, file)
  if (path.startsWith("..") || isAbsolute(path)) {
    throw new SixbCliError(`[SixbRun] ${script} is outside the project.`, {
      remediation:
        "Move it into the project, such as into scripts/, and run sixb run from the project's directory.",
    })
  }
  const projectPath = path.split(sep).join("/")
  // Sixb imports every module in these folders as a definition, and a script is not one.
  const modules = await listProjectModules(cwd)
  if (modules.some((module) => module.path.split(sep).join("/") === projectPath)) {
    throw new SixbCliError(`[SixbRun] ${projectPath} is in a folder Sixb loads definitions from.`, {
      remediation: "Move it outside the definition folders, such as into scripts/.",
    })
  }
  return { file, path: projectPath }
}

async function runHere(
  cwd: string,
  script: ProjectScript,
  options: RunScriptOptions
): Promise<number> {
  // The source entry, even where a build exists: the script imports the project's source modules,
  // and loading the same files keeps one copy of each.
  const entry = resolve(cwd, options.entry ?? "sixb.config.ts")
  if (!(await Bun.file(entry).exists())) {
    throw new SixbCliError(`[SixbRun] No ${relative(cwd, entry)} here.`, {
      remediation: "Run sixb run from the project's directory, or pass --entry.",
    })
  }

  const host = await loadSixbFromEntry(entry)
  const stop = interruptOnSignals()
  try {
    // Before anything can fail: closing the host must not publish the running instance's events.
    const bound = bindScript(host, script.path)

    // Awaited here, as `sixb check` does: `checkReadiness()` serves a probe that polls, so its first
    // answer only starts this check and reports it in progress.
    const schema = await checkStorageSchema(host.storage)
    if (!schema.ok) {
      throw new SixbCliError(`[SixbRun] ${host.id}'s storage is not usable: ${schema.reason}`)
    }

    const module = (await import(pathToFileURL(script.file).href)) as { readonly default?: unknown }
    if (typeof module.default !== "function") {
      throw new SixbCliError(`[SixbRun] ${script.path} has no default export to run.`, {
        remediation:
          "Export a function: `export default async function ({ sixb, args, signal }: ScriptContext) { ... }`.",
      })
    }

    if (stop.signal.aborted) return 130
    say(`${tone.muted(glyph.prompt)} ${tone.strong(script.path)} ${tone.muted(`on ${host.id}`)}`)
    const started = performance.now()
    try {
      await bound.run({ main: module.default, args: options.args, signal: stop.signal })
    } catch (error) {
      // A script that stops by throwing once its signal aborts, as `throwIfAborted()` does, was
      // stopped; any other throw is its own failure, and its stack is what its author needs.
      if (!stop.signal.aborted) {
        console.error(error)
        say(`${tone.fail(glyph.fail)} ${script.path} failed after ${seconds(started)}`)
        return 1
      }
    }

    if (stop.signal.aborted) {
      say(`${tone.warn(glyph.warn)} ${script.path} stopped after ${seconds(started)}`)
      return 130
    }
    say(`${tone.ok(glyph.ok)} ${script.path} finished in ${seconds(started)}`)
    return 0
  } finally {
    stop.dispose()
    await stopSixbProviders(host)
  }
}

/**
 * The first Ctrl-C or SIGTERM aborts the script's `signal`; a second one exits at once. A hangup,
 * such as a closed SSH connection, exits at once: nobody is left to read the output or press
 * Ctrl-C again. Either way, writes already committed stay committed.
 */
function interruptOnSignals(): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const onSignal = (signal: (typeof signals)[number]) => {
    if (signal === "SIGHUP") process.exit(129)
    if (controller.signal.aborted) process.exit(130)
    say(tone.muted("Stopping the script. Press Ctrl-C again to exit at once."))
    controller.abort(new Error(`[SixbRun] Stopped by ${signal}.`))
  }
  for (const signal of signals) process.on(signal, onSignal)
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) process.off(signal, onSignal)
    },
  }
}

async function runOnDeployment(
  cwd: string,
  script: ProjectScript,
  options: RunScriptOptions
): Promise<number> {
  const { config } = await loadDeployConfig(cwd)
  const { target } = config
  if (!target.run) {
    throw new SixbCliError(`[SixbRun] A ${target.kind} deployment cannot run scripts.`)
  }

  const status = await withTask("run", `Asking ${target.location}`, () =>
    target.status({ name: config.name })
  )
  if (!status.release) {
    throw new SixbCliError(
      `[SixbRun] Nothing named ${config.name} is deployed on ${target.location} yet.`,
      { remediation: "Deploy it first: sixb deploy." }
    )
  }

  const deployed = status.release.commit
  const head = await headCommit(cwd)
  const question =
    `Run ${tone.strong(script.path)} on ${tone.strong(config.name)} ${tone.muted(`(${target.kind} ${target.location})`)}?\n` +
    tone.muted(
      `  Its imports resolve against the deployed ${deployed.slice(0, 12)}` +
        (head && head !== deployed ? `; your HEAD is ${head.slice(0, 12)}.` : ".")
    )
  if (!(await confirm(question, options.yes === true))) {
    say(tone.muted("Not run."))
    return 1
  }

  return target.run(
    {
      path: script.path,
      source: new Uint8Array(await readFile(script.file)),
      args: options.args,
    },
    { name: config.name }
  )
}

/** Asks before a deployed run. Without a terminal there is nobody to ask, so only `--yes` proceeds. */
async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (!process.stdin.isTTY) {
    throw new SixbCliError("[SixbRun] Running on the deployment needs a yes.", {
      remediation: "Pass --yes to run without being asked.",
    })
  }

  say(question)
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await prompt.question("Run it? [y/N] ").finally(() => prompt.close())
  return answer.trim().toLowerCase() === "y"
}

/** On standard error, so a script run here has standard output to itself. */
function say(line: string): void {
  process.stderr.write(`${line}\n`)
}

function seconds(started: number): string {
  return `${((performance.now() - started) / 1000).toFixed(1)}s`
}

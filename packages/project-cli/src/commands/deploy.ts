import { relative } from "node:path"
import { writeJson } from "@sixb/cli"
import type {
  DeployCheck,
  DeployConfig,
  DeployControlAction,
  DeployEvent,
  DeployRelease,
} from "@sixb/core/deploy"
import { loadDeployConfig } from "../lib/deploy-config"
import { buildDeployRelease, lakeWorkChecks } from "../lib/deploy-release"
import {
  commitHasProjectFile,
  deployer,
  packSource,
  projectPathOf,
  resolveBunVersion,
  usesChromium,
} from "../lib/deploy-source"
import { ENV_CONFIG_FILE, loadEnvConfig } from "../lib/env-config"
import { SixbCliError } from "../lib/errors"
import {
  cliErrorView,
  deployChecksView,
  deployCompleteView,
  deployReleaseView,
  deployStatusView,
  deployStepLine,
  renderStatic,
  withTask,
} from "../ui"
import { ENV_KEPT_MESSAGE } from "../ui/env-screens"
import { canRunLive } from "../ui/live/can-run-live"

export interface DeployOptions {
  readonly dryRun?: boolean
  readonly json?: boolean
  readonly ref?: string
  readonly cwd?: string
}

export async function runDeploy(options: DeployOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const { path, config } = await loadDeployConfig(cwd)
  const envSource = (await loadEnvConfig(cwd))?.source
  const envFromSource = Boolean(envSource)

  if (options.dryRun) {
    const release = buildDeployRelease(config, {
      bunVersion: await resolveBunVersion(cwd),
      envFromSource,
    })
    if (options.json) return writeJson(release)
    await renderStatic(
      deployReleaseView({
        release,
        configPath: relative(cwd, path) || path,
        warnings: configWarnings(config),
      })
    )
    return
  }

  const deployStartedAt = Date.now()
  const { source, release, checks } = await withTask("deploy", "Packing source", async (task) => {
    const source = await packSource(cwd, options.ref)
    const release = buildDeployRelease(config, {
      bunVersion: await resolveBunVersion(cwd, source),
      // `--ref` can name a commit from before the project had one, which can't run the pull.
      envFromSource: envFromSource && (await commitHasProjectFile(cwd, source, ENV_CONFIG_FILE)),
    })
    // Stop before uploading anything when the target already says the deploy cannot work.
    task.step(`Checking ${location(config)}`)
    const checks = await config.target.check(release, {
      name: config.name,
      projectPath: source.projectPath,
      chromium: await usesChromium(cwd),
      envToken: envSource?.serverNeedsToken !== false,
    })
    return { source, release, checks }
  })
  if (checks.some(blocksDeploy)) {
    await renderStatic(deployChecksView({ name: config.name, location: location(config), checks }))
    process.exit(1)
  }
  const progress = await createProgress(release, {
    commit: source.commit,
    ref: source.ref,
    dirty: source.dirty,
  })
  try {
    await config.target.deploy(release, source, {
      name: config.name,
      deployedBy: await deployer(cwd),
      report: progress.report,
    })
  } catch (error) {
    const failed = progress.state.labels[progress.state.current ?? -1]
    await progress.fail(
      cliErrorView(error, {
        title: failed ? `Deploy failed at "${failed}"` : "Deploy failed",
        details: progress.state.output,
      })
    )
    process.exit(1)
  }
  await progress.finish(
    deployCompleteView({
      release,
      seconds: (Date.now() - deployStartedAt) / 1000,
      keptEnv: progress.state.keptEnv,
      warnings: configWarnings(config),
    })
  )
}

export async function runDeployCheck(options: { readonly json?: boolean; readonly cwd?: string }) {
  const cwd = options.cwd ?? process.cwd()
  const { config } = await loadDeployConfig(cwd)
  const envSource = (await loadEnvConfig(cwd))?.source
  const release = buildDeployRelease(config, {
    bunVersion: await resolveBunVersion(cwd),
    envFromSource: Boolean(envSource),
  })
  const context = {
    name: config.name,
    projectPath: await projectPathOf(cwd),
    chromium: await usesChromium(cwd),
    envToken: envSource?.serverNeedsToken !== false,
  }
  const targetChecks = await withTask("deploy check", `Checking ${location(config)}`, () =>
    config.target.check(release, context)
  )
  const checks = [...targetChecks, ...lakeWorkChecks(config)]
  if (options.json) writeJson(checks)
  else
    await renderStatic(deployChecksView({ name: config.name, location: location(config), checks }))
  if (checks.some(blocksDeploy)) process.exitCode = 1
}

function configWarnings(config: DeployConfig): readonly string[] {
  return lakeWorkChecks(config).map((check) => `${check.label}: ${check.detail} ${check.remedy}`)
}

function blocksDeploy(check: DeployCheck): boolean {
  return check.status === "fail"
}

function location(config: DeployConfig): string {
  return `${config.target.kind} ${config.target.location}`
}

export async function runDeployStatus(options: { readonly json?: boolean; readonly cwd?: string }) {
  const { config } = await loadDeployConfig(options.cwd)
  const status = await withTask("deploy status", `Asking ${config.target.location}`, () =>
    config.target.status({ name: config.name })
  )
  if (options.json) return writeJson(status)
  await renderStatic(
    deployStatusView({ name: config.name, location: config.target.location, status })
  )
}

export async function runDeployLogs(options: {
  readonly service?: string
  readonly follow?: boolean
  readonly tail?: string
  readonly cwd?: string
}) {
  const tail = options.tail === undefined ? 100 : Number(options.tail)
  if (!Number.isInteger(tail) || tail < 1) {
    throw new SixbCliError("[SixbDeploy] --tail must be a positive number of lines.")
  }
  const { config } = await loadDeployConfig(options.cwd)
  await config.target.logs(
    {
      ...(options.service ? { service: options.service } : {}),
      tail,
      follow: options.follow === true,
      write: (line) => console.log(line),
    },
    { name: config.name }
  )
}

export async function runDeployControl(options: {
  readonly action: DeployControlAction
  readonly service?: string
  readonly cwd?: string
}) {
  const { config } = await loadDeployConfig(options.cwd)
  await config.target.control(options.action, options.service, { name: config.name })
  await renderStatic(
    deployStatusView({
      name: config.name,
      location: config.target.location,
      status: await config.target.status({ name: config.name }),
    })
  )
}

/**
 * Follows the target's progress: a live view in a terminal, one line per step and output line
 * elsewhere, so CI logs read top to bottom.
 */
async function createProgress(
  release: DeployRelease,
  source: { readonly commit: string; readonly ref: string; readonly dirty: boolean }
) {
  const location = `${release.target.kind} ${release.target.location}`
  const state = {
    labels: [] as string[],
    current: null as number | null,
    /** The latest output lines of the step running now, kept when it fails. */
    output: [] as string[],
    /** The pull left `.env` as it was. A live view clears step output, so the result has to say. */
    keptEnv: false,
  }
  const live = canRunLive()
    ? await (await import("../ui/live/deploy")).startLiveDeploy({
        name: release.name,
        location,
        ...source,
      })
    : null
  const started = new Map<number, number>()
  const seconds = (index: number) =>
    ((Date.now() - (started.get(index) ?? Date.now())) / 1000).toFixed(1)

  if (!live) {
    console.log(`Deploying ${release.name} ${source.commit.slice(0, 12)} to ${location}`)
    if (source.dirty) console.log("Uncommitted changes are not deployed.")
  }

  return {
    state,
    report(event: DeployEvent) {
      if (event.type === "steps") {
        state.labels = [...event.labels]
        live?.steps(state.labels)
      }
      if (event.type === "step" && event.status === "running") {
        // A step's output is what explains its failure; earlier steps' would bury it.
        state.output = []
        state.current = event.index
        started.set(event.index, Date.now())
        if (live) live.running(event.index)
        else console.log(`▸ ${state.labels[event.index]}`)
      }
      if (event.type === "step" && event.status === "done") {
        if (live) live.done(event.index, seconds(event.index))
        else console.log(deployStepLine(state.labels[event.index] ?? "", seconds(event.index)))
      }
      if (event.type === "output") {
        state.output = [...state.output, event.line].slice(-12)
        if (event.line.includes(ENV_KEPT_MESSAGE)) state.keptEnv = true
        if (live) live.output(event.line)
        else console.log(`  ${event.line}`)
      }
    },
    /** Ends the progress with the screen that explains how it ended. */
    async fail(report: string) {
      if (live) {
        await live.failed(
          state.current,
          state.current === null ? null : seconds(state.current),
          report
        )
      } else {
        await renderStatic(report)
      }
    },
    async finish(report: string) {
      if (live) await live.finished(report)
      else await renderStatic(report)
    },
  }
}

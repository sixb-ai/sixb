import { relative } from "node:path"
import { writeJson } from "@sixb/cli-core"
import type { DeployControlAction, DeployEvent, DeployRelease } from "@sixb/core/deploy"
import { loadDeployConfig } from "../lib/deploy-config"
import { buildDeployRelease } from "../lib/deploy-release"
import { deployer, packSource, resolveBunVersion } from "../lib/deploy-source"
import { SixbCliError } from "../lib/errors"
import {
  DeployCompleteView,
  type DeployProgressState,
  DeployProgressView,
  DeployReleaseView,
  DeployStatusView,
  renderCliError,
  renderPersistent,
  renderStatic,
} from "../ui"

export interface DeployOptions {
  readonly dryRun?: boolean
  readonly json?: boolean
  readonly ref?: string
  readonly cwd?: string
}

export async function runDeploy(options: DeployOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const { path, config } = await loadDeployConfig(cwd)
  const release = buildDeployRelease(config, { bunVersion: await resolveBunVersion(cwd) })

  if (options.dryRun) {
    if (options.json) return writeJson(release)
    await renderStatic(
      <DeployReleaseView release={release} configPath={relative(cwd, path) || path} />
    )
    return
  }

  const source = await packSource(cwd, options.ref)
  const progress = createProgress(release, {
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
    progress.fail()
    const failed = progress.state.labels[progress.state.current ?? -1]
    await renderCliError(error, {
      title: failed ? `Deploy failed at "${failed}"` : "Deploy failed",
      details: progress.state.output,
    })
    process.exit(1)
  }
  progress.finish()
  await renderStatic(
    <DeployCompleteView release={release} commit={source.commit} ref={source.ref} />
  )
}

export async function runDeployStatus(options: { readonly json?: boolean; readonly cwd?: string }) {
  const { config } = await loadDeployConfig(options.cwd)
  const status = await config.target.status({ name: config.name })
  if (options.json) return writeJson(status)
  await renderStatic(
    <DeployStatusView name={config.name} location={config.target.location} status={status} />
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
    <DeployStatusView
      name={config.name}
      location={config.target.location}
      status={await config.target.status({ name: config.name })}
    />
  )
}

/**
 * Follows the target's progress: a live view in a terminal, one line per step and output line
 * elsewhere, so CI logs read top to bottom.
 */
function createProgress(
  release: DeployRelease,
  source: { readonly commit: string; readonly ref: string; readonly dirty: boolean }
) {
  const state: { -readonly [Key in keyof DeployProgressState]: DeployProgressState[Key] } = {
    name: release.name,
    location: `${release.target.kind} ${release.target.location}`,
    commit: source.commit,
    ref: source.ref,
    dirty: source.dirty,
    labels: [],
    done: 0,
    current: null,
    output: [],
    outcome: "running",
  }
  const live = process.stdout.isTTY && !process.env.CI
  const app = live ? renderPersistent(<DeployProgressView state={{ ...state }} />) : null
  const started = new Map<number, number>()
  const render = () => app?.rerender(<DeployProgressView state={{ ...state }} />)

  if (!live) {
    console.log(`Deploying ${release.name} ${source.commit.slice(0, 12)} to ${state.location}`)
    if (source.dirty) console.log("Uncommitted changes are not deployed.")
  }

  return {
    state,
    report(event: DeployEvent) {
      if (event.type === "steps") state.labels = [...event.labels]
      if (event.type === "step" && event.status === "running") {
        state.current = event.index
        started.set(event.index, Date.now())
        if (!live) console.log(`▸ ${state.labels[event.index]}`)
      }
      if (event.type === "step" && event.status === "done") {
        state.done = event.index + 1
        if (!live) {
          const seconds = ((Date.now() - (started.get(event.index) ?? Date.now())) / 1000).toFixed(
            1
          )
          console.log(`✓ ${state.labels[event.index]} (${seconds}s)`)
        }
      }
      if (event.type === "output") {
        state.output = [...state.output, event.line].slice(-12)
        if (!live) console.log(`  ${event.line}`)
      }
      render()
    },
    fail() {
      state.outcome = "failed"
      render()
      app?.unmount()
    },
    finish() {
      state.outcome = "done"
      state.current = null
      render()
      app?.unmount()
    },
  }
}

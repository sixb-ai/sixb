import { mkdir } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { writeJson } from "@sixb/cli-core"
import type {
  DeployAccessKey,
  DeployCheck,
  DeployConfig,
  DeployControlAction,
  DeployEvent,
  DeployRelease,
} from "@sixb/core/deploy"
import { loadDeployConfig } from "../lib/deploy-config"
import { buildDeployRelease } from "../lib/deploy-release"
import {
  deployer,
  packSource,
  projectPathOf,
  repoRootOf,
  resolveBunVersion,
} from "../lib/deploy-source"
import { SixbCliError } from "../lib/errors"
import {
  bunVersionFile,
  CI_ENVIRONMENT,
  currentRepo,
  ensureEnvironment,
  hasSecret,
  isPrivate,
  readSubmodules,
  renderWorkflow,
  SUBMODULE_TOKEN_SECRET,
  secretName,
  setSecret,
  workflowPath,
} from "../lib/github-ci"
import {
  cliErrorView,
  deployAccessView,
  deployChecksView,
  deployCiView,
  deployCompleteView,
  deployReleaseView,
  deployStatusView,
  deployStepLine,
  renderStatic,
  withTask,
} from "../ui"
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

  if (options.dryRun) {
    const release = buildDeployRelease(config, { bunVersion: await resolveBunVersion(cwd) })
    if (options.json) return writeJson(release)
    await renderStatic(deployReleaseView({ release, configPath: relative(cwd, path) || path }))
    return
  }

  const deployStartedAt = Date.now()
  const { source, release, checks } = await withTask("deploy", "Packing source", async (task) => {
    const source = await packSource(cwd, options.ref)
    const release = buildDeployRelease(config, {
      bunVersion: await resolveBunVersion(cwd, source),
    })
    // Stop before uploading anything when the target already says the deploy cannot work.
    task.step(`Checking ${location(config)}`)
    const checks = await config.target.check(release, {
      name: config.name,
      projectPath: source.projectPath,
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
      commit: source.commit,
      ref: source.ref,
      seconds: (Date.now() - deployStartedAt) / 1000,
    })
  )
}

export async function runDeployCheck(options: { readonly json?: boolean; readonly cwd?: string }) {
  const cwd = options.cwd ?? process.cwd()
  const { config } = await loadDeployConfig(cwd)
  const release = buildDeployRelease(config, { bunVersion: await resolveBunVersion(cwd) })
  const projectPath = await projectPathOf(cwd)
  const checks = await withTask("deploy check", `Checking ${location(config)}`, () =>
    config.target.check(release, { name: config.name, projectPath })
  )
  if (options.json) writeJson(checks)
  else
    await renderStatic(deployChecksView({ name: config.name, location: location(config), checks }))
  if (checks.some(blocksDeploy)) process.exitCode = 1
}

export async function runDeploySetup(options: {
  readonly admin?: string
  readonly key?: string
  readonly cwd?: string
}) {
  const cwd = options.cwd ?? process.cwd()
  const { config } = await loadDeployConfig(cwd)
  const release = buildDeployRelease(config, { bunVersion: await resolveBunVersion(cwd) })
  const context = { name: config.name, projectPath: await projectPathOf(cwd) }

  if (!config.target.setup) {
    console.log(`A ${config.target.kind} target needs no setup.`)
  } else {
    await config.target.setup(release, {
      ...context,
      ...(options.admin ? { admin: options.admin } : {}),
      ...(options.key ? { key: options.key } : {}),
      write: (line) => console.log(line),
    })
  }
  const checks = await config.target.check(release, context)
  await renderStatic(deployChecksView({ name: config.name, location: location(config), checks }))
}

export async function runDeployAccess(options: {
  readonly action: "list" | "add" | "remove"
  readonly value?: string
  readonly json?: boolean
  readonly cwd?: string
}) {
  const { config } = await loadDeployConfig(options.cwd)
  const access = config.target.access
  if (!access) {
    throw new SixbCliError(`[SixbDeploy] A ${config.target.kind} target has no keys to manage.`)
  }
  const context = { name: config.name }

  if (options.action === "list") {
    const keys = await access.list(context)
    if (options.json) return writeJson(keys)
    return renderStatic(deployAccessView({ title: `Keys for ${location(config)}`, keys }))
  }
  if (options.action === "add") {
    const added: DeployAccessKey[] = []
    for (const key of await publicKeys(options.value ?? ""))
      added.push(await access.add(key, context))
    return renderStatic(deployAccessView({ title: "Authorized", keys: added }))
  }
  const removed = await access.remove(options.value ?? "", context)
  return renderStatic(deployAccessView({ title: "Revoked", keys: removed }))
}

/**
 * Sets up deploys from GitHub Actions: a key for the job, authorized on the target and stored as
 * secrets of the repository's `production` environment, and the workflow that uses it. Running it
 * again rotates the key: the new one is stored before the old one is revoked.
 */
export async function runDeployCi(options: { readonly branch?: string; readonly cwd?: string }) {
  const cwd = options.cwd ?? process.cwd()
  const { config } = await loadDeployConfig(cwd)
  const ci = config.target.ci
  if (!ci) {
    throw new SixbCliError(`[SixbDeploy] A ${config.target.kind} target cannot deploy from CI.`)
  }

  const repo = await currentRepo(cwd)
  const projectPath = await projectPathOf(cwd)
  const repoRoot = await repoRootOf(cwd)
  const submodules = await readSubmodules(repoRoot, repo)
  const privateSubmodules = []
  for (const submodule of submodules) {
    if (!submodule.repo || (await isPrivate(submodule.repo))) privateSubmodules.push(submodule)
  }

  const credential = await ci.create(`github:${repo.name}`, { name: config.name })
  const secrets = Object.fromEntries(
    Object.keys(credential.secrets).map((variable) => [variable, secretName(config.name, variable)])
  )
  try {
    await ensureEnvironment(repo)
    for (const [variable, value] of Object.entries(credential.secrets)) {
      await setSecret(repo, secrets[variable] ?? variable, value)
    }
  } catch (error) {
    // CI never got the new key, so it must not stay authorized.
    await credential.revoke()
    throw error
  }
  const retired = await credential.retireOthers()

  const branch = options.branch ?? repo.defaultBranch
  const workflow = renderWorkflow({
    name: config.name,
    branch,
    projectPath,
    bunVersionFile: await bunVersionFile(join(repoRoot, projectPath), repoRoot),
    secrets,
    install: credential.install,
    submodules:
      privateSubmodules.length > 0 ? "private" : submodules.length > 0 ? "public" : "none",
  })
  const path = workflowPath(config.name)
  const file = Bun.file(join(repoRoot, path))
  // A workflow already there may have been edited, and rotating the key must not undo that.
  const existing = (await file.exists()) ? await file.text() : null
  if (existing === null) {
    await mkdir(dirname(join(repoRoot, path)), { recursive: true })
    await Bun.write(file, workflow)
  }

  await renderStatic(
    deployCiView({
      name: config.name,
      repo: repo.name,
      environment: CI_ENVIRONMENT,
      branch,
      credential: credential.description,
      secrets: Object.values(secrets),
      retired,
      workflow: {
        path,
        state: existing === null ? "written" : existing === workflow ? "unchanged" : "kept",
      },
      token:
        privateSubmodules.length > 0 && !(await hasSecret(repo, SUBMODULE_TOKEN_SECRET))
          ? { name: SUBMODULE_TOKEN_SECRET, submodules: privateSubmodules }
          : null,
    })
  )
}

/**
 * The public keys a value names: `github:<user>` for the keys on that GitHub account, a path to a
 * `.pub` file, or the key's own text.
 */
async function publicKeys(value: string): Promise<string[]> {
  if (value.startsWith("github:")) {
    const user = value.slice("github:".length)
    const response = await fetch(`https://github.com/${encodeURIComponent(user)}.keys`)
    if (!response.ok) {
      throw new SixbCliError(`[SixbDeploy] GitHub has no public keys for '${user}'.`)
    }
    const keys = (await response.text()).split("\n").filter((line) => line.trim())
    if (keys.length === 0) throw new SixbCliError(`[SixbDeploy] '${user}' has no keys on GitHub.`)
    return keys.map((key) => `${key.trim()} ${user}@github`)
  }
  const file = Bun.file(value)
  if (await file.exists()) return [(await file.text()).trim()]
  return [value]
}

function blocksDeploy(check: DeployCheck): boolean {
  return check.status === "fixable" || check.status === "manual"
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

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
  DeployAccessView,
  DeployChecksView,
  DeployCiView,
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

  if (options.dryRun) {
    const release = buildDeployRelease(config, { bunVersion: await resolveBunVersion(cwd) })
    if (options.json) return writeJson(release)
    await renderStatic(
      <DeployReleaseView release={release} configPath={relative(cwd, path) || path} />
    )
    return
  }

  const source = await packSource(cwd, options.ref)
  const release = buildDeployRelease(config, { bunVersion: await resolveBunVersion(cwd, source) })

  // Stop before uploading anything when the target already says the deploy cannot work.
  const checks = await config.target.check(release, {
    name: config.name,
    projectPath: source.projectPath,
  })
  if (checks.some(blocksDeploy)) {
    await renderStatic(
      <DeployChecksView name={config.name} location={location(config)} checks={checks} />
    )
    process.exit(1)
  }
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

export async function runDeployCheck(options: { readonly json?: boolean; readonly cwd?: string }) {
  const cwd = options.cwd ?? process.cwd()
  const { config } = await loadDeployConfig(cwd)
  const release = buildDeployRelease(config, { bunVersion: await resolveBunVersion(cwd) })
  const checks = await config.target.check(release, {
    name: config.name,
    projectPath: await projectPathOf(cwd),
  })
  if (options.json) writeJson(checks)
  else
    await renderStatic(
      <DeployChecksView name={config.name} location={location(config)} checks={checks} />
    )
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
  await renderStatic(
    <DeployChecksView name={config.name} location={location(config)} checks={checks} />
  )
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
    return renderStatic(<DeployAccessView title={`Keys for ${location(config)}`} keys={keys} />)
  }
  if (options.action === "add") {
    const added: DeployAccessKey[] = []
    for (const key of await publicKeys(options.value ?? ""))
      added.push(await access.add(key, context))
    return renderStatic(<DeployAccessView title="Authorized" keys={added} />)
  }
  const removed = await access.remove(options.value ?? "", context)
  return renderStatic(<DeployAccessView title="Revoked" keys={removed} />)
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
  const privateSubmodules: string[] = []
  for (const submodule of submodules) {
    if (!submodule.repo || (await isPrivate(submodule.repo))) privateSubmodules.push(submodule.path)
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
  const changed = !(await file.exists()) || (await file.text()) !== workflow
  if (changed) {
    await mkdir(dirname(join(repoRoot, path)), { recursive: true })
    await Bun.write(file, workflow)
  }

  await renderStatic(
    <DeployCiView
      name={config.name}
      repo={repo.name}
      environment={CI_ENVIRONMENT}
      branch={branch}
      credential={credential.description}
      secrets={Object.values(secrets)}
      retired={retired}
      workflow={{ path, changed }}
      token={
        privateSubmodules.length > 0 && !(await hasSecret(repo, SUBMODULE_TOKEN_SECRET))
          ? { name: SUBMODULE_TOKEN_SECRET, submodules: privateSubmodules }
          : null
      }
    />
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
        // A step's output is what explains its failure; earlier steps' would bury it.
        state.output = []
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

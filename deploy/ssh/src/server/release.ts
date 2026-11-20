import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises"
import { dirname, join, posix, relative } from "node:path"
import type { DeployCommand, DeployRelease } from "@sixb/core/deploy"
import {
  type DeploymentLayout,
  type DeploySlot,
  deploymentLayout,
  legacyLayout,
  otherSlot,
  type ReleaseLayout,
  releaseLayout,
  SLOT_PORTS,
  type SlotLayout,
  slotLayout,
} from "../layout"
import { commandLabel, event, type ReleasePlan } from "../plan"
import {
  releaseForSlot,
  renderCaddySnippet,
  renderCtl,
  renderLauncher,
  renderProcessManifest,
  renderSlotUnit,
} from "../render"
import { isExclusiveService, loadProcessManifest, type ProcessManifest } from "./manifest"
import { isMissing, isPidRunning, type ProcessState, writeFileAtomically } from "./state"
import type { SupervisorCommand } from "./supervisor"

/** What the rollout does to the server beyond its own files, so a test can stand in for it. */
export interface ReleaseHost {
  /** Runs a command with its output in the release's log; resolves with its exit code. */
  run(
    command: readonly string[],
    options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }
  ): Promise<number>
  systemctl(...args: string[]): Promise<number>
  /** Whether a unit runs anything: started, starting, or still stopping while it drains. */
  isActive(unit: string): Promise<boolean>
  readRoutes(path: string): Promise<string | null>
  /** Writes the deployment's routes, or removes them with null. */
  writeRoutes(path: string, routes: string | null): Promise<void>
  /** Validates the whole Caddy configuration; resolves with Caddy's complaint, or null. */
  validateCaddy(): Promise<string | null>
  reloadCaddy(): Promise<boolean>
  /** Whether a URL answers with a 2xx. */
  answers(url: string): Promise<boolean>
  supervise(runDir: string, command: SupervisorCommand, service: string): Promise<void>
  readState(runDir: string): Promise<ProcessState | null>
  sleep(ms: number): Promise<void>
  print(line: string): void
}

const READY_ATTEMPTS = 90
/** A process that exits in its first seconds fails the check: services that start must stay up. */
const QUIET_MS = 5_000
const SUPERVISOR_START_MS = 15_000
/** How long a slot left draining by an earlier deploy gets before it is killed for this one. */
const LEFTOVER_STOP_MS = 10_000

/** The live release: a slot, a deployment from before slots, or nothing running. */
type Live =
  | { readonly kind: "slot"; readonly slot: DeploySlot; readonly manifest: ProcessManifest }
  | { readonly kind: "legacy"; readonly slot: DeploySlot; readonly manifest: ProcessManifest }

/**
 * Rolls a release out beside the live one, under the deploy lock the bootstrap holds. The live
 * release keeps serving until the new one has passed its checks after the routes move; any
 * failure before that leaves it serving, and one after it moves the routes back.
 */
export async function runRelease(plan: ReleasePlan, host: ReleaseHost, home: string) {
  const { release } = plan
  const layout = deploymentLayout({ home, name: release.name })
  const next = releaseLayout(layout, {
    id: plan.releaseId,
    projectPath: plan.projectPath,
    bunVersion: release.bunVersion,
  })
  const step = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    host.print(event({ step: label, status: "running" }))
    const result = await work()
    host.print(event({ step: label, status: "done" }))
    return result
  }
  const sixb = (args: readonly string[]) =>
    host.run([next.bun, `${next.project}/node_modules/.bin/sixb`, ...args], {
      cwd: next.project,
      env: { ...release.env, PATH: `${next.bunDir}:${process.env.PATH ?? ""}` },
    })
  const mustRun = async (command: DeployCommand) => {
    const code =
      command.program === "sixb"
        ? await sixb(command.args)
        : await host.run([next.bun, ...command.args], { cwd: next.project, env: release.env })
    if (code !== 0)
      throw new Error(`[SshTarget] ${commandLabel(command)} exited with code ${code}.`)
  }

  let live = await findLive(layout, host)
  const slot = slotLayout(layout, live ? otherSlot(live.slot) : await idleSlot(layout))
  const undo: (() => Promise<void>)[] = []

  if (release.steps.env) {
    const pull = release.steps.env
    await step(commandLabel(pull), async () => {
      // On an outage, the pull keeps the `.env` it finds: the live release's.
      await copyIfPresent(join(layout.code, plan.projectPath, ".env"), join(next.project, ".env"))
      await mustRun({ ...pull, args: [...pull.args, "--token-file", layout.envToken] })
    })
  } else if (await exists(layout.sharedEnv)) {
    await symlink(layout.sharedEnv, join(next.project, ".env")).catch(ignoreExisting)
  }

  for (const [index, command] of release.steps.build.entries()) {
    await step(commandLabel(command), async () => {
      await mustRun(command)
      if (index === release.steps.build.length - 1) {
        await carryAssets(join(layout.code, plan.projectPath), next.project)
      }
    })
  }

  for (const command of release.steps.beforeStart) {
    await step(commandLabel(command), async () => {
      if (!migrates(command)) return mustRun(command)
      const anyway = { ...command, args: [...command.args, "--allow-incompatible"] }
      // With nothing live, there is nothing a migration could break.
      if (!live) return mustRun(anyway)
      const code = await sixb(command.args)
      if (code === 0) return
      if (code !== INCOMPATIBLE_MIGRATION) {
        throw new Error(`[SshTarget] ${commandLabel(command)} exited with code ${code}.`)
      }
      if (!plan.acceptDowntime) {
        throw new Error(
          "[SshTarget] A migration in this release breaks the live release. Deploy again with --accept-downtime to stop the services while it runs."
        )
      }
      host.print("Stopping the services: a migration in this release breaks the live release.")
      await stopLive(layout, live, host)
      live = null
      await mustRun(anyway)
    })
  }

  const exclusive = release.services.filter((service) => isExclusive(service.kind))
  const holdExclusive = live !== null

  try {
    await step("Start new release", async () => {
      await stopLeftover(slot, host)
      await writeServiceFiles(layout, slot, next, release, holdExclusive)
      await host.systemctl("daemon-reload")
      await rm(join(slot.runDir, "state.json"), { force: true })
      undo.push(() => host.systemctl("stop", slot.unit).then(() => undefined))
      if ((await host.systemctl("start", slot.unit)) !== 0) {
        throw new Error(`[SshTarget] systemd did not start ${slot.unit}.`)
      }
    })

    await step("Check services", async () => {
      const startedAt = Date.now()
      await waitForReadiness(release, slot, host)
      const quiet = QUIET_MS - (Date.now() - startedAt)
      if (quiet > 0) await host.sleep(quiet)
      await assertHealthy(slot, host, holdExclusive)
    })

    await step("Update routes", async () => {
      const routes = renderCaddySnippet(releaseForSlot(release, SLOT_PORTS[slot.slot]))
      const previous = await switchRoutes(layout.caddySnippet, routes, host)
      undo.push(async () => {
        await host.writeRoutes(layout.caddySnippet, previous)
        if (!(await host.reloadCaddy())) {
          host.print("Caddy did not reload the previous routes: run sudo systemctl reload caddy.")
        }
      })
    })

    await step("Move singletons", async () => {
      if (!live) return
      const previous = live
      const running = previous.manifest.services.filter(isExclusiveService)
      for (const service of running) await controlLive(previous, layout, "stop", service.name, host)
      undo.push(async () => {
        for (const service of running) {
          await controlLive(previous, layout, "start", service.name, host)
        }
      })
      for (const service of exclusive) await host.supervise(slot.runDir, "start", service.name)
      if (exclusive.length > 0) await host.sleep(2_000)
      await assertHealthy(slot, host, false)
    })
  } catch (error) {
    for (const back of undo.reverse()) {
      await back().catch((failure: unknown) => host.print(errorMessage(failure)))
    }
    throw new Error(
      live ? `${errorMessage(error)}\nThe previous release is still serving.` : errorMessage(error)
    )
  }

  await step("Retire previous release", async () => {
    await retire({ layout, slot, next, release, plan, live, host })
  })
}

/** Reads the live release from the services that run, not from files a crash could leave. */
async function findLive(layout: DeploymentLayout, host: ReleaseHost): Promise<Live | null> {
  const recorded = (await readText(layout.liveSlotFile))?.trim()
  if (recorded === "blue" || recorded === "green") {
    const slot = slotLayout(layout, recorded)
    if (await host.isActive(slot.unit)) {
      return { kind: "slot", slot: recorded, manifest: await loadProcessManifest(slot.manifest) }
    }
  }
  const legacy = legacyLayout(layout)
  if (await host.isActive(legacy.unit)) {
    const manifest = await loadProcessManifest(legacy.manifest)
    return { kind: "legacy", slot: manifest.slot ?? "blue", manifest }
  }
  return null
}

/** With nothing live, the slot after the last one used, so a stopped deployment alternates too. */
async function idleSlot(layout: DeploymentLayout): Promise<DeploySlot> {
  const recorded = (await readText(layout.liveSlotFile))?.trim()
  return recorded === "blue" ? "green" : "blue"
}

/** A slot an earlier deploy left draining gets a few seconds, then goes, for this release. */
async function stopLeftover(slot: SlotLayout, host: ReleaseHost): Promise<void> {
  if (!(await host.isActive(slot.unit))) return
  host.print(`Stopping what an earlier release left draining in the ${slot.slot} slot.`)
  await host.systemctl("stop", "--no-block", slot.unit)
  for (let waited = 0; waited < LEFTOVER_STOP_MS; waited += 500) {
    if (!(await host.isActive(slot.unit))) return
    await host.sleep(500)
  }
  await host.systemctl("kill", "--signal=SIGKILL", slot.unit)
  await host.systemctl("stop", slot.unit)
}

async function writeServiceFiles(
  layout: DeploymentLayout,
  slot: SlotLayout,
  next: ReleaseLayout,
  release: DeployRelease,
  holdExclusive: boolean
): Promise<void> {
  const manifest = renderProcessManifest(releaseForSlot(release, SLOT_PORTS[slot.slot]), {
    layout,
    slot,
    release: next,
    holdExclusive,
  })
  await mkdir(layout.unitDir, { recursive: true })
  await mkdir(layout.deployDir, { recursive: true })
  await mkdir(slot.logDir, { recursive: true })
  await writeFileAtomically(slot.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeExecutable(slot.launcher, renderLauncher(next, slot))
  await writeFileAtomically(layout.unitTemplate, renderSlotUnit(release, layout))
}

async function waitForReadiness(
  release: DeployRelease,
  slot: SlotLayout,
  host: ReleaseHost
): Promise<void> {
  const api = releaseForSlot(release, SLOT_PORTS[slot.slot]).services.find(
    (service) => service.http?.readinessPath
  )?.http
  if (!api) return
  const url = `http://${api.host}:${api.port}${api.readinessPath}`
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (await host.answers(url)) return
    await host.sleep(1_000)
  }
  await printLogTail(slot, `${release.name}-api-0.log`, host)
  throw new Error(`[SshTarget] The API did not answer ${url} within ${READY_ATTEMPTS} seconds.`)
}

/** Every process the slot runs is up, and none has exited since it started. */
async function assertHealthy(slot: SlotLayout, host: ReleaseHost, holdExclusive: boolean) {
  let state: ProcessState | null = null
  for (let waited = 0; waited < SUPERVISOR_START_MS; waited += 250) {
    state = await host.readState(slot.runDir)
    if (state && isPidRunning(state.supervisorPid)) break
    await host.sleep(250)
  }
  if (!state || !isPidRunning(state.supervisorPid)) {
    throw new Error(`[SshTarget] The ${slot.slot} slot's supervisor did not start.`)
  }
  const manifest = await loadProcessManifest(slot.manifest)
  const held = new Set(
    holdExclusive ? manifest.services.filter(isExclusiveService).map((service) => service.name) : []
  )
  const down = state.instances.filter(
    (instance) =>
      !held.has(instance.service) && (instance.status !== "running" || instance.restarts > 0)
  )
  if (down.length > 0) {
    for (const instance of down) {
      host.print(
        `${instance.service}#${instance.instance} ${instance.status === "running" ? `restarted ${instance.restarts}x` : instance.status}${instance.lastError ? `: ${instance.lastError}` : ""}`
      )
      await printLogTail(slot, `${instance.processName}-${instance.instance}.log`, host)
    }
    throw new Error(
      `[SshTarget] ${down.map((instance) => instance.service).join(", ")} did not stay up.`
    )
  }
}

/**
 * Points Caddy at the new slot, and resolves with the routes it replaced. Caddy has to accept the
 * whole configuration before it reloads; otherwise the previous routes come back.
 */
async function switchRoutes(path: string, routes: string, host: ReleaseHost) {
  const previous = await host.readRoutes(path)
  if (previous === routes) return previous
  await host.writeRoutes(path, routes)

  const rejected = await host.validateCaddy()
  if (rejected !== null) {
    await host.writeRoutes(path, previous)
    host.print(rejected)
    throw new Error("[SshTarget] Caddy rejected the routes; the previous ones are back in place.")
  }
  if (!(await host.reloadCaddy())) {
    await host.writeRoutes(path, previous)
    throw new Error("[SshTarget] Caddy did not reload; the previous routes are back in place.")
  }
  return previous
}

/** A deployment from before slots answers through its own `ctl`; a slot through its supervisor. */
async function controlLive(
  live: Live,
  layout: DeploymentLayout,
  command: "start" | "stop",
  service: string,
  host: ReleaseHost
): Promise<void> {
  if (live.kind === "slot") {
    await host.supervise(slotLayout(layout, live.slot).runDir, command, service)
  } else if ((await host.run([layout.ctl, command, service])) !== 0) {
    throw new Error(`[SshTarget] The previous release did not ${command} ${service}.`)
  }
}

/** For a migration that breaks the live release: its services stop before it runs. */
async function stopLive(layout: DeploymentLayout, live: Live, host: ReleaseHost): Promise<void> {
  if (live.kind === "legacy") {
    await host.systemctl("stop", legacyLayout(layout).unit)
    return
  }
  const slot = slotLayout(layout, live.slot)
  for (const service of live.manifest.services) {
    await host.supervise(slot.runDir, "stop", service.name).catch(() => {})
  }
  await host.systemctl("stop", slot.unit)
}

/**
 * The new release serves: record it, start it at boot, let the previous one drain, and keep the
 * releases still in use.
 */
async function retire(input: {
  readonly layout: DeploymentLayout
  readonly slot: SlotLayout
  readonly next: ReleaseLayout
  readonly release: DeployRelease
  readonly plan: ReleasePlan
  readonly live: Live | null
  readonly host: ReleaseHost
}): Promise<void> {
  const { layout, slot, next, release, plan, live, host } = input
  const previousRelease = await currentReleaseId(layout)

  // Restarted by systemd, the slot runs everything: it is live now.
  const manifest = renderProcessManifest(releaseForSlot(release, SLOT_PORTS[slot.slot]), {
    layout,
    slot,
    release: next,
    holdExclusive: false,
  })
  await writeFileAtomically(slot.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

  // A deployment from before releases kept its code in `code/` itself.
  if ((await lstat(layout.code).catch(() => null))?.isDirectory()) {
    await mkdir(layout.releasesDir, { recursive: true })
    await rm(join(layout.releasesDir, "legacy"), { recursive: true, force: true })
    await rename(layout.code, join(layout.releasesDir, "legacy"))
  }
  await replaceLink(layout.currentLink, posix.join("releases", next.id))
  await replaceLink(layout.code, "current")
  await writeFileAtomically(layout.releaseRecord, `${JSON.stringify(plan.record)}\n`)
  await writeFileAtomically(layout.liveSlotFile, `${slot.slot}\n`)
  await writeExecutable(layout.ctl, renderCtl(next, slot))

  await host.systemctl("enable", slot.unit)
  await host.systemctl("disable", slotLayout(layout, otherSlot(slot.slot)).unit)
  if (live?.kind === "slot") {
    await host.systemctl("stop", "--no-block", slotLayout(layout, live.slot).unit)
  } else if (live?.kind === "legacy") {
    const legacy = legacyLayout(layout)
    await host.systemctl("stop", "--no-block", legacy.unit)
    await host.systemctl("disable", legacy.unit)
    await rm(legacy.unitPath, { force: true })
    await rm(legacy.manifest, { force: true })
    await host.systemctl("daemon-reload")
  }

  // The previous release drains for a few minutes, and the next deploy may roll back to it.
  const keep = new Set([next.id, previousRelease, live?.kind === "legacy" ? "legacy" : null])
  for (const entry of await readdir(layout.releasesDir).catch(() => [])) {
    if (!keep.has(entry))
      await rm(join(layout.releasesDir, entry), { recursive: true, force: true })
  }
}

/**
 * Carries one generation of content-hashed assets from the previous build into the new one, so a
 * tab opened before the deploy never asks for a lazy chunk that is gone.
 */
export async function carryAssets(previousProject: string, nextProject: string): Promise<void> {
  const nextApp = join(nextProject, ".sixb", "dist", "app")
  const previousApp = join(previousProject, ".sixb", "dist", "app")
  if (!(await exists(nextApp))) return
  const own = await listFiles(nextApp)
  await writeFileAtomically(
    join(nextProject, ".sixb", "dist", ".own-assets"),
    `${own.join("\n")}\n`
  )
  if (!(await exists(previousApp))) return

  const previousOwn = await readText(join(previousProject, ".sixb", "dist", ".own-assets"))
  const candidates = previousOwn
    ? previousOwn.split("\n").filter(Boolean)
    : await listFiles(previousApp)
  const present = new Set(own)
  for (const file of candidates) {
    if (present.has(file) || !CARRIED_ASSET.test(posix.basename(file))) continue
    const from = join(previousApp, file)
    const to = join(nextApp, file)
    if (!(await exists(from))) continue
    await mkdir(dirname(to), { recursive: true })
    await link(from, to).catch(() => copyFile(from, to))
  }
}

const CARRIED_ASSET = /^(chunk-|asset-|app-.+\.|shared-app-.+\.|auth-.+\.)/

/** `sixb check --migrate` exits with this when a pending migration breaks the live release. */
const INCOMPATIBLE_MIGRATION = 4

function migrates(command: DeployCommand): boolean {
  return command.program === "sixb" && command.args.includes("--migrate")
}

function isExclusive(kind: DeployRelease["services"][number]["kind"]): boolean {
  return kind === "singleton" || kind === "script"
}

async function printLogTail(slot: SlotLayout, file: string, host: ReleaseHost): Promise<void> {
  const text = await readText(join(slot.logDir, file))
  if (!text) return
  host.print(`Its latest log lines (${file}):`)
  for (const line of text.trimEnd().split("\n").slice(-30)) host.print(line)
}

async function currentReleaseId(layout: DeploymentLayout): Promise<string | null> {
  const target = await readlink(layout.currentLink).catch(() => null)
  return target ? posix.basename(target) : null
}

async function replaceLink(path: string, target: string): Promise<void> {
  const temporary = `${path}.${process.pid}.link`
  await rm(temporary, { force: true })
  await symlink(target, temporary)
  await rename(temporary, path)
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFileAtomically(path, content)
  await chmod(path, 0o755)
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await cp(from, to, { dereference: true })
    await chmod(to, 0o600)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

function ignoreExisting(error: unknown): void {
  if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { type ChildProcess, spawn } from "node:child_process"
import type { WriteStream } from "node:fs"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { Readable } from "node:stream"
import type { DeploySlot } from "../layout"
import { openProcessLog, processLogPath, rotateLogIfLarge } from "./logs"
import {
  controlDir,
  isOverlapSafeService,
  loadProcessManifest,
  type ProcessManifest,
  type ProcessServiceManifest,
  responseDir,
  statePath,
} from "./manifest"
import {
  isMissing,
  isPidRunning,
  type ProcessInstanceState,
  type ProcessInstanceStatus,
  type ProcessState,
  readProcessState,
  writeFileAtomically,
  writeProcessState,
} from "./state"

export type SupervisorCommand = "restart" | "start" | "stop" | "stage" | "activate" | "discard"

const LINUX_CLOCK_TICKS_PER_SECOND = 100
/** How often memory, CPU, and log sizes are checked. */
const SAMPLE_INTERVAL_MS = 5_000
const MAX_RESTART_DELAY_MS = 30_000
/** How long old `api` and `workers` may drain in the background after a blue-green cutover. */
export const RETIRING_KILL_TIMEOUT_MS = 300_000

interface SupervisorRequest {
  readonly id: string
  readonly type: SupervisorCommand
  readonly service?: string
  readonly manifestPath?: string
}

interface SupervisorResponse {
  readonly id: string
  readonly ok: boolean
  readonly message?: string
}

type InstanceCohort = "active" | "staged" | "retiring"

interface ManagedInstance {
  readonly key: string
  readonly cwd: string
  readonly slot?: DeploySlot
  readonly service: ProcessServiceManifest
  readonly instance: number
  readonly child: ChildProcess
  readonly logPath: string
  cohort: InstanceCohort
  log: WriteStream
  startedAt: string
  stoppedAt?: string
  status: ProcessInstanceStatus
  restarts: number
  stopping: boolean
  exited: boolean
  /** Whether the child's output streams have ended. */
  closed: boolean
  cpuPercent?: number
  cpuSample?: CpuSample
  memoryBytes?: number
  restartTimer?: ReturnType<typeof setTimeout>
  cancelRetire?: () => void
  lastExitCode?: number | null
  lastSignal?: NodeJS.Signals | null
  lastError?: string
}

interface CpuSample {
  readonly processSeconds: number
  readonly sampledAtMs: number
}

/**
 * Runs every process a deployment's manifest lists, restarting any that exit, and answers
 * control requests. One per deployment, started by the deployment's `systemd --user` unit.
 *
 * Requests arrive as files in `run/control` followed by `SIGUSR2`, so a caller needs nothing but
 * the file system and the supervisor's pid from `run/state.json`. The supervisor answers in
 * `run/responses`.
 */
export async function runSupervisor(manifestPath: string): Promise<void> {
  const supervisor = new Supervisor(manifestPath, await loadProcessManifest(manifestPath))
  await supervisor.run()
}

/** Asks the running supervisor to control services or cut over a staged release. */
export async function sendSupervisorCommand(
  manifest: ProcessManifest,
  type: SupervisorCommand,
  options: {
    readonly service?: string
    readonly manifestPath?: string
    readonly timeoutMs?: number
  } = {}
): Promise<string> {
  const state = await readProcessState(statePath(manifest))
  if (!state || !isPidRunning(state.supervisorPid)) {
    throw new Error("[SshTarget] The deployment's supervisor is not running.")
  }

  const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`
  await mkdir(controlDir(manifest), { recursive: true })
  await writeFileAtomically(
    resolve(controlDir(manifest), `${id}.json`),
    `${JSON.stringify({
      id,
      type,
      ...(options.service ? { service: options.service } : {}),
      ...(options.manifestPath ? { manifestPath: options.manifestPath } : {}),
    })}\n`
  )
  process.kill(state.supervisorPid, "SIGUSR2")

  const response = await waitForResponse(
    resolve(responseDir(manifest), `${id}.json`),
    options.timeoutMs ?? 90_000
  )
  if (!response.ok) throw new Error(response.message ?? "[SshTarget] The supervisor refused.")
  return response.message ?? type
}

class Supervisor {
  private manifest: ProcessManifest
  private candidate: ProcessManifest | null = null
  private readonly managed = new Map<string, ManagedInstance>()
  private readonly staged = new Map<string, ManagedInstance>()
  private readonly retiring = new Set<ManagedInstance>()
  private readonly restartCounts = new Map<string, number>()
  private readonly stagedRestartCounts = new Map<string, number>()
  private shuttingDown = false
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private resolveStopped: (() => void) | null = null
  private stateWrites: Promise<void> = Promise.resolve()

  constructor(
    private readonly manifestPath: string,
    manifest: ProcessManifest
  ) {
    this.manifest = manifest
  }

  async run(): Promise<void> {
    await mkdir(this.manifest.logDir, { recursive: true })
    await mkdir(controlDir(this.manifest), { recursive: true })
    await mkdir(responseDir(this.manifest), { recursive: true })
    process.once("SIGINT", () => void this.shutdown())
    process.once("SIGTERM", () => void this.shutdown())
    process.on("SIGUSR2", () => void this.handleControlRequests())

    for (const desired of desiredInstances(this.manifest)) {
      await this.startInstance(this.manifest, desired.service, desired.instance, "active")
    }
    // Requests written while the supervisor was starting would otherwise wait for a signal.
    await this.handleControlRequests()
    this.sampleTimer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS)

    await new Promise<void>((resolveStopped) => {
      this.resolveStopped = resolveStopped
    })
  }

  private async startInstance(
    manifest: ProcessManifest,
    service: ProcessServiceManifest,
    instance: number,
    cohort: "active" | "staged"
  ): Promise<void> {
    const key = instanceKey(service.processName, instance)
    const logPath = processLogPath(manifest, service.processName, instance)
    const log = await openProcessLog(logPath)
    // A restart already under way when shutdown began must not leave a process behind.
    if (this.shuttingDown) {
      log.end()
      return
    }
    const counts = cohort === "active" ? this.restartCounts : this.stagedRestartCounts
    const targetMap = cohort === "active" ? this.managed : this.staged
    const child = spawn(service.command, [...service.args], {
      cwd: manifest.cwd,
      env: { ...process.env, ...service.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const managed: ManagedInstance = {
      key,
      cwd: manifest.cwd,
      ...(manifest.slot ? { slot: manifest.slot } : {}),
      service,
      instance,
      cohort,
      child,
      log,
      logPath,
      startedAt: new Date().toISOString(),
      status: "running",
      restarts: counts.get(key) ?? 0,
      stopping: false,
      exited: false,
      closed: false,
    }

    targetMap.set(key, managed)
    log.write(
      `[${managed.startedAt}] start ${service.processName}#${instance} pid=${child.pid ?? "unknown"}\n`
    )
    this.pipeOutput(managed, child.stdout, "stdout")
    this.pipeOutput(managed, child.stderr, "stderr")
    child.on("error", (error) => {
      managed.lastError = error.message
      managed.status = "exited"
      void this.writeState()
    })
    // Lifecycle follows `exit`: Bun does not always emit `close` for a child killed right after
    // it started. `close` only decides when the log may end; see `endLog`.
    child.once("close", () => {
      managed.closed = true
    })
    child.on("exit", (code, signal) => void this.handleExit(managed, code, signal))

    await this.writeState()
  }

  private async handleExit(
    managed: ManagedInstance,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    managed.exited = true
    managed.lastExitCode = code
    managed.lastSignal = signal
    managed.stoppedAt = new Date().toISOString()
    managed.status = managed.stopping ? "stopped" : "exited"
    managed.log.write(
      `[${managed.stoppedAt}] exit code=${code ?? "null"} signal=${signal ?? "null"}\n`
    )
    void endLog(managed)

    if (managed.cohort === "retiring") {
      this.retiring.delete(managed)
      await this.writeState()
      return
    }

    const cohort = managed.cohort
    const ownerMap = cohort === "active" ? this.managed : this.staged
    const counts = cohort === "active" ? this.restartCounts : this.stagedRestartCounts

    if (this.shuttingDown || managed.stopping) {
      if (ownerMap.get(managed.key) === managed) ownerMap.delete(managed.key)
      await this.writeState()
      return
    }

    // Back off a process that keeps exiting: each restart waits one delay longer, up to 30s.
    const restarts = (counts.get(managed.key) ?? 0) + 1
    counts.set(managed.key, restarts)
    managed.restarts = restarts
    const delay = Math.min(managed.service.restartDelayMs * restarts, MAX_RESTART_DELAY_MS)
    managed.restartTimer = setTimeout(() => {
      if (ownerMap.get(managed.key) !== managed) return
      ownerMap.delete(managed.key)
      const currentManifest = cohort === "active" ? this.manifest : this.candidate
      if (!currentManifest || currentManifest.cwd !== managed.cwd) return
      void this.startInstance(currentManifest, managed.service, managed.instance, cohort)
    }, delay)
    await this.writeState()
  }

  private async stopManaged(
    managed: ManagedInstance,
    timeoutMs = managed.service.killTimeoutMs
  ): Promise<void> {
    if (managed.restartTimer) clearTimeout(managed.restartTimer)
    managed.cancelRetire?.()
    managed.cancelRetire = undefined
    managed.stopping = true

    const removeFromOwner = () => {
      if (this.managed.get(managed.key) === managed) this.managed.delete(managed.key)
      if (this.staged.get(managed.key) === managed) this.staged.delete(managed.key)
      this.retiring.delete(managed)
    }

    // Tracked here rather than read from `child.exitCode`, which Bun does not always set.
    if (managed.exited) {
      removeFromOwner()
      await this.writeState()
      return
    }

    managed.status = "stopping"
    await this.writeState()
    await new Promise<void>((resolveStop) => {
      // The child can exit during the state write above, and its `exit` has then already fired.
      // systemd signals every process in the unit at once, so a deploy's stop often lands here.
      if (managed.exited) {
        resolveStop()
        return
      }
      // Give draining roles 10s before SIGKILL to escalate via SIGINT and record partial work.
      const interruptTimer =
        timeoutMs > 15_000
          ? setTimeout(() => {
              if (!managed.exited) managed.child.kill("SIGINT")
            }, timeoutMs - 10_000)
          : undefined
      const killTimer = setTimeout(() => {
        if (!managed.exited) managed.child.kill("SIGKILL")
      }, timeoutMs)
      // A child killed as it started may never report its exit; stopping must still finish.
      const giveUp = setTimeout(done, timeoutMs + 2_000)
      function done() {
        if (interruptTimer) clearTimeout(interruptTimer)
        clearTimeout(killTimer)
        clearTimeout(giveUp)
        resolveStop()
      }
      managed.child.once("exit", done)
      managed.child.kill("SIGTERM")
    })
    removeFromOwner()
    // The exit listener queues its state write asynchronously. Publish the final state before
    // the control request can acknowledge the stop, including when the exit event never arrives.
    await this.writeState()
  }

  private retireManaged(managed: ManagedInstance): void {
    if (managed.restartTimer) clearTimeout(managed.restartTimer)
    managed.cohort = "retiring"
    managed.stopping = true
    managed.status = "stopping"

    if (managed.exited) {
      this.retiring.delete(managed)
      return
    }

    this.retiring.add(managed)
    const timeoutMs = Math.max(managed.service.killTimeoutMs, RETIRING_KILL_TIMEOUT_MS)
    const interruptTimer = setTimeout(
      () => {
        if (!managed.exited) managed.child.kill("SIGINT")
      },
      Math.max(timeoutMs - 10_000, 1_000)
    )
    const killTimer = setTimeout(() => {
      if (!managed.exited) managed.child.kill("SIGKILL")
    }, timeoutMs)
    const giveUp = setTimeout(() => {
      cleanup()
      this.retiring.delete(managed)
      void this.writeState()
    }, timeoutMs + 2_000)

    const cleanup = () => {
      clearTimeout(interruptTimer)
      clearTimeout(killTimer)
      clearTimeout(giveUp)
      managed.cancelRetire = undefined
    }
    managed.cancelRetire = cleanup
    managed.child.once("exit", cleanup)
    managed.child.kill("SIGTERM")
  }

  private async handleControlRequests(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(controlDir(this.manifest))
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }

    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const path = resolve(controlDir(this.manifest), entry)
      let request: SupervisorRequest | null = null
      try {
        request = parseRequest(JSON.parse(await readFile(path, "utf8")))
        await rm(path, { force: true })
        await this.writeResponse(request.id, true, await this.handleRequest(request))
      } catch (error) {
        await rm(path, { force: true })
        if (request) await this.writeResponse(request.id, false, errorMessage(error))
      }
    }
  }

  private async handleRequest(request: SupervisorRequest): Promise<string> {
    if (request.type === "stage") {
      if (!request.manifestPath) {
        throw new Error("[SshTarget] stage requires a candidate manifest path.")
      }
      return this.stageCandidate(await loadProcessManifest(request.manifestPath))
    }
    if (request.type === "discard") {
      await this.discardStaged()
      return "discarded candidate"
    }
    if (request.type === "activate") {
      return this.activateCandidate()
    }

    const services = this.manifest.services.filter(
      (service) => !request.service || service.name === request.service
    )
    if (services.length === 0) {
      throw new Error(
        `[SshTarget] No service named '${request.service}'. ` +
          `Services: ${this.manifest.services.map((service) => service.name).join(", ")}.`
      )
    }
    const names = new Set(services.map((service) => service.name))
    const running = [...this.managed.values()].filter((managed) => names.has(managed.service.name))

    if (request.type !== "start") {
      for (const managed of running) await this.stopManaged(managed)
    }
    if (request.type !== "stop") {
      for (const desired of desiredInstances(this.manifest)) {
        if (!names.has(desired.service.name) || this.managed.has(desired.key)) continue
        this.restartCounts.delete(desired.key)
        await this.startInstance(this.manifest, desired.service, desired.instance, "active")
      }
    }
    return `${request.type === "stop" ? "stopped" : `${request.type}ed`} ${[...names].join(", ")}`
  }

  private async stageCandidate(candidate: ProcessManifest): Promise<string> {
    await this.discardStaged()

    // Ensure no retiring HTTP server still holds the candidate slot's loopback ports.
    const sameSlotHttp = [...this.retiring].filter(
      (managed) =>
        managed.service.kind === "http" &&
        (candidate.slot === undefined || managed.slot === candidate.slot)
    )
    if (sameSlotHttp.length > 0) {
      await Promise.all(sameSlotHttp.map((managed) => this.stopManaged(managed, 5_000)))
    }

    this.candidate = candidate
    this.stagedRestartCounts.clear()
    const started: string[] = []
    for (const desired of desiredInstances(candidate)) {
      if (!isOverlapSafeService(desired.service)) continue
      await this.startInstance(candidate, desired.service, desired.instance, "staged")
      if (!started.includes(desired.service.name)) started.push(desired.service.name)
    }
    await this.writeState()
    return `staged ${started.join(", ") || "candidate"}`
  }

  private async discardStaged(): Promise<void> {
    const staged = [...this.staged.values()]
    this.candidate = null
    this.stagedRestartCounts.clear()
    if (staged.length > 0) {
      await Promise.all(staged.map((managed) => this.stopManaged(managed)))
    }
    await this.writeState()
  }

  private async activateCandidate(): Promise<string> {
    const nextManifest = this.candidate ?? (await loadProcessManifest(this.manifestPath))
    const activeInstances = [...this.managed.values()]
    const exclusiveOld = activeInstances.filter((managed) => !isOverlapSafeService(managed.service))
    const overlapOld = activeInstances.filter((managed) => isOverlapSafeService(managed.service))

    // Stop singletons and custom scripts before starting the new release's copies.
    if (exclusiveOld.length > 0) {
      await Promise.all(exclusiveOld.map((managed) => this.stopManaged(managed)))
    }

    // Drain old HTTP and worker instances in the background while green serves traffic.
    for (const managed of overlapOld) {
      this.managed.delete(managed.key)
      this.retireManaged(managed)
    }

    this.manifest = nextManifest
    this.candidate = null
    this.restartCounts.clear()
    for (const [key, count] of this.stagedRestartCounts) {
      this.restartCounts.set(key, count)
    }
    this.stagedRestartCounts.clear()

    for (const [key, staged] of this.staged) {
      staged.cohort = "active"
      this.managed.set(key, staged)
    }
    this.staged.clear()

    for (const desired of desiredInstances(nextManifest)) {
      if (this.managed.has(desired.key)) continue
      await this.startInstance(nextManifest, desired.service, desired.instance, "active")
    }

    await this.writeState()
    return `activated ${nextManifest.services.map((service) => service.name).join(", ")}`
  }

  private async writeResponse(id: string, ok: boolean, message: string): Promise<void> {
    await mkdir(responseDir(this.manifest), { recursive: true })
    await writeFileAtomically(
      resolve(responseDir(this.manifest), `${id}.json`),
      `${JSON.stringify({ id, ok, message } satisfies SupervisorResponse)}\n`
    )
  }

  private async sample(): Promise<void> {
    for (const managed of [...this.managed.values()]) {
      const pid = managed.child.pid
      if (!pid || managed.status !== "running") continue
      await this.rotateLog(managed)
      const cpuSample = await readLinuxCpuSample(pid)
      if (cpuSample) {
        managed.cpuPercent = cpuPercent(managed.cpuSample, cpuSample)
        managed.cpuSample = cpuSample
      }
      const memory = await readLinuxRssBytes(pid)
      if (!memory) continue
      managed.memoryBytes = memory

      const limit = managed.service.maxMemory ? parseMemoryLimit(managed.service.maxMemory) : null
      if (limit && memory > limit) {
        managed.lastError = `memory limit exceeded: ${formatBytes(memory)} > ${managed.service.maxMemory}`
        managed.log.write(`[${new Date().toISOString()}] ${managed.lastError}\n`)
        await this.stopManaged(managed)
        this.restartCounts.set(managed.key, managed.restarts + 1)
        await this.startInstance(this.manifest, managed.service, managed.instance, "active")
      }
    }
    await this.writeState()
  }

  private async rotateLog(managed: ManagedInstance): Promise<void> {
    if (!(await rotateLogIfLarge(managed.logPath))) return
    const previous = managed.log
    managed.log = await openProcessLog(managed.logPath)
    previous.end()
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.sampleTimer) clearInterval(this.sampleTimer)

    const all = [...this.managed.values(), ...this.staged.values(), ...this.retiring]
    await Promise.all(all.map((managed) => this.stopManaged(managed)))
    await this.writeState()
    this.resolveStopped?.()
  }

  /**
   * Queues a snapshot write. Writes run one at a time, each taking its snapshot when it starts,
   * and a failed one is reported rather than stopping the processes it describes.
   */
  private writeState(): Promise<void> {
    this.stateWrites = this.stateWrites
      .then(() => writeProcessState(statePath(this.manifest), this.snapshotState()))
      .catch((error) => console.error(`[SshTarget] Could not write state: ${errorMessage(error)}`))
    return this.stateWrites
  }

  private snapshotState(): ProcessState {
    const staged = this.candidate
      ? desiredInstances(this.candidate)
          .filter((desired) => isOverlapSafeService(desired.service))
          .map((desired) =>
            snapshotDesired(this.candidate!, desired, this.staged, this.stagedRestartCounts)
          )
      : undefined
    const retiringCwds = [...new Set([...this.retiring].map((managed) => managed.cwd))]

    return {
      version: 1,
      name: this.manifest.name,
      supervisorPid: process.pid,
      updatedAt: new Date().toISOString(),
      ...(this.manifest.slot ? { slot: this.manifest.slot } : {}),
      instances: desiredInstances(this.manifest).map((desired) =>
        snapshotDesired(this.manifest, desired, this.managed, this.restartCounts)
      ),
      ...(staged ? { staged } : {}),
      ...(retiringCwds.length > 0 ? { retiringCwds } : {}),
    }
  }

  private pipeOutput(
    managed: ManagedInstance,
    stream: Readable | null,
    streamName: "stdout" | "stderr"
  ): void {
    if (!stream) return
    let buffer = ""
    const write = (line: string) => {
      if (managed.log.writableEnded) return
      managed.log.write(`[${new Date().toISOString()}] [${streamName}] ${line}\n`)
    }

    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n|\r/)
      buffer = lines.pop() ?? ""
      for (const line of lines) write(line)
    })
    stream.on("end", () => {
      if (buffer) write(buffer)
      buffer = ""
    })
  }
}

function desiredInstances(manifest: ProcessManifest): {
  readonly key: string
  readonly service: ProcessServiceManifest
  readonly instance: number
}[] {
  return manifest.services.flatMap((service) =>
    Array.from({ length: service.instances }, (_, instance) => ({
      key: instanceKey(service.processName, instance),
      service,
      instance,
    }))
  )
}

function snapshotDesired(
  manifest: ProcessManifest,
  desired: {
    readonly key: string
    readonly service: ProcessServiceManifest
    readonly instance: number
  },
  instances: ReadonlyMap<string, ManagedInstance>,
  restarts: ReadonlyMap<string, number>
): ProcessInstanceState {
  const managed = instances.get(desired.key)
  if (managed) return snapshot(managed)
  return {
    service: desired.service.name,
    processName: desired.service.processName,
    instance: desired.instance,
    status: "stopped",
    restarts: restarts.get(desired.key) ?? 0,
    logPath: processLogPath(manifest, desired.service.processName, desired.instance),
  }
}

/** Ends a log once the child's output has drained, or two seconds after it exited. */
async function endLog(managed: ManagedInstance): Promise<void> {
  for (let waited = 0; !managed.closed && waited < 2_000; waited += 50) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50))
  }
  managed.log.end()
}

function snapshot(managed: ManagedInstance): ProcessInstanceState {
  return {
    service: managed.service.name,
    processName: managed.service.processName,
    instance: managed.instance,
    ...(managed.child.pid ? { pid: managed.child.pid } : {}),
    status: managed.status,
    startedAt: managed.startedAt,
    ...(managed.stoppedAt ? { stoppedAt: managed.stoppedAt } : {}),
    restarts: managed.restarts,
    ...(managed.cpuPercent === undefined ? {} : { cpuPercent: managed.cpuPercent }),
    ...(managed.memoryBytes ? { memoryBytes: managed.memoryBytes } : {}),
    ...(managed.lastExitCode === undefined ? {} : { lastExitCode: managed.lastExitCode }),
    ...(managed.lastSignal === undefined ? {} : { lastSignal: managed.lastSignal }),
    ...(managed.lastError ? { lastError: managed.lastError } : {}),
    logPath: managed.logPath,
  }
}

async function waitForResponse(path: string, timeoutMs: number): Promise<SupervisorResponse> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = JSON.parse(await readFile(path, "utf8")) as SupervisorResponse
      await rm(path, { force: true })
      return response
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error("[SshTarget] Timed out waiting for the supervisor to answer.")
}

const VALID_COMMANDS: readonly SupervisorCommand[] = [
  "restart",
  "start",
  "stop",
  "stage",
  "activate",
  "discard",
]

function parseRequest(value: unknown): SupervisorRequest {
  const request = value as Partial<SupervisorRequest> | null
  if (
    !request ||
    typeof request.id !== "string" ||
    !VALID_COMMANDS.includes(request.type as SupervisorCommand)
  ) {
    throw new Error("[SshTarget] Invalid supervisor request.")
  }
  return {
    id: request.id,
    type: request.type as SupervisorCommand,
    ...(typeof request.service === "string" ? { service: request.service } : {}),
    ...(typeof request.manifestPath === "string" ? { manifestPath: request.manifestPath } : {}),
  }
}

function instanceKey(processName: string, instance: number): string {
  return `${processName}:${instance}`
}

export function parseMemoryLimit(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i)
  if (!match) return null
  const unit = (match[2] ?? "b").toLowerCase()[0]
  const multiplier = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1
  return Math.round(Number(match[1]) * multiplier)
}

async function readLinuxRssBytes(pid: number): Promise<number | null> {
  try {
    const rssPages = Number((await readFile(`/proc/${pid}/statm`, "utf8")).trim().split(/\s+/)[1])
    return Number.isFinite(rssPages) ? rssPages * 4096 : null
  } catch {
    return null
  }
}

async function readLinuxCpuSample(pid: number): Promise<CpuSample | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    const end = stat.lastIndexOf(") ")
    if (end === -1) return null
    const fields = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/)
    const ticks = Number(fields[11]) + Number(fields[12])
    if (!Number.isFinite(ticks)) return null
    return { processSeconds: ticks / LINUX_CLOCK_TICKS_PER_SECOND, sampledAtMs: Date.now() }
  } catch {
    return null
  }
}

function cpuPercent(previous: CpuSample | undefined, current: CpuSample): number | undefined {
  if (!previous) return undefined
  const processSeconds = current.processSeconds - previous.processSeconds
  const wallSeconds = (current.sampledAtMs - previous.sampledAtMs) / 1000
  if (processSeconds < 0 || wallSeconds <= 0) return undefined
  return Math.max(0, Math.round((processSeconds / wallSeconds) * 1000) / 10)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${bytes}B`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { DeploySlot } from "../layout"

export type ProcessServiceKind = "http" | "singleton" | "workers" | "script"

/** What the supervisor runs for one deployment, written by `sixb deploy` on each deploy. */
export interface ProcessManifest {
  readonly version: 1
  readonly name: string
  /** Which port pair (`blue` or `green`) this release's HTTP services bind. */
  readonly slot?: DeploySlot
  /** The project directory every process starts in. */
  readonly cwd: string
  /** Supervisor state, control requests, and logs live here. */
  readonly runDir: string
  readonly logDir: string
  /** Written by the deploy; read back by `status`. */
  readonly releasePath: string
  /**
   * The environment every service starts from, before its own additions: what `ctl run` gives a
   * script. Absent from deployments made before scripts could run.
   */
  readonly env?: Readonly<Record<string, string>>
  readonly services: readonly ProcessServiceManifest[]
}

export interface ProcessServiceManifest {
  readonly name: string
  readonly kind?: ProcessServiceKind
  readonly processName: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly instances: number
  readonly killTimeoutMs: number
  readonly restartDelayMs: number
  readonly maxMemory?: string
}

const SERVICE_KINDS: readonly ProcessServiceKind[] = ["http", "singleton", "workers", "script"]

export function isOverlapSafeService(service: ProcessServiceManifest): boolean {
  if (service.kind) return service.kind === "http" || service.kind === "workers"
  return service.name === "api" || service.name === "app" || service.name === "workers"
}

export async function loadProcessManifest(path: string): Promise<ProcessManifest> {
  return parseProcessManifest(JSON.parse(await readFile(path, "utf8")), path)
}

export function statePath(manifest: ProcessManifest): string {
  return resolve(manifest.runDir, "state.json")
}

export function controlDir(manifest: ProcessManifest): string {
  return resolve(manifest.runDir, "control")
}

export function responseDir(manifest: ProcessManifest): string {
  return resolve(manifest.runDir, "responses")
}

export function parseProcessManifest(value: unknown, source = "process manifest"): ProcessManifest {
  const manifest = record(value, source)
  if (manifest.version !== 1) throw new Error(`[SshTarget] ${source}.version must be 1`)
  if (!Array.isArray(manifest.services)) {
    throw new Error(`[SshTarget] ${source}.services must be an array`)
  }
  const slot = parseSlot(manifest.slot, `${source}.slot`)

  return {
    version: 1,
    name: string(manifest.name, `${source}.name`),
    ...(slot === undefined ? {} : { slot }),
    cwd: string(manifest.cwd, `${source}.cwd`),
    runDir: string(manifest.runDir, `${source}.runDir`),
    logDir: string(manifest.logDir, `${source}.logDir`),
    releasePath: string(manifest.releasePath, `${source}.releasePath`),
    ...(manifest.env === undefined ? {} : { env: environment(manifest.env, `${source}.env`) }),
    services: manifest.services.map((service, index) =>
      parseService(service, `${source}.services[${index}]`)
    ),
  }
}

function parseService(value: unknown, source: string): ProcessServiceManifest {
  const service = record(value, source)
  if (!Array.isArray(service.args) || service.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`[SshTarget] ${source}.args must be an array of strings`)
  }
  const env = environment(service.env, `${source}.env`)
  const kind = parseKind(service.kind, `${source}.kind`)

  return {
    name: string(service.name, `${source}.name`),
    ...(kind === undefined ? {} : { kind }),
    processName: string(service.processName, `${source}.processName`),
    command: string(service.command, `${source}.command`),
    args: service.args,
    env,
    instances: positiveInteger(service.instances, `${source}.instances`),
    killTimeoutMs: positiveInteger(service.killTimeoutMs, `${source}.killTimeoutMs`),
    restartDelayMs: positiveInteger(service.restartDelayMs, `${source}.restartDelayMs`),
    ...(service.maxMemory === undefined
      ? {}
      : { maxMemory: string(service.maxMemory, `${source}.maxMemory`) }),
  }
}

function parseSlot(value: unknown, source: string): DeploySlot | undefined {
  if (value === undefined) return undefined
  if (value === "blue" || value === "green") return value
  throw new Error(`[SshTarget] ${source} must be 'blue' or 'green'`)
}

function parseKind(value: unknown, source: string): ProcessServiceKind | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string" && (SERVICE_KINDS as readonly string[]).includes(value)) {
    return value as ProcessServiceKind
  }
  throw new Error(`[SshTarget] ${source} must be one of: ${SERVICE_KINDS.join(", ")}`)
}

function environment(value: unknown, source: string): Record<string, string> {
  const env = record(value, source)
  for (const [key, variable] of Object.entries(env)) {
    if (typeof variable !== "string")
      throw new Error(`[SshTarget] ${source}.${key} must be a string`)
  }
  return env as Record<string, string>
}

function record(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[SshTarget] ${source} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[SshTarget] ${source} must be a non-empty string`)
  }
  return value
}

function positiveInteger(value: unknown, source: number | string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`[SshTarget] ${source} must be a positive integer`)
  }
  return value as number
}

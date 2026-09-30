import { readFile, rename, writeFile } from "node:fs/promises"

export type ProcessInstanceStatus = "starting" | "running" | "stopping" | "stopped" | "exited"

/** What the supervisor last knew about every process, rewritten on each change. */
export interface ProcessState {
  readonly version: 1
  readonly name: string
  readonly supervisorPid: number
  readonly updatedAt: string
  readonly instances: readonly ProcessInstanceState[]
}

export interface ProcessInstanceState {
  readonly service: string
  readonly processName: string
  readonly instance: number
  readonly pid?: number
  readonly status: ProcessInstanceStatus
  readonly startedAt?: string
  readonly stoppedAt?: string
  readonly restarts: number
  readonly cpuPercent?: number
  readonly memoryBytes?: number
  readonly lastExitCode?: number | null
  readonly lastSignal?: string | null
  readonly lastError?: string
  readonly logPath: string
}

const STATUSES: readonly ProcessInstanceStatus[] = [
  "starting",
  "running",
  "stopping",
  "stopped",
  "exited",
]

export async function readProcessState(path: string): Promise<ProcessState | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  return parseProcessState(JSON.parse(raw), path)
}

/** Writes through a rename, so a reader never sees half a file. */
export async function writeProcessState(path: string, state: ProcessState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

export function parseProcessState(value: unknown, source = "process state"): ProcessState {
  const state = value as Partial<ProcessState> | null
  if (!state || state.version !== 1 || !Array.isArray(state.instances)) {
    throw new Error(`[SshTarget] ${source} is not a supervisor state file`)
  }
  for (const instance of state.instances) {
    if (!STATUSES.includes(instance.status)) {
      throw new Error(`[SshTarget] ${source} has an instance with status '${instance.status}'`)
    }
  }
  return state as ProcessState
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

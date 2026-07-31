export type LocalIsolation = "auto" | "seatbelt" | "bwrap" | "none"

export type ResolvedIsolation = "seatbelt" | "bwrap" | "none"

export interface IsolationProbe {
  readonly backend: ResolvedIsolation
  readonly available: boolean
  readonly message: string
}

/**
 * Inputs to detectIsolation. Tests can pass synthetic values for platform and
 * binary availability without monkey-patching globals.
 */
export interface DetectInput {
  readonly platform: NodeJS.Platform
  hasBinary(name: string): boolean
  canRunSeatbelt?(): boolean
}

export function detectIsolation(input: DetectInput = defaultDetectInput()): IsolationProbe {
  if (input.platform === "darwin") {
    if (input.hasBinary("sandbox-exec")) {
      if (input.canRunSeatbelt?.() === false) {
        return {
          backend: "none",
          available: true,
          message: "darwin: sandbox-exec cannot apply a sandbox; falling back to no isolation",
        }
      }
      return {
        backend: "seatbelt",
        available: true,
        message: "darwin: sandbox-exec available",
      }
    }
    return {
      backend: "none",
      available: true,
      message: "darwin: sandbox-exec not on PATH; falling back to no isolation",
    }
  }

  if (input.platform === "linux") {
    if (input.hasBinary("bwrap")) {
      return { backend: "bwrap", available: true, message: "linux: bwrap available" }
    }
    return {
      backend: "none",
      available: true,
      message: "linux: bwrap not on PATH; falling back to no isolation",
    }
  }

  return {
    backend: "none",
    available: true,
    message: `unsupported platform ${input.platform}; using no isolation`,
  }
}

function defaultDetectInput(): DetectInput {
  return {
    platform: process.platform as NodeJS.Platform,
    hasBinary: (name) => Boolean(Bun.which(name)),
    canRunSeatbelt,
  }
}

function canRunSeatbelt(): boolean {
  try {
    const result = Bun.spawnSync([
      "sandbox-exec",
      "-p",
      "(version 1)\n(allow default)\n",
      "/usr/bin/true",
    ])
    return result.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Announces an `auto` resolution that ended up with no isolation at all.
 *
 * `auto` accepts whatever the host offers, and on a Linux box without `bwrap` or a macOS
 * one without `sandbox-exec` that is nothing: every command an agent runs executes
 * directly on the host. The probe already worded the reason; it was simply never said out
 * loud, so `auto` isolating and `auto` not isolating looked identical from the outside.
 *
 * Per-sandbox rather than once, for the same reason the network downgrade warns
 * per-sandbox: a module-level flag silences every later sandbox and leaks across tests.
 */
export function warnIfUnisolated(probe: IsolationProbe): void {
  if (probe.backend !== "none") {
    return
  }
  console.warn(
    `[Sandbox] no isolation backend is available, so commands run unisolated on the host ` +
      `(${probe.message}). Set isolation: "none" to make that explicit, or install the backend ` +
      `for this platform.`
  )
}

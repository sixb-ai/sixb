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

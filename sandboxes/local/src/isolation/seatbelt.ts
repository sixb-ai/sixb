import type { SandboxNetworkPolicy } from "@sixb/core"

export interface SeatbeltProfileInput {
  readonly workingDirectory: string
  readonly readOnlyPaths: readonly string[]
  readonly readWritePaths: readonly string[]
  readonly network: SandboxNetworkPolicy
}

export interface SeatbeltArgvInput {
  readonly profile: string
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Build a Seatbelt profile string for sandbox-exec.
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const lines: string[] = []
  lines.push("(version 1)")
  lines.push("(allow default)")

  if (!allowsOutboundNetwork(input.network)) {
    lines.push("(deny network-outbound)")
  }

  lines.push("(deny file-write*)")
  lines.push(`(allow file-write* (subpath ${sbplString(input.workingDirectory)}))`)
  lines.push('(allow file-write* (subpath "/private/tmp"))')
  lines.push('(allow file-write* (subpath "/private/var/folders"))')
  for (const path of input.readWritePaths) {
    lines.push(`(allow file-write* (subpath ${sbplString(path)}))`)
  }

  return `${lines.join("\n")}\n`
}

/**
 * Build the argv invoked by Bun.spawn to run a command under sandbox-exec.
 */
export function buildSeatbeltArgv(input: SeatbeltArgvInput): readonly string[] {
  return ["sandbox-exec", "-p", input.profile, input.command, ...input.args]
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function allowsOutboundNetwork(policy: SandboxNetworkPolicy): boolean {
  // Local Seatbelt support is binary today: deny outbound for "none", host network otherwise.
  return policy.mode !== "none"
}

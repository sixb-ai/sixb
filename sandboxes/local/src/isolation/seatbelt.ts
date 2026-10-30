import { dirname } from "node:path"
import type { SandboxNetworkPolicy } from "@sixb/core"
import { allowsOutboundNetwork } from "./network"

export interface SeatbeltProfileInput {
  readonly workingDirectory: string
  readonly readOnlyPaths: readonly string[]
  readonly readWritePaths: readonly string[]
  /** Real paths commands may neither read nor write, whatever else allows them. */
  readonly denyReadPaths: readonly string[]
  readonly network: SandboxNetworkPolicy
  /** Where the sandbox's credential forwarder listens, reachable whatever the network. */
  readonly forwarderDirectory?: string
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
    if (input.forwarderDirectory !== undefined) {
      lines.push(`(allow network-outbound (subpath ${sbplString(input.forwarderDirectory)}))`)
    }
  }

  lines.push("(deny file-write*)")
  // The devices any shell writes to: `2>/dev/null`, the terminal, a descriptor named by path.
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))'
  )
  lines.push(`(allow file-write* (subpath ${sbplString(input.workingDirectory)}))`)
  lines.push('(allow file-write* (subpath "/private/tmp"))')
  lines.push('(allow file-write* (subpath "/private/var/folders"))')
  for (const path of input.readWritePaths) {
    lines.push(`(allow file-write* (subpath ${sbplString(path)}))`)
  }
  // Last, so they win over every allow above: the profile's last matching rule decides. Rules
  // match paths, so a denied path's directories can't be renamed either: moved, its files would
  // sit at a path no rule names. What they hold can still change.
  for (const path of input.denyReadPaths) {
    const directories = ancestors(path).map((directory) => `(literal ${sbplString(directory)})`)
    if (directories.length > 0) lines.push(`(deny file-write* ${directories.join(" ")})`)
    lines.push(`(deny file-read* file-write* (subpath ${sbplString(path)}))`)
  }

  return `${lines.join("\n")}\n`
}

/**
 * Build the argv invoked by Bun.spawn to run a command under sandbox-exec.
 */
export function buildSeatbeltArgv(input: SeatbeltArgvInput): readonly string[] {
  return ["sandbox-exec", "-p", input.profile, input.command, ...input.args]
}

/** Every directory above `path`, the root excluded. */
function ancestors(path: string): string[] {
  const directories: string[] = []
  for (let directory = dirname(path); directory !== "/"; directory = dirname(directory)) {
    directories.push(directory)
  }
  return directories
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

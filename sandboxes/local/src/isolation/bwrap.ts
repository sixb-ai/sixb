import type { SandboxNetworkPolicy } from "@sixb/core"
import type { ForwarderPaths } from "../credential-forwarder"
import { allowsOutboundNetwork } from "./network"

export interface BwrapArgvInput {
  readonly command: string
  readonly args: readonly string[]
  readonly workingDirectory: string
  readonly readOnlyPaths: readonly string[]
  readonly readWritePaths: readonly string[]
  /** Existing real paths commands may not read, with what each is. */
  readonly denyReadPaths: readonly DeniedPath[]
  readonly network: SandboxNetworkPolicy
  /** The sandbox's credential forwarder: its own directory alone shows under the root. */
  readonly forwarder?: ForwarderPaths
}

export interface DeniedPath {
  readonly path: string
  readonly kind: "directory" | "file"
}

/**
 * Build the argv invoked by Bun.spawn to run a command under bwrap.
 * Arguments are passed verbatim after --, so shell metacharacters are not
 * interpreted unless the caller explicitly runs a shell.
 */
export function buildBwrapArgv(input: BwrapArgvInput): readonly string[] {
  const argv: string[] = ["bwrap"]

  argv.push("--ro-bind", "/", "/")
  for (const path of input.readOnlyPaths) {
    argv.push("--ro-bind", path, path)
  }
  argv.push("--bind", input.workingDirectory, input.workingDirectory)
  for (const path of input.readWritePaths) {
    argv.push("--bind", path, path)
  }
  // Mounted last, over every bind above: a directory shows empty and a file reads as nothing, and
  // no write reaches the real path.
  for (const { path, kind } of input.denyReadPaths) {
    if (kind === "directory") argv.push("--tmpfs", path)
    else argv.push("--ro-bind", "/dev/null", path)
  }
  // Every sandbox's forwarder listens under one root, and a read-only mount doesn't stop a
  // connect: the root shows empty but for this sandbox's directory, at the same path.
  if (input.forwarder !== undefined) {
    const { root, directory } = input.forwarder
    argv.push("--tmpfs", root, "--ro-bind", directory, directory)
  }
  argv.push("--proc", "/proc", "--dev", "/dev")

  argv.push("--unshare-pid")
  if (!allowsOutboundNetwork(input.network)) {
    argv.push("--unshare-net")
  }

  argv.push("--die-with-parent")
  argv.push("--", input.command, ...input.args)

  return argv
}

export interface BwrapArgvInput {
  readonly command: string
  readonly args: readonly string[]
  readonly workingDirectory: string
  readonly readOnlyPaths: readonly string[]
  readonly readWritePaths: readonly string[]
  readonly allowNetwork: boolean
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
  argv.push("--proc", "/proc", "--dev", "/dev")

  argv.push("--unshare-pid")
  if (!input.allowNetwork) {
    argv.push("--unshare-net")
  }

  argv.push("--die-with-parent")
  argv.push("--", input.command, ...input.args)

  return argv
}

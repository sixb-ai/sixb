import { homedir } from "node:os"

export interface ResolvedSshConfig {
  /** The real hostname or address behind the target's host, which may be an SSH config alias. */
  readonly hostname: string
  readonly port: number
  /** The host SSH jumps through first, when the config sets one. */
  readonly proxyJump?: string
  /** Identity files SSH would offer, in order, with `~` expanded. */
  readonly identityFiles: readonly string[]
}

/** What OpenSSH makes of a destination once its config applies, from `ssh -G`. */
export async function resolveSshConfig(destination: string): Promise<ResolvedSshConfig> {
  const child = Bun.spawn(["ssh", "-G", destination], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (exitCode !== 0) throw new Error(`[SshTarget] ssh -G ${destination} failed.`)

  let hostname = destination.split("@").at(-1) ?? destination
  let port = 22
  let proxyJump: string | undefined
  const identityFiles: string[] = []
  for (const line of output.split("\n")) {
    const [key, ...rest] = line.split(" ")
    const value = rest.join(" ")
    if (key === "hostname" && value) hostname = value
    if (key === "port" && Number(value) > 0) port = Number(value)
    // `ssh -G` prints `none` for a host reached directly.
    if ((key === "proxyjump" || key === "proxycommand") && value && value !== "none") {
      proxyJump = value
    }
    if (key === "identityfile" && value) identityFiles.push(value.replace(/^~(?=\/)/, homedir()))
  }
  return { hostname, port, identityFiles, ...(proxyJump ? { proxyJump } : {}) }
}

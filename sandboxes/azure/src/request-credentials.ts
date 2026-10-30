import {
  GUEST_CREDENTIAL_PATHS,
  GUEST_FORWARDER_NOT_RUNNING,
  type GuestCommand,
  guestCredentialsCommands,
  SandboxError,
  type SandboxRequestCredential,
} from "@sixb/core/sandboxes"
import type { AzureSandboxClient } from "./azure-client"
import { shellQuote } from "./command-execution"

const CONTROL_PATH = "PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8"

/**
 * Install request credentials in the guest and start its forwarder, all as root. Commands run as
 * uid 65534 under the supervisor, so they cannot read them. The credentials and the forwarder go
 * in through the file API, in root-only files: a shell command's text is any process's to read.
 */
export async function installAzureCredentials(
  client: AzureSandboxClient,
  id: string,
  credentials: readonly SandboxRequestCredential[],
  signal: AbortSignal
): Promise<void> {
  const commands = guestCredentialsCommands(credentials)
  const run = (command: string) => client.execute(id, command, "/", { signal })
  // Never the output: a failed step must not echo what it was given.
  const failed = () =>
    new SandboxError(`[Sandbox] Azure could not install request credentials in ${id}.`)

  const state = GUEST_CREDENTIAL_PATHS.state
  if ((await run(`umask 077 && mkdir -p -- ${shellQuote(state)}`)).exitCode !== 0) throw failed()
  for (const file of commands.files) {
    await client.writeFile(id, file.path, file.contents, file.mode, { signal })
  }

  const installed = await run(commandLine(commands.install, commands.fileEnv))
  if (installed.exitCode === 3) {
    throw new SandboxError(`[Sandbox] Azure request credentials need Node in the image of ${id}.`)
  }
  if (installed.exitCode === GUEST_FORWARDER_NOT_RUNNING) {
    // A session of its own, as the supervisor's commands: it outlives this exec.
    const started = await run(`setsid -f ${commandLine(commands.start)} </dev/null >/dev/null 2>&1`)
    if (started.exitCode !== 0) throw failed()
  } else if (installed.exitCode !== 0) {
    throw failed()
  }
  if ((await run(commandLine(commands.ready))).exitCode !== 0) throw failed()
}

/** A guest command as one shell line, with a fixed environment and none of `omitted`. */
function commandLine(command: GuestCommand, omitted: readonly string[] = []): string {
  const env = Object.entries(command.env)
    .filter(([key]) => !omitted.includes(key))
    .map(([key, value]) => shellQuote(`${key}=${value}`))
  return ["/usr/bin/env", "-i", CONTROL_PATH, ...env, ...command.argv.map(shellQuote)].join(" ")
}

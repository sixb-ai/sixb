import { posix } from "node:path"
import { captureEnvironment, type SandboxEnvironment } from "./configuration"
import { SandboxError } from "./errors"
import type { Sandbox } from "./sandbox"

/** Select the same project directory on creation and resume without touching saved files. */
export function sandboxProjectDirectory(session: Sandbox, hasSource: boolean): Sandbox {
  if (!hasSource) return session
  const workingDirectory = posix.join(session.workingDirectory, "repository")
  return {
    id: session.id,
    provider: session.provider,
    get status() {
      return session.status
    },
    workingDirectory,
    runCommand: (command, args, options) =>
      session.runCommand(command, args, { ...options, cwd: options?.cwd ?? workingDirectory }),
    writeFiles: (files) =>
      session.writeFiles(
        files.map((file) => ({
          ...file,
          path: posix.isAbsolute(file.path) ? file.path : posix.join(workingDirectory, file.path),
        }))
      ),
    stop: () => session.stop(),
    destroy: () => session.destroy(),
  }
}

/** Provider-side initialization, after the session network/credentials have been applied.
 * Call only on fresh creation. The caller owns cleanup if any command fails.
 */
export async function initializeSandboxEnvironment(
  session: Sandbox,
  environment: Pick<SandboxEnvironment, "source" | "setup">,
  signal?: AbortSignal
): Promise<Sandbox> {
  environment = captureEnvironment(environment)
  const run = async (sandbox: Sandbox, command: string, args: readonly string[]) => {
    signal?.throwIfAborted()
    const result = await sandbox.runCommand(command, args, { timeout: 120_000, signal })
    if (result.exitCode !== 0 || result.timedOut) {
      throw new SandboxError("[Sixb] Sandbox environment initialization failed.")
    }
  }
  signal?.throwIfAborted()
  const sandbox = sandboxProjectDirectory(session, environment.source !== undefined)
  if (environment.source) {
    await run(session, "git", ["clone", "--", environment.source.url, "repository"])
    if (environment.source.revision) {
      await run(sandbox, "git", ["checkout", environment.source.revision, "--"])
    }
  }
  for (const command of environment.setup ?? []) await run(sandbox, "bash", ["-lc", command])
  return sandbox
}

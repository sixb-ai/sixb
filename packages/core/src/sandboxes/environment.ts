import { posix } from "node:path"
import type { ParamsConfig } from "../shared/params/types"
import type { SandboxConfig } from "./configuration"
import { captureEnvironment, type SandboxEnvironment } from "./configuration"
import { SandboxError } from "./errors"
import type { CreateSandboxOptions, Sandbox } from "./sandbox"

/** Select and validate before provisioning. Only the execution runtime may resolve a recipe. */
export function sandboxCreationEnvironment<TParams extends ParamsConfig>(
  configuration: SandboxConfig<TParams>,
  options: CreateSandboxOptions
): Pick<SandboxEnvironment, "source" | "setup"> {
  if (options.environment === undefined && configuration.resolve !== undefined) {
    throw new SandboxError(
      "[Sixb] Dynamic sandbox configuration requires an execution-resolved environment."
    )
  }
  const environment = captureEnvironment(
    options.environment !== undefined
      ? options.environment
      : {
          ...(configuration.source === undefined ? {} : { source: configuration.source }),
          ...(configuration.setup === undefined ? {} : { setup: configuration.setup }),
        }
  )
  if (environment.env !== undefined || environment.network !== undefined) {
    throw new SandboxError(
      "[Sixb] Pass env and network as sandbox session options, not environment."
    )
  }
  if (environment.source) {
    if (
      (configuration.auth !== undefined || environment.source.access === "write") &&
      !options.requestCredentials?.length
    ) {
      throw new SandboxError(
        "[Sixb] Sandbox source authentication requires execution-prepared request credentials."
      )
    }
    const network = options.network ?? configuration.network ?? { mode: "none" }
    const origin = new URL(environment.source.url).origin
    if (
      network.mode === "none" ||
      (network.mode === "restricted" && !network.allow.some((target) => target.origin === origin))
    ) {
      throw new SandboxError("[Sixb] Sandbox network policy denies the source origin.")
    }
  }
  options.signal?.throwIfAborted()
  return environment
}

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
    ...(session.setRequestCredentials
      ? { setRequestCredentials: session.setRequestCredentials.bind(session) }
      : {}),
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

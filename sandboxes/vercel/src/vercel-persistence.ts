import {
  type Sandbox,
  SandboxError,
  type SandboxSessionOptions,
  SandboxStateUnavailableError,
} from "@sixb/core/sandboxes"
import { APIError, type Session, Sandbox as VercelSdkSandbox } from "@vercel/sandbox"
import { withRequestCredentials } from "./network"
import { VercelSandbox, type VercelSandboxClient } from "./vercel-sandbox"

type PersistentSession = Pick<
  Session,
  "sessionId" | "status" | "cwd" | "runCommand" | "writeFiles" | "stop" | "update"
>

export interface VercelPersistentClient {
  readonly name: string
  readonly persistent: boolean
  currentSession(): PersistentSession
  delete(): Promise<void>
}

/** SDK-shaped seam used by deterministic provider tests; not exported from the package root. */
export interface VercelPersistenceOperations {
  create(params: Parameters<typeof VercelSdkSandbox.create>[0]): Promise<VercelPersistentClient>
  get(params: Parameters<typeof VercelSdkSandbox.get>[0]): Promise<VercelPersistentClient>
}

export const vercelPersistenceOperations: VercelPersistenceOperations = VercelSdkSandbox

export function persistentSandboxError(
  error: unknown,
  operation: "create" | "resume" | "configure"
): SandboxError {
  if (error instanceof SandboxError) return error
  if (error instanceof APIError) {
    const data: unknown = error.json
    const code =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof data.error === "object" &&
      data.error !== null &&
      "code" in data.error
        ? data.error.code
        : undefined
    if (
      operation === "resume" &&
      ((error.response.status === 404 && code === "not_found") ||
        (error.response.status === 410 && code === "snapshot_not_found"))
    ) {
      return new SandboxStateUnavailableError(
        "[Sandbox] Vercel saved state is missing or expired; no replacement was created."
      )
    }
    if (operation === "create" && error.response.status === 409) {
      return new SandboxError(
        "[Sandbox] Vercel sandbox name already exists. Resume its stopped state or choose a new name; nothing was overwritten."
      )
    }
    return new SandboxError(
      `[Sandbox] Vercel persistent sandbox ${operation} failed (HTTP ${error.response.status}).`
    )
  }
  // Provider messages may contain request details. Do not expose raw SDK errors to agent output.
  return new SandboxError(`[Sandbox] Vercel persistent sandbox ${operation} failed.`)
}

export function assertPersistentName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.trim() !== name ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new SandboxError(
      "[Sandbox] A non-empty sandbox name without surrounding whitespace or control characters is required."
    )
  }
}

export function assertStoppedPersistent(client: VercelPersistentClient): void {
  if (!client.persistent) {
    throw new SandboxError("[Sandbox] Cannot resume a non-persistent Vercel sandbox.")
  }
  if (client.currentSession().status !== "stopped") {
    throw new SandboxError(
      "[Sandbox] Vercel sandbox must be stopped before resume. Serialize its lifecycle and resolve any previous execution first."
    )
  }
}

/** Bind every operation to this VM, never the SDK's automatically-resuming named handle. */
export async function bindPersistentSandbox(
  client: VercelPersistentClient,
  options: SandboxSessionOptions
): Promise<Sandbox> {
  if (!client.persistent) {
    throw new SandboxError("[Sandbox] Vercel did not enable requested persistence.")
  }
  const session = client.currentSession()
  if (session.status !== "running") {
    throw new SandboxError("[Sandbox] Vercel persistent session is not running.")
  }
  await session.update({
    networkPolicy: withRequestCredentials(options.network, options.requestCredentials ?? []),
  })
  const pinned: VercelSandboxClient = {
    setRequestCredentials: async (credentials) => {
      await session.update({
        networkPolicy: withRequestCredentials(options.network, credentials),
      })
    },
    name: client.name,
    cwd: session.cwd,
    get status() {
      return session.status
    },
    runCommand: (params) => session.runCommand({ ...params, args: [...(params.args ?? [])] }),
    writeFiles: (files) =>
      session.writeFiles(
        files.map((file) => ({
          path: file.path,
          content: Buffer.from(file.content),
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }))
      ),
    stop: async () => {
      // Close run-specific network access before producing a reusable filesystem snapshot.
      let networkResetFailed = false
      try {
        await session.update({ networkPolicy: "deny-all" })
      } catch {
        networkResetFailed = true
      }
      // A firewall failure must not leave the VM running. Still stop, but never report success.
      const result = await session.stop()
      if (networkResetFailed) {
        throw new SandboxError("[Sandbox] Vercel network cleanup failed before snapshotting.")
      }
      if (
        result.session.status !== "stopped" ||
        result.snapshot?.status !== "created" ||
        result.snapshot.sourceSessionId !== session.sessionId
      ) {
        throw new SandboxError(
          "[Sandbox] Vercel did not confirm a saved snapshot for this session."
        )
      }
    },
    delete: () => client.delete(),
  }
  return new VercelSandbox({ client: pinned, ...options })
}

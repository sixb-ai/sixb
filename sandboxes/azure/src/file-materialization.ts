import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import { SandboxError, type SandboxFileRecord, SandboxNotRunningError } from "@sixb/core/sandboxes"
import type { AzureSandboxClient } from "./azure-client"
import { supervisorCommand } from "./command-execution"

export interface PreparedFile {
  readonly path: string
  readonly contents: Uint8Array
  readonly mode?: number
}

/** Reject the entire invalid batch before uploading; snapshot caller-owned byte views. */
export function prepareFiles(
  directory: string,
  files: readonly SandboxFileRecord[]
): readonly PreparedFile[] {
  if (!Array.isArray(files)) throw new SandboxError("[Sandbox] Azure files must be an array.")
  return files.map((file) => {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      file.path.includes("\0") ||
      file.path.endsWith("/")
    ) {
      throw new SandboxError("[Sandbox] Azure file paths must be non-empty file names without NUL.")
    }
    const target = posix.resolve(directory, file.path)
    const relative = posix.relative(directory, target)
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      posix.isAbsolute(relative)
    ) {
      throw new SandboxError("[Sandbox] Azure file path escapes the sandbox working directory.")
    }
    if (typeof file.contents !== "string" && !(file.contents instanceof Uint8Array)) {
      throw new SandboxError("[Sandbox] Azure file contents must be a string or Uint8Array.")
    }
    if (
      file.mode !== undefined &&
      (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777)
    ) {
      throw new SandboxError("[Sandbox] Azure file mode must be an integer between 0 and 0o7777.")
    }
    return {
      path: relative,
      contents:
        typeof file.contents === "string"
          ? new TextEncoder().encode(file.contents)
          : new Uint8Array(file.contents),
      mode: file.mode,
    }
  })
}

/** Rejection is safe to reuse only when the guest has cleaned staging and thawed workloads. */
export class AzureFilePolicyError extends SandboxError {}

export async function materializeFiles(
  client: AzureSandboxClient,
  sandboxId: string,
  root: string,
  files: readonly PreparedFile[],
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted)
    throw new SandboxNotRunningError("[Sandbox] Azure sandbox closed before file materialization.")
  const id = randomUUID()
  const staging = `${root}/files-${id}`
  for (let index = 0; index < files.length; index++) {
    // Native file writes are restricted to a provider-generated protected path.
    // They never resolve workload-controlled paths or carry the final file mode.
    await client.writeFile(sandboxId, `${staging}/${index}`, files[index]!.contents, 0o600, {
      signal,
    })
    signal.throwIfAborted()
  }
  await client.writeFile(
    sandboxId,
    `${staging}/manifest.json`,
    JSON.stringify(files.map(({ path, mode }) => ({ path, mode }))),
    0o600,
    { signal }
  )
  signal.throwIfAborted()
  // Once commit is issued, let its bounded request settle even if stop begins.
  // HTTP cancellation cannot prove the guest has finished writing and thawing.
  const result = await client.execute(sandboxId, supervisorCommand(root, "files", id), "/")
  if (result.exitCode !== 0)
    throw new SandboxError("[Sandbox] Azure file publication or workload thaw failed.")
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new SandboxError("[Sandbox] Invalid Azure file publication response.")
  }
  if (value && typeof value === "object" && "state" in value) {
    if (value.state === "files-written") return
    if (
      value.state === "files-rejected" &&
      "reason" in value &&
      (value.reason === "unsafe-path" || value.reason === "workspace-changed")
    ) {
      throw new AzureFilePolicyError(
        value.reason === "workspace-changed"
          ? "[Sandbox] Azure workspace identity changed; file materialization was rejected."
          : "[Sandbox] Azure file path contains a symlink or non-regular filesystem entry."
      )
    }
  }
  throw new SandboxError("[Sandbox] Azure file publication was not confirmed.")
}

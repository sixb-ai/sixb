import type { BlobStorage, Sandbox, SandboxNetworkPolicy } from "@sixb/core"
import { FRAME_ASSETS, FRAME_CDN_ALLOWLIST } from "@sixb/core/internal/artifacts/frames"
import readScript from "./read.cjs" with { type: "text" }

// What every render does in its blank sandbox: reaches only the CDNs a frame may load from, runs
// its script with the image's browser, and reads back what the script wrote.

/** What a render may reach: the libraries, stylesheets and fonts a frame may load. */
export const RENDER_NETWORK: SandboxNetworkPolicy = {
  mode: "restricted",
  allow: FRAME_CDN_ALLOWLIST.map((origin) => ({ name: new URL(origin).hostname, origin })),
}

/** A frame's own file, which an entry loads from `__sixb/`. */
export function kitFile(path: string): string {
  const file = FRAME_ASSETS[path]
  if (!file) throw new Error(`[SixbRenderWorker] The frame has no '${path}'.`)
  return file.body
}

/** A blob's bytes. */
export async function readBlob(
  blobStorage: Pick<BlobStorage, "open">,
  blobId: string
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await blobStorage.open(blobId)).arrayBuffer())
}

/**
 * Runs `script` in the sandbox, returning the last line of its stdout as JSON: its report,
 * `{ skipped: "no_node" }` without Node, or null when it printed none.
 */
export async function runScript(
  sandbox: Sandbox,
  script: string,
  args: readonly (string | number)[],
  options: { readonly timeoutMs: number; readonly signal: AbortSignal }
): Promise<{ readonly report: Record<string, unknown> | null; readonly stderr: string }> {
  const result = await runNode(sandbox, [script, ...args], options)
  return { report: lastJsonLine(result.stdout), stderr: result.stderr.trim() }
}

/**
 * Runs `node <args>` once a login shell has loaded the image's profile, which puts Node on the
 * path and points Playwright at its browsers, as the agent's sandbox commands do: the login shell
 * is replaced, so its logout script never runs.
 */
async function runNode(
  sandbox: Sandbox,
  args: readonly (string | number)[],
  options: { readonly timeoutMs: number; readonly signal: AbortSignal }
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const quoted = args.map((arg) => `'${String(arg).replaceAll("'", "'\\''")}'`)
  const result = await sandbox.runCommand(
    "bash",
    [
      "-lc",
      'exec "$BASH" -c "$1" bash',
      "bash",
      `command -v node >/dev/null 2>&1 || { echo '{"skipped":"no_node"}'; exit 0; }; exec node ${quoted.join(" ")}`,
    ],
    { timeout: options.timeoutMs, signal: options.signal }
  )
  options.signal.throwIfAborted()
  return result
}

/**
 * Files a script wrote in the sandbox, at most `maxBytes` each, read a batch at a time, which the
 * stdout of one command carries: each its bytes, or why it could not be read, in order.
 */
export async function readSandboxFiles(
  sandbox: Sandbox,
  directory: string,
  files: readonly { readonly path: string; readonly bytes?: number }[],
  options: { readonly maxBytes: number; readonly signal: AbortSignal }
): Promise<(Uint8Array | { readonly error: string })[]> {
  const script = `${directory}/read.cjs`
  await sandbox.writeFiles([{ path: script, contents: readScript }])

  const read: (Uint8Array | { readonly error: string })[] = []
  for (const batch of batches(files, options.maxBytes)) {
    const result = await runNode(
      sandbox,
      [script, options.maxBytes, ...batch.map((file) => file.path)],
      { timeoutMs: READ_TIMEOUT_MS, signal: options.signal }
    )
    const lines = result.stdout.split("\n")
    for (const [index] of batch.entries()) {
      const line = parse(lines[index] ?? "")
      read.push(
        typeof line?.data === "string"
          ? Buffer.from(line.data, "base64")
          : { error: typeof line?.error === "string" ? line.error : "unreadable" }
      )
    }
  }
  return read
}

const READ_TIMEOUT_MS = 60_000
/** The most one command reads out of the sandbox, base64 on its stdout. */
const READ_BATCH_BYTES = 24 * 1024 * 1024

/** The files in batches of at most {@link READ_BATCH_BYTES}, as their script sized them. */
function batches<T extends { readonly bytes?: number }>(files: readonly T[], maxBytes: number) {
  const all: T[][] = []
  let batch: T[] = []
  let bytes = 0
  for (const file of files) {
    const size = Math.min(file.bytes ?? maxBytes, maxBytes)
    if (batch.length > 0 && bytes + size > READ_BATCH_BYTES) {
      all.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(file)
    bytes += size
  }
  if (batch.length > 0) all.push(batch)
  return all
}

function lastJsonLine(stdout: string): Record<string, unknown> | null {
  return parse(stdout.trim().split("\n").at(-1) ?? "")
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

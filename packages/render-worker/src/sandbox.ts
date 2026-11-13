import type { BlobStorage, Sandbox, SandboxNetworkPolicy } from "@sixb/core"
import { FRAME_ASSETS, FRAME_CDN_ALLOWLIST } from "@sixb/core/internal/artifacts/frames"
import type { RenderHost } from "./host"
import readScript from "./read.cjs" with { type: "text" }
import sharedScript from "./shared.cjs" with { type: "text" }

// What every render does in its blank sandbox: reaches only the CDNs a frame may load from, runs
// its script with the image's browser, reads back what the script wrote, and is destroyed.

/** What a render may reach: the libraries, stylesheets and fonts a frame may load. */
export const RENDER_NETWORK: SandboxNetworkPolicy = {
  mode: "restricted",
  allow: FRAME_CDN_ALLOWLIST.map((origin) => ({ name: new URL(origin).hostname, origin })),
}

/** A frame's own file, which an entry loads from `__sixb/`. */
export function frameFile(path: string): string {
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

/** A render's script in the sandbox's working directory, with what the scripts share beside it. */
export function scriptFiles(sandbox: Sandbox, name: string, contents: string) {
  return [
    { path: `${sandbox.workingDirectory}/shared.cjs`, contents: sharedScript },
    { path: `${sandbox.workingDirectory}/${name}`, contents },
  ]
}

/** How long a sandbox has to be destroyed before the render goes on without waiting for it. */
const DESTROY_MS = 30_000

/**
 * Runs `render` in a blank sandbox of the project, within `timeoutMs`, and destroys the sandbox,
 * waiting for that at most {@link DESTROY_MS}. `left()` is how much of the time is left, which
 * each step bounds itself by.
 */
export async function inRenderSandbox<T>(
  host: Required<Pick<RenderHost, "sandboxes">>,
  what: string,
  options: { readonly timeoutMs: number; readonly signal: AbortSignal },
  render: (sandbox: Sandbox, left: () => number, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ends = Date.now() + options.timeoutMs
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  const sandbox = await host.sandboxes.create({ environment: {}, network: RENDER_NETWORK, signal })
  try {
    return await render(sandbox, () => Math.max(0, ends - Date.now()), signal)
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<"waited">((resolve) => {
      timer = setTimeout(() => resolve("waited"), DESTROY_MS)
    })
    const destroyed = await Promise.race([sandbox.destroy(), waited]).then(
      (result) => result !== "waited",
      (error: unknown) => {
        console.error(`[SixbRenderWorker] Could not destroy the sandbox that ${what}:`, error)
        return true
      }
    )
    clearTimeout(timer)
    if (!destroyed) {
      console.error(
        `[SixbRenderWorker] The sandbox that ${what} was not destroyed within ${DESTROY_MS / 1000} seconds.`
      )
    }
  }
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
 * The most one command reads out of a sandbox. Some providers keep at most 1 MiB of a command's
 * output, and base64 is a third larger than what it holds.
 */
const READ_BYTES = 512 * 1024
const READ_TIMEOUT_MS = 60_000
/** How many of those commands run at once. */
const READS_AT_ONCE = 4

/**
 * Files a script wrote in the sandbox, each as large as its script said: its bytes, or why it
 * could not be read, in order. One past `maxBytes` is not read. They are read a piece at a time,
 * as many pieces to a command as {@link READ_BYTES} holds, {@link READS_AT_ONCE} commands at once.
 */
export async function readSandboxFiles(
  sandbox: Sandbox,
  files: readonly { readonly path: string; readonly bytes: number }[],
  options: { readonly maxBytes: number; readonly signal: AbortSignal }
): Promise<(Uint8Array | { readonly error: string })[]> {
  const script = `${sandbox.workingDirectory}/read.cjs`
  await sandbox.writeFiles([{ path: script, contents: readScript }])

  const read: (Uint8Array | { readonly error: string })[] = files.map(({ bytes }) =>
    bytes > options.maxBytes ? { error: "too_large" } : new Uint8Array(bytes)
  )
  const pieces = files.flatMap(({ path, bytes }, file) =>
    read[file] instanceof Uint8Array
      ? Array.from({ length: Math.ceil(bytes / READ_BYTES) }, (_, index) => ({
          file,
          path,
          start: index * READ_BYTES,
          length: Math.min(READ_BYTES, bytes - index * READ_BYTES),
        }))
      : []
  )

  // As many pieces to a command as its output holds.
  const batches: (typeof pieces)[] = []
  for (let at = 0; at < pieces.length; ) {
    const batch: typeof pieces = []
    for (let size = 0; at < pieces.length; at += 1) {
      const piece = pieces[at] as (typeof pieces)[number]
      if (batch.length > 0 && size + piece.length > READ_BYTES) break
      batch.push(piece)
      size += piece.length
    }
    batches.push(batch)
  }

  const readBatch = async (batch: typeof pieces) => {
    const result = await runNode(
      sandbox,
      [script, ...batch.flatMap(({ path, start, length }) => [path, start, length])],
      { timeoutMs: READ_TIMEOUT_MS, signal: options.signal }
    )
    const lines = result.stdout.split("\n")
    for (const [index, { file, start, length }] of batch.entries()) {
      const into = read[file]
      if (!(into instanceof Uint8Array)) continue
      const line = parse(lines[index] ?? "")
      const bytes = typeof line?.data === "string" ? Buffer.from(line.data, "base64") : null
      if (bytes?.byteLength === length) into.set(bytes, start)
      else read[file] = { error: "unreadable" }
    }
  }
  const waiting = [...batches]
  const reader = async () => {
    for (let batch = waiting.shift(); batch; batch = waiting.shift()) await readBatch(batch)
  }
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, batches.length) }, reader))
  return read
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

import type { BlobStorage, FileRef, Sandbox, SandboxNetworkPolicy, Storage } from "@sixb/core"
import { FRAME_ASSETS, FRAME_CDN_ALLOWLIST } from "@sixb/core/internal/artifacts/frames"
import {
  createFileDownloadUrl,
  type FileDownloadUrlContext,
  revokeFileDownloadUrl,
} from "@sixb/core/internal/blob-storage"
import { getApiPublicOrigin } from "@sixb/core/internal/runtime"
import type { RenderHost } from "./host"
import readScript from "./read.cjs" with { type: "text" }
import sharedScript from "./shared.cjs" with { type: "text" }

// What every render does in its blank sandbox: reaches only the CDNs a frame may load from, runs
// its script with the image's browser, reads back what the script wrote, and is destroyed. A render
// whose files are large fetches them itself, from the API, and streams what it wrote back to blob
// storage a piece at a time: neither is ever held whole by the worker.

/** What a render may reach: the libraries, stylesheets and fonts a frame may load. */
export const RENDER_NETWORK: SandboxNetworkPolicy = {
  mode: "restricted",
  allow: FRAME_CDN_ALLOWLIST.map((origin) => ({ name: new URL(origin).hostname, origin })),
}

/** {@link RENDER_NETWORK}, with `origins` beside the CDNs. */
export function renderNetwork(origins: readonly string[]): SandboxNetworkPolicy {
  if (origins.length === 0) return RENDER_NETWORK
  return {
    mode: "restricted",
    allow: [
      ...(RENDER_NETWORK.mode === "restricted" ? RENDER_NETWORK.allow : []),
      ...origins.map((origin) => ({ name: new URL(origin).hostname, origin })),
    ],
  }
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
 * each step bounds itself by. `reach` opens more origins than the CDNs, such as the API's, for a
 * render that fetches its files with {@link downloadIntoSandbox}.
 */
export async function inRenderSandbox<T>(
  host: Required<Pick<RenderHost, "sandboxes">>,
  what: string,
  options: {
    readonly timeoutMs: number
    readonly signal: AbortSignal
    readonly reach?: readonly string[]
  },
  render: (sandbox: Sandbox, left: () => number, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ends = Date.now() + options.timeoutMs
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  const network = renderNetwork(options.reach ?? [])
  const sandbox = await host.sandboxes.create({ environment: {}, network, signal })
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

/** What fetching files by download URL takes from the host: the API's grants and blobs. */
export interface RenderDownloadHost {
  readonly id: string
  readonly storage: Pick<Storage, "fileDownloadGrants">
  readonly blobStorage: Pick<BlobStorage, "stat">
}

/**
 * The API's public origin, where a render's sandbox fetches its files: pass it to
 * {@link inRenderSandbox} as `reach`. The API records it, and `SIXB_API_PUBLIC_ORIGIN` tells a
 * worker of its own.
 */
export function renderApiOrigin(host: object): string {
  const origin = getApiPublicOrigin(host)
  if (!origin) {
    throw new Error(
      "[SixbRenderWorker] A render that fetches its files needs the API's public origin. Set SIXB_API_PUBLIC_ORIGIN for the worker."
    )
  }
  return origin
}

/** How long fetching files may take at most, whatever is left of the render. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/**
 * Puts each file at its path in the sandbox, which fetches it itself with curl from a download URL
 * of the API: a large one never passes through the worker, as `writeFiles` would take it. Each URL
 * lasts as long as the fetch may, and is revoked once it is over. The sandbox must reach the API:
 * create it with {@link renderApiOrigin} in `reach`.
 */
export async function downloadIntoSandbox(
  host: RenderDownloadHost,
  sandbox: Sandbox,
  files: readonly { readonly path: string; readonly file: FileRef }[],
  options: {
    readonly timeoutMs: number
    readonly signal: AbortSignal
    /** What asked, kept with each URL so an exposure is traced back to it: the render's job. */
    readonly executionId: string
  }
): Promise<void> {
  if (files.length === 0) return

  const timeoutMs = Math.min(options.timeoutMs, DOWNLOAD_TIMEOUT_MS)
  const context: FileDownloadUrlContext = {
    projectId: host.id,
    storage: host.storage,
    blobStorage: host.blobStorage,
    executionId: options.executionId,
    apiPublicOrigin: renderApiOrigin(host),
  }
  const urls: { readonly id: string; readonly url: string }[] = []
  try {
    for (const { file } of files) {
      urls.push(await createFileDownloadUrl(context, file, { expiresInMs: timeoutMs + 60_000 }))
    }

    const result = await sandbox.runCommand(
      "bash",
      [
        "-c",
        FETCH_SCRIPT,
        "fetch",
        ...files.flatMap(({ path, file }, index) => [
          path,
          urls[index]?.url ?? "",
          String(file.sizeBytes),
        ]),
      ],
      { timeout: timeoutMs, signal: options.signal }
    )
    options.signal.throwIfAborted()
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `[SixbRenderWorker] The sandbox could not fetch its files: ${result.stderr.trim().slice(0, 500) || (result.timedOut ? "it ran out of time" : `exit ${result.exitCode}`)}`
      )
    }
  } finally {
    for (const { id } of urls) {
      await revokeFileDownloadUrl(context, id).catch((error: unknown) => {
        console.warn(`[SixbRenderWorker] Could not revoke download URL '${id}':`, error)
      })
    }
  }
}

// Fetches each `<path> <url> <bytes>` in turn, and refuses a file that did not arrive whole.
const FETCH_SCRIPT = `set -eu
command -v curl >/dev/null 2>&1 || { echo "the sandbox has no curl" >&2; exit 3; }
while [ "$#" -gt 0 ]; do
  path="$1"
  url="$2"
  bytes="$3"
  shift 3
  mkdir -p -- "$(dirname -- "$path")"
  curl --fail --silent --show-error --retry 3 --output "$path" --url "$url"
  [ "$(wc -c < "$path" | tr -d ' ')" = "$bytes" ] || { echo "$path did not arrive whole" >&2; exit 1; }
done`

/**
 * Stores a file a script wrote in the sandbox, `bytes` long as the script said: it streams into
 * blob storage a piece at a time, read as {@link readSandboxFiles} reads, a few pieces ahead, so
 * the worker never holds the whole file.
 *
 * A sandbox could instead upload it to blob storage itself, as `sixb files upload` does from the
 * Agent's sandbox. A render's sandbox cannot: it holds no credential for the API, and the URLs a
 * blob store signs for a direct upload are on an origin its network does not reach, which the
 * contract does not name before the upload exists, when the sandbox's network is already set.
 */
export async function storeSandboxFile(
  blobStorage: Pick<BlobStorage, "put">,
  sandbox: Sandbox,
  file: {
    readonly path: string
    readonly bytes: number
    readonly fileName: string
    readonly mediaType: string
  },
  options: { readonly signal: AbortSignal }
): Promise<FileRef> {
  const script = `${sandbox.workingDirectory}/read.cjs`
  await sandbox.writeFiles([{ path: script, contents: readScript }])

  const pieces = Math.ceil(file.bytes / READ_BYTES)
  const reading: Promise<Uint8Array>[] = []
  let next = 0
  const readPiece = async (index: number): Promise<Uint8Array> => {
    const start = index * READ_BYTES
    const length = Math.min(READ_BYTES, file.bytes - start)
    const result = await runNode(sandbox, [script, file.path, start, length], {
      timeoutMs: READ_TIMEOUT_MS,
      signal: options.signal,
    })
    const line = parse(result.stdout.trim())
    const bytes = typeof line?.data === "string" ? Buffer.from(line.data, "base64") : null
    if (bytes?.byteLength !== length) {
      throw new Error(`[SixbRenderWorker] ${file.path} could not be read back from the sandbox.`)
    }
    return bytes
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (reading.length < READS_AT_ONCE && next < pieces) {
        const piece = readPiece(next)
        // Read ahead: a piece that fails before its turn is reported when its turn comes.
        piece.catch(() => {})
        reading.push(piece)
        next += 1
      }
      const piece = reading.shift()
      if (piece) controller.enqueue(await piece)
      else controller.close()
    },
  })

  return blobStorage.put({
    body,
    expectedSizeBytes: file.bytes,
    signal: options.signal,
    fileName: file.fileName,
    mediaType: file.mediaType,
  })
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

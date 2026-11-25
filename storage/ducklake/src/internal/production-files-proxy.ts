import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeProductionFilesOptions } from "../types"
import { PRODUCTION_FILES_ROOT } from "./catalog-slice"
import { quoteSqlString } from "./sql"

/**
 * A branch's way to production's lake files. A catalog slice names them under a host that never
 * resolves; DuckDB reaches this loopback proxy for that host alone, through a scoped HTTP secret
 * with a password only this process knows. The proxy:
 *
 * - forwards GET and HEAD to production's file route with the slice token, and refuses any other
 *   method, so nothing on the branch can write a production file;
 * - caches what it read on disk, in 1 MiB blocks by file name: production's files never change,
 *   so a block is fetched once and read from disk ever after, across restarts;
 * - asks for a new token once when production answers that the token expired.
 */
export class ProductionFilesProxy {
  private server: ReturnType<typeof Bun.serve> | undefined
  private token: Promise<string> | undefined
  private readonly password = randomBytes(24).toString("base64url")
  private readonly upstream: string
  private readonly fetching = new Map<string, Promise<void>>()

  constructor(private readonly options: DuckLakeProductionFilesOptions) {
    const url = new URL(options.url)
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new LakeStorageError(
        `[SixbDuckLake] productionFiles.url must be production's HTTPS file route; got '${options.url}'.`
      )
    }
    this.upstream = url.href.endsWith("/") ? url.href : `${url.href}/`
  }

  /** The secret through which DuckDB reads production's files, starting the proxy if needed. */
  secretSql(): string {
    if (!this.server) removeTemporaryFiles(this.options.cacheDirectory)
    this.server ??= Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => this.serve(request),
    })

    return `CREATE OR REPLACE TEMPORARY SECRET sixb_production_files (${[
      "TYPE http",
      `HTTP_PROXY ${quoteSqlString(`127.0.0.1:${this.server.port}`)}`,
      "HTTP_PROXY_USERNAME 'sixb'",
      `HTTP_PROXY_PASSWORD ${quoteSqlString(this.password)}`,
      `SCOPE ${quoteSqlString(PRODUCTION_FILES_ROOT)}`,
    ].join(", ")})`
  }

  async close(): Promise<void> {
    await this.server?.stop(true)
    this.server = undefined
  }

  private async serve(request: Request): Promise<Response> {
    if (!this.authorized(request.headers.get("proxy-authorization"))) {
      return new Response(null, { status: 407 })
    }

    const url = new URL(request.url)
    if (`${url.protocol}//${url.host}/` !== PRODUCTION_FILES_ROOT) {
      return new Response(null, { status: 403 })
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return failure(405, "A branch never writes production's lake files.")
    }

    // DuckDB sends the path as the slice names it, each segment percent-encoded once.
    let path: string
    try {
      path = url.pathname.slice(1).split("/").map(decodeURIComponent).join("/")
    } catch {
      return failure(400, `'${url.pathname}' is not a path a slice names.`)
    }

    try {
      const size = await this.size(path)
      if (request.method === "HEAD") {
        return new Response(null, {
          headers: { "content-length": String(size), "accept-ranges": "bytes" },
        })
      }

      return await this.read(path, size, request.headers.get("range"))
    } catch (error) {
      return failure(502, error instanceof Error ? error.message : String(error))
    }
  }

  private async read(path: string, size: number, rangeHeader: string | null): Promise<Response> {
    const range = parseRange(rangeHeader, size)
    if (!range) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } })
    }

    const first = Math.floor(range.start / BLOCK_BYTES)
    const last = Math.floor(range.end / BLOCK_BYTES)
    await this.cacheBlocks(path, size, first, last)

    const directory = this.directory(path)
    const parts: Blob[] = []
    for (let block = first; block <= last; block++) {
      const from = Math.max(range.start, block * BLOCK_BYTES) - block * BLOCK_BYTES
      const to = Math.min(range.end, (block + 1) * BLOCK_BYTES - 1) - block * BLOCK_BYTES
      parts.push(Bun.file(join(directory, String(block))).slice(from, to + 1))
    }

    // One block in memory at a time, however large the range.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const part = parts.shift()
        if (part) controller.enqueue(await part.bytes())
        else controller.close()
      },
    })

    return new Response(body, {
      status: rangeHeader ? 206 : 200,
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(range.end - range.start + 1),
        ...(rangeHeader ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}),
      },
    })
  }

  /** Fetches the blocks not on disk yet, a run of missing blocks per request. */
  private async cacheBlocks(path: string, size: number, first: number, last: number) {
    const directory = this.directory(path)
    const waits: Promise<void>[] = []
    let run: number | undefined

    const flush = (end: number) => {
      if (run === undefined) return
      for (let start = run; start <= end; start += BLOCKS_PER_REQUEST) {
        waits.push(
          this.fetchBlocks(path, size, start, Math.min(end, start + BLOCKS_PER_REQUEST - 1))
        )
      }
      run = undefined
    }

    // Checked and registered without awaiting in between: two reads of one block fetch it once.
    for (let block = first; block <= last; block++) {
      const key = `${path}\0${block}`
      const pending = this.fetching.get(key)
      if (pending) {
        flush(block - 1)
        waits.push(pending)
      } else if (existsSync(join(directory, String(block)))) {
        flush(block - 1)
      } else {
        run ??= block
      }
    }
    flush(last)

    await Promise.all(waits)
  }

  private fetchBlocks(path: string, size: number, first: number, last: number): Promise<void> {
    const start = first * BLOCK_BYTES
    const end = Math.min((last + 1) * BLOCK_BYTES, size) - 1
    const fetched = (async () => {
      const response = await this.fetchUpstream(path, { range: `bytes=${start}-${end}` })
      const body = new Uint8Array(await response.arrayBuffer())
      const offset = response.status === 206 ? start : 0
      if (body.length < end - offset + 1) {
        throw new LakeStorageError(`[SixbDuckLake] Production sent part of '${path}' only.`)
      }

      const directory = this.directory(path)
      await mkdir(directory, { recursive: true })
      for (let block = first; block <= last; block++) {
        const from = block * BLOCK_BYTES - offset
        const to = Math.min((block + 1) * BLOCK_BYTES, size) - offset
        await writeAtomically(join(directory, String(block)), body.subarray(from, to))
      }
    })()

    for (let block = first; block <= last; block++) {
      const key = `${path}\0${block}`
      this.fetching.set(key, fetched)
      void fetched.catch(() => undefined).finally(() => this.fetching.delete(key))
    }
    return fetched
  }

  private async size(path: string): Promise<number> {
    const cached = Bun.file(join(this.directory(path), "size"))
    if (await cached.exists()) return Number(await cached.text())

    const response = await this.fetchUpstream(path, { method: "HEAD" })
    const size = Number(response.headers.get("content-length"))
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new LakeStorageError(`[SixbDuckLake] Production sent no size for '${path}'.`)
    }

    await mkdir(this.directory(path), { recursive: true })
    await writeAtomically(join(this.directory(path), "size"), String(size))
    return size
  }

  /** One request to production's file route, with a fresh token once if the last one expired. */
  private async fetchUpstream(
    path: string,
    init: { readonly method?: string; readonly range?: string }
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.currentToken(attempt > 0)
      const encoded = path.split("/").map(encodeURIComponent).join("/")
      const response = await fetch(`${this.upstream}${encoded}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.range ? { range: init.range } : {}),
        },
        redirect: "error",
      })
      if (response.ok) return response

      await response.body?.cancel()
      if (response.status === 401 && attempt === 0) continue

      const message =
        response.status === 401
          ? "Production refused the branch's lake token. Open the branch again from production to get a new one."
          : response.status === 404
            ? `Production serves no file '${path}' for this branch: the slice no longer holds it.`
            : `Production answered ${response.status} for '${path}'.`
      console.error(`[SixbDuckLake] ${message}`)
      throw new LakeStorageError(`[SixbDuckLake] ${message}`)
    }
  }

  private currentToken(renew: boolean): Promise<string> {
    if (renew || this.token === undefined) {
      const token = Promise.resolve(this.options.token())
      this.token = token
      token.catch(() => {
        if (this.token === token) this.token = undefined
      })
    }
    return this.token
  }

  private directory(path: string): string {
    const key = createHash("sha256").update(path).digest("hex")
    return join(this.options.cacheDirectory, key.slice(0, 2), key)
  }

  private authorized(header: string | null): boolean {
    const expected = Buffer.from(`Basic ${Buffer.from(`sixb:${this.password}`).toString("base64")}`)
    const actual = Buffer.from(header ?? "")
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
}

const BLOCK_BYTES = 1 << 20
/** At most 16 MiB per request to production, so one read never holds a whole file in memory. */
const BLOCKS_PER_REQUEST = 16

function parseRange(
  header: string | null,
  size: number
): { readonly start: number; readonly end: number } | null {
  if (size === 0) return null
  if (header === null) return { start: 0, end: size - 1 }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null

  if (!match[1]) {
    return { start: Math.max(size - Number(match[2]), 0), end: size - 1 }
  }

  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return start <= end ? { start, end } : null
}

/** What a process that stopped mid-write left behind: never a block, since blocks are renamed. */
function removeTemporaryFiles(directory: string): void {
  if (!existsSync(directory)) return
  for (const name of new Bun.Glob("**/*.tmp").scanSync({ cwd: directory, onlyFiles: true })) {
    rmSync(join(directory, name), { force: true })
  }
}

async function writeAtomically(path: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

function failure(status: number, message: string): Response {
  return new Response(`[SixbDuckLake] ${message}`, { status })
}

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { prefetchDuckDbExtensions } from "../src/internal/duckdb-extensions"
import {
  createDuckDbRuntime,
  type DuckDbRuntime,
  installDuckLakeExtensions,
} from "../src/internal/duckdb-runtime"

// Not a real extension: DuckDB refuses it, so these tests stub INSTALL or prove the refusal.
// tests/duckdb-extensions.e2e.ts installs a real one.
const payload = new TextEncoder().encode("extension bytes")
const gzipped = new Uint8Array(gzipSync(payload))

function serve(respond: (url: string) => Response | Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async (input: string | URL | Request) => respond(String(input)), {
      preconnect: fetch.preconnect,
    })
  )
}

describe("prefetchDuckDbExtensions", () => {
  let directory: string
  let runtime: DuckDbRuntime | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sixb-ducklake-extensions-"))
  })

  afterEach(async () => {
    mock.restore()
    await runtime?.close()
    runtime = undefined
    await rm(directory, { recursive: true, force: true })
  })

  async function open(config: Record<string, string> = {}): Promise<DuckDbRuntime> {
    runtime = await createDuckDbRuntime({
      config: {
        extension_directory: join(directory, "extensions"),
        temp_directory: join(directory, "tmp"),
        ...config,
      },
    })
    return runtime
  }

  async function platformDirectory(runtime: DuckDbRuntime) {
    const [row] = await runtime.query(
      "SELECT version() AS version, (SELECT platform FROM pragma_platform()) AS platform"
    )
    const version = String(row?.version)
    const platform = String(row?.platform)
    return { version, platform, path: join(directory, "extensions", version, platform) }
  }

  test("installs each download from a file named after the extension", async () => {
    // Red check: drop the alias match in missingExtensions; sqlite is then not fetched at all.
    const urls: string[] = []
    serve((url) => {
      urls.push(url)
      return new Response(gzipped)
    })
    const runtime = await open()
    const { version, platform } = await platformDirectory(runtime)
    const installed: { statement: string; bytes: Uint8Array }[] = []
    spyOn(runtime, "run").mockImplementation(async (sql) => {
      const file = /^INSTALL '(.+)'$/.exec(sql)?.[1] ?? ""
      installed.push({ statement: sql, bytes: new Uint8Array(await readFile(file)) })
    })

    await prefetchDuckDbExtensions(runtime, ["ducklake", "sqlite"])

    expect(urls.sort()).toEqual([
      `https://extensions.duckdb.org/${version}/${platform}/ducklake.duckdb_extension.gz`,
      `https://extensions.duckdb.org/${version}/${platform}/sqlite_scanner.duckdb_extension.gz`,
    ])
    expect(installed.map(({ statement }) => statement.split("/").at(-1)).sort()).toEqual([
      "ducklake.duckdb_extension'",
      "sqlite_scanner.duckdb_extension'",
    ])
    for (const { bytes } of installed) expect(bytes).toEqual(payload)
  })

  test("skips extensions DuckDB already reports installed", async () => {
    // Red check: drop `NOT installed` in missingExtensions.
    const fetch = serve(() => new Response(gzipped))
    const runtime = await open()
    const { path: target } = await platformDirectory(runtime)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "ducklake.duckdb_extension"), "installed earlier")

    await prefetchDuckDbExtensions(runtime, ["ducklake"])

    expect(fetch).not.toHaveBeenCalled()
    expect(await readFile(join(target, "ducklake.duckdb_extension"), "utf8")).toBe(
      "installed earlier"
    )
  })

  test("leaves a download DuckDB refuses out of its extension directory", async () => {
    // Red check: drop the .catch() around the INSTALL '<file>'; prefetch rejects.
    serve(() => new Response(gzipped))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const runtime = await open()

    await prefetchDuckDbExtensions(runtime, ["ducklake"])

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("'ducklake'")
    expect(
      await runtime.query(
        "SELECT installed FROM duckdb_extensions() WHERE extension_name = 'ducklake'"
      )
    ).toEqual([{ installed: false }])
  })

  test("falls back to DuckDB's INSTALL when the download fails", async () => {
    // Red check: drop the .catch() around download; installDuckLakeExtensions rejects.
    serve((url) => {
      if (url.includes("ducklake")) throw new TypeError("network unreachable")
      return new Response("not found", { status: 404 })
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const runtime = await open()
    const statements: string[] = []
    spyOn(runtime, "run").mockImplementation(async (sql) => {
      statements.push(sql)
    })

    await installDuckLakeExtensions(runtime, {
      catalog: { type: "sqlite", path: join(directory, "metadata.sqlite") },
    })

    expect(statements).toEqual(["INSTALL ducklake", 'INSTALL "sqlite"'])
    expect(warn.mock.calls.map(([message]) => String(message)).sort()).toEqual([
      expect.stringContaining("'ducklake' over HTTPS (network unreachable)"),
      expect.stringContaining("'sqlite_scanner' over HTTPS (HTTP 404)"),
    ])
  })

  test("never rejects, so a broken setup still reaches DuckDB's INSTALL", async () => {
    // Red check: drop the .catch() in prefetchDuckDbExtensions; the missing temp directory rejects.
    const fetch = serve(() => new Response(gzipped))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const runtime = await open()
    const tmpdir = process.env.TMPDIR
    process.env.TMPDIR = join(directory, "missing", "tmp")
    try {
      await prefetchDuckDbExtensions(runtime, ["ducklake"])
    } finally {
      process.env.TMPDIR = tmpdir
    }

    expect(fetch).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain("ENOENT")
  })

  test("leaves a custom extension repository to DuckDB", async () => {
    // Red check: remove the custom_extension_repository check in prefetchDuckDbExtensions.
    const fetch = serve(() => new Response(gzipped))
    const runtime = await open({ custom_extension_repository: "http://extensions.example.test" })

    await prefetchDuckDbExtensions(runtime, ["ducklake"])

    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(directory)).not.toContain("extensions")
  })
})

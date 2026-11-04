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

  test("downloads missing extensions over HTTPS into the configured extension_directory", async () => {
    // Red check: drop the alias lookup; sqlite is then written as sqlite.duckdb_extension and
    // DuckDB does not report sqlite_scanner as installed.
    const urls: string[] = []
    serve((url) => {
      urls.push(url)
      return new Response(gzipped)
    })
    const runtime = await open()
    const { version, platform, path: target } = await platformDirectory(runtime)

    await prefetchDuckDbExtensions(runtime, ["ducklake", "sqlite"])

    expect(urls.sort()).toEqual([
      `https://extensions.duckdb.org/${version}/${platform}/ducklake.duckdb_extension.gz`,
      `https://extensions.duckdb.org/${version}/${platform}/sqlite_scanner.duckdb_extension.gz`,
    ])
    expect((await readdir(target)).sort()).toEqual([
      "ducklake.duckdb_extension",
      "sqlite_scanner.duckdb_extension",
    ])
    expect(new Uint8Array(await readFile(join(target, "ducklake.duckdb_extension")))).toEqual(
      payload
    )
    expect(
      await runtime.query(
        "SELECT extension_name, installed FROM duckdb_extensions() WHERE extension_name IN ('ducklake', 'sqlite_scanner') ORDER BY 1"
      )
    ).toEqual([
      { extension_name: "ducklake", installed: true },
      { extension_name: "sqlite_scanner", installed: true },
    ])
  })

  test("skips extensions whose file already exists", async () => {
    // Red check: remove the exists() check in downloadExtension.
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

  test("falls back to DuckDB's INSTALL when the download fails", async () => {
    // Red check: drop the .catch() around downloadExtension; installDuckLakeExtensions rejects.
    serve((url) => {
      if (url.includes("ducklake")) throw new TypeError("network unreachable")
      return new Response("not found", { status: 404 })
    })
    const runtime = await open()
    const statements: string[] = []
    spyOn(runtime, "run").mockImplementation(async (sql) => {
      statements.push(sql)
    })

    await installDuckLakeExtensions(runtime, {
      catalog: { type: "sqlite", path: join(directory, "metadata.sqlite") },
    })

    expect(statements).toEqual(["INSTALL ducklake", 'INSTALL "sqlite"'])
    expect(await readdir(directory)).not.toContain("extensions")
  })

  test("leaves a custom extension repository to DuckDB", async () => {
    // Red check: remove the custom_extension_repository check in readExtensionTarget.
    const fetch = serve(() => new Response(gzipped))
    const runtime = await open({ custom_extension_repository: "http://extensions.example.test" })

    await prefetchDuckDbExtensions(runtime, ["ducklake"])

    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(directory)).not.toContain("extensions")
  })
})

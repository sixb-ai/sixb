import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import {
  createDuckDbRuntime,
  type DuckDbRuntime,
  setupDuckLake,
} from "../src/internal/duckdb-runtime"

describe("DuckDB extensions over HTTPS", () => {
  let directory: string
  const runtimes: DuckDbRuntime[] = []

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sixb-ducklake-extensions-"))
  })

  afterEach(async () => {
    mock.restore()
    for (const runtime of runtimes.splice(0)) await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })

  async function open(config: Record<string, string> = {}): Promise<DuckDbRuntime> {
    const runtime = await createDuckDbRuntime({
      config: { temp_directory: join(directory, "tmp"), ...config },
    })
    runtimes.push(runtime)
    return runtime
  }

  test("a lake opens on extensions fetched over HTTPS", async () => {
    // Red check: make prefetchDuckDbExtensions return at once; INSTALL then downloads from its
    // own repository and install_mode reads REPOSITORY.
    //
    // The preload installed real extensions into the default directory; serve those bytes as
    // extensions.duckdb.org would, gzipped.
    const preloaded = await open()
    const files = new Map<string, Uint8Array<ArrayBuffer>>()
    for (const row of await preloaded.query(
      "SELECT extension_name, install_path FROM duckdb_extensions() WHERE extension_name IN ('ducklake', 'sqlite_scanner')"
    )) {
      files.set(
        String(row.extension_name),
        new Uint8Array(gzipSync(await readFile(String(row.install_path))))
      )
    }
    const urls: string[] = []
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: string | URL | Request) => {
          const url = String(input)
          urls.push(url)
          const name = /\/([a-z_]+)\.duckdb_extension\.gz$/.exec(url)?.[1] ?? ""
          const body = files.get(name)
          return body ? new Response(body) : new Response("not found", { status: 404 })
        },
        { preconnect: fetch.preconnect }
      )
    )

    const runtime = await open({ extension_directory: join(directory, "extensions") })
    await setupDuckLake(runtime, {
      catalog: { type: "sqlite", path: join(directory, "metadata.sqlite") },
      dataPath: join(directory, "data"),
    })

    const [target] = await runtime.query(
      "SELECT version() AS version, (SELECT platform FROM pragma_platform()) AS platform"
    )
    const version = String(target?.version)
    const platform = String(target?.platform)
    expect(urls.sort()).toEqual([
      `https://extensions.duckdb.org/${version}/${platform}/ducklake.duckdb_extension.gz`,
      `https://extensions.duckdb.org/${version}/${platform}/sqlite_scanner.duckdb_extension.gz`,
    ])
    expect(
      await runtime.query(
        "SELECT extension_name, loaded, install_mode FROM duckdb_extensions() WHERE extension_name IN ('ducklake', 'sqlite_scanner') ORDER BY 1"
      )
    ).toEqual([
      { extension_name: "ducklake", loaded: true, install_mode: "CUSTOM_PATH" },
      { extension_name: "sqlite_scanner", loaded: true, install_mode: "CUSTOM_PATH" },
    ])
  })
})

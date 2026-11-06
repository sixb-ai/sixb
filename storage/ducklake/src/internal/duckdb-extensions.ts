import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { gunzip } from "node:zlib"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { quoteSqlString, quoteSqlStringList } from "./sql"

const extensionsUrl = "https://extensions.duckdb.org"
const downloadTimeoutMillis = 60_000
const gunzipAsync = promisify(gunzip)

/**
 * Install missing core extensions from `https://extensions.duckdb.org`.
 *
 * DuckDB's `INSTALL` downloads from `http://extensions.duckdb.org`, and fetching over HTTPS needs
 * `httpfs`, which DuckDB itself fetches over HTTP. A host that only allows HTTPS by name, such as
 * a Vercel sandbox whose firewall filters on TLS SNI, can reach neither. So the file is fetched
 * here and handed to `INSTALL '<file>'`, which puts it where DuckDB looks; the plain `INSTALL`
 * that follows is then a no-op, and `LOAD` still checks the extension's signature.
 *
 * Best effort: a failure is logged and leaves the extension to DuckDB's own `INSTALL`. A project
 * that set `custom_extension_repository` keeps its own repository.
 */
export async function prefetchDuckDbExtensions(
  runtime: DuckDbQueryRuntime,
  extensions: readonly string[]
): Promise<void> {
  await prefetch(runtime, extensions).catch((error: unknown) =>
    warnFallback(extensions.join("', '"), error)
  )
}

async function prefetch(runtime: DuckDbQueryRuntime, extensions: readonly string[]) {
  const [target] = await runtime.query(`
    SELECT
      version() AS version,
      (SELECT platform FROM pragma_platform()) AS platform,
      current_setting('custom_extension_repository') AS repository
  `)
  if (target?.repository !== "") return

  const missing = await missingExtensions(runtime, extensions)
  if (missing.length === 0) return

  const directory = await mkdtemp(join(tmpdir(), "sixb-duckdb-extensions-"))
  try {
    const downloads = await Promise.all(
      missing.map(async (name) => ({
        name,
        file: await download(`${target.version}/${target.platform}/${name}`, directory, name).catch(
          (error: unknown) => warnFallback(name, error)
        ),
      }))
    )

    // One at a time: the runtime runs statements in order anyway, and this keeps failures apart.
    for (const { name, file } of downloads) {
      if (file === undefined) continue
      await runtime
        .run(`INSTALL ${quoteSqlString(file)}`)
        .catch((error: unknown) => warnFallback(name, error))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function warnFallback(name: string, error: unknown): undefined {
  const reason = error instanceof Error ? error.message : String(error)
  console.warn(
    `[SixbDuckLake] Could not install DuckDB extension '${name}' over HTTPS (${reason}); falling back to DuckDB's INSTALL.`
  )
  return undefined
}

/** Canonical names of the requested extensions not installed yet: `sqlite` is `sqlite_scanner`. */
async function missingExtensions(
  runtime: DuckDbQueryRuntime,
  extensions: readonly string[]
): Promise<string[]> {
  const requested = `[${quoteSqlStringList(extensions.map((extension) => extension.toLowerCase()))}]`
  const rows = await runtime.query(`
    SELECT extension_name
    FROM duckdb_extensions()
    WHERE NOT installed
      AND (list_contains(${requested}, extension_name) OR list_has_any(${requested}, aliases))
  `)
  return rows.map((row) => String(row.extension_name))
}

/** `INSTALL '<file>'` names the extension after the file, so it is written as `<name>.duckdb_extension`. */
async function download(path: string, directory: string, name: string): Promise<string> {
  const response = await fetch(`${extensionsUrl}/${path}.duckdb_extension.gz`, {
    signal: AbortSignal.timeout(downloadTimeoutMillis),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const file = join(directory, `${name}.duckdb_extension`)
  await writeFile(file, await gunzipAsync(new Uint8Array(await response.arrayBuffer())))
  return file
}

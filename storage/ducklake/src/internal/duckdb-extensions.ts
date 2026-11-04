import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { gunzip } from "node:zlib"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"

const extensionsUrl = "https://extensions.duckdb.org"
const downloadTimeoutMillis = 60_000
const gunzipAsync = promisify(gunzip)

interface ExtensionTarget {
  readonly version: string
  readonly platform: string
  readonly directory: string
}

/**
 * Download missing core extensions over HTTPS into the directory `INSTALL` reads.
 *
 * DuckDB's `INSTALL` fetches from `http://extensions.duckdb.org`. A host that only allows
 * HTTPS by name, such as a Vercel sandbox whose firewall filters on TLS SNI, cannot reach it.
 * A file already at `<extension_directory>/<version>/<platform>/<name>.duckdb_extension`
 * turns `INSTALL` into a no-op, and `LOAD` still checks the extension's signature.
 *
 * This is best effort: any failure leaves the file missing and `INSTALL` downloads it as
 * before. A project that set `custom_extension_repository` keeps its own repository.
 */
export async function prefetchDuckDbExtensions(
  runtime: DuckDbQueryRuntime,
  extensions: readonly string[]
): Promise<void> {
  const target = await readExtensionTarget(runtime).catch(() => undefined)
  if (target === undefined) return

  const names = await Promise.all(
    extensions.map((extension) => resolveExtensionName(runtime, extension).catch(() => undefined))
  )

  await Promise.all(
    names.map((name) =>
      name === undefined ? undefined : downloadExtension(target, name).catch(() => {})
    )
  )
}

async function readExtensionTarget(
  runtime: DuckDbQueryRuntime
): Promise<ExtensionTarget | undefined> {
  const [row] = await runtime.query(`
    SELECT
      version() AS version,
      (SELECT platform FROM pragma_platform()) AS platform,
      current_setting('extension_directory') AS extension_directory,
      current_setting('home_directory') AS home_directory,
      current_setting('custom_extension_repository') AS repository
  `)
  if (row === undefined || row.repository !== "") return undefined

  const { version, platform } = row
  if (typeof version !== "string" || typeof platform !== "string") return undefined

  const home =
    typeof row.home_directory === "string" && row.home_directory !== ""
      ? row.home_directory
      : homedir()
  const configured = typeof row.extension_directory === "string" ? row.extension_directory : ""

  // Same default and `~` expansion as DuckDB, relative paths from the working directory.
  const directory =
    configured === ""
      ? join(home, ".duckdb", "extensions")
      : configured === "~" || configured.startsWith("~/")
        ? join(home, configured.slice(1))
        : resolve(configured)

  return { version, platform, directory }
}

/** `INSTALL sqlite` writes `sqlite_scanner.duckdb_extension`: files use the canonical name. */
async function resolveExtensionName(
  runtime: DuckDbQueryRuntime,
  extension: string
): Promise<string> {
  const name = extension.toLowerCase()
  const [row] = await runtime.query(
    "SELECT extension_name FROM duckdb_extensions() WHERE extension_name = ? OR list_contains(aliases, ?)",
    [name, name]
  )
  return typeof row?.extension_name === "string" ? row.extension_name : name
}

async function downloadExtension(target: ExtensionTarget, name: string): Promise<void> {
  const file = join(target.directory, target.version, target.platform, `${name}.duckdb_extension`)
  if (await exists(file)) return

  const response = await fetch(
    `${extensionsUrl}/${target.version}/${target.platform}/${name}.duckdb_extension.gz`,
    { signal: AbortSignal.timeout(downloadTimeoutMillis) }
  )
  if (!response.ok) return

  const bytes = await gunzipAsync(new Uint8Array(await response.arrayBuffer()))

  // Rename into place so another runtime or process never loads a half-written file.
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false
  )
}

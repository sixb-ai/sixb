import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  asRecord,
  CliError,
  createInstanceApiClient,
  EXIT_API,
  fail,
  isFileError,
  isHelp,
  type SandboxInstanceCliMode,
  writeJson,
  writeText,
} from "@sixb/cli-core"
import {
  AGENT_MEMORY_ENTRY,
  AGENT_MEMORY_MANIFEST,
  AGENT_MEMORY_STARTER,
  type AgentMemoryManifest,
  type AgentMemoryManifestRepo,
  type AgentMemoryRepo,
  agentMemoryFileHash,
} from "../../agent-runtime/memory"

const HELP = `Usage:
  sixb memory save <repo> -m <message>   Save local edits as one revision
  sixb memory pull [repo]                Bring the local copy up to the latest revision

<repo> is user or project. Files live under $SIXB_MEMORY_DIR/<repo>/.

A save is rejected for files another conversation changed since they were loaded. Their
current contents are written next to yours as <file>.theirs: merge each into its file, delete
it, then save again. Changes others made to other files are brought in by save and pull.`

interface RemoteRepo {
  readonly revision: number
  readonly files: ReadonlyMap<string, string>
}

interface MemoryConflict {
  readonly path: string
  /** Where their version was written, or `null` when another save deleted the file. */
  readonly theirs: string | null
}

const THEIRS = ".theirs"
const CONFLICT_HINT = "Merge each .theirs file into its file, delete it, then save again."

export async function memory(args: readonly string[], mode: SandboxInstanceCliMode): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || rest.some(isHelp)) return writeText(HELP)
  const local = localMemory()
  if (sub === "save") return save(local, rest, mode)
  if (sub === "pull") return pull(local, rest, mode)
  fail(`Unknown memory command '${sub}'. Run 'sixb memory --help'.`)
}

async function save(
  local: LocalMemory,
  args: readonly string[],
  mode: SandboxInstanceCliMode
): Promise<void> {
  const { repo, message } = parseSaveArgs(args)
  const manifest = await local.readManifest()
  const loaded = manifest.repos[repo]
  if (!loaded)
    fail(
      `Memory repo '${repo}' is not installed.`,
      "invalid_arguments",
      `Run 'sixb memory pull ${repo}'.`
    )
  const files = await local.readRepo(repo)
  const unresolved = [...files.keys()].filter((path) => path.endsWith(THEIRS))
  if (unresolved.length > 0) {
    fail(`Resolve ${unresolved.join(", ")} first.`, "unresolved_conflicts", CONFLICT_HINT)
  }
  const changes = [...new Set([...files.keys(), ...Object.keys(loaded.files)])]
    .sort()
    .flatMap((path) => {
      const contents = files.get(path)
      const changed =
        (contents === undefined ? undefined : agentMemoryFileHash(contents)) !== loaded.files[path]
      return changed ? [{ path, contents: contents ?? null }] : []
    })
  if (changes.length === 0) {
    return writeJson({
      repo,
      saved: false,
      changed: [],
      hint: "No file changed since it was loaded.",
    })
  }

  const api = createInstanceApiClient(mode)
  let saved: Record<string, unknown>
  try {
    saved = asRecord(
      await api.post(`/api/agent-memory/${repo}/revisions`, {
        baseRevision: loaded.revision,
        message,
        changes,
      })
    )
  } catch (error) {
    if (!(error instanceof CliError) || error.body.status !== 409) throw error
    const { revision, conflicts } = await update(local, repo, manifest, await fetchRepo(api, repo))
    process.exitCode = 1
    return writeJson({ repo, saved: false, revision, conflicts, hint: CONFLICT_HINT })
  }

  // The saved files are now what the repo holds, so updating does not report them as conflicts.
  const savedFiles = { ...loaded.files }
  for (const change of changes) {
    if (change.contents === null) delete savedFiles[change.path]
    else savedFiles[change.path] = agentMemoryFileHash(change.contents)
  }
  const after: AgentMemoryManifest = {
    repos: { ...manifest.repos, [repo]: { ...loaded, files: savedFiles } },
  }
  const { revision, conflicts } = await update(local, repo, after, await fetchRepo(api, repo))
  const warnings = Array.isArray(saved.warnings) ? saved.warnings : []
  writeJson({
    repo,
    saved: true,
    revision,
    changed: changes.map((change) => change.path),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(conflicts.length > 0 ? { conflicts, hint: CONFLICT_HINT } : {}),
  })
}

async function pull(
  local: LocalMemory,
  args: readonly string[],
  mode: SandboxInstanceCliMode
): Promise<void> {
  if (args.length > 1) fail("Invalid arguments for 'memory pull'.")
  const manifest = await local.readManifest()
  const repos = args[0] === undefined ? installedRepos(manifest) : [parseRepo(args[0])]
  if (repos.length === 0) {
    fail("No memory repo is installed.", "invalid_arguments", "Run 'sixb memory pull user'.")
  }

  const api = createInstanceApiClient(mode)
  let current = manifest
  for (const repo of repos) {
    const result = await update(local, repo, current, await fetchRepo(api, repo))
    current = result.manifest
    writeJson({
      repo,
      revision: result.revision,
      updated: result.updated,
      conflicts: result.conflicts,
      ...(result.conflicts.length > 0 ? { hint: CONFLICT_HINT } : {}),
    })
  }
}

/**
 * Bring the local copy of `repo` to `remote`, three ways against the manifest: a file only the
 * repo changed is updated, a file only this copy changed is kept, and a file both changed gets
 * the repo's version next to it as `.theirs`. The manifest then records `remote`, so the next save
 * sends what this copy holds against the latest revision.
 */
async function update(
  local: LocalMemory,
  repo: AgentMemoryRepo,
  manifest: AgentMemoryManifest,
  remote: RemoteRepo
): Promise<{
  readonly manifest: AgentMemoryManifest
  readonly revision: number
  readonly updated: readonly string[]
  readonly conflicts: readonly MemoryConflict[]
}> {
  const base = manifest.repos[repo]?.files ?? {}
  const files = await local.readRepo(repo)
  const updated: string[] = []
  const conflicts: MemoryConflict[] = []

  for (const path of [
    ...new Set([...files.keys(), ...remote.files.keys(), ...Object.keys(base)]),
  ].sort()) {
    if (path.endsWith(THEIRS)) continue
    const mine = files.get(path)
    const theirs = remote.files.get(path)
    const mineHash = mine === undefined ? undefined : agentMemoryFileHash(mine)
    const theirsHash = theirs === undefined ? undefined : agentMemoryFileHash(theirs)
    if (theirsHash === base[path] || theirsHash === mineHash) continue
    if (mineHash === base[path]) {
      await local.write(repo, path, theirs)
      updated.push(path)
    } else if (theirs === undefined) {
      conflicts.push({ path, theirs: null })
    } else {
      await local.write(repo, `${path}${THEIRS}`, theirs)
      conflicts.push({ path, theirs: `${path}${THEIRS}` })
    }
  }
  if (
    !remote.files.has(AGENT_MEMORY_ENTRY) &&
    !(await local.readRepo(repo)).has(AGENT_MEMORY_ENTRY)
  ) {
    await local.write(repo, AGENT_MEMORY_ENTRY, AGENT_MEMORY_STARTER)
  }

  const next: AgentMemoryManifest = {
    repos: {
      ...manifest.repos,
      [repo]: {
        revision: remote.revision,
        files: Object.fromEntries(
          [...remote.files].map(([path, contents]) => [path, agentMemoryFileHash(contents)])
        ),
      },
    },
  }
  await local.writeManifest(next)
  return { manifest: next, revision: remote.revision, updated, conflicts }
}

async function fetchRepo(
  api: ReturnType<typeof createInstanceApiClient>,
  repo: AgentMemoryRepo
): Promise<RemoteRepo> {
  const body = asRecord(await api.get(`/api/agent-memory/${repo}`))
  const files = Array.isArray(body.files) ? body.files.map(asRecord) : null
  if (
    typeof body.revision !== "number" ||
    !files?.every((file) => typeof file.path === "string" && typeof file.contents === "string")
  ) {
    throw new CliError(
      { code: "invalid_api_response", message: "The Sixb API returned an invalid memory repo." },
      EXIT_API
    )
  }
  return {
    revision: body.revision,
    files: new Map(files.map((file) => [String(file.path), String(file.contents)])),
  }
}

interface LocalMemory {
  readManifest(): Promise<AgentMemoryManifest>
  writeManifest(manifest: AgentMemoryManifest): Promise<void>
  /** Every file of the local copy, by path from the repo root. */
  readRepo(repo: AgentMemoryRepo): Promise<Map<string, string>>
  /** `undefined` deletes the file. */
  write(repo: AgentMemoryRepo, path: string, contents: string | undefined): Promise<void>
}

function localMemory(): LocalMemory {
  const root = process.env.SIXB_MEMORY_DIR
  const contextDir = process.env.SIXB_CONTEXT_DIR
  if (!root || !contextDir) {
    fail("Agent memory is not available in this run.", "runtime_unavailable")
  }
  const manifestPath = join(contextDir, ...AGENT_MEMORY_MANIFEST.split("/"))
  const fileOf = (repo: AgentMemoryRepo, path: string) => join(root, repo, ...path.split("/"))

  return {
    async readManifest() {
      let text: string
      try {
        text = await readFile(manifestPath, "utf8")
      } catch (error) {
        if (isFileError(error, "ENOENT")) return { repos: {} }
        throw error
      }
      try {
        return parseManifest(JSON.parse(text))
      } catch {
        fail(`Memory manifest '${manifestPath}' is not valid.`, "invalid_json")
      }
    },

    async writeManifest(manifest) {
      await mkdir(dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    },

    async readRepo(repo) {
      const files = new Map<string, string>()
      const walk = async (directory: string, prefix: string): Promise<void> => {
        let entries: string[]
        try {
          entries = await readdir(directory)
        } catch (error) {
          if (isFileError(error, "ENOENT")) return
          throw error
        }
        for (const name of entries) {
          const path = prefix ? `${prefix}/${name}` : name
          const stats = await lstat(join(directory, name))
          if (stats.isDirectory()) await walk(join(directory, name), path)
          else if (stats.isFile()) files.set(path, await readFile(join(directory, name), "utf8"))
          else fail(`Memory file '${repo}/${path}' is not a regular file.`)
        }
      }
      await walk(join(root, repo), "")
      return files
    },

    async write(repo, path, contents) {
      const file = fileOf(repo, path)
      if (contents === undefined) {
        await rm(file, { force: true })
        return
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, contents)
    },
  }
}

function parseSaveArgs(args: readonly string[]): { repo: AgentMemoryRepo; message: string } {
  const positionals: string[] = []
  let message: string | undefined
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? ""
    if (argument === "-m" || argument === "--message") {
      if (message !== undefined) fail(`${argument} may only be provided once.`)
      message = args[++index]
      if (!message) fail(`${argument} requires a value.`)
    } else if (argument.startsWith("-")) {
      fail(`Unknown memory save option '${argument}'.`)
    } else {
      positionals.push(argument)
    }
  }
  if (positionals.length !== 1) fail("Invalid arguments for 'memory save'.")
  if (message === undefined || message.trim().length === 0) {
    fail("memory save requires -m <what you learned>.")
  }
  return { repo: parseRepo(positionals[0] ?? ""), message }
}

function parseRepo(value: string): AgentMemoryRepo {
  if (value === "user" || value === "project") return value
  fail(`Unknown memory repo '${value}'. Use 'user' or 'project'.`)
}

function installedRepos(manifest: AgentMemoryManifest): AgentMemoryRepo[] {
  return (["user", "project"] as const).filter((repo) => manifest.repos[repo] !== undefined)
}

function parseManifest(value: unknown): AgentMemoryManifest {
  const repos = asRecord(asRecord(value).repos)
  const parsed: Partial<Record<AgentMemoryRepo, AgentMemoryManifestRepo>> = {}
  for (const repo of ["user", "project"] as const) {
    if (repos[repo] === undefined) continue
    const entry = asRecord(repos[repo])
    const files = asRecord(entry.files)
    if (
      typeof entry.revision !== "number" ||
      !Object.values(files).every((digest) => typeof digest === "string")
    ) {
      throw new Error("invalid memory manifest")
    }
    parsed[repo] = {
      revision: entry.revision,
      files: files as Record<string, string>,
    }
  }
  return { repos: parsed }
}

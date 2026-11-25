import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type BranchRuntime, hostOnBranch, readBranchCopy } from "@sixb/core/internal/branches"
import { branchNamespaces, importSnapshot } from "@sixb/core/internal/snapshots"
import type { LakeStorage } from "@sixb/core/lake-storage"
import { type BranchNamespace, migrateStorage } from "@sixb/core/storage"
import type { LoadedSixbHost } from "./loadSixb"

/** Production as `sixb dev --from production` reaches it: the developer's own CLI sign-in. */
export interface ProductionConnection {
  readonly apiUrl: string
  /** The `Authorization` header of the developer's CLI session in production. */
  authorization(): Promise<string>
}

export interface BranchFromProductionInput {
  /** The project's host, loaded as the branch: its gates are on, its providers the project's. */
  readonly host: LoadedSixbHost
  readonly projectRoot: string
  readonly production: ProductionConnection
  /** The checked-out git branch, and every local one: a namespace outlives no git branch. */
  readonly gitBranch: string
  readonly gitBranches: readonly string[]
  /** Take a new copy, discarding what the branch wrote to the last one. */
  readonly refresh?: boolean
}

export interface BranchFromProduction {
  /** The project's host on the branch's own data. */
  readonly host: LoadedSixbHost
  readonly namespace: string
  /** Whether this run took the copy; otherwise it reused the last one. */
  readonly copied: boolean
  /** When production's data was copied. */
  readonly takenAt: string
  /** Namespaces dropped because their git branch is gone. */
  readonly dropped: readonly string[]
  /** What production's datasets give the branch, or why they give it nothing. */
  readonly lake: "in place" | string
}

/** What the CLI keeps of each branch's copy, next to its data. */
interface BranchRecord {
  readonly gitBranch: string
  readonly takenAt: string
  readonly userId: string
  readonly lake?: { readonly sliceId: string; readonly point: string }
}

type BranchIndex = Record<string, BranchRecord>

/**
 * Sets a git branch up on a copy of what its developer reads in production, in that branch's own
 * namespace of the project's local storage: copied on the first run, reused on the next, taken
 * again with `refresh`. A namespace whose git branch is gone is dropped first.
 */
export async function branchFromProduction(
  input: BranchFromProductionInput
): Promise<BranchFromProduction> {
  // A storage that cannot keep the branch apart is refused: the copy is real data.
  const storage = branchNamespaces(input.host.storage)

  const directory = join(input.projectRoot, ".sixb", "branches")
  await mkdir(directory, { recursive: true })
  const index = await readIndex(directory)
  const name = namespaceFor(input.gitBranch)

  // Namespaces outlive no git branch, and a refresh starts from nothing.
  const dropped: string[] = []
  for (const existing of await storage.listBranchNamespaces()) {
    const record = index[existing]
    if (!record) continue
    const gone = !input.gitBranches.includes(record.gitBranch)
    if (!gone && !(existing === name && input.refresh)) continue

    await dropBranch(storage, directory, index, existing, input.production)
    if (gone) dropped.push(record.gitBranch)
  }

  let namespace = await storage.openBranchNamespace(name)
  const copied = namespace === null || index[name] === undefined
  if (copied) {
    if (namespace) await dropBranch(storage, directory, index, name, input.production)
    namespace = await copyFromProduction({ ...input, storage, directory, index, name })
  }
  await writeIndex(directory, index)

  const record = index[name]
  if (!namespace || !record) {
    throw new Error(`[SixbCLI] Branch namespace '${name}' was not set up. Run with --refresh.`)
  }

  const { lakeStorage, lake } = branchLake(input, directory, name, record)
  const runtime: BranchRuntime = {
    person: { userId: record.userId },
    production: { url: input.production.apiUrl, authorization: input.production.authorization },
    takenAt: record.takenAt,
  }
  const host = hostOnBranch(input.host, {
    storage: namespace,
    ...(lakeStorage ? { lakeStorage } : {}),
    runtime,
  }) as LoadedSixbHost

  return { host, namespace: name, copied, takenAt: record.takenAt, dropped, lake }
}

/**
 * A namespace name for a git branch: lowercase, digits and dashes, at most 40 characters, the
 * exact name's hash keeping `feature/a` and `feature-a` apart.
 */
export function namespaceFor(gitBranch: string): string {
  const slug = gitBranch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31)
  const hash = createHash("sha256").update(gitBranch).digest("hex").slice(0, 8)
  return slug ? `${slug}-${hash}` : hash
}

async function copyFromProduction(input: {
  readonly host: LoadedSixbHost
  readonly production: ProductionConnection
  readonly gitBranch: string
  readonly storage: { createBranchNamespace(name: string): Promise<BranchNamespace> }
  readonly directory: string
  readonly index: BranchIndex
  readonly name: string
}): Promise<BranchNamespace> {
  const response = await fetch(new URL("api/branches/copy", apiBase(input.production.apiUrl)), {
    method: "POST",
    headers: {
      authorization: await input.production.authorization(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ branch: input.gitBranch }),
  })
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(
      body?.error ??
        `[SixbCLI] Production refused the copy (${response.status}). Run \`sixb login\` with your production profile.`
    )
  }

  const namespace = await input.storage.createBranchNamespace(input.name)
  const copy = readBranchCopy(response.body as unknown as AsyncIterable<Uint8Array>)
  try {
    const report = await importSnapshot({
      snapshot: copy.snapshot,
      storage: namespace,
      ontology: input.host.definitions.ontology as never,
      projections: input.host.definitions.projections,
    })
    const rest = await copy.rest()
    await migrateStorage(namespace, {
      projectId: input.host.id,
      ontology: input.host.definitions.ontology as never,
    })

    const branchDirectory = join(input.directory, input.name)
    await rm(branchDirectory, { recursive: true, force: true })
    await mkdir(branchDirectory, { recursive: true })
    if (rest) await writeFile(join(branchDirectory, "lake.ducklake"), rest.catalog)

    input.index[input.name] = {
      gitBranch: input.gitBranch,
      takenAt: report.takenAt,
      userId: report.takenBy.id,
      ...(rest ? { lake: { sliceId: rest.lake.sliceId, point: rest.lake.point } } : {}),
    }
    return namespace
  } catch (error) {
    // Nothing of a failed copy is kept, here or in production.
    const rest = await copy.rest().catch(() => null)
    if (rest) await deleteSlice(input.production, rest.lake.sliceId)
    throw error
  }
}

/** Production's datasets on the branch, read in place, when the project's lake can be branched. */
function branchLake(
  input: BranchFromProductionInput,
  directory: string,
  name: string,
  record: BranchRecord
): { readonly lakeStorage?: LakeStorage; readonly lake: string } {
  if (!record.lake) return { lake: "production's lake cannot be branched: no dataset is copied" }

  const openBranch = input.host.lakeStorage.openBranch
  if (!openBranch) {
    return {
      lake: "the project's local lake cannot read production's datasets in place: use DuckLake",
    }
  }

  const sliceId = record.lake.sliceId
  let token: { value: string; expiresAt: number } | undefined
  const lakeStorage = openBranch.call(input.host.lakeStorage, {
    catalogPath: join(directory, name, "lake.ducklake"),
    dataPath: join(directory, name, "lake"),
    productionFiles: {
      url: new URL("api/lake/slice-files/", apiBase(input.production.apiUrl)).toString(),
      // Production renews the slice's token for its person while they still read every version.
      token: async () => {
        if (token && token.expiresAt - Date.now() > 60_000) return token.value
        const renewed = await renewToken(input.production, sliceId)
        token = renewed
        return renewed.value
      },
      cacheDirectory: join(directory, name, "lake-cache"),
    },
  })
  return { lakeStorage, lake: "in place" }
}

async function renewToken(production: ProductionConnection, sliceId: string) {
  const response = await fetch(new URL("api/branches/lake-token", apiBase(production.apiUrl)), {
    method: "POST",
    headers: {
      authorization: await production.authorization(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ sliceId }),
  })
  const body = (await response.json().catch(() => null)) as {
    token?: string
    expiresAt?: string
    error?: string
  } | null
  if (!response.ok || !body?.token || !body.expiresAt) {
    throw new Error(
      body?.error ??
        `[SixbCLI] Production refused a new lake token (${response.status}). Run \`sixb dev --from production --refresh\`.`
    )
  }
  return { value: body.token, expiresAt: Date.parse(body.expiresAt) }
}

async function dropBranch(
  storage: { dropBranchNamespace(name: string): Promise<void> },
  directory: string,
  index: BranchIndex,
  name: string,
  production: ProductionConnection
): Promise<void> {
  await storage.dropBranchNamespace(name)
  await rm(join(directory, name), { recursive: true, force: true })

  const sliceId = index[name]?.lake?.sliceId
  delete index[name]
  await writeIndex(directory, index)
  // Production keeps a slice two weeks unless told: say it is no longer read.
  if (sliceId) await deleteSlice(production, sliceId).catch(() => undefined)
}

async function deleteSlice(production: ProductionConnection, sliceId: string): Promise<void> {
  await fetch(
    new URL(`api/branches/slices/${encodeURIComponent(sliceId)}`, apiBase(production.apiUrl)),
    {
      method: "DELETE",
      headers: { authorization: await production.authorization() },
    }
  )
}

async function readIndex(directory: string): Promise<BranchIndex> {
  const text = await readFile(join(directory, "index.json"), "utf8").catch(() => null)
  return text ? (JSON.parse(text) as BranchIndex) : {}
}

async function writeIndex(directory: string, index: BranchIndex): Promise<void> {
  await writeFile(join(directory, "index.json"), `${JSON.stringify(index, null, 2)}\n`)
}

function apiBase(apiUrl: string): string {
  return apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`
}

/** The checked-out git branch: the branch's name, and its namespace's. */
export async function currentGitBranch(projectRoot: string): Promise<string> {
  const branch = (await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  if (!branch || branch === "HEAD") {
    throw new Error(
      "[SixbCLI] `sixb dev --from production` runs a git branch: check one out (a detached HEAD has no name)."
    )
  }
  return branch
}

/** Every local git branch: a namespace whose branch is not among them is dropped. */
export async function localGitBranches(projectRoot: string): Promise<readonly string[]> {
  const output = await git(projectRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
  return output.split("\n").filter((line) => line.length > 0)
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => process.kill(), 10_000)
  try {
    const [output, error, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (code !== 0) {
      throw new Error(`[SixbCLI] git ${args.join(" ")} failed: ${error.trim() || `exit ${code}`}`)
    }
    return output
  } finally {
    clearTimeout(timer)
  }
}

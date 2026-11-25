import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type BranchRuntime, hostOnBranch, readBranchCopy } from "@sixb/core/internal/branches"
import { branchNamespaces, importSnapshot } from "@sixb/core/internal/snapshots"
import type { LakeStorage } from "@sixb/core/lake-storage"
import { type BranchNamespace, migrateStorage } from "@sixb/core/storage"
import type { LoadedSixbHost } from "./loadSixb"

// `sixb dev --from production` in two steps, so the process that runs the branch's code never
// holds the developer's production session:
//
// 1. The supervisor, signed in as the developer, asks production for a copy when the branch needs
//    one (`fetchBranchCopy`) and writes it to a file, whole or not at all. Production's read closes
//    as fast as it exports, whatever the load costs after.
// 2. The process that runs the branch (`branchFromProduction`) loads that file into the git
//    branch's namespace, or reuses the namespace. It reaches production only with the branch's own
//    credential, which reads its objects' files and its lake slice, and nothing else.

/** Production as the supervisor reaches it: the developer's own CLI sign-in. */
export interface ProductionConnection {
  readonly apiUrl: string
  /** The `Authorization` header of the developer's CLI session in production. */
  authorization(): Promise<string>
}

/** What the CLI keeps of each branch's copy, next to its data. */
interface BranchRecord {
  readonly gitBranch: string
  readonly takenAt: string
  readonly userId: string
  /** Production's API, and the CLI profile the copy was taken with. */
  readonly apiUrl: string
  readonly profile: string
  /** The branch's own credential in production. */
  readonly credential?: string
  readonly lake?: { readonly sliceId: string; readonly point: string }
}

type BranchIndex = Record<string, BranchRecord>

/** A copy fetched by the supervisor and not loaded yet. */
interface PendingCopy {
  readonly gitBranch: string
  readonly apiUrl: string
  readonly profile: string
}

export interface FetchBranchCopyInput {
  readonly projectRoot: string
  readonly gitBranch: string
  /** Take a new copy, discarding what the branch wrote to the last one. */
  readonly refresh?: boolean
  /** The CLI profile the developer is signed in with, read without the network. */
  readonly profile: string
  /** Signs in to production: called only when a copy is needed. */
  readonly connect: () => Promise<ProductionConnection>
}

/**
 * The supervisor's step: fetch a copy when the git branch has none, or when asked to refresh.
 * Reusing a copy needs no network, and refuses one taken under another CLI profile.
 */
export async function fetchBranchCopy(input: FetchBranchCopyInput): Promise<boolean> {
  const directory = branchesDirectory(input.projectRoot)
  await mkdir(directory, { recursive: true })
  const name = await namespaceOf(input.projectRoot, input.gitBranch)
  const record = (await readIndex(directory))[name]

  if (record && !input.refresh) {
    if (record.profile !== input.profile) {
      throw new Error(
        `[SixbCLI] This branch's copy was taken as ${record.profile}, and you are signed in as ${input.profile}. Run \`sixb dev --from production --refresh\` to take your own.`
      )
    }
    return false
  }

  const production = await input.connect()
  const response = await fetch(new URL("api/branches/copy", apiBase(production.apiUrl)), {
    method: "POST",
    headers: {
      authorization: await production.authorization(),
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

  // Whole or not at all: a copy cut short never becomes the branch's.
  const spool = join(directory, `${name}.copy`)
  const partial = `${spool}.${randomUUID()}.partial`
  try {
    await Bun.write(partial, response)
    await chmod(partial, 0o600)
    await rename(partial, spool)
  } finally {
    await rm(partial, { force: true })
  }
  const pending: PendingCopy = {
    gitBranch: input.gitBranch,
    apiUrl: production.apiUrl,
    profile: input.profile,
  }
  await writeFile(`${spool}.json`, JSON.stringify(pending))
  return true
}

export interface BranchFromProductionInput {
  /** The project's host, loaded as the branch: its gates are on, its providers the project's. */
  readonly host: LoadedSixbHost
  readonly projectRoot: string
  /** The branch this process runs as, and every local git branch. */
  readonly gitBranch: string
  readonly gitBranches: readonly string[]
}

export interface BranchFromProduction {
  /** The project's host on the branch's own data. */
  readonly host: LoadedSixbHost
  readonly namespace: string
  /** Whether this run loaded a new copy; otherwise it reused the last one. */
  readonly copied: boolean
  /** When production's data was copied. */
  readonly takenAt: string
  /** Git branches whose copies were dropped because they are gone. */
  readonly dropped: readonly string[]
  /** What production's datasets give the branch, or why they give it nothing. */
  readonly lake: "in place" | string
}

/**
 * The branch's step: load the copy the supervisor fetched into the git branch's namespace of the
 * project's local storage, or reuse it. A namespace whose git branch is gone is dropped first.
 * Only namespaces this checkout made are ever dropped: the index lists them.
 */
export async function branchFromProduction(
  input: BranchFromProductionInput
): Promise<BranchFromProduction> {
  // A storage that cannot keep the branch apart is refused: the copy is real data.
  const storage = branchNamespaces(input.host.storage)
  const directory = branchesDirectory(input.projectRoot)
  await mkdir(directory, { recursive: true })
  const index = await readIndex(directory)
  const name = await namespaceOf(input.projectRoot, input.gitBranch)

  const dropped: string[] = []
  for (const [existing, record] of Object.entries(index)) {
    if (input.gitBranches.includes(record.gitBranch)) continue
    await dropBranch(storage, directory, index, existing)
    dropped.push(record.gitBranch)
  }

  const spool = join(directory, `${name}.copy`)
  const fetched = await stat(spool).then(
    () => true,
    () => false
  )
  if (fetched) {
    if (index[name] || (await storage.openBranchNamespace(name))) {
      await dropBranch(storage, directory, index, name)
    }
    await loadCopy({ host: input.host, storage, directory, index, name, spool })
  }

  const namespace = await storage.openBranchNamespace(name)
  const record = index[name]
  if (!namespace || !record) {
    throw new Error(
      `[SixbCLI] Branch ${input.gitBranch} has no copy here. Run \`sixb dev --from production\`.`
    )
  }

  const { lakeStorage, lake } = branchLake(input.host, directory, name, record)
  const credential = record.credential
  const runtime: BranchRuntime = {
    person: { userId: record.userId },
    // Production as the branch reaches it: its credential, never the developer's session.
    production: {
      url: record.apiUrl,
      authorization: async () => (credential ? `Bearer ${credential}` : ""),
    },
    takenAt: record.takenAt,
  }
  const host = hostOnBranch(input.host, {
    storage: namespace,
    ...(lakeStorage ? { lakeStorage } : {}),
    runtime,
  }) as LoadedSixbHost

  return { host, namespace: name, copied: fetched, takenAt: record.takenAt, dropped, lake }
}

/**
 * The namespace of a git branch in this checkout: lowercase, digits and dashes, at most 40
 * characters. The hash covers the checkout too, so two checkouts sharing a database never meet.
 */
export function namespaceFor(gitBranch: string, checkout: string): string {
  const slug = gitBranch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31)
  const hash = createHash("sha256").update(`${checkout}\0${gitBranch}`).digest("hex").slice(0, 8)
  return slug ? `${slug}-${hash}` : hash
}

/** This checkout's namespace for a git branch. */
export async function namespaceOf(projectRoot: string, gitBranch: string): Promise<string> {
  const directory = branchesDirectory(projectRoot)
  await mkdir(directory, { recursive: true })
  const file = join(directory, "checkout")
  let checkout = (await readFile(file, "utf8").catch(() => "")).trim()
  if (!checkout) {
    checkout = randomUUID()
    await writeFile(file, `${checkout}\n`)
  }
  return namespaceFor(gitBranch, checkout)
}

async function loadCopy(input: {
  readonly host: LoadedSixbHost
  readonly storage: { createBranchNamespace(name: string): Promise<BranchNamespace> } & {
    dropBranchNamespace(name: string): Promise<void>
  }
  readonly directory: string
  readonly index: BranchIndex
  readonly name: string
  readonly spool: string
}): Promise<void> {
  const pending = JSON.parse(await readFile(`${input.spool}.json`, "utf8")) as PendingCopy
  const namespace = await input.storage.createBranchNamespace(input.name)
  const copy = readBranchCopy(
    Bun.file(input.spool).stream() as unknown as AsyncIterable<Uint8Array>
  )

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
      gitBranch: pending.gitBranch,
      takenAt: report.takenAt,
      userId: report.takenBy.id,
      apiUrl: pending.apiUrl,
      profile: pending.profile,
      ...(rest
        ? {
            credential: rest.lake.credential,
            lake: { sliceId: rest.lake.sliceId, point: rest.lake.point },
          }
        : {}),
    }
    await writeIndex(input.directory, input.index)
  } catch (error) {
    // Nothing of a failed copy is kept, here or in production.
    await input.storage.dropBranchNamespace(input.name).catch(() => undefined)
    const rest = await copy.rest().catch(() => null)
    if (rest) {
      await deleteSlice(pending.apiUrl, rest.lake.credential, rest.lake.sliceId).catch(
        () => undefined
      )
    }
    throw error
  } finally {
    await rm(input.spool, { force: true })
    await rm(`${input.spool}.json`, { force: true })
  }
}

/** Production's datasets on the branch, read in place, when the project's lake can be branched. */
function branchLake(
  host: LoadedSixbHost,
  directory: string,
  name: string,
  record: BranchRecord
): { readonly lakeStorage?: LakeStorage; readonly lake: string } {
  const credential = record.credential
  if (!record.lake || !credential) {
    return { lake: "production's lake cannot be branched: no dataset is copied" }
  }

  const openBranch = host.lakeStorage.openBranch
  if (!openBranch) {
    return {
      lake: "the project's local lake cannot read production's datasets in place: use DuckLake",
    }
  }

  const sliceId = record.lake.sliceId
  let token: { value: string; expiresAt: number } | undefined
  const lakeStorage = openBranch.call(host.lakeStorage, {
    catalogPath: join(directory, name, "lake.ducklake"),
    dataPath: join(directory, name, "lake"),
    productionFiles: {
      url: new URL("api/lake/slice-files/", apiBase(record.apiUrl)).toString(),
      // Production renews the slice's token for its person while they still read every version.
      token: async () => {
        if (token && token.expiresAt - Date.now() > 60_000) return token.value
        const renewed = await renewToken(record.apiUrl, credential, sliceId)
        token = renewed
        return renewed.value
      },
      cacheDirectory: join(directory, name, "lake-cache"),
    },
  })
  return { lakeStorage, lake: "in place" }
}

async function renewToken(apiUrl: string, credential: string, sliceId: string) {
  const response = await fetch(new URL("api/branches/lake-token", apiBase(apiUrl)), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
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
  name: string
): Promise<void> {
  await storage.dropBranchNamespace(name)
  await rm(join(directory, name), { recursive: true, force: true })

  const record = index[name]
  delete index[name]
  await writeIndex(directory, index)
  // Production keeps a slice two weeks unless told: say it is no longer read.
  if (record?.credential && record.lake) {
    await deleteSlice(record.apiUrl, record.credential, record.lake.sliceId).catch(() => undefined)
  }
}

async function deleteSlice(apiUrl: string, credential: string, sliceId: string): Promise<void> {
  await fetch(new URL(`api/branches/slices/${encodeURIComponent(sliceId)}`, apiBase(apiUrl)), {
    method: "DELETE",
    headers: { authorization: `Bearer ${credential}` },
  })
}

function branchesDirectory(projectRoot: string): string {
  return join(projectRoot, ".sixb", "branches")
}

async function readIndex(directory: string): Promise<BranchIndex> {
  const text = await readFile(join(directory, "index.json"), "utf8").catch(() => null)
  return text ? (JSON.parse(text) as BranchIndex) : {}
}

/** The index holds each branch's credential: readable by its owner only. */
async function writeIndex(directory: string, index: BranchIndex): Promise<void> {
  const file = join(directory, "index.json")
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
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

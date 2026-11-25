import { createHash, randomBytes, randomUUID } from "node:crypto"
import { resolveAuthorizationContext } from "../authorization/resolve"
import { createPrincipalRequestScope } from "../execution/scopes"
import type { ExecutionScope } from "../execution/types"
import type { LakeFile, LakeForks, LakeSliceVersion } from "../lake-storage/forks"
import type { DatasetVersionRef, LakeStorage } from "../lake-storage/types"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import type { SecurityDefinitionCatalog } from "../security/registry"
import type { LakeSliceRecord, LakeSliceStorage, Storage } from "../storage"
import type { DatasetDefinition } from "./types"

/**
 * A branch reads production's datasets in place: production cuts a slice of its lake's catalog
 * for the person who opens the branch, and serves the files of that slice to a short-lived token.
 *
 * The slice holds a dataset only when that person reads it in full: the `dataset.view` grant, and
 * clearance for every column of the version, as `sixb.datasets.readRows` decides it. A dataset
 * they may view but not read in full is skipped and reported; one they may not view is not
 * mentioned at all. Taking the slice and every token re-check that, so a person who loses access
 * stops reading at the latest when their token expires.
 */

/** Path prefix of the production route that serves a slice's files. */
export const LAKE_SLICE_FILES_ROUTE_PREFIX = "/api/lake/slice-files/"

/**
 * How long a slice stays live after its last token expired (or after it was cut, with none): as
 * long as a branch may go unopened. Production keeps its versions and its files that long.
 */
export const LAKE_SLICE_KEEP_MS = 14 * 24 * 60 * 60_000

/**
 * How long a branch's copy may go unconfirmed: long enough to stream and spool the largest copy.
 * Past it, the slice of a copy its branch never confirmed holding is no longer live.
 */
export const UNRECEIVED_COPY_LIVES_MS = 60 * 60_000

/** Whether a slice is a branch's copy that its branch never confirmed, and its grace is over. */
export function isUnreceivedCopy(slice: LakeSliceRecord, now = new Date()): boolean {
  return (
    slice.credentialHash !== undefined &&
    slice.receivedAt === undefined &&
    slice.createdAt.getTime() + UNRECEIVED_COPY_LIVES_MS <= now.getTime()
  )
}

const DEFAULT_TOKEN_EXPIRY_MS = 15 * 60_000
const LONGEST_TOKEN_EXPIRY_MS = 24 * 60 * 60_000
/** 32 random bytes in base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** What a branch's lake holds of production's, for the person who opened it. */
export interface LakeSlice {
  /** The slice's record, which its tokens are issued for. */
  readonly id: string
  /** The point in the lake's history the slice was cut at. */
  readonly point: string
  /** Each dataset its person reads in full, at its version as of the point. */
  readonly versions: readonly DatasetVersionRef[]
  /** Datasets its person may view but not read in full: the branch holds none of their rows. */
  readonly skipped: readonly LakeSliceSkip[]
}

export interface LakeSliceSkip {
  readonly datasetId: string
  readonly reason: "missing_clearance"
  /** The columns its person has no clearance for. */
  readonly columns: readonly string[]
}

export interface LakeSliceToken {
  readonly token: string
  readonly expiresAt: Date
}

export interface WriteLakeSliceOptions {
  readonly point: string
  /** A local file the slice's catalog is written to. */
  readonly path: string
  /** The branch the slice is for. */
  readonly branch: string
  /**
   * Versions to hold instead of a dataset's latest at the point, one per dataset, such as the one
   * a projection applied to the objects the branch copied: the branch's projection then continues
   * from it.
   */
  readonly pinned?: readonly DatasetVersionRef[]
  /** SHA-256 of the branch's credential, recorded with the slice it reads production for. */
  readonly credentialHash?: string
}

export interface IssueLakeSliceTokenInput {
  /** The slice, as `writeLakeSlice` returned it. */
  readonly sliceId: string
  /** Defaults to 15 minutes. At most a day. */
  readonly expiresInMs?: number
}

export type LakeSliceFileResult =
  | { readonly kind: "file"; readonly file: LakeFile }
  /** The token is unknown or expired: the branch asks for a new one. */
  | { readonly kind: "unauthorized" }
  /** No file of the slice has this path. */
  | { readonly kind: "not_found" }
  /** This production cannot serve branches: its providers lack what it takes. */
  | { readonly kind: "unavailable"; readonly message: string }

/** What production's side of a branch reads. */
export interface LakeSliceHost {
  readonly id: string
  readonly lakeStorage: Pick<LakeStorage, "forks" | "fork">
  readonly storage: Pick<Storage, "lakeSlices">
}

/** What production needs to act for a person outside their own request. */
export interface LakeSliceRenewalHost extends LakeSliceHost {
  readonly storage: Pick<Storage, "lakeSlices" | "auth">
  readonly definitions: { readonly security: Pick<SecurityDefinitionCatalog, "listResolvedRoles"> }
  withScope(scope: ExecutionScope): object
}

/** The person a slice is cut for, as their own request sees production. */
export type LakeSliceReader = Pick<Sixb, "datasets" | "execution">

/**
 * The lake's position now. Take it right after the snapshot of the objects began: every dataset
 * version an object was derived from is then at or before it.
 */
export async function currentLakePoint(host: LakeSliceHost): Promise<string> {
  return requireForks(host).currentPoint()
}

/**
 * Cuts the slice of what `reader` reads in full at `point`, writes its catalog to the local file
 * `path`, and records it. The record, with the exact files the slice serves, is written before
 * the cut writes any of them: production's retention holds those files, and keeps the copies,
 * from that moment. A cut that fails leaves no record.
 */
export async function writeLakeSlice(
  host: LakeSliceHost,
  reader: LakeSliceReader,
  input: WriteLakeSliceOptions
): Promise<LakeSlice> {
  const forks = requireForks(host)
  const slices = requireSlices(host)
  const userId = requirePerson(reader, "cut a lake slice")
  if (input.branch.trim().length === 0) {
    throw new Error("[Sixb] A lake slice needs the name of the branch it is for.")
  }

  // Only what the person may view: the provider never resolves anything else.
  const datasets = reader.datasets.list()
  const versions = await forks.versionsAt({
    point: input.point,
    datasetIds: datasets.map((dataset) => dataset.id),
  })

  const pinned = pinnedVersions(input.pinned ?? [], datasets)
  const held: LakeSliceVersion[] = []
  const skipped: LakeSliceSkip[] = []
  for (const dataset of datasets) {
    const pin = pinned.get(dataset.id)
    const version =
      pin === undefined ? versions.get(dataset.id) : await reader.datasets.getVersion(dataset, pin)

    if (pin !== undefined && !version) {
      throw new Error(
        `[Sixb] The slice pins version '${pin}' of '${dataset.id}', which no longer exists. Take the version the projection applies now.`
      )
    }
    if (!version) continue

    const hidden = await hiddenColumns(reader, dataset, version.versionId)
    if (hidden === null) continue

    if (hidden.length > 0) {
      skipped.push({ datasetId: dataset.id, reason: "missing_clearance", columns: hidden })
      continue
    }

    const visible = await reader.datasets.getVersion(dataset, version.versionId)
    held.push({
      datasetId: dataset.id,
      versionId: version.versionId,
      ...(visible?.producer === undefined ? {} : { producer: visible.producer }),
    })
  }

  const id = `lakeslice_${randomUUID()}`
  const refs = held.map(({ datasetId, versionId }) => ({ datasetId, versionId }))
  let recorded = false
  try {
    await forks.writeSlice({
      point: input.point,
      versions: held,
      path: input.path,
      record: async (files) => {
        await slices.create({
          id,
          projectId: host.id,
          userId,
          branch: input.branch,
          ...(input.credentialHash ? { credentialHash: input.credentialHash } : {}),
          point: input.point,
          versions: refs,
          files: [...files],
          createdAt: new Date(),
        })
        recorded = true
      },
    })
  } catch (error) {
    if (recorded) await slices.delete({ projectId: host.id, id })
    throw error
  }

  return { id, point: input.point, versions: refs, skipped }
}

/**
 * Issues a token that reads the files of a slice `reader` cut. Each call checks again that they
 * read every version of it in full, so a branch keeps reading only while its person could.
 */
export async function issueLakeSliceToken(
  host: LakeSliceHost,
  reader: LakeSliceReader,
  input: IssueLakeSliceTokenInput
): Promise<LakeSliceToken> {
  requireForks(host)
  const slices = requireSlices(host)
  const userId = requirePerson(reader, "read production's lake from a branch")

  const slice = await slices.get({ projectId: host.id, id: input.sliceId })
  if (!slice || slice.userId !== userId) {
    throw new Error(`[Sixb] '${userId}' has no lake slice '${input.sliceId}'. Take a new slice.`)
  }

  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + tokenExpiry(input.expiresInMs))

  for (const { datasetId, versionId } of slice.versions) {
    const dataset = reader.datasets.getById(datasetId)
    const hidden = dataset ? await hiddenColumns(reader, dataset, versionId) : null
    if (hidden === null || hidden.length > 0) {
      throw new Error(
        `[Sixb] '${userId}' can no longer read version '${versionId}' of dataset '${datasetId}' in full. Take a new slice for the branch.`
      )
    }
  }

  const token = randomBytes(32).toString("base64url")
  await slices.createGrant({
    id: `lakeslicegrant_${randomUUID()}`,
    projectId: host.id,
    tokenHash: hashToken(token),
    sliceId: slice.id,
    createdAt,
    expiresAt,
  })

  return { token, expiresAt }
}

/**
 * Issues a new token for a slice whose person is not making a request, such as production
 * renewing the token of a branch it hosts. It reads production as that person does now, from
 * their membership and the project's roles, and checks their access as `issueLakeSliceToken` does.
 */
export async function renewLakeSliceToken(
  host: LakeSliceRenewalHost,
  input: IssueLakeSliceTokenInput
): Promise<LakeSliceToken> {
  const slice = await requireSlices(host).get({ projectId: host.id, id: input.sliceId })
  if (!slice) throw new Error(`[Sixb] There is no lake slice '${input.sliceId}'. Take a new slice.`)
  return issueLakeSliceToken(host, await readerFor(host, slice.userId), input)
}

/** The file a token may read at `path`, if any: one its slice recorded serving. */
export async function openLakeSliceFile(
  host: LakeSliceHost,
  input: { readonly token: string; readonly path: string }
): Promise<LakeSliceFileResult> {
  const forks = host.lakeStorage.forks
  const slices = host.storage.lakeSlices
  if (!forks) return { kind: "unavailable", message: NO_FORKS }
  if (!slices) return { kind: "unavailable", message: NO_SLICES }
  if (!TOKEN_PATTERN.test(input.token)) return { kind: "unauthorized" }

  const grant = await slices.findGrantByTokenHash({
    projectId: host.id,
    tokenHash: hashToken(input.token),
  })
  if (!grant || grant.expiresAt.getTime() <= Date.now()) return { kind: "unauthorized" }

  const files = await sliceFiles(slices, host.id, grant.sliceId)
  if (!files.has(input.path)) return { kind: "not_found" }

  const file = await forks.openFile(input.path)
  return file ? { kind: "file", file } : { kind: "not_found" }
}

/**
 * The slices a branch may still open: cut, or holding a token, less than `LAKE_SLICE_KEEP_MS`
 * ago, less a copy no branch confirmed. Production's retention keeps their versions and files.
 */
export async function liveLakeSlices(
  host: Pick<LakeSliceHost, "id" | "storage">
): Promise<readonly LakeSliceRecord[]> {
  const now = new Date()
  const live =
    (await host.storage.lakeSlices?.listLive({
      projectId: host.id,
      liveAfter: new Date(now.getTime() - LAKE_SLICE_KEEP_MS),
    })) ?? []
  return live.filter((slice) => !isUnreceivedCopy(slice, now))
}

/** Deletes the files production made for slices no branch may still open. Returns how many. */
export async function releaseLakeSliceFiles(host: LakeSliceHost): Promise<number> {
  const forks = host.lakeStorage.forks
  // A branch's lake cuts no slice: it has no file made for one, and production's are not its own.
  if (!forks || host.lakeStorage.fork || !host.storage.lakeSlices) return 0

  const live = await liveLakeSlices(host)
  return forks.releaseFiles({ liveSlices: live.map((slice) => slice.files) })
}

/** One version per dataset the reader views: a slice holds a single version of each. */
function pinnedVersions(
  pins: readonly DatasetVersionRef[],
  datasets: readonly { readonly id: string }[]
): ReadonlyMap<string, string> {
  const pinned = new Map<string, string>()
  for (const { datasetId, versionId } of pins) {
    const earlier = pinned.get(datasetId)
    if (earlier !== undefined && earlier !== versionId) {
      throw new Error(
        `[Sixb] The slice pins '${datasetId}' at both '${earlier}' and '${versionId}'. A slice holds one version of each dataset: pin one.`
      )
    }
    if (!datasets.some((dataset) => dataset.id === datasetId)) {
      throw new Error(
        `[Sixb] The slice pins '${datasetId}', which is not a dataset its person reads. Pin only the datasets they view.`
      )
    }
    pinned.set(datasetId, versionId)
  }

  return pinned
}

/**
 * Deletes a slice and its tokens, such as one whose branch was never made: its versions and files
 * are released by the next retention pass instead of two weeks later. Deleting a missing slice
 * does nothing.
 */
export async function dropLakeSlice(host: LakeSliceHost, sliceId: string): Promise<void> {
  await requireSlices(host).delete({ projectId: host.id, id: sliceId })
}

/**
 * Whether the person reads a version of a dataset in full, as a slice decides it: a snapshot
 * takes a projection's source over only then.
 */
export async function readsVersionInFull(
  reader: LakeSliceReader,
  datasetId: string,
  versionId: string
): Promise<boolean> {
  const dataset = reader.datasets.list().find((candidate) => candidate.id === datasetId)
  if (!dataset) return false

  const hidden = await hiddenColumns(reader, dataset, versionId)
  return hidden !== null && hidden.length === 0
}

/**
 * The columns of a version its reader cannot read, or null when the version does not exist.
 * This is the reader's own `readRows`, so a slice never decides access otherwise than a read; it
 * reads no row, since its rows are never iterated.
 */
async function hiddenColumns(
  reader: LakeSliceReader,
  dataset: DatasetDefinition,
  versionId: string
): Promise<readonly string[] | null> {
  const read = await reader.datasets.readRows(dataset, { versionId, limit: 0 })
  return read ? Object.keys(read.redactions ?? {}) : null
}

/** Production as a person reads it now, outside any request of theirs. */
async function readerFor(host: LakeSliceRenewalHost, userId: string): Promise<LakeSliceReader> {
  const auth = host.storage.auth
  if (!auth) {
    throw new Error(
      "[Sixb] Renewing a branch's lake token reads production's members from storage.auth."
    )
  }

  const user = await auth.users.getById({ projectId: host.id, id: userId })
  if (!user || user.status !== "active") {
    throw new Error(
      `[Sixb] '${userId}' is no longer an active member: the branch reads nothing more.`
    )
  }

  const memberships = await auth.groupMemberships.listForUser({ projectId: host.id, userId })
  const scope = createPrincipalRequestScope({
    projectId: host.id,
    requestId: `lake_slice_renewal_${randomUUID()}`,
    correlationId: `lake_slice_renewal_${randomUUID()}`,
    context: resolveAuthorizationContext({
      principal: { type: "user", id: userId },
      groupIds: memberships.map((membership) => membership.groupId),
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })

  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) throw new Error("[Sixb] The host did not return an execution-bound Sixb.")
  return sixb
}

// A slice's files never change, and every request of a scan asks for them: kept for the last
// slices asked about.
const LISTED_SLICES_KEPT = 64
const listedFiles = new WeakMap<LakeSliceStorage, Map<string, Promise<ReadonlySet<string>>>>()

function sliceFiles(
  slices: LakeSliceStorage,
  projectId: string,
  sliceId: string
): Promise<ReadonlySet<string>> {
  let listed = listedFiles.get(slices)
  if (!listed) {
    listed = new Map()
    listedFiles.set(slices, listed)
  }

  const cached = listed.get(sliceId)
  if (cached) return cached

  const files = slices
    .get({ projectId, id: sliceId })
    .then((slice): ReadonlySet<string> => new Set(slice?.files ?? []))
  listed.set(sliceId, files)
  files.catch(() => listed.delete(sliceId))
  if (listed.size > LISTED_SLICES_KEPT) listed.delete(listed.keys().next().value as string)
  return files
}

const NO_FORKS =
  "[Sixb] This lake provider cannot be read from a branch. Use @sixb/ducklake for production's lake."
const NO_SLICES =
  "[Sixb] A branch reads production's lake through slices kept in storage.lakeSlices, which this storage does not provide. Use @sixb/pg or @sixb/sqlite."

function requireForks(host: LakeSliceHost): LakeForks {
  if (!host.lakeStorage.forks) throw new Error(NO_FORKS)
  return host.lakeStorage.forks
}

function requireSlices(host: Pick<LakeSliceHost, "storage">): LakeSliceStorage {
  if (!host.storage.lakeSlices) throw new Error(NO_SLICES)
  return host.storage.lakeSlices
}

function requirePerson(reader: LakeSliceReader, purpose: string): string {
  const { executor, requestedBy } = reader.execution
  if (executor.type !== "request" || requestedBy?.type !== "user") {
    throw new Error(`[Sixb] Only a person's own request can ${purpose}.`)
  }
  return requestedBy.id
}

function tokenExpiry(expiresInMs: number | undefined): number {
  const value = expiresInMs ?? DEFAULT_TOKEN_EXPIRY_MS
  if (!Number.isSafeInteger(value) || value <= 0 || value > LONGEST_TOKEN_EXPIRY_MS) {
    throw new Error("[Sixb] A lake slice token lasts a positive whole number of ms, at most a day.")
  }
  return value
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

import {
  currentLakePoint,
  dropLakeSlice,
  issueLakeSliceToken,
  type LakeSlice,
  type LakeSliceHost,
  type LakeSliceReader,
  type LakeSliceToken,
  readsVersionInFull,
  writeLakeSlice,
} from "../datasets/lake-slices"
import {
  type AuthorizedObjectReader,
  createAuthorizedObjectReader,
  objectReadersIn,
  type ReaderSnapshotScope,
  readerSnapshotScope,
  readSnapshotPage,
  type SnapshotPage,
} from "../execution/authorized-object-reader"
import type { ExecutionScope } from "../execution/types"
import type { DatasetVersionRef } from "../lake-storage/types"
import type { OntologyObjectRef } from "../materialization/model"
import { vectorConfiguration, vectorSources } from "../objects/vectors/profile"
import { OntologyRegistry } from "../ontology"
import type { ObjectType } from "../ontology/types"
import type { UserRef } from "../ontology/user-ref"
import type { ProjectionDefinitionCatalog } from "../projections"
import type { SixbHostView } from "../runtime/host"
import { isBoundSixb } from "../runtime/sixb"
import type { AppliedMarkings } from "../security/applied-markings"
import { appliedSourcesKey } from "../security/applied-markings"
import { getAppliedMarkings } from "../security/applied-markings-host"
import type { UserRecord } from "../storage/auth"
import type { LakeSliceCredentialMinter } from "../storage/lake-slices"
import type { ObjectRow } from "../storage/objects/types"
import type { ActiveOntologySource } from "../storage/ontology"
import {
  isSnapshotReadStorage,
  type SnapshotLinkEditRow,
  type SnapshotRange,
  type SnapshotReadStorage,
  type SnapshotReadView,
} from "../storage/snapshots"
import type { Storage } from "../storage/types"
import { typeDefinitionManifest } from "./definitions"
import {
  encodeSnapshotFrame,
  jsonOf,
  jsonRecordOf,
  SNAPSHOT_FORMAT,
  SNAPSHOT_SIGNATURE,
  type SnapshotCounts,
  SnapshotFrameTooLarge,
  type SnapshotManifest,
  type SnapshotMembers,
  type SnapshotPoints,
  type SnapshotProjection,
  type SnapshotRecord,
  type SnapshotSourceVersion,
  type SnapshotTypeManifest,
  type SnapshotVectors,
  toColumns,
} from "./format"

/** The production runtime a snapshot reads from. */
export interface SnapshotSource {
  readonly projectId: string
  readonly storage: Storage
  readonly ontology: OntologyRegistry
  readonly appliedMarkings?: AppliedMarkings
  readonly projections?: ProjectionDefinitionCatalog
  /** Production's lake, for a snapshot that cuts a branch's lake slice of the same moment. */
  readonly lake?: SnapshotLakeSource
}

export interface SnapshotLakeSource {
  readonly host: LakeSliceHost
  /** Production as the person reads it: what of the lake they read in full. */
  readonly readerFor: (scope: ExecutionScope) => LakeSliceReader
}

/**
 * The lake slice a branch reads production's datasets through. Its point is taken inside the
 * snapshot's read, so the objects and the datasets describe the same moment.
 */
export interface SnapshotLakeOptions {
  /** A local file the slice's catalog is written to. */
  readonly path: string
  /** The branch the slice is for. */
  readonly branch: string
  /** SHA-256 of the branch's credential, which reads production for this slice only. */
  readonly credentialHash?: string
  /** The groups the credential reads with at most. */
  readonly credentialGroupIds?: readonly string[]
  /** What the person signed in with, which the credential dies with. */
  readonly credentialMintedBy?: LakeSliceCredentialMinter
  /** Receives the slice and its first token, before the snapshot's end record. */
  readonly onSlice: (slice: SnapshotLakeSlice) => void | Promise<void>
}

export interface SnapshotLakeSlice {
  readonly slice: LakeSlice
  readonly token: LakeSliceToken
}

export interface ExportSnapshotOptions {
  /** The person the snapshot is taken as: what it holds is what this scope's reader reads. */
  readonly scope: ExecutionScope
  /** How many object types are read at once, each on its own connection. Defaults to 4. */
  readonly concurrency?: number
  /** How long production keeps the consistent read open. Defaults to 30 minutes. */
  readonly maxDurationMs?: number
  /**
   * The vector configurations the target accepts. Omitted, every vector is exported and the
   * importer keeps those matching its own; empty, none is.
   */
  readonly vectorConfigurations?: readonly string[]
  /** Compress each frame with zstd. Defaults to true; a sink on the same host may skip it. */
  readonly compress?: boolean
  /** Objects per page and frame. Defaults to 2,000. */
  readonly pageSize?: number
  /** Cut the branch's lake slice at S too. The snapshot fails when the slice does. */
  readonly lake?: SnapshotLakeOptions
}

const DEFAULT_CONCURRENCY = 4
const DEFAULT_MAX_DURATION_MS = 30 * 60_000
const DEFAULT_PAGE_SIZE = 2_000
const MAX_PAGE_SIZE = 10_000
const MEMBER_PAGE_SIZE = 1_000

export function hostSnapshotSource(host: SixbHostView): SnapshotSource {
  const ontology = host.definitions.ontology
  if (!(ontology instanceof OntologyRegistry)) {
    throw new Error("[Sixb] A snapshot reads a host built from an ontology registry.")
  }

  return {
    projectId: host.projectId,
    storage: host.storage,
    ontology,
    appliedMarkings: getAppliedMarkings(host),
    projections: host.definitions.projections,
    lake: {
      host: { id: host.id, lakeStorage: host.lakeStorage, storage: host.storage },
      readerFor: (scope) => {
        const sixb = host.withScope(scope)
        if (!isBoundSixb(sixb)) {
          throw new Error("[Sixb] The host did not return an execution-bound Sixb.")
        }
        return sixb
      },
    },
  }
}

/**
 * Production's objects, links, latest telemetry and members as one person reads them, at one
 * moment: the snapshot's bytes, ready for a file or for {@link importSnapshot}.
 *
 * Nothing the person cannot read is in it. Every type is read through the person's object reader,
 * so its grants, view conditions and clearance apply as they do to any of their reads. History,
 * runs, threads, activity, sessions, tokens and connections are never read.
 */
export async function* exportSnapshot(
  source: SnapshotSource,
  options: ExportSnapshotOptions
): AsyncGenerator<Uint8Array> {
  const settings = exportSettings(options)
  const frames = new FrameQueue(settings.concurrency * 2)

  const written = writeSnapshot(source, options.scope, settings, frames).then(
    () => frames.close(),
    (error: unknown) => frames.fail(error)
  )

  try {
    yield SNAPSHOT_SIGNATURE
    yield* frames
  } finally {
    frames.abandon()
    await written
  }
}

interface ExportSettings {
  readonly concurrency: number
  readonly maxDurationMs: number
  readonly pageSize: number
  readonly compress: boolean
  readonly vectorConfigurations?: ReadonlySet<string>
  readonly lake?: SnapshotLakeOptions
}

function exportSettings(options: ExportSnapshotOptions): ExportSettings {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE

  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("[Sixb] Snapshot concurrency must be an integer from 1 to 32.")
  }
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) {
    throw new Error("[Sixb] Snapshot maxDurationMs must be a positive integer.")
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`[Sixb] Snapshot pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}.`)
  }

  return {
    concurrency,
    maxDurationMs,
    pageSize,
    compress: options.compress ?? true,
    ...(options.lake === undefined ? {} : { lake: options.lake }),
    ...(options.vectorConfigurations === undefined
      ? {}
      : { vectorConfigurations: new Set(options.vectorConfigurations) }),
  }
}

async function writeSnapshot(
  source: SnapshotSource,
  executionScope: ExecutionScope,
  settings: ExportSettings,
  frames: FrameQueue
): Promise<void> {
  if (!isSnapshotReadStorage(source.storage)) {
    throw new Error(
      "[Sixb] This storage provider cannot take a snapshot: it has no consistent read. Use PostgreSQL, SQLite or in-memory storage."
    )
  }

  // Applied markings can lag the versions projections applied by a few seconds. The clearance is
  // pinned to the versions it was built from, and the read at S checks them: when a projection
  // applied a version in between, the clearance is resolved again and the read taken again.
  for (let attempt = 1; ; attempt += 1) {
    const taken = await takeSnapshot(source, executionScope, settings, frames)
    if (taken) return

    if (attempt === APPLIED_MARKINGS_ATTEMPTS) {
      throw new Error(
        "[Sixb] Projections kept applying new dataset versions while the snapshot started: take it again once they settle."
      )
    }
  }
}

/** One attempt; false when the applied markings moved between the clearance and S. */
async function takeSnapshot(
  source: SnapshotSource,
  executionScope: ExecutionScope,
  settings: ExportSettings,
  frames: FrameQueue
): Promise<boolean> {
  const storage = source.storage as SnapshotReadStorage
  const applied = source.appliedMarkings
  applied?.invalidate()
  await applied?.current()
  const pinnedSources = applied?.appliedSources?.()

  // Resolving the reader's clearance may read storage, which the snapshot's views must not wait
  // on: it is pinned here, and every view's reader, the scope's included, keeps it.
  const readersIn = await objectReadersIn(
    createAuthorizedObjectReader({
      scope: executionScope,
      ontology: source.ontology,
      objectStorage: storage.objects,
      ...(source.appliedMarkings === undefined ? {} : { appliedMarkings: source.appliedMarkings }),
    })
  )
  const scope = await readerSnapshotScope(readersIn(storage.objects))
  const user = scope.user
  if (!user) throw new Error("[Sixb] A snapshot is taken as a user: sign in as one.")

  const lake = settings.lake ? { source: lakeSourceOf(source), options: settings.lake } : undefined
  let slicing: Promise<SnapshotLakeSlice> | undefined

  const counts = {
    objects: 0,
    links: 0,
    points: 0,
    vectors: 0,
    users: 0,
    sourceRoots: 0,
    edits: 0,
  }
  const encode = (record: SnapshotRecord) =>
    encodeSnapshotFrame(record, { compress: settings.compress })
  const pushFrame = (frame: Uint8Array) => frames.push(frame)
  const push = async (record: SnapshotRecord) => pushFrame(await encode(record))

  const read = storage.readSnapshot(
    { views: settings.concurrency, maxDurationMs: settings.maxDurationMs },
    (views) =>
      withinDuration(
        settings.maxDurationMs,
        (reason) => frames.stopProducers(reason),
        async (stop) => {
          const takenAt = new Date().toISOString()
          const [first] = views
          if (!first) throw new Error("[Sixb] The storage gave a snapshot no view to read it with.")

          const active = await first.storage.ontology.sources.listActive({
            projectId: source.projectId,
          })
          if (
            pinnedSources !== undefined &&
            appliedSourcesKey(active, declaredProjectionIds(source)) !== pinnedSources
          ) {
            return false
          }

          // Every version an object was derived from was committed before the read began, so the
          // lake's point taken now is at or after it: the slice and the objects agree.
          const point = lake ? await currentLakePoint(lake.source.host) : undefined
          const sources = await travellingSources({
            source,
            view: first,
            scope,
            active,
            ...(lake && point !== undefined
              ? { reader: lake.source.readerFor(executionScope) }
              : {}),
          })
          if (lake && point !== undefined) {
            const pinned = [...sources.values()].flatMap((travel) =>
              travel.kind === "source" ? [travel.pin] : []
            )
            slicing = cutLakeSlice(lake.source, lake.options, executionScope, point, pinned)
            slicing.catch((error: unknown) => stop.abort(error))
          }

          const manifest = snapshotManifest(source, { ...scope, user }, active, settings, sources)
          await push({
            ...manifest,
            takenAt,
            ...(point === undefined ? {} : { lake: { catalogVersion: point } }),
          })

          const members = await readMembers(source.projectId, first, scope)
          counts.users = members.users.length
          await push(members)

          const tasks: ExportTask[] = [
            ...(await exportTasks(source, manifest.types, first, views.length, settings)),
            ...sourceTasks(manifest.types),
          ]
          const travelling = new Set(
            manifest.types.flatMap((type) => (type.projection?.source ? [type.objectTypeId] : []))
          )
          // Every view settles before the provider ends the read, the failed ones included.
          const settled = await Promise.allSettled(
            views.map(async (view) => {
              const typeReader = readersIn(view.storage.objects)
              const work = { source, view, settings, encode, pushFrame, counts, stop: stop.signal }
              try {
                for (let task = tasks.shift(); task; task = tasks.shift()) {
                  if (task.part === "sourceRoots") await exportSourceRoots({ ...work, ...task })
                  else if (task.part === "objectEdits") {
                    await exportObjectEdits({ ...work, ...task })
                  } else if (task.part === "linkEdits") {
                    await exportLinkEdits({ ...work, ...task }, scope, typeReader, travelling)
                  } else {
                    await exportType({ ...work, ...task }, (input) =>
                      readSnapshotPage(typeReader, input)
                    )
                  }
                }
              } catch (error) {
                // A failed reader stops the others before their next page.
                stop.abort(error)
                throw error
              }
            })
          )
          const failed = settled.find((result) => result.status === "rejected")
          if (failed) throw failed.reason

          if (slicing && lake) await lake.options.onSlice(await slicing)
          await push({ kind: "end", counts })
          return true
        }
      )
  )

  try {
    return await read
  } catch (error) {
    // A snapshot that fails leaves no slice: its record would hold production's files for weeks.
    const cut = await slicing?.catch(() => undefined)
    if (cut && lake) await dropLakeSlice(lake.source.host, cut.slice.id)
    throw error
  }
}

const APPLIED_MARKINGS_ATTEMPTS = 3

function lakeSourceOf(source: SnapshotSource): SnapshotLakeSource {
  if (!source.lake) {
    throw new Error("[Sixb] This snapshot source has no lake: a branch's slice is cut from a host.")
  }
  return source.lake
}

/** The person's slice at the snapshot's point, and the first token a branch reads it with. */
async function cutLakeSlice(
  lake: SnapshotLakeSource,
  options: SnapshotLakeOptions,
  scope: ExecutionScope,
  point: string,
  pinned: readonly DatasetVersionRef[]
): Promise<SnapshotLakeSlice> {
  const reader = lake.readerFor(scope)
  const slice = await writeLakeSlice(lake.host, reader, {
    point,
    path: options.path,
    branch: options.branch,
    ...(options.credentialHash ? { credentialHash: options.credentialHash } : {}),
    ...(options.credentialGroupIds ? { credentialGroupIds: options.credentialGroupIds } : {}),
    ...(options.credentialMintedBy ? { credentialMintedBy: options.credentialMintedBy } : {}),
    ...(pinned.length === 0 ? {} : { pinned }),
  })

  // A cut that fails after its slice is written deletes it: no one could read it, and it would
  // hold production's files for two weeks.
  try {
    // A projection's source travels only with the version it applied, which the branch reads.
    for (const pin of pinned) {
      const held = slice.versions.some(
        (version) => version.datasetId === pin.datasetId && version.versionId === pin.versionId
      )
      if (!held) {
        throw new Error(
          `[Sixb] The person no longer reads '${pin.datasetId}' in full at the version its projection applied. Take the snapshot again.`
        )
      }
    }

    const token = await issueLakeSliceToken(lake.host, reader, { sliceId: slice.id })
    return { slice, token }
  } catch (error) {
    await dropLakeSlice(lake.host, slice.id)
    throw error
  }
}

/** How a type a projection feeds travels: as its source, or as created objects, and why. */
type SourceTravel =
  | {
      readonly kind: "source"
      readonly projectionId: string
      readonly version: SnapshotSourceVersion
      readonly pin: DatasetVersionRef
    }
  | { readonly kind: "objects"; readonly reason: string }

/**
 * Which types a projection feeds travel as its source: those a branch's projection can continue.
 * The branch reads the dataset in place at the version production applied, which the person
 * reads in full; the person reads every object and property of the type, so the edits over it
 * hide nothing; and the storage reads sources. Anything else travels as created objects.
 */
async function travellingSources(input: {
  readonly source: SnapshotSource
  readonly view: SnapshotReadView
  readonly scope: ReaderSnapshotScope
  readonly active: readonly ActiveOntologySource[]
  readonly reader?: LakeSliceReader
}): Promise<ReadonlyMap<string, SourceTravel>> {
  const { source, view, scope, reader } = input
  const travels = new Map<string, SourceTravel>()
  const definitions = source.projections?.listObjects() ?? []
  const applied = new Map(input.active.map((entry) => [entry.source.projectionId, entry]))
  // Links a link projection feeds have no edit that makes them: their source does not travel, so
  // the branch could not tell them from the type's own. Such a type travels as created objects.
  const linkSources = new Set(
    (source.projections?.listLinks() ?? []).map((definition) => definition.sourceObjectTypeId)
  )

  // A slice holds one version of a dataset: projections that applied two of one go as objects.
  const versionsByDataset = new Map<string, Set<string>>()
  for (const definition of definitions) {
    const version = applied.get(definition.id)?.datasetVersion.versionId
    if (version === undefined) continue
    const versions = versionsByDataset.get(definition.datasetId) ?? new Set<string>()
    versionsByDataset.set(definition.datasetId, versions.add(version))
  }

  for (const definition of definitions) {
    const access = scope.types.get(definition.objectTypeId)
    if (!access) continue

    const objects = (reason: string) =>
      travels.set(definition.objectTypeId, { kind: "objects", reason })
    const version = applied.get(definition.id)

    if (!reader) objects("the branch does not read production's datasets in place")
    else if (!version) objects(NOT_APPLIED)
    else if (linkSources.has(definition.objectTypeId)) {
      objects("a link projection feeds links from it, and its source does not travel")
    } else if (access.throughCondition || access.hiddenPropertyIds.length > 0) {
      objects("the person does not read every object and property of the type")
    } else if ((versionsByDataset.get(definition.datasetId)?.size ?? 0) > 1) {
      objects("its dataset feeds projections that applied different versions of it")
    } else if (
      !(await readsVersionInFull(reader, definition.datasetId, version.datasetVersion.versionId))
    ) {
      objects("the person does not read its dataset in full")
    } else {
      const record = await view.storage.ontology.sources.getActive({
        projectId: source.projectId,
        source: { projectionId: definition.id },
      })
      if (!record) objects(NOT_APPLIED)
      else {
        travels.set(definition.objectTypeId, {
          kind: "source",
          projectionId: definition.id,
          version: {
            datasetVersion: record.datasetVersion,
            projectionRevision: record.projectionRevision,
            ownershipHash: record.ownershipHash,
            ontologyRevision: record.ontologyRevision,
          },
          pin: { datasetId: definition.datasetId, versionId: record.datasetVersion.versionId },
        })
      }
    }
  }

  return travels
}

const NOT_APPLIED = "its projection has not applied a version yet"

/** A type that travels as its source sends its roots and its edits after its objects. */
function sourceTasks(types: readonly SnapshotTypeManifest[]): ExportTask[] {
  return types.flatMap((type) =>
    type.projection?.source
      ? [
          { type, range: {}, part: "sourceRoots" as const },
          { type, range: {}, part: "objectEdits" as const },
          { type, range: {}, part: "linkEdits" as const },
        ]
      : []
  )
}

/** Every live root of the type's source, a page a frame. */
async function exportSourceRoots(work: TypeExport): Promise<void> {
  const projectionId = work.type.projection?.projectionId
  if (projectionId === undefined) return

  for (let after: string | undefined; ; ) {
    work.stop.throwIfAborted()
    const roots = await work.view.readSourceRoots({
      projectId: work.source.projectId,
      projectionId,
      limit: work.settings.pageSize,
      ...(after === undefined ? {} : { afterRootKey: after }),
    })
    if (roots.length === 0) return

    await pushInHalves(work, roots, (part) => ({
      kind: "sourceRoots",
      projectionId,
      roots: part.map((root) => [root.root, root.assertions]),
    }))
    work.counts.sourceRoots += roots.length
    after = roots.at(-1)?.rootKey
  }
}

/** The edits over the type's objects, a page a frame, in primary id order. */
async function exportObjectEdits(work: TypeExport): Promise<void> {
  const objectTypeId = work.type.objectTypeId

  for (let after: string | undefined; ; ) {
    work.stop.throwIfAborted()
    const edits = await work.view.readObjectEdits({
      projectId: work.source.projectId,
      objectTypeId,
      limit: work.settings.pageSize,
      ...(after === undefined ? {} : { afterPrimaryId: after }),
    })
    if (edits.length === 0) return

    await pushInHalves(work, edits, (part) => ({
      kind: "edits",
      objectTypeId,
      objects: part.map((edit) => [
        edit.ref.primaryId,
        edit.value,
        edit.editedAt ?? null,
        Date.parse(edit.updatedAt),
      ]),
      links: [],
      slots: [],
    }))
    work.counts.edits += edits.length
    after = edits.at(-1)?.ref.primaryId
  }
}

/**
 * The edits over links from the type's objects, a page a frame. An edit leaves only as the link it
 * edits would: the person reads links of its definition, and the object it reaches. That object
 * was exported, or its type travels as its source, whose roots hold even the objects an edit
 * deleted. A cleared slot's anchor is such an object too, or the clear stays in production.
 */
async function exportLinkEdits(
  work: TypeExport,
  scope: ReaderSnapshotScope,
  reader: AuthorizedObjectReader,
  travelling: ReadonlySet<string>
): Promise<void> {
  const sourceTypeId = work.type.objectTypeId

  for (let after: string | undefined; ; ) {
    work.stop.throwIfAborted()
    const page = await work.view.readLinkEdits({
      projectId: work.source.projectId,
      sourceTypeId,
      limit: work.settings.pageSize,
      ...(after === undefined ? {} : { afterKey: after }),
    })
    if (page.length === 0) return
    after = page.at(-1)?.key

    const targetOf = (edit: SnapshotLinkEditRow) =>
      edit.kind === "edge" ? edit.ref.target : edit.value.target
    const linkOf = (edit: SnapshotLinkEditRow) =>
      edit.kind === "edge" ? edit.ref.linkId : edit.linkId
    const readable = page.filter((edit) =>
      scope.readsLink(sourceTypeId, linkOf(edit), targetOf(edit).objectTypeId)
    )
    const reached = await reachedTargets(
      reader,
      readable.map(targetOf).filter((target) => !travelling.has(target.objectTypeId))
    )
    const kept = readable.filter((edit) => {
      const target = targetOf(edit)
      return travelling.has(target.objectTypeId) || reached.has(objectKey(target))
    })
    if (kept.length === 0) continue

    await pushInHalves(work, kept, (part) => ({
      kind: "edits",
      objectTypeId: sourceTypeId,
      objects: [],
      links: part.flatMap((edit) =>
        edit.kind === "edge" ? [[edit.ref, edit.value, Date.parse(edit.updatedAt)] as const] : []
      ),
      slots: part.flatMap((edit) =>
        edit.kind === "slot"
          ? [[edit.source.primaryId, edit.linkId, edit.value, Date.parse(edit.updatedAt)] as const]
          : []
      ),
    }))
    work.counts.edits += kept.length
  }
}

/** The objects among these the reader reads at the snapshot's moment. */
async function reachedTargets(
  reader: AuthorizedObjectReader,
  targets: readonly OntologyObjectRef[]
): Promise<ReadonlySet<string>> {
  if (targets.length === 0) return new Set()

  const rows = await reader.getByPrimaryIdBatch({ items: targets })
  return new Set([...rows.values()].map((row) => objectKey(row)))
}

function objectKey(ref: { readonly objectTypeId: string; readonly primaryId: string }): string {
  return JSON.stringify([ref.objectTypeId, ref.primaryId])
}

/** Encode rows as one record, or in halves when they pass a frame's limit. */
async function pushInHalves<T>(
  work: TypeExport,
  rows: readonly T[],
  record: (rows: readonly T[]) => SnapshotRecord
): Promise<void> {
  try {
    await work.pushFrame(await work.encode(record(rows)))
  } catch (error) {
    if (!(error instanceof SnapshotFrameTooLarge) || rows.length < 2) throw error
    const middle = Math.ceil(rows.length / 2)
    await pushInHalves(work, rows.slice(0, middle), record)
    await pushInHalves(work, rows.slice(middle), record)
  }
}

function declaredProjectionIds(source: SnapshotSource): readonly string[] {
  return [
    ...(source.projections?.listObjects() ?? []),
    ...(source.projections?.listLinks() ?? []),
  ].map((projection) => projection.id)
}

/**
 * The pages to read: each type, a large one split into ranges of primary ids that several views
 * share, those first. A type seen through a condition stays whole: a range ends on an object,
 * which the reader must see.
 */
async function exportTasks(
  source: SnapshotSource,
  types: readonly SnapshotTypeManifest[],
  view: SnapshotReadView,
  views: number,
  settings: ExportSettings
): Promise<ExportTask[]> {
  const split: ExportTask[] = []
  const whole: ExportTask[] = []

  for (const type of types) {
    const ranges =
      views > 1 && view.readRanges && !type.throughCondition
        ? await view.readRanges({
            projectId: source.projectId,
            objectTypeId: type.objectTypeId,
            parts: views,
            minObjects: settings.pageSize * 4,
          })
        : []

    if (ranges.length > 1) split.push(...ranges.map((range) => ({ type, range })))
    else whole.push({ type, range: {} })
  }

  return [...split, ...whole]
}

/**
 * Bound how long production keeps the read open, whatever holds it: a slow consumer or a slow
 * read. Past the bound the readers stop: those waiting on the consumer are woken, the others stop
 * before their next page. Only once every view has settled does the provider close its read.
 */
async function withinDuration<T>(
  maxDurationMs: number,
  onStop: (reason: unknown) => void,
  run: (stop: AbortController) => Promise<T>
): Promise<T> {
  const stop = new AbortController()
  stop.signal.addEventListener("abort", () => onStop(stop.signal.reason), { once: true })
  const timer = setTimeout(
    () =>
      stop.abort(
        new Error(
          `[Sixb] The snapshot was still being read after ${maxDurationMs} ms, so production ended it. Take it again where it is read faster, or raise maxDurationMs.`
        )
      ),
    maxDurationMs
  )

  try {
    return await run(stop)
  } catch (error) {
    throw stop.signal.aborted ? stop.signal.reason : error
  } finally {
    clearTimeout(timer)
  }
}

function snapshotManifest(
  source: SnapshotSource,
  scope: ReaderSnapshotScope & { readonly user: UserRef },
  active: readonly ActiveOntologySource[],
  settings: ExportSettings,
  sources: ReadonlyMap<string, SourceTravel>
): Omit<SnapshotManifest, "takenAt"> {
  const projections = projectionsByType(source, active, scope.canViewDataset, sources)

  const types: SnapshotTypeManifest[] = []
  const unreadableTypeIds: string[] = []

  for (const objectType of source.ontology.listObjectTypes()) {
    const access = scope.types.get(objectType.id)
    if (!access) {
      unreadableTypeIds.push(objectType.id)
      continue
    }

    const projection = projections.get(objectType.id)
    types.push({
      objectTypeId: objectType.id,
      ...typeDefinitionManifest(objectType, source.ontology),
      hiddenPropertyIds: access.hiddenPropertyIds,
      throughCondition: access.throughCondition,
      vectors: exportedVectorProfiles(objectType, access.hiddenPropertyIds, settings),
      ...(projection === undefined ? {} : { projection }),
    })
  }

  return {
    kind: "manifest",
    format: SNAPSHOT_FORMAT,
    projectId: source.projectId,
    takenBy: scope.user,
    members: scope.canViewUsers ? "all" : "self",
    types: types.sort((left, right) => compare(left.objectTypeId, right.objectTypeId)),
    unreadableTypeIds: unreadableTypeIds.sort(compare),
  }
}

/**
 * The projection feeding each type, with the version production applied. A type fed by a
 * projection is exported as objects; the version lets a branch that reads the dataset in place
 * take its rows over later.
 */
function projectionsByType(
  source: SnapshotSource,
  active: readonly ActiveOntologySource[],
  canViewDataset: (datasetId: string) => boolean,
  sources: ReadonlyMap<string, SourceTravel>
): ReadonlyMap<string, SnapshotProjection> {
  const definitions = source.projections?.listObjects() ?? []
  if (definitions.length === 0) return new Map()

  const applied = new Map(active.map((entry) => [entry.source.projectionId, entry]))

  return new Map(
    definitions.map((definition) => {
      const version = applied.get(definition.id)
      const travel = sources.get(definition.objectTypeId)
      return [
        definition.objectTypeId,
        {
          projectionId: definition.id,
          datasetId: definition.datasetId,
          datasetView: canViewDataset(definition.datasetId),
          ...(version
            ? {
                applied: {
                  datasetVersionId: version.datasetVersion.versionId,
                  projectionRevision: version.projectionRevision,
                },
              }
            : {}),
          ...(travel?.kind === "source" ? { source: travel.version } : {}),
          ...(travel?.kind === "objects" ? { notReprojectable: travel.reason } : {}),
        },
      ]
    })
  )
}

/**
 * The vector profiles whose values may leave: a vector is computed from its sources, so one that
 * reads a property the person cannot read stays in production.
 */
function exportedVectorProfiles(
  objectType: ObjectType,
  hiddenPropertyIds: readonly string[],
  settings: ExportSettings
): SnapshotTypeManifest["vectors"] {
  const profiles = Object.entries(objectType.search?.vectors ?? {})

  return profiles.flatMap(([profile, definition]) => {
    const configuration = vectorConfiguration(definition)
    const accepted = settings.vectorConfigurations?.has(configuration) ?? true
    const readable = definition.source.every(
      (propertyId) => !hiddenPropertyIds.includes(propertyId)
    )

    return accepted && readable ? [{ profile, configuration }] : []
  })
}

/**
 * The members the person may see: everyone and every group with `can.view(project.users)`,
 * otherwise only the person and their own groups.
 */
async function readMembers(
  projectId: string,
  view: SnapshotReadView,
  scope: ReaderSnapshotScope
): Promise<SnapshotMembers> {
  const auth = view.storage.auth
  if (!auth || !scope.user) return { kind: "members", users: [], memberships: [] }

  const users: UserRecord[] = []
  if (scope.canViewUsers) {
    for (let offset = 0, more = true; more; offset += MEMBER_PAGE_SIZE) {
      const page = await auth.users.list({ projectId, limit: MEMBER_PAGE_SIZE, offset })
      users.push(...page.users)
      more = page.hasMore
    }
  } else {
    const self = await auth.users.getById({ projectId, id: scope.user.id })
    if (self) users.push(self)
  }

  const userIds = new Set(users.map((user) => user.id))
  const memberships = (await view.readMemberships({ projectId })).filter((membership) =>
    userIds.has(membership.userId)
  )

  return {
    kind: "members",
    users: users.map((user) => [
      user.id,
      user.email,
      user.displayName ?? null,
      user.avatarUrl ?? null,
      user.status,
      user.createdAt.getTime(),
      user.updatedAt.getTime(),
    ]),
    memberships: memberships.map((membership) => [
      membership.userId,
      membership.groupId,
      membership.source,
      membership.createdAt.getTime(),
    ]),
  }
}

interface TypeExport {
  readonly source: SnapshotSource
  readonly view: SnapshotReadView
  readonly type: SnapshotTypeManifest
  readonly settings: ExportSettings
  readonly encode: (record: SnapshotRecord) => Promise<Uint8Array>
  readonly pushFrame: (frame: Uint8Array) => Promise<void>
  readonly counts: { -readonly [K in keyof SnapshotCounts]: SnapshotCounts[K] }
  readonly stop: AbortSignal
  readonly range: SnapshotRange
}

interface ExportTask {
  readonly type: SnapshotTypeManifest
  readonly range: SnapshotRange
  /** What of the type the task sends: its objects by default. */
  readonly part?: "sourceRoots" | "objectEdits" | "linkEdits"
}

/** What one page reads from storage: its objects and links, their latest points, their vectors. */
interface PageRead {
  readonly page: SnapshotPage
  readonly points: SnapshotPoints | undefined
  readonly vectors: readonly SnapshotVectors[]
}

/**
 * Every page of one type, the next one read while the current one is written. A page's reads run
 * one after the other on the view's connection, never beside another page's.
 */
async function exportType(
  work: TypeExport,
  readPage: (input: {
    objectTypeId: string
    limit: number
    pageToken?: string
  }) => Promise<SnapshotPage>
): Promise<void> {
  const { type, settings } = work
  const objectTypeId = type.objectTypeId

  const read = (pageToken?: string) => {
    work.stop.throwIfAborted()
    const reads = (async (): Promise<PageRead> => {
      const page = endRange(
        await readPage({
          objectTypeId,
          limit: settings.pageSize,
          ...(pageToken ? { pageToken } : {}),
        }),
        work.range
      )
      const points = await readPoints(work, page.objects)
      const vectors = await readVectors(work, page.objects)
      return { page, points, vectors }
    })()

    // Read ahead: it is awaited on the next turn, or abandoned when this page fails.
    reads.catch(() => undefined)
    return reads
  }

  for (let next: Promise<PageRead> | undefined = read(work.range.startToken); next; ) {
    const current: PageRead = await next
    const token = current.page.nextPageToken
    next = token === undefined ? undefined : read(token)

    if (current.page.objects.length > 0) await exportPage(work, current)
  }
}

/**
 * A range ends with the object it names last, which the next range starts after: the page that
 * holds it keeps the objects up to it and their links, and reads no further.
 */
function endRange(page: SnapshotPage, range: SnapshotRange): SnapshotPage {
  const last = range.lastPrimaryId
  if (last === undefined) return page

  const index = page.objects.findIndex((row) => row.primaryId === last)
  if (index === -1) return page

  const objects = page.objects.slice(0, index + 1)
  const kept = new Set(objects.map((row) => row.primaryId))
  return { objects, links: page.links.filter((link) => kept.has(link.sourceId)) }
}

/**
 * Write one page's records. They are encoded before any is written, so a page too large for one
 * frame is split in halves, objects with their links, points and vectors, without duplicates.
 */
async function exportPage(work: TypeExport, read: PageRead): Promise<void> {
  const { type, counts } = work
  const { page, points, vectors } = read
  const objects = page.objects

  const records: SnapshotRecord[] = [
    {
      kind: "objects",
      objectTypeId: type.objectTypeId,
      ids: objects.map((row) => row.primaryId),
      createdAt: objects.map((row) => row.createdAt.getTime()),
      updatedAt: objects.map((row) => row.updatedAt.getTime()),
      columns: toColumns(objects.map((row) => row.properties)),
    },
  ]
  if (page.links.length > 0) {
    records.push({
      kind: "links",
      sourceTypeId: type.objectTypeId,
      rows: page.links.map((link) => [
        link.sourceId,
        link.linkId,
        link.targetTypeId,
        link.targetId,
        link.createdAt.getTime(),
        link.updatedAt.getTime(),
        link.properties === undefined ? null : jsonRecordOf(link.properties),
      ]),
    })
  }
  if (points) records.push(points)
  records.push(...vectors)

  let frames: Uint8Array[]
  try {
    frames = await Promise.all(records.map((record) => work.encode(record)))
  } catch (error) {
    if (!(error instanceof SnapshotFrameTooLarge) || objects.length < 2) throw error
    for (const half of halves(read)) await exportPage(work, half)
    return
  }

  for (const frame of frames) await work.pushFrame(frame)
  counts.objects += objects.length
  counts.links += page.links.length
  counts.points += points?.rows.length ?? 0
  counts.vectors += vectors.reduce((total, record) => total + record.ids.length, 0)
}

/** A page's two halves, each with the links, points and vectors of its objects. */
function halves(read: PageRead): readonly PageRead[] {
  const middle = Math.ceil(read.page.objects.length / 2)

  return [read.page.objects.slice(0, middle), read.page.objects.slice(middle)].map((objects) => {
    const ids = new Set(objects.map((row) => row.primaryId))
    const points = read.points && {
      ...read.points,
      rows: read.points.rows.filter(([objectId]) => ids.has(objectId)),
    }

    return {
      page: { objects, links: read.page.links.filter((link) => ids.has(link.sourceId)) },
      points: points && points.rows.length > 0 ? points : undefined,
      vectors: read.vectors.flatMap((record) => {
        const kept = record.ids.flatMap((id, index) => (ids.has(id) ? [index] : []))
        if (kept.length === 0) return []

        const bytes = Buffer.from(record.values, "base64")
        const size = record.dimensions * 4
        return [
          {
            ...record,
            ids: kept.map((index) => record.ids[index]!),
            sourceFingerprints: kept.map((index) => record.sourceFingerprints[index]!),
            values: Buffer.concat(
              kept.map((index) => bytes.subarray(index * size, (index + 1) * size))
            ).toString("base64"),
          },
        ]
      }),
    }
  })
}

/** The latest point of each telemetry property the person reads on these objects. */
async function readPoints(
  work: TypeExport,
  objects: readonly ObjectRow[]
): Promise<SnapshotPoints | undefined> {
  const { source, type, view } = work
  const objectType = source.ontology.resolveObjectType(type.objectTypeId)
  const telemetry = objectType.properties.filter((property) => property.mode === "telemetry")
  if (telemetry.length === 0) return undefined

  // A row holds a telemetry value exactly when the person reads it and a point exists.
  const visible = new Set(
    objects.flatMap((row) =>
      telemetry
        .filter((property) => row.properties[property.id] !== undefined)
        .map((property) => `${property.id}\u0000${row.primaryId}`)
    )
  )
  if (visible.size === 0) return undefined

  const latest = await view.readLatestPoints({
    projectId: source.projectId,
    objectTypeId: type.objectTypeId,
    objectIds: objects.map((row) => row.primaryId),
    propertyIds: telemetry.map((property) => property.id),
  })
  const rows = latest
    .filter((point) => visible.has(`${point.propertyId}\u0000${point.objectId}`))
    .map(
      (point) =>
        [
          point.objectId,
          point.propertyId,
          jsonOf(point.value),
          point.unit ?? null,
          point.at.getTime(),
        ] as const
    )

  return rows.length > 0 ? { kind: "points", objectTypeId: type.objectTypeId, rows } : undefined
}

/** The vectors of these objects still computed from what each object holds now. */
async function readVectors(
  work: TypeExport,
  objects: readonly ObjectRow[]
): Promise<readonly SnapshotVectors[]> {
  const { source, type, view } = work
  if (type.vectors.length === 0 || objects.length === 0) return []

  const profiles = source.ontology.resolveObjectType(type.objectTypeId).search?.vectors ?? {}
  const stored = await view.readVectors({
    projectId: source.projectId,
    refs: objects.map((row) => ({ objectTypeId: row.objectTypeId, primaryId: row.primaryId })),
  })
  const rows = new Map(objects.map((row) => [row.primaryId, row]))
  const records: SnapshotVectors[] = []

  for (const { profile, configuration } of type.vectors) {
    const definition = profiles[profile]
    if (!definition) continue

    const dimensions = definition.model.definition.dimensions
    const kept = stored.filter((vector) => {
      const row = rows.get(vector.ref.primaryId)
      return (
        row !== undefined &&
        vector.profile === profile &&
        vector.configuration === configuration &&
        vector.values.length === dimensions &&
        vector.sourceFingerprint ===
          vectorSources(definition.source, row.properties).sourceFingerprint
      )
    })
    if (kept.length === 0) continue

    const values = new Float32Array(kept.length * dimensions)
    kept.forEach((vector, index) => {
      values.set(vector.values, index * dimensions)
    })

    records.push({
      kind: "vectors",
      objectTypeId: type.objectTypeId,
      profile,
      configuration,
      source: [...definition.source],
      dimensions,
      ids: kept.map((vector) => vector.ref.primaryId),
      sourceFingerprints: kept.map((vector) => vector.sourceFingerprint),
      values: Buffer.from(values.buffer).toString("base64"),
    })
  }

  return records
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Frames between the readers and whoever consumes the snapshot. It holds a few frames at most, so
 * a slow consumer slows the readers rather than filling memory; the duration cap then bounds how
 * long that keeps production's read open.
 */
class FrameQueue implements AsyncIterable<Uint8Array> {
  readonly #capacity: number
  readonly #frames: Uint8Array[] = []
  #wakeConsumer?: () => void
  #wakeProducers: (() => void)[] = []
  #closed = false
  #abandoned = false
  #stopped?: { readonly reason: unknown }
  #failure?: { readonly error: unknown }

  constructor(capacity: number) {
    this.#capacity = capacity
  }

  async push(frame: Uint8Array): Promise<void> {
    while (this.#frames.length >= this.#capacity && !this.#abandoned && !this.#stopped) {
      await new Promise<void>((resolve) => this.#wakeProducers.push(resolve))
    }
    if (this.#stopped) throw this.#stopped.reason
    if (this.#abandoned) throw new Error("[Sixb] The snapshot's consumer stopped reading it.")

    this.#frames.push(frame)
    this.#wake()
  }

  close(): void {
    this.#closed = true
    this.#wake()
  }

  fail(error: unknown): void {
    this.#failure = { error }
    this.#wake()
  }

  /** The read stopped: every producer waiting or pushing next fails, and unwinds. */
  stopProducers(reason: unknown): void {
    this.#stopped = { reason }
    for (const wake of this.#wakeProducers.splice(0)) wake()
  }

  /** The consumer stopped: every producer waiting or pushing next fails, and unwinds. */
  abandon(): void {
    this.#abandoned = true
    for (const wake of this.#wakeProducers.splice(0)) wake()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const frame = this.#frames.shift()
      if (frame) {
        this.#wakeProducers.shift()?.()
        yield frame
        continue
      }

      if (this.#failure) throw this.#failure.error
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#wakeConsumer = resolve
      })
    }
  }

  #wake(): void {
    const wake = this.#wakeConsumer
    this.#wakeConsumer = undefined
    wake?.()
  }
}

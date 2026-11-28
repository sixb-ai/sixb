import { SNAPSHOT_SKIP_KINDS } from "../../snapshots/format"
import type {
  BranchChanges,
  BranchCopySkipKind,
  BranchData,
  BranchError,
  BranchNotice,
  BranchRecord,
  BranchState,
  BranchWanted,
} from "./types"

const STATES: readonly BranchState[] = ["stopped", "copying", "starting", "ready", "failed"]
const WANTED: readonly BranchWanted[] = ["running", "stopped", "deleted"]

/** The branch with `changes` written over it, one revision on. */
export function applyBranchChanges(
  branch: BranchRecord,
  changes: BranchChanges,
  at: Date
): BranchRecord {
  return { ...branch, ...changes, updatedAt: at, revision: branch.revision + 1 }
}

/**
 * The stored form of everything but the identity and the revision, which providers keep as
 * columns: what `parseBranchRow` reads back.
 */
export function serializeBranch(branch: BranchRecord): string {
  const { projectId: _projectId, name: _name, revision: _revision, ...stored } = branch
  return JSON.stringify(stored)
}

/** Rebuilds a branch from a provider row: `record` arrives as text (SQLite) or parsed (jsonb). */
export function parseBranchRow(row: {
  readonly project_id: unknown
  readonly name: unknown
  readonly revision: unknown
  readonly record: unknown
}): BranchRecord {
  const name = String(row.name)
  const stored: unknown = typeof row.record === "string" ? JSON.parse(row.record) : row.record
  if (typeof stored !== "object" || stored === null) throw corrupt(name, "record is no object")

  const value = stored as Record<string, unknown>
  const state = value.state as BranchState
  const wanted = value.wanted as BranchWanted
  if (!STATES.includes(state)) throw corrupt(name, "state is unknown")
  if (!WANTED.includes(wanted)) throw corrupt(name, "wanted is unknown")

  return {
    projectId: String(row.project_id),
    name,
    namespace: String(value.namespace),
    wanted,
    state,
    createdBy: String(value.createdBy),
    key: String(value.key),
    port: typeof value.port === "number" ? value.port : null,
    sandbox: nullableString(value.sandbox),
    url: nullableString(value.url),
    generation: typeof value.generation === "number" ? value.generation : null,
    commit: nullableString(value.commit),
    error: parseError(value.error),
    data: parseData(value.data),
    refreshRequestedAt: nullableDate(value.refreshRequestedAt),
    remoteCommit: nullableString(value.remoteCommit),
    remoteError: nullableString(value.remoteError),
    notices: parseNotices(value.notices),
    owner: nullableString(value.owner),
    leaseExpiresAt: nullableDate(value.leaseExpiresAt),
    createdAt: new Date(String(value.createdAt)),
    updatedAt: new Date(String(value.updatedAt)),
    openedAt: new Date(String(value.openedAt)),
    lastSeenAt: new Date(String(value.lastSeenAt)),
    revision: Number(row.revision),
  }
}

function parseError(value: unknown): BranchError | null {
  if (typeof value !== "object" || value === null) return null

  const { message, file } = value as Record<string, unknown>
  return { message: String(message), ...(typeof file === "string" ? { file } : {}) }
}

const NOTICES: readonly BranchNotice["code"][] = [
  "data-reset",
  "no-dev-env",
  "machine-ended",
  "temp-files-uncapped",
  "database-limit",
  "database-closed",
]

function parseNotices(value: unknown): readonly BranchNotice[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    const { code, message } = (entry ?? {}) as Record<string, unknown>
    const known = NOTICES.find((candidate) => candidate === code)
    return known ? [{ code: known, message: String(message) }] : []
  })
}

function parseData(value: unknown): BranchData | null {
  if (typeof value !== "object" || value === null) return null

  const data = value as Record<string, unknown>
  const skippedDatasets = Array.isArray(data.skippedDatasets) ? data.skippedDatasets : []
  return {
    takenAt: new Date(String(data.takenAt)),
    objects: Number(data.objects),
    ...parseCopyTypes(data),
    skippedDatasets: skippedDatasets.map((entry) => {
      const skip = entry as Record<string, unknown>
      return {
        datasetId: String(skip.datasetId),
        reason: "missing_clearance" as const,
        columns: Array.isArray(skip.columns) ? skip.columns.map(String) : [],
      }
    }),
    lakeSliceId: nullableString(data.lakeSliceId),
  }
}

/**
 * What a copy says of its types, as a row or a runtime's status carries it. A field an earlier
 * copy lacks reads as empty, and a skip without its kind as one the branch's code doesn't fit.
 */
export function parseCopyTypes(
  data: Readonly<Record<string, unknown>>
): Pick<BranchData, "skipped" | "partial" | "refusedByDeploy" | "unchecked" | "migrated"> {
  const entries = (value: unknown) =>
    (Array.isArray(value) ? value : []).map((entry) => (entry ?? {}) as Record<string, unknown>)
  const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])

  return {
    skipped: entries(data.skipped).map((skip) => ({
      objectTypeId: String(skip.objectTypeId),
      kind: skipKind(skip),
      reason: String(skip.reason),
      findings: strings(skip.findings),
    })),
    partial: entries(data.partial).map((type) => ({
      objectTypeId: String(type.objectTypeId),
      hiddenPropertyIds: strings(type.hiddenPropertyIds),
      throughCondition: type.throughCondition === true,
    })),
    refusedByDeploy: entries(data.refusedByDeploy).map((type) => ({
      objectTypeId: String(type.objectTypeId),
      findings: strings(type.findings),
    })),
    unchecked: entries(data.unchecked).map((type) => ({
      objectTypeId: String(type.objectTypeId),
      lines: strings(type.lines),
    })),
    migrated: entries(data.migrated).map((type) => ({
      objectTypeId: String(type.objectTypeId),
      migrationIds: strings(type.migrationIds),
    })),
  }
}

/**
 * A skip's kind. A copy recorded before skips had one says it in its reason, in the words the
 * import used then; any other reason was a definition the copy no longer fit.
 */
function skipKind(skip: Readonly<Record<string, unknown>>): BranchCopySkipKind {
  const known = SNAPSHOT_SKIP_KINDS.find((kind) => kind === skip.kind)
  if (known) return known

  const reason = String(skip.reason)
  if (reason.startsWith("the person who took it")) return "unreadable"
  if (reason === "the branch no longer defines this type") return "removed"
  if (reason.startsWith("its primary property changed")) return "primary"
  return "unfit"
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function nullableDate(value: unknown): Date | null {
  return typeof value === "string" ? new Date(value) : null
}

function corrupt(name: string, reason: string): Error {
  return new Error(`[Sixb] Stored branch '${name}' is invalid: ${reason}.`)
}

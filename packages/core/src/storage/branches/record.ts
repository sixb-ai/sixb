import type {
  BranchChanges,
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
  const skipped = Array.isArray(data.skipped) ? data.skipped : []
  return {
    takenAt: new Date(String(data.takenAt)),
    objects: Number(data.objects),
    skipped: skipped.map((entry) => ({
      objectTypeId: String((entry as Record<string, unknown>).objectTypeId),
      reason: String((entry as Record<string, unknown>).reason),
    })),
    lakeSliceId: nullableString(data.lakeSliceId),
  }
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

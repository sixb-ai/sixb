import type { BranchChanges, BranchError, BranchRecord, BranchState } from "./types"

const STATES: readonly BranchState[] = ["stopped", "starting", "ready", "failed"]

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
  readonly projectId: unknown
  readonly name: unknown
  readonly revision: unknown
  readonly record: unknown
}): BranchRecord {
  const stored = (typeof row.record === "string" ? JSON.parse(row.record) : row.record) as Record<
    string,
    unknown
  >
  const name = String(row.name)
  if (typeof stored !== "object" || stored === null) throw corrupt(name, "record is no object")
  const state = stored.state as BranchState
  if (!STATES.includes(state)) throw corrupt(name, "state is unknown")
  if (stored.wanted !== "running" && stored.wanted !== "stopped") {
    throw corrupt(name, "wanted is unknown")
  }

  return {
    projectId: String(row.projectId),
    name,
    wanted: stored.wanted,
    state,
    key: String(stored.key),
    port: Number(stored.port),
    sandbox: nullableString(stored.sandbox),
    url: nullableString(stored.url),
    generation: typeof stored.generation === "number" ? stored.generation : null,
    commit: nullableString(stored.commit),
    manifest: nullableString(stored.manifest),
    error: parseError(stored.error),
    pushedAt: nullableDate(stored.pushedAt),
    pulledAt: nullableDate(stored.pulledAt),
    owner: nullableString(stored.owner),
    leaseExpiresAt: nullableDate(stored.leaseExpiresAt),
    createdBy: nullableString(stored.createdBy),
    createdAt: new Date(String(stored.createdAt)),
    updatedAt: new Date(String(stored.updatedAt)),
    lastSeenAt: new Date(String(stored.lastSeenAt)),
    revision: Number(row.revision),
  }
}

function parseError(value: unknown): BranchError | null {
  if (typeof value !== "object" || value === null) return null
  const { message, file } = value as Record<string, unknown>
  return { message: String(message), ...(typeof file === "string" ? { file } : {}) }
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

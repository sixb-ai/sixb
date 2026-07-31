import type { Storage } from "../types"

export interface MigrationStepInfo {
  readonly id: string
  readonly version: number
  readonly name: string
  readonly checksum?: string
}

/** One forward-only schema change owned by a durable adapter. */
export interface MigrationStep<TContext> extends MigrationStepInfo {
  up(context: TContext): void | Promise<void>
}

export interface MigrationStepOptions {
  readonly checksum?: string
}

export interface MigrationSet<TContext> {
  readonly adapterId: string
  readonly latestVersion: number
  readonly steps: readonly MigrationStep<TContext>[]
}

export interface DefineMigrationsOptions<TContext> {
  readonly adapterId: string
  readonly steps: readonly MigrationStep<TContext>[]
}

export interface MigrationRecord {
  readonly adapterId: string
  readonly version: number
  readonly id: string
  readonly checksum?: string
  readonly status: "started" | "applied"
  readonly startedAt: string
  readonly finishedAt?: string
}

export interface MigrationHistoryStore {
  ensure(): void | Promise<void>
  readHistory(adapterId: string): readonly MigrationRecord[] | Promise<readonly MigrationRecord[]>
  markStarted(adapterId: string, step: MigrationStepInfo, at: string): void | Promise<void>
  markApplied(adapterId: string, step: MigrationStepInfo, at: string): void | Promise<void>
  transaction<T>(run: () => Promise<T>): Promise<T>
}

export interface MigrationPlan<TContext> {
  readonly adapterId: string
  readonly latestVersion: number
  readonly applied: readonly MigrationRecord[]
  readonly pending: readonly MigrationStep<TContext>[]
}

export interface MigrationReport {
  readonly adapterId: string
  readonly latestVersion: number
  readonly status: "current" | "migrated"
  readonly applied: readonly string[]
  readonly skipped: readonly string[]
}

/**
 * Grouped by what an operator has to do about it: nothing (`current`), run
 * `sixb db migrate` (`uninitialized`, `pending`), or intervene by hand (the rest).
 *
 * Every state here is one `describeMigrationHistory` returns. There is no state for "the
 * history could not be read": an unreachable database, a missing grant or a corrupt
 * table all throw out of the read, and the probe reports the thrown reason. A state
 * nothing produces is a branch every caller writes and none of them exercises.
 */
export type MigrationState =
  /** Every known migration is applied. The only state a host should serve traffic in. */
  | "current"
  /** No migration history exists yet: an empty database, or one never migrated. */
  | "uninitialized"
  /** History is a valid prefix of this build's migrations, but incomplete. */
  | "pending"
  /** The database has versions this build does not know — usually an app rolled back without its schema. */
  | "ahead"
  /** A migration recorded a start and never an end. */
  | "dirty"
  /** History contradicts the declared migrations: changed checksum, mismatched id, duplicate version, foreign adapter. */
  | "incompatible"

interface MigrationStatusBase {
  readonly adapterId: string
  readonly latestVersion: number
  /** Highest applied version; 0 when no history exists. */
  readonly appliedVersion: number
}

/**
 * A state, and the reason for it when there is one to give.
 *
 * A union rather than an optional field: "absent only when `current`" was a comment enforced by
 * nothing, and the type accepted `current` with a reason and `dirty` without one. Every other
 * state exists because an operator has to act, so each owes them a sentence.
 */
export type MigrationStatus =
  | (MigrationStatusBase & { readonly state: "current"; readonly reason?: never })
  | (MigrationStatusBase & {
      readonly state: Exclude<MigrationState, "current">
      /** What an operator has to do about it. */
      readonly reason: string
    })

export interface StorageMigrator {
  readonly adapterId: string
  readonly latestVersion: number

  /**
   * Reports the schema state without touching it.
   *
   * Strictly read-only, unlike `migrate()`, which calls `ensure()` first: on Postgres
   * that runs `CREATE SCHEMA`/`CREATE TABLE` and on SQLite it creates the database file.
   * That is correct on the way to a migration and wrong for a probe — `/ready` is public
   * and unauthenticated, and a least-privilege deployment has no DDL grant to spend on a
   * health check.
   *
   * Reports the dangerous states (`ahead`, `dirty`) instead of throwing, because a
   * probe that throws tells an operator less than one that names the condition.
   */
  status(): Promise<MigrationStatus>

  migrate(): Promise<MigrationReport>
}

/** Optional storage capability for startup/CLI-driven schema migration. */
export interface MigrationCapableStorage extends Storage {
  readonly migrators: readonly StorageMigrator[]
}

export interface StorageMigrationResult {
  readonly status: "migrated" | "current" | "skipped"
  readonly reports: readonly MigrationReport[]
}

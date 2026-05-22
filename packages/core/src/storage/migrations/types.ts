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

export interface StorageMigrator {
  readonly adapterId: string
  readonly latestVersion: number
  plan(): Promise<MigrationPlan<unknown>>
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

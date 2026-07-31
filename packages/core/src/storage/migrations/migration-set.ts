import type {
  DefineMigrationsOptions,
  MigrationHistoryStore,
  MigrationPlan,
  MigrationRecord,
  MigrationReport,
  MigrationSet,
  MigrationStatus,
  MigrationStep,
  MigrationStepOptions,
} from "./types"

export interface PlanMigrationSetParams<TContext> {
  readonly migrations: MigrationSet<TContext>
  readonly state: MigrationHistoryStore
}

export interface RunMigrationSetParams<TContext> extends PlanMigrationSetParams<TContext> {
  readonly context: TContext
  readonly now?: () => string
}

export function step<TContext>(
  id: string,
  up: (context: TContext) => void | Promise<void>,
  options: MigrationStepOptions = {}
): MigrationStep<TContext> {
  const { version, name } = parseMigrationId(id)

  return {
    id,
    version,
    name,
    checksum: options.checksum,
    up,
  }
}

export function defineMigrations<TContext>(
  options: DefineMigrationsOptions<TContext>
): MigrationSet<TContext> {
  const steps = [...options.steps]
  assertValidSteps(options.adapterId, steps)

  return {
    adapterId: options.adapterId,
    latestVersion: steps.at(-1)?.version ?? 0,
    steps,
  }
}

async function planMigrationSet<TContext>(
  params: PlanMigrationSetParams<TContext>
): Promise<MigrationPlan<TContext>> {
  await params.state.ensure()

  const rows = await params.state.readHistory(params.migrations.adapterId)
  const applied = assertAppliedPrefix(params.migrations, rows)

  return {
    adapterId: params.migrations.adapterId,
    latestVersion: params.migrations.latestVersion,
    applied,
    pending: params.migrations.steps.slice(applied.length),
  }
}

export async function runMigrationSet<TContext>(
  params: RunMigrationSetParams<TContext>
): Promise<MigrationReport> {
  const now = params.now ?? (() => new Date().toISOString())
  const plan = await planMigrationSet(params)
  const applied: string[] = []

  for (const migration of plan.pending) {
    await params.state.transaction(async () => {
      await params.state.markStarted(plan.adapterId, migration, now())
      await migration.up(params.context)
      await params.state.markApplied(plan.adapterId, migration, now())
    })

    applied.push(migration.id)
  }

  return {
    adapterId: plan.adapterId,
    latestVersion: plan.latestVersion,
    status: applied.length > 0 ? "migrated" : "current",
    applied,
    skipped: plan.applied.map((migration) => migration.id),
  }
}

function parseMigrationId(id: string): { version: number; name: string } {
  const match = /^(\d+)(?:[-_](.+))?$/.exec(id)

  if (!match) {
    throw new Error(`[Sixb] Migration id must start with a numeric prefix: ${id}`)
  }

  const version = Number(match[1])

  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`[Sixb] Migration id must start with a positive version: ${id}`)
  }

  return {
    version,
    name: match[2] ?? id,
  }
}

function assertValidSteps<TContext>(
  adapterId: string,
  steps: readonly MigrationStep<TContext>[]
): void {
  let previousVersion = 0

  for (const migration of steps) {
    if (migration.version <= previousVersion) {
      throw new Error(`[${adapterId}] Migrations must be ordered by ascending version.`)
    }

    previousVersion = migration.version
  }
}

/**
 * Classifies migration history without touching the database.
 *
 * The single source of truth for what a history means. `status()` reports the result
 * and `assertAppliedPrefix` throws on it, so the read-only probe and the migration
 * path can never disagree about whether a database is usable.
 *
 * `rows: null` means the history table itself is absent, which a probe must be able to
 * express without creating it.
 */
export function describeMigrationHistory<TContext>(params: {
  readonly migrations: MigrationSet<TContext>
  readonly rows: readonly MigrationRecord[] | null
}): MigrationStatus {
  const { migrations, rows } = params
  const base = { adapterId: migrations.adapterId, latestVersion: migrations.latestVersion }

  // An adapter that declares no migrations and has recorded none is as current as it can
  // be. Reading that as `uninitialized` sent an operator to run `sixb db migrate`, which
  // would have applied nothing and reported the same state again. Only the empty history
  // qualifies: an adapter with no steps whose database recorded some is `ahead`, which
  // the walk below still finds.
  if (rows === null) {
    return migrations.steps.length === 0
      ? { ...base, appliedVersion: 0, state: "current" }
      : {
          ...base,
          appliedVersion: 0,
          state: "uninitialized",
          reason: "No migration history exists. Run `sixb db migrate`.",
        }
  }

  const applied = [...rows].sort((a, b) => a.version - b.version)
  const appliedVersion = applied.at(-1)?.version ?? 0
  const found = { ...base, appliedVersion }
  const seen = new Set<number>()

  for (const row of applied) {
    if (row.adapterId !== migrations.adapterId) {
      return {
        ...found,
        state: "incompatible",
        reason: `Migration state belongs to a different adapter: ${row.adapterId}`,
      }
    }

    if (row.status === "started") {
      return {
        ...found,
        state: "dirty",
        reason: `Migration '${row.id}' started and never finished. Resolve it by hand before serving traffic.`,
      }
    }

    if (row.status !== "applied") {
      return {
        ...found,
        state: "incompatible",
        reason: `Invalid migration status: ${row.status}`,
      }
    }

    if (seen.has(row.version)) {
      return {
        ...found,
        state: "incompatible",
        reason: `Duplicate applied migration: ${row.version}`,
      }
    }

    seen.add(row.version)
  }

  for (const [index, row] of applied.entries()) {
    const migration = migrations.steps[index]

    if (!migration || row.version > migrations.latestVersion) {
      return {
        ...found,
        state: "ahead",
        reason:
          "Database schema is newer than this Sixb version. Downgrades are not supported; " +
          "deploy a build that knows this schema.",
      }
    }

    if (row.version !== migration.version || row.id !== migration.id) {
      return {
        ...found,
        state: "incompatible",
        reason: "Applied migration history does not match declared migrations",
      }
    }

    if ((row.checksum ?? null) !== (migration.checksum ?? null)) {
      return {
        ...found,
        state: "incompatible",
        reason: `Applied migration checksum changed: ${row.id}`,
      }
    }
  }

  if (applied.length === 0) {
    return migrations.steps.length === 0
      ? { ...found, state: "current" }
      : {
          ...found,
          state: "uninitialized",
          reason: "Migration history is empty. Run `sixb db migrate`.",
        }
  }

  const pendingCount = migrations.steps.length - applied.length
  if (pendingCount > 0) {
    return {
      ...found,
      state: "pending",
      reason: `${pendingCount} migration(s) are not applied. Run \`sixb db migrate\`.`,
    }
  }

  return { ...found, state: "current" }
}

function assertAppliedPrefix<TContext>(
  migrations: MigrationSet<TContext>,
  rows: readonly MigrationRecord[]
): readonly MigrationRecord[] {
  const status = describeMigrationHistory({ migrations, rows })

  // `uninitialized` and `pending` are the normal inputs to a migration, not failures.
  if (
    status.state !== "current" &&
    status.state !== "uninitialized" &&
    status.state !== "pending"
  ) {
    throw new Error(`[${migrations.adapterId}] ${status.reason}`)
  }

  return [...rows].sort((a, b) => a.version - b.version)
}

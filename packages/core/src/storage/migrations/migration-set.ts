import type {
  DefineMigrationsOptions,
  MigrationHistoryStore,
  MigrationPlan,
  MigrationRecord,
  MigrationReport,
  MigrationSet,
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

export async function planMigrationSet<TContext>(
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

function assertAppliedPrefix<TContext>(
  migrations: MigrationSet<TContext>,
  rows: readonly MigrationRecord[]
): readonly MigrationRecord[] {
  const applied = [...rows].sort((a, b) => a.version - b.version)
  const seen = new Set<number>()

  for (const row of applied) {
    if (row.adapterId !== migrations.adapterId) {
      throw new Error(
        `[${migrations.adapterId}] Migration state belongs to a different adapter: ${row.adapterId}`
      )
    }

    if (row.status === "started") {
      throw new Error(`[${migrations.adapterId}] Database is in a dirty migration state`)
    }

    if (row.status !== "applied") {
      throw new Error(`[${migrations.adapterId}] Invalid migration status: ${row.status}`)
    }

    if (seen.has(row.version)) {
      throw new Error(`[${migrations.adapterId}] Duplicate applied migration: ${row.version}`)
    }

    seen.add(row.version)
  }

  for (const [index, row] of applied.entries()) {
    const migration = migrations.steps[index]

    if (!migration || row.version > migrations.latestVersion) {
      throw new Error(`[${migrations.adapterId}] Database schema is newer than this Sixb version`)
    }

    if (row.version !== migration.version || row.id !== migration.id) {
      throw new Error(
        `[${migrations.adapterId}] Applied migration history does not match declared migrations`
      )
    }

    if ((row.checksum ?? null) !== (migration.checksum ?? null)) {
      throw new Error(`[${migrations.adapterId}] Applied migration checksum changed: ${row.id}`)
    }
  }

  return applied
}

import { migrateStorage } from "@sixb/core"
import { SixbCliError } from "./errors"
import type { LoadedSixb } from "./loadSixb"
import type { StorageSchemaRole } from "./production-roles"

/** Set to `1` to start a role without bringing the storage schema up to date. */
const SKIP_ENV_VAR = "SIXB_SKIP_MIGRATION"

export interface RoleStorageMigrationOptions {
  readonly role: StorageSchemaRole
  /** `--no-migrate`. Combines with `SIXB_SKIP_MIGRATION=1`; either one opts out. */
  readonly noMigrate?: boolean
  readonly env?: Record<string, string | undefined>
  /**
   * Called once, only when a migration is about to run. A schema change can take minutes, and
   * a process that looks stuck is a process an operator restarts.
   */
  readonly onStart?: () => void
}

export type RoleStorageMigrationOutcome =
  /** Steps were applied; `applied` names them. */
  | "migrated"
  /** The schema was already at the latest version. */
  | "current"
  /** The configured storage exposes no migrators, so there is no schema to migrate. */
  | "skipped"
  /** The operator opted out with `--no-migrate` or `SIXB_SKIP_MIGRATION=1`. */
  | "disabled"

export interface RoleStorageMigration {
  readonly outcome: RoleStorageMigrationOutcome
  /** Migration step ids that this process applied, in order. */
  readonly applied: readonly string[]
  /** One line for the role's startup panel, naming what ran, or `null` when nothing did. */
  readonly summary: string | null
}

/**
 * Brings the storage schema up to date before a production role starts serving, so a forgotten
 * `sixb db migrate` cannot surface as a missing column on the first request.
 *
 * Concurrent replicas are handled below this call: Postgres serializes migrators on a session
 * advisory lock, and every adapter refuses a history it does not recognize, so late replicas
 * no-op instead of racing. SQLite is the exception, and its error is translated rather than
 * passed through raw.
 */
export async function migrateStorageForRole(
  sixb: LoadedSixb,
  options: RoleStorageMigrationOptions
): Promise<RoleStorageMigration> {
  const { role } = options
  const env = options.env ?? process.env
  const skippedByEnv = env[SKIP_ENV_VAR] === "1"

  // An opt-out says so out loud. Silence here is what made the old missing-migration
  // failure so hard to place, and this is the path an operator chose deliberately.
  if (options.noMigrate || skippedByEnv) {
    const source = options.noMigrate ? "--no-migrate" : `${SKIP_ENV_VAR}=1`
    return {
      outcome: "disabled",
      applied: [],
      summary: `migration skipped (${source}); run \`sixb db migrate\` separately`,
    }
  }

  options.onStart?.()
  const result = await runMigration(sixb, role)

  if (result.status === "skipped") {
    return { outcome: "skipped", applied: [], summary: null }
  }

  const applied = result.reports.flatMap((report) => report.applied)

  if (applied.length === 0) {
    return { outcome: "current", applied, summary: "schema up to date" }
  }

  return {
    outcome: "migrated",
    applied,
    summary: `migrated: ${applied.join(", ")}`,
  }
}

async function runMigration(sixb: LoadedSixb, role: StorageSchemaRole) {
  try {
    return await migrateStorage(sixb.storage)
  } catch (error) {
    throw isBusyDatabaseError(error) ? concurrentMigrationError(error, role) : error
  }
}

/**
 * SQLite has no cross-process migration lock, so two roles starting at the same moment
 * on the same file collide. The raw `SQLITE_BUSY` says nothing about why or what to do,
 * and it is the one concurrency case the layers below cannot serialize for us.
 */
function concurrentMigrationError(error: unknown, role: StorageSchemaRole): Error {
  const detail = error instanceof Error ? error.message : String(error)

  return new SixbCliError(
    `[SixbCLI] \`sixb ${role}\` could not migrate storage because the database was locked ` +
      `by another process: ${detail}. SQLite has no cross-process migration lock, so roles ` +
      `starting together on the same file collide.`,
    {
      cause: error,
      remediation:
        "Run `sixb db migrate` once before starting the roles and start them with " +
        "`--no-migrate`, or move to a storage provider that serializes migrations across " +
        "processes.",
    }
  )
}

function isBusyDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : ""
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(message)
}

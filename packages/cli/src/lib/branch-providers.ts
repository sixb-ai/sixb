import { pathToFileURL } from "node:url"
import { BRANCH_DATABASE_SCHEMA_ENV, BRANCH_DATABASE_URL_ENV } from "@sixb/core/internal/branches"
import type { Storage } from "@sixb/core/storage"

/**
 * For a branch production runs: the schema production made for it on its instance, as the role
 * limited to it, which the branch loads its copy into and runs on. `@sixb/pg` comes from the
 * project, which installs it to run production.
 */
export async function hostedBranchStorage(projectRoot: string, branch: string): Promise<Storage> {
  const url = required(BRANCH_DATABASE_URL_ENV)
  const schemaName = required(BRANCH_DATABASE_SCHEMA_ENV)
  const pg = (await importFromProject("@sixb/pg", projectRoot)) as {
    readonly PostgresStorage: new (options: Record<string, unknown>) => Storage
  }
  // The role's connection limit bounds the pool: a branch shares production's instance.
  return new pg.PostgresStorage({ connectionString: url, schemaName, branch, max: 4 })
}

/** The project's own copy of a package, the one its configuration imports. */
async function importFromProject(name: string, projectRoot: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(Bun.resolveSync(name, projectRoot)).href)
  } catch (error) {
    throw new Error(
      `[SixbDev] A branch production runs needs ${name}, which production's own providers use. Add it to the project's dependencies.`,
      { cause: error }
    )
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`[SixbDev] ${name} is missing: production starts a hosted branch with it.`)
  }
  return value
}

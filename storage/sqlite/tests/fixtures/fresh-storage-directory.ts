import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freshSqliteDatabase, sqliteStoragePath } from "../../src/migrations"

/**
 * A new storage directory whose database already holds the current schema.
 *
 * Migrating a file replays every migration, a few hundred milliseconds each time. This writes the
 * schema `freshSqliteDatabase` keeps instead, which `sqlite-fresh-schema.test.ts` proves is the one
 * the migration runner leaves. The file has no migration history: a test about migrating starts
 * from an empty directory. The caller removes the directory.
 */
export async function freshStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-"))
  const schema = freshSqliteDatabase()
  try {
    await writeFile(sqliteStoragePath(directory), schema.serialize())
  } finally {
    schema.close()
  }
  return directory
}

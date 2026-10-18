import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freshSqliteDatabase, migrateSqliteStorage, sqliteStoragePath } from "../src/migrations"

// Everything a migration can leave behind: schema objects, rows it seeds, and the version pragma.
// The runner's own history table is not part of the schema.
function snapshot(db: Database) {
  const schema = db
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'sixb_migrations' ORDER BY type, name"
    )
    .all()
  const rows = Object.fromEntries(
    schema
      .filter((entry) => entry.type === "table" && !entry.name.startsWith("sqlite_"))
      .map((entry) => [entry.name, db.query(`SELECT * FROM "${entry.name}"`).all()])
  )
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
    user_version: 0,
  }
  return { schema, rows, user_version }
}

// In-memory storage starts from a copy of one database built by replaying every migration, while
// the runner migrates a file one step at a time with foreign keys off. Every in-memory test, and
// every test file written from that copy, relies on both leaving the same schema. Regression
// proof: build the template with a schema-changing migration such as 062 left out, or return the
// template itself instead of a copy, and this fails.
test("a fresh in-memory database is an independent copy of the migrated schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-fresh-schema-"))
  try {
    await migrateSqliteStorage(directory)
    const migrated = new Database(sqliteStoragePath(directory), { readonly: true })
    const first = freshSqliteDatabase()
    const second = freshSqliteDatabase()
    try {
      const expected = snapshot(migrated)
      expect(snapshot(first)).toEqual(expected)

      first.run("CREATE TABLE written_by_first (id INTEGER)")
      expect(snapshot(second)).toEqual(expected)
    } finally {
      for (const db of [migrated, first, second]) db.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

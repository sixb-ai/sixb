import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { freshSqliteDatabase, installFreshSqliteSchema } from "../src/migrations"

// Everything a migration can leave behind: schema objects, rows it seeds, and the version pragma.
function snapshot(db: Database) {
  const schema = db
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
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

// In-memory storage starts from a copy of one migrated database instead of replaying every
// migration. Regression proof: build the template with the last migration left out, or return
// the template itself instead of a copy, and this fails.
test("a fresh in-memory database is an independent copy of the replayed schema", () => {
  const replayed = new Database(":memory:")
  replayed.run("PRAGMA foreign_keys = ON")
  installFreshSqliteSchema(replayed)
  const first = freshSqliteDatabase()
  const second = freshSqliteDatabase()
  try {
    expect(snapshot(first)).toEqual(snapshot(replayed))

    first.run("CREATE TABLE written_by_first (id INTEGER)")
    expect(snapshot(second)).toEqual(snapshot(replayed))
  } finally {
    for (const db of [replayed, first, second]) db.close()
  }
})

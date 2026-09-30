import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPgClient, type SQL } from "../src/pg-client"
import { runPgTransaction } from "../src/transactions"

const FIXTURE = `${import.meta.dir}/fixtures/connection-loss.ts`

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error("[SixbPg] DATABASE_URL is required. Run `bun run test:e2e` from @sixb/pg.")
  }
  return url
}

describe("PostgreSQL connection loss", () => {
  // Both guards are needed. To see this test fail, either make `runPgTransaction` call
  // `sql.begin(...)` again (its ROLLBACK is written to the closed socket) or let
  // `withReservedPgConnection` release a lost connection (the next query is): with postgres.js
  // 3.4.9 the child then dies on `null is not an object (evaluating 'socket.write')`.
  test("rejects the transaction, survives, and keeps the pool usable", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, FIXTURE],
      env: { ...process.env, DATABASE_URL: databaseUrl() },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
    expect(JSON.parse(stdout)).toEqual({
      rejection: expect.stringMatching(/^(CONNECTION_CLOSED|57P01)$/),
      firstQuery: expect.stringMatching(/^(ok|57P01)$/),
      secondQuery: "ok",
    })
  }, 40_000)
})

describe("PostgreSQL transaction outcome", () => {
  let sql: SQL
  beforeAll(() => {
    sql = createPgClient({ connectionString: databaseUrl(), max: 1, schemaName: "public" })
  })
  afterAll(() => sql.end())

  test("fails instead of reporting a commit PostgreSQL turned into a rollback", async () => {
    const table = `connection_loss_${crypto.randomUUID().replaceAll("-", "")}`
    await sql.unsafe(`CREATE TABLE ${table} (id integer)`)
    try {
      await expect(
        runPgTransaction(sql, async (tx) => {
          await tx.unsafe(`INSERT INTO ${table} VALUES (1)`)
          await tx`SELECT 1 / 0`.catch(() => {})
        })
      ).rejects.toThrow("rolled the transaction back instead of committing it")

      const rows = await sql.unsafe(`SELECT id FROM ${table}`)
      expect(rows).toHaveLength(0)
    } finally {
      await sql.unsafe(`DROP TABLE ${table}`)
    }
  })
})

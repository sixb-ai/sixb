import { expect, test } from "bun:test"
import { postgresStorageMigrations } from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

// Removal proof: omit the owner columns from migration 089; the SELECT below fails.
test("connection owners migration keeps existing rows as the project's", async () => {
  const steps = postgresStorageMigrations.steps
  const migrationIndex = steps.findIndex((step) => step.id === "101-connector-connection-owners")
  expect(migrationIndex).toBeGreaterThan(-1)
  const created = await createTestStorage({ migrateThrough: migrationIndex })
  const sql = createPgClient({
    connectionString: created.connectionString,
    schemaName: created.schemaName,
    max: 1,
  })
  try {
    await sql.unsafe(`
      INSERT INTO connector_authorizations (
        project_id, connector_id, id, authorized_by, credentials, scopes, accounts, status,
        revision, created_at, updated_at
      ) VALUES ('project', 'm365', 'authorization-a', '{"type":"user","id":"user-a"}',
        '{}', '[]', '[{"id":"account-a","label":"a"}]', 'active', 0, now(), now());
      INSERT INTO connector_connections (
        project_id, connector_id, id, authorization_id, slot, account, account_id, status,
        created_at, updated_at
      ) VALUES ('project', 'm365', 'connection-a', 'authorization-a', 'default',
        '{"id":"account-a","label":"a"}', 'account-a', 'connected', now(), now());
    `)
    await steps[migrationIndex]!.up({
      exec: async (text: string) => {
        await sql.unsafe(text)
      },
    })

    const rows = await sql`SELECT id, owner_type, owner_id FROM connector_connections`
    expect([...rows]).toEqual([{ id: "connection-a", owner_type: "project", owner_id: "" }])

    const connect = (id: string, ownerType: string, ownerId: string) =>
      sql`
        INSERT INTO connector_connections (
          project_id, connector_id, id, authorization_id, owner_type, owner_id, slot, account,
          account_id, status, created_at, updated_at
        ) VALUES ('project', 'm365', ${id}, 'authorization-a', ${ownerType}, ${ownerId}, 'default',
          '{"id":"account-a","label":"a"}', 'account-a', 'connected', now(), now())
      `.then(() => "inserted")
    expect(await connect("connection-b", "user", "user-a")).toBe("inserted")
    expect(await connect("connection-c", "user", "user-b")).toBe("inserted")
    expect(String(await connect("connection-d", "project", "").catch((e) => e))).toContain(
      "duplicate key"
    )
    expect(String(await connect("connection-e", "user", "user-a").catch((e) => e))).toContain(
      "duplicate key"
    )
    expect(String(await connect("connection-f", "user", "").catch((e) => e))).toContain(
      "check constraint"
    )
    expect(
      String(
        await sql`
          INSERT INTO connector_connections (
            project_id, connector_id, id, authorization_id, slot, account, account_id, status,
            created_at, updated_at
          ) VALUES ('project', 'm365', 'connection-g', 'authorization-a', 'other',
            '{"id":"account-a","label":"a"}', 'account-a', 'connected', now(), now())
        `.catch((e) => e)
      )
    ).toContain("owner_type")
  } finally {
    await sql.end()
    await disposeTestStorage(created.storage)
  }
})

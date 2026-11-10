import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import connectorSchema from "../src/migrations/025-connector-connections.sql" with { type: "text" }
import optionalPkce from "../src/migrations/039-connector-optional-pkce.sql" with { type: "text" }
import connectionOwners from "../src/migrations/098-connector-connection-owners.sql" with {
  type: "text",
}

test("connection owners migration keeps existing rows as the project's", () => {
  // Removal proof: omit db.run(connectionOwners); the owner columns are missing.
  const db = new Database(":memory:")
  try {
    db.run("PRAGMA foreign_keys = ON")
    db.run(connectorSchema)
    db.run(optionalPkce)
    db.run(`
      INSERT INTO connector_authorizations (
        project_id, connector_id, id, authorized_by, credentials, scopes, accounts, status,
        revision, created_at, updated_at
      ) VALUES ('project', 'm365', 'authorization-a', '{"type":"user","id":"user-a"}',
        '{}', '[]', '[{"id":"account-a","label":"a"}]', 'active', 0,
        '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z')
    `)
    db.run(`
      INSERT INTO connector_connections (
        project_id, connector_id, id, authorization_id, slot, account, account_id, status,
        created_at, updated_at
      ) VALUES ('project', 'm365', 'connection-a', 'authorization-a', 'default',
        '{"id":"account-a","label":"a"}', 'account-a', 'connected',
        '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z')
    `)
    db.run(`
      INSERT INTO connector_connection_runs (
        project_id, connector_id, id, kind, slot, initiated_by_execution_id, status,
        waiting_for, expires_at, created_at, updated_at
      ) VALUES ('project', 'm365', 'run-a', 'connect', 'default', 'execution', 'waiting',
        'provider_authorization', '2026-11-08T00:10:00Z',
        '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z')
    `)

    db.run(connectionOwners)

    const owners = (table: string) =>
      db.query(`SELECT id, owner_type, owner_id FROM ${table}`).all()
    expect(owners("connector_connections")).toEqual([
      { id: "connection-a", owner_type: "project", owner_id: "" },
    ])
    expect(owners("connector_connection_runs")).toEqual([
      { id: "run-a", owner_type: "project", owner_id: "" },
    ])

    const connect = (id: string, ownerType: string, ownerId: string) =>
      db.run(
        `
        INSERT INTO connector_connections (
          project_id, connector_id, id, authorization_id, owner_type, owner_id, slot, account,
          account_id, status, created_at, updated_at
        ) VALUES ('project', 'm365', ?, 'authorization-a', ?, ?, 'default',
          '{"id":"account-a","label":"a"}', 'account-a', 'connected',
          '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z')
      `,
        [id, ownerType, ownerId]
      )
    connect("connection-b", "user", "user-a")
    connect("connection-c", "user", "user-b")
    expect(() => connect("connection-d", "project", "")).toThrow("UNIQUE")
    expect(() => connect("connection-e", "user", "user-a")).toThrow("UNIQUE")
    expect(() => connect("connection-f", "user", "")).toThrow("CHECK")
    expect(() => connect("connection-g", "project", "user-a")).toThrow("CHECK")

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'connector_connections' AND name LIKE 'idx_%' ORDER BY name"
        )
        .all()
    ).toEqual([
      { name: "idx_connector_connections_authorization" },
      { name: "idx_connector_connections_status" },
    ])
  } finally {
    db.close()
  }
})

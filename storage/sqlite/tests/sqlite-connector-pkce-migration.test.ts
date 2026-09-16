import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import connectorSchema from "../src/migrations/025-connector-connections.sql" with { type: "text" }
import optionalPkce from "../src/migrations/039-connector-optional-pkce.sql" with { type: "text" }

test("optional PKCE migration preserves existing attempts and admits absent verifiers", () => {
  // Removal proof: omit db.run(optionalPkce); inserting the non-PKCE attempt fails NOT NULL.
  const db = new Database(":memory:")
  try {
    db.run("PRAGMA foreign_keys = ON")
    db.run(connectorSchema)
    const insert = (id: string, verifier: string | null) =>
      db.run(
        `
      INSERT INTO connector_authorization_attempts (
        project_id, connector_id, id, slot, initiated_by_execution_id,
        state_hash, code_verifier, redirect_uri, created_at, expires_at
      ) VALUES ('project', 'connector', ?, 'default', 'execution', 'state', ?,
        'https://app.test/callback', '2026-09-16T00:00:00Z', '2026-09-16T00:10:00Z')
    `,
        [id, verifier]
      )
    const verifier = JSON.stringify({
      version: 1,
      algorithm: "A256GCM",
      nonce: "nonce",
      ciphertext: "ciphertext",
      tag: "tag",
    })
    insert("existing", verifier)
    const before = db.query("SELECT * FROM connector_authorization_attempts").all()
    expect(() => insert("disabled", null)).toThrow()
    db.run(optionalPkce)
    expect(db.query("SELECT * FROM connector_authorization_attempts").all()).toEqual(before)
    insert("disabled", null)
    expect(
      db
        .query("SELECT code_verifier FROM connector_authorization_attempts WHERE id = 'disabled'")
        .get()
    ).toEqual({ code_verifier: null })
    expect(() => insert("invalid", "[]")).toThrow()
    expect(() => insert("existing", verifier)).toThrow()
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_connector_attempts_expiry'"
        )
        .get()
    ).not.toBeNull()
  } finally {
    db.close()
  }
})

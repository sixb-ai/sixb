import { expect, test } from "bun:test"
import { postgresStorageMigrations } from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

// Removal proofs: drop the UPDATE from 103 and the migration fails its own CHECK on the guest's
// comment; drop that CHECK and a guest's comment without its link is taken.
test("guest comment links migration keeps the shared link each guest's comment came through", async () => {
  const steps = postgresStorageMigrations.steps
  const migrationIndex = steps.findIndex((step) => step.id === "103-guest-comment-links")
  expect(migrationIndex).toBeGreaterThan(-1)
  const created = await createTestStorage({ migrateThrough: migrationIndex })
  const sql = createPgClient({
    connectionString: created.connectionString,
    schemaName: created.schemaName,
    max: 1,
  })
  try {
    await sql.unsafe(`
      INSERT INTO artifacts (
        project_id, id, kind, title, owner_principal_type, owner_principal_id, latest_version,
        next_version, revision, created_at, updated_at
      ) VALUES ('p', 'art_canvas01', 'canvas', 'Plan', 'user', 'u', 1, 2, 1, now(), now());
      INSERT INTO share_grants (
        project_id, id, definition_id, target_object_type_id, target_primary_id,
        issued_by_type, issued_by_id, authority_version, authority_snapshot,
        authority_digest, token_hash, destination_path, created_at, expires_at
      ) VALUES (
        'p', 'shg_kickoff', 'contract', 'Contract', 'c-1', 'user', 'u', 1,
        '{"version":1,"access":{"grants":[]}}'::jsonb, repeat('a', 64), repeat('b', 64),
        '/contracts/c-1', now(), now() + interval '1 day'
      );
      INSERT INTO share_sessions (
        project_id, id, grant_id, token_hash, created_at, expires_at, absolute_expires_at
      ) VALUES (
        'p', 'shs_1', 'shg_kickoff', repeat('c', 64), now(), now() + interval '1 hour',
        now() + interval '1 day'
      );
      INSERT INTO artifact_comments (
        project_id, artifact_id, id, anchor, body, author_principal_type, author_principal_id,
        author_name, created_at
      ) VALUES
        ('p', 'art_canvas01', 'cmt_guest', '{"revision":1}', 'Hi', 'guest', 'shs_1', 'Ava', now()),
        ('p', 'art_canvas01', 'cmt_team', '{"revision":1}', 'Hm', 'user', 'u', NULL, now());
    `)
    await steps[migrationIndex]!.up({
      exec: async (text: string) => {
        await sql.unsafe(text)
      },
    })

    const rows = await sql`SELECT id, author_grant_id FROM artifact_comments ORDER BY id`
    expect([...rows]).toEqual([
      { id: "cmt_guest", author_grant_id: "shg_kickoff" },
      { id: "cmt_team", author_grant_id: null },
    ])

    // A guest's comment keeps its link, and nobody else's does.
    const comment = (id: string, type: string, name: string | null, grantId: string | null) =>
      sql`
        INSERT INTO artifact_comments (
          project_id, artifact_id, id, anchor, body, author_principal_type, author_principal_id,
          author_name, author_grant_id, created_at
        ) VALUES ('p', 'art_canvas01', ${id}, '{"revision":1}', 'Hi', ${type}, 'shs_2', ${name},
          ${grantId}, now())
      `.then(() => "inserted")
    expect(String(await comment("cmt_linkless", "guest", "Ava", null).catch((e) => e))).toContain(
      "artifact_comments_author_grant_check"
    )
    expect(
      String(await comment("cmt_linked", "user", null, "shg_kickoff").catch((e) => e))
    ).toContain("artifact_comments_author_grant_check")
    expect(await comment("cmt_next", "guest", "Ava", "shg_kickoff")).toBe("inserted")
  } finally {
    await sql.end()
    await disposeTestStorage(created.storage)
  }
})

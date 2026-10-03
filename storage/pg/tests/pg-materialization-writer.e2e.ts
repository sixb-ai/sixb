import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createEventId } from "@sixb/core/internal/materialization"
import type {
  MaterializationPlanHeader,
  MaterializationPlanWorkItem,
  MaterializationWorkRecord,
} from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import { createPgClient, type SQL } from "../src/pg-client"
import { createTestStorage } from "./helpers"

const projectId = "writer"
const committedAt = "2026-03-01T00:00:00.000Z"
const object = (primaryId: string) => ({ objectTypeId: "Device", primaryId })
const link = (sourceId: string, targetId: string) => ({
  source: object(sourceId),
  linkId: "parent",
  target: object(targetId),
})

let storage: PostgresStorage
let schemaName: string
let sql: SQL

beforeAll(async () => {
  ;({ storage, schemaName } = await createTestStorage())
  sql = createPgClient({ connectionString: process.env.DATABASE_URL!, schemaName, max: 1 })
  await sql`
    INSERT INTO objects (
      project_id, object_type_id, primary_id, properties, created_at, updated_at, version,
      last_commit_id
    )
    SELECT ${projectId}, 'Device', id, '{}'::jsonb, ${committedAt}, ${committedAt}, 1, 'old'
    FROM unnest(ARRAY['a', 'b', 'c']) AS id
  `
  await sql`
    INSERT INTO links (
      project_id, source_type_id, source_id, link_id, target_type_id, target_id,
      properties, created_at, updated_at, last_commit_id
    ) VALUES (${projectId}, 'Device', 'a', 'parent', 'Device', 'b', NULL, ${committedAt},
      ${committedAt}, 'old')
  `
  await sql`
    INSERT INTO ontology_object_overrides (
      project_id, object_type_id, primary_id, value, edited_at, last_commit_id, updated_at
    ) VALUES (${projectId}, 'Device', 'a', '{"kind":"patch","set":{}}'::jsonb, '{}'::jsonb, 'old',
      ${committedAt})
  `
  await sql`
    INSERT INTO ontology_link_overrides (
      project_id, identity_kind, identity_key, source_type_id, source_primary_id, link_id,
      target_type_id, target_primary_id, value, last_commit_id, updated_at
    ) VALUES (${projectId}, 'slot', '["Device","c","parent"]'::jsonb, 'Device', 'c', 'parent',
      'Device', 'a', '{"kind":"clear","target":{"objectTypeId":"Device","primaryId":"a"}}'::jsonb,
      'old', ${committedAt})
  `
  await sql`
    INSERT INTO ontology_link_overrides (
      project_id, identity_kind, identity_key, source_type_id, source_primary_id, link_id,
      target_type_id, target_primary_id, value, last_commit_id, updated_at
    ) VALUES (${projectId}, 'edge', '["Device","a","parent","Device","b"]'::jsonb, 'Device', 'a',
      'parent', 'Device', 'b', '{"kind":"delete"}'::jsonb, 'old', ${committedAt})
  `
  await sql`
    INSERT INTO timeseries (
      project_id, object_type_id, object_id, property_id, value, unit, at, last_commit_id
    ) VALUES (${projectId}, 'Device', 'a', 'temperature', '1'::jsonb, NULL, ${committedAt}, 'old')
  `
})

afterAll(async () => {
  await sql.end()
  await storage.dropSchema()
  await storage.close()
})

function header(id: string): MaterializationPlanHeader {
  return {
    commit: {
      projectId,
      id,
      idempotencyKey: `runtime:${id}`,
      requestHash: id,
      executionId: `execution:${id}`,
      origin: { kind: "runtime", requestId: id },
      ontologyRevision: "revision",
      intent: { kind: "edit", mode: "atomic", operationCount: 0 },
      committedAt,
    },
    expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
  }
}

function plan(item: MaterializationPlanWorkItem, sortKey = "61"): MaterializationWorkRecord {
  const phase: Record<MaterializationPlanWorkItem["kind"], 0 | 1 | 2 | 3 | 4 | 5> = {
    "object-override-upsert": 0,
    "object-override-delete": 0,
    "link-override-upsert": 0,
    "link-override-delete": 0,
    "link-slot-override-upsert": 0,
    "link-slot-override-delete": 0,
    "point-upsert": 1,
    "link-delete": 2,
    "object-delete": 3,
    "object-upsert": 4,
    "link-upsert": 5,
  }
  return {
    kind: "plan",
    recordKey: `plan:${item.kind}:${sortKey}`,
    applyPhase: phase[item.kind],
    sortKey,
    item,
  }
}

async function apply(id: string, records: readonly MaterializationWorkRecord[]) {
  return storage.transaction(async (tx) => {
    const session = await tx.ontology.materializations.begin(header(id))
    await tx.ontology.materializations.stageWork({ session, records })
    return tx.ontology.materializations.apply({ session })
  })
}

describe("PostgreSQL set-based plan writes", () => {
  // Removal proof: return `written` without comparing it to `staged` in the writer; every case
  // below then resolves instead of rejecting.
  for (const [name, item, message] of [
    [
      "object insert over an existing object",
      {
        kind: "object-upsert",
        value: {
          row: {
            ref: object("a"),
            properties: {},
            version: 1,
            createdAt: committedAt,
            updatedAt: committedAt,
            lastCommitId: "object-insert",
          },
          expected: { ref: object("a"), exists: false },
        },
      },
      'Expected object ["Device","a"] to be absent.',
    ],
    [
      "object update of a moved revision",
      {
        kind: "object-upsert",
        value: {
          row: {
            ref: object("b"),
            properties: {},
            version: 3,
            createdAt: committedAt,
            updatedAt: committedAt,
            lastCommitId: "object-update",
          },
          expected: { ref: object("b"), exists: true, version: 2, lastCommitId: "old" },
        },
      },
      'Expected object ["Device","b"] changed.',
    ],
    [
      "object delete of a moved revision",
      {
        kind: "object-delete",
        value: {
          ref: object("c"),
          expected: { ref: object("c"), exists: true, version: 1, lastCommitId: "newer" },
        },
      },
      'Expected object ["Device","c"] changed.',
    ],
    [
      "link insert over an existing link",
      {
        kind: "link-upsert",
        value: {
          row: {
            ref: link("a", "b"),
            createdAt: committedAt,
            updatedAt: committedAt,
            lastCommitId: "link-insert",
          },
          expected: { ref: link("a", "b"), exists: false },
        },
      },
      'Expected link ["Device","a","parent","Device","b"] to be absent.',
    ],
    [
      "link delete of a moved revision",
      {
        kind: "link-delete",
        value: {
          ref: link("a", "b"),
          expected: { ref: link("a", "b"), exists: true, lastCommitId: "newer" },
        },
      },
      'Expected link ["Device","a","parent","Device","b"] changed.',
    ],
    [
      "object override update of a moved revision",
      {
        kind: "object-override-upsert",
        value: {
          ref: object("a"),
          value: { kind: "patch", set: { name: "x" }, unset: [], reset: [] },
          editedAt: { name: committedAt },
          expectedLastCommitId: "newer",
          lastCommitId: "override-update",
          updatedAt: committedAt,
        },
      },
      "Expected object override changed.",
    ],
    [
      "slot override delete of a moved revision",
      {
        kind: "link-slot-override-delete",
        value: {
          ref: { source: object("c"), linkId: "parent" },
          expectedLastCommitId: "newer",
        },
      },
      "Expected link slot override changed.",
    ],
    [
      "point insert over an existing point",
      {
        kind: "point-upsert",
        value: {
          point: {
            series: { object: object("a"), propertyId: "temperature" },
            value: 2,
            at: committedAt,
            lastCommitId: "point-insert",
          },
          expected: {
            series: { object: object("a"), propertyId: "temperature" },
            at: committedAt,
            lastCommitId: null,
          },
        },
      },
      `Telemetry point ${JSON.stringify(["Device", "a", "temperature", committedAt])} changed.`,
    ],
  ] as const) {
    test(`names the entity of a conflicting ${name}`, async () => {
      const id = name.replaceAll(" ", "-")
      const records = [
        plan({ ...item, value: withCommit(item.value, id) } as MaterializationPlanWorkItem),
      ]
      await expect(apply(id, records)).rejects.toThrow(message)
    })
  }

  // Removal proof: give the insert statement's diagnostic every staged override write; the edge
  // update staged beside it, not yet written, is then blamed for the slot insert's conflict.
  test("names the kind of a conflicting override insert, not one still to update", async () => {
    const id = "override-insert-beside-update"
    const records = [
      plan({
        kind: "link-override-upsert",
        value: {
          ref: link("a", "b"),
          value: { kind: "upsert" },
          expectedLastCommitId: "old",
          lastCommitId: id,
          updatedAt: committedAt,
        },
      }),
      plan({
        kind: "link-slot-override-upsert",
        value: {
          ref: { source: object("c"), linkId: "parent" },
          value: { kind: "set", target: object("b") },
          expectedLastCommitId: null,
          lastCommitId: id,
          updatedAt: committedAt,
        },
      }),
    ]
    await expect(apply(id, records)).rejects.toThrow("Expected link slot override changed.")
  })

  test("writes staged rows and sequences the outbox like createEventId", async () => {
    const id = "writes-everything"
    await storage.executions.create({
      id: `execution:${id}`,
      projectId,
      executor: { type: "request", requestId: id },
      source: { type: "http", requestId: id },
      correlationId: id,
      authorizationRef: { type: "disabled" },
    })
    const events = ["d", "e"].map(
      (primaryId, index): MaterializationWorkRecord => ({
        kind: "event",
        recordKey: `event:0:6${index}`,
        eventKindRank: 0,
        sortKey: `6${index}`,
        draft: {
          type: "object.created",
          payload: { objectTypeId: "Device", primaryId, properties: {} },
        },
      })
    )
    const created = ["d", "e"].map((primaryId, index) =>
      plan(
        {
          kind: "object-upsert",
          value: {
            row: {
              ref: object(primaryId),
              properties: { name: primaryId },
              version: 1,
              createdAt: committedAt,
              updatedAt: committedAt,
              lastCommitId: id,
            },
            expected: { ref: object(primaryId), exists: false },
          },
        },
        `6${index}`
      )
    )
    await storage.transaction(async (tx) => {
      const session = await tx.ontology.materializations.begin(header(id))
      await tx.ontology.materializations.stageWork({ session, records: [...created, ...events] })
      await expect(tx.ontology.materializations.apply({ session })).resolves.toEqual({
        eventCount: 2,
      })
      await tx.ontology.materializations.finalize({
        session,
        finalization: {
          sourceActivations: [],
          result: {
            kind: "edit",
            commitId: id,
            created: true,
            eventCount: 2,
            committedAt,
            outcomes: [],
            changes: { objects: [], links: [] },
          },
        },
      })
    })
    const eventId = (ordinal: number) => createEventId(projectId, id, ordinal)
    expect([
      ...(await sql`
        SELECT id, commit_ordinal::integer AS ordinal, event
        FROM ontology_outbox WHERE commit_id = ${id} ORDER BY commit_ordinal
      `),
    ]).toEqual(
      [0, 1].map((ordinal) => ({
        id: eventId(ordinal),
        ordinal,
        event: {
          type: "object.created",
          payload: { objectTypeId: "Device", primaryId: ["d", "e"][ordinal], properties: {} },
        },
      }))
    )
    expect([
      ...(await sql`
        SELECT primary_id, properties->>'name' AS name FROM objects
        WHERE project_id = ${projectId} AND last_commit_id = ${id} ORDER BY primary_id
      `),
    ]).toEqual([
      { primary_id: "d", name: "d" },
      { primary_id: "e", name: "e" },
    ])
  })
})

/** The item with its write provenance pointing at the commit that stages it. */
function withCommit(value: unknown, commitId: string): unknown {
  const copy = structuredClone(value) as Record<string, unknown>
  const row = copy.row as Record<string, unknown> | undefined
  if (row) row.lastCommitId = commitId
  const point = copy.point as Record<string, unknown> | undefined
  if (point) point.lastCommitId = commitId
  if ("lastCommitId" in copy) copy.lastCommitId = commitId
  return copy
}

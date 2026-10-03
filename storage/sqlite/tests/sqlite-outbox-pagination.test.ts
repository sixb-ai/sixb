import { Database, type SQLQueryBindings } from "bun:sqlite"
import { expect, test } from "bun:test"
import { installFreshSqliteSchema } from "../src/migrations"
import { SqliteOntologyOutboxStorage } from "../src/ontology-storage/outbox"

const EVENT = `json_object('type','object.created','payload',json_object(
  'objectTypeId','Device','primaryId',CAST(i AS TEXT),'properties',json('{}')))`

function insertCommit(db: Database): void {
  db.run(`INSERT INTO executions (
    project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
    authority_kind, created_at
  ) VALUES (
    'project', 'execution', 'request', 'request', 'http', 'request', 'correlation', 'disabled',
    '2026-09-19'
  )`)
  db.run(`INSERT INTO ontology_commits (
    project_id, id, idempotency_key, request_hash, execution_id, origin_kind, origin,
    ontology_revision, intent, result, committed_at
  ) VALUES (
    'project', 'commit', 'runtime:commit', 'hash', 'execution', 'runtime',
    json('{"kind":"runtime","requestId":"request"}'), 'revision', json('{}'), json('{}'),
    '2026-09-19'
  )`)
}

// Regression proof: restore the former single ordered scan. With the new index it loses the
// eligibility probe; without that index it sorts the entire ready backlog for every batch.
for (const analyzed of [false, true]) {
  for (const readyFrom of [1, 9950, 10001]) {
    test(`SQLite outbox selects a bounded page (statistics: ${analyzed}, ready from: ${readyFrom})`, async () => {
      const db = new Database(":memory:")
      installFreshSqliteSchema(db)
      try {
        insertCommit(db)
        db.run(`WITH RECURSIVE rows(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM rows WHERE i<10000)
      INSERT INTO ontology_outbox(project_id,id,commit_id,commit_ordinal,event,available_at,created_at,lease_id,lease_expires_at)
      SELECT 'project',CAST(i AS TEXT),'commit',i,${EVENT},
        CASE WHEN i=1 OR i<${readyFrom} THEN '2026-09-21' ELSE '2026-09-19' END,'2026-09-19',
        CASE WHEN i IN (2,3) THEN 'previous' END,
        CASE WHEN i=2 THEN '2026-09-21' WHEN i=3 THEN '2026-09-19' END FROM rows`)
        if (analyzed) db.run("ANALYZE ontology_outbox")
        const plan: string[] = []
        const observed = observePlans(db, plan)
        const outbox = new SqliteOntologyOutboxStorage(observed, async (run) => run())
        const claimed = await outbox.claim({
          projectId: "project",
          limit: 100,
          now: "2026-09-20T00:00:00.000Z",
          leaseId: "claim",
          leaseExpiresAt: "2026-09-20T00:01:00.000Z",
        })
        expect(claimed.map((row) => Number(row.envelope.id)).sort((a, b) => a - b)).toEqual(
          Array.from({ length: 10000 }, (_, i) => i + 1)
            .filter((id) => id >= readyFrom && id > 2)
            .slice(0, 100)
        )
        expect(plan.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false)
        expect(plan.some((detail) => detail.includes("idx_ontology_outbox_claim"))).toBe(true)
        expect(
          plan.some((detail) => detail.includes("idx_ontology_outbox_publication_order"))
        ).toBe(readyFrom === 1)
        // The batch's one commit and its execution are read by their keys, not once per event.
        expect(
          plan
            .filter((detail) => detail.startsWith("SEARCH commits "))
            .map((detail) => detail.includes("(project_id=? AND id=?)"))
        ).toEqual(claimed.length === 0 ? [] : [true])
      } finally {
        db.close()
      }
    })
  }
}

for (const operation of ["markPublished", "reschedule"] as const) {
  // Regression proof: replace CROSS JOIN with the former join driven from outbox. Without
  // statistics, SQLite scans the project's history rather than looking up the requested IDs.
  test(`SQLite outbox ${operation} looks up only the requested leases without statistics`, async () => {
    const db = new Database(":memory:")
    installFreshSqliteSchema(db)
    try {
      insertCommit(db)
      db.run(`WITH RECURSIVE rows(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM rows WHERE i<10000)
        INSERT INTO ontology_outbox(project_id,id,commit_id,commit_ordinal,event,available_at,created_at)
        SELECT 'project',CAST(i AS TEXT),'commit',i,${EVENT},
          '2026-09-19','2026-09-19' FROM rows`)
      const plan: string[] = []
      const outbox = new SqliteOntologyOutboxStorage(observePlans(db, plan), async (run) => run())
      const rows = await outbox.claim({
        projectId: "project",
        now: "2026-09-20T00:00:00.000Z",
        limit: 100,
        leaseId: "claim",
        leaseExpiresAt: "2026-09-20T00:01:00.000Z",
      })
      plan.length = 0
      const lease = {
        projectId: "project",
        ids: rows.map((row) => row.envelope.id),
        leaseId: "claim",
      }
      if (operation === "markPublished") {
        await outbox.markPublished({ ...lease, publishedAt: "2026-09-20T00:00:00.000Z" })
      } else {
        await outbox.reschedule({ ...lease, availableAt: "2026-09-20T00:00:00.000Z" })
      }
      expect(
        plan.some(
          (detail) =>
            detail.startsWith("SEARCH outbox ") && detail.includes("(project_id=? AND id=?)")
        )
      ).toBe(true)
    } finally {
      db.close()
    }
  })
}

function observePlans(db: Database, plans: string[]): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "query")
        return (sql: string) => {
          const statement = target.query(sql)
          return new Proxy(statement, {
            get(query, method) {
              if (method === "all" || method === "run")
                return (...bindings: SQLQueryBindings[]) => {
                  plans.push(
                    ...target
                      .query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
                      .all(...bindings)
                      .map((row) => row.detail)
                  )
                  return query[method](...bindings)
                }
              return Reflect.get(query, method, query)
            },
          })
        }
      return Reflect.get(target, property, target)
    },
  })
}

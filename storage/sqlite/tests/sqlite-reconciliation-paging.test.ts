import { Database, type SQLQueryBindings } from "bun:sqlite"
import { expect, test } from "bun:test"
import { installFreshSqliteSchema } from "../src/migrations"
import { SqliteObjectStorage } from "../src/objects/storage"
import { SqliteRulesStorage } from "../src/rules-storage"

// Regression proof: restore the `? IS NULL OR …` cursors, or filter rule states on
// `subject_kind = 'object'` again. Each page then starts at the first row of the object type (and
// sorts every rule state of the project), so one reconciliation pass is quadratic in its rows.
for (const analyzed of [false, true]) {
  test(`SQLite reconciliation pages seek to their cursor (statistics: ${analyzed})`, async () => {
    const db = new Database(":memory:")
    installFreshSqliteSchema(db)
    try {
      db.run(`WITH RECURSIVE ids(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM ids WHERE i < 100)
        INSERT INTO objects (
          project_id, object_type_id, primary_id, properties, created_at, updated_at, version,
          last_commit_id
        )
        SELECT 'project', 'Device', printf('d-%03d', i), '{}', 'c', 'u', 1, 'commit' FROM ids`)
      db.run(`INSERT INTO rule_states
        SELECT 'project', 'rule-' || (rowid % 2), 'object', 'Device', primary_id, '2026-10-07'
        FROM objects`)
      if (analyzed) db.run("ANALYZE")
      const plan: string[] = []
      const connection = {
        db: observePlans(db, plan),
        ownsConnection: false,
        installFreshSchema: false,
      }
      const rules = new SqliteRulesStorage({ connection })
      const objects = new SqliteObjectStorage({ connection })

      const firstStates = await rules.listReconciliationPage({ projectId: "project", limit: 60 })
      const nextStates = await rules.listReconciliationPage({
        projectId: "project",
        after: firstStates.next,
        limit: 60,
      })
      const firstObjects = await objects.listByPrimaryIdPage({
        projectId: "project",
        objectTypeId: "Device",
        limit: 60,
      })
      const nextObjects = await objects.listByPrimaryIdPage({
        projectId: "project",
        objectTypeId: "Device",
        afterPrimaryId: firstObjects.nextPrimaryId,
        limit: 60,
      })

      expect(firstStates.states.length + nextStates.states.length).toBe(100)
      expect(nextStates.next).toBeUndefined()
      expect(firstObjects.objects.length + nextObjects.objects.length).toBe(100)
      expect(nextObjects.nextPrimaryId).toBeUndefined()
      expect(plan.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([])
      expect(plan).toContain(
        "SEARCH rule_states USING INDEX sqlite_autoindex_rule_states_1 (project_id=? AND (rule_id,subject_kind,object_type_id,primary_id)>(?,?,?,?))"
      )
      expect(plan).toContain(
        "SEARCH objects USING INDEX sqlite_autoindex_objects_1 (project_id=? AND object_type_id=? AND primary_id>?)"
      )
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
              if (method === "all")
                return (...bindings: SQLQueryBindings[]) => {
                  plans.push(
                    ...target
                      .query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
                      .all(...bindings)
                      .map((row) => row.detail)
                  )
                  return query.all(...bindings)
                }
              return Reflect.get(query, method, query)
            },
          })
        }
      return Reflect.get(target, property, target)
    },
  })
}

import { Database, type SQLQueryBindings } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { OntologyLinkRef, OntologyObjectRef } from "@sixb/core/internal/materialization"
import { installFreshSqliteSchema } from "../src/migrations"
import { SqliteMaterializationStateReader } from "../src/ontology-storage/materialization-state"

interface RecordedQuery {
  readonly sql: string
  readonly bindings: readonly SQLQueryBindings[]
}

interface QueryPlanRow {
  readonly detail: string
}

const projectId = "query-plan-project"
const objectRef: OntologyObjectRef = { objectTypeId: "Employee", primaryId: "employee-1" }
const linkRef: OntologyLinkRef = {
  source: objectRef,
  linkId: "timecards",
  target: { objectTypeId: "Timecard", primaryId: "timecard-1" },
}

describe("SQLite materialization query plans", () => {
  // Regression proof: replacing the requested-first CROSS JOINs with reorderable JOINs makes
  // SQLite search the project tables on project_id alone, and these assertions fail.
  test("object state batches drive indexed lookups from the requested objects", () => {
    withRecordedReader(({ db, reader, recorded }) => {
      reader.objectStates([objectRef])

      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "SELECT objects.* FROM requested"),
        "SEARCH objects",
        ["project_id=?", "object_type_id=?", "primary_id=?"]
      )
      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "CROSS JOIN ontology_source_rows AS rows", "'object'"),
        "SEARCH rows",
        ["project_id=?", "object_type_id=?", "primary_id=?"]
      )
      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "SELECT overrides.* FROM requested", "'object'"),
        "SEARCH overrides",
        ["project_id=?", "object_type_id=?", "primary_id=?"]
      )
      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "ROW_NUMBER() OVER", "CROSS JOIN timeseries"),
        "SEARCH timeseries",
        ["project_id=?", "object_type_id=?", "object_id=?"]
      )
    })
  })

  test("link state batches drive indexed lookups from the requested links", () => {
    withRecordedReader(({ db, reader, recorded }) => {
      reader.linkStates([linkRef])

      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "SELECT links.* FROM requested"),
        "SEARCH links",
        [
          "project_id=?",
          "source_type_id=?",
          "source_id=?",
          "link_id=?",
          "target_type_id=?",
          "target_id=?",
        ]
      )
      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "CROSS JOIN ontology_source_rows AS rows", "'link'"),
        "SEARCH rows",
        [
          "project_id=?",
          "source_type_id=?",
          "source_primary_id=?",
          "link_id=?",
          "target_type_id=?",
          "target_primary_id=?",
        ]
      )
      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "SELECT overrides.* FROM requested", "'link'"),
        "SEARCH overrides",
        [
          "project_id=?",
          "source_type_id=?",
          "source_primary_id=?",
          "link_id=?",
          "target_type_id=?",
          "target_primary_id=?",
        ]
      )
    })
  })

  test("point and link-scope batches use their complete lookup keys", () => {
    withRecordedReader(({ db, reader, recorded }) => {
      reader.exactPoints([
        {
          series: { object: objectRef, propertyId: "workedMinutes" },
          at: "2026-08-06T00:00:00.000Z",
        },
      ])
      reader.linkScopes([{ source: objectRef, linkId: "timecards" }])

      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "SELECT timeseries.* FROM requested"),
        "SEARCH timeseries",
        ["project_id=?", "object_type_id=?", "object_id=?", "property_id=?", "at=?"]
      )
      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "SELECT requested.scope_sort_key, links.*"),
        "SEARCH links",
        ["project_id=?", "source_type_id=?", "source_id=?", "link_id=?"]
      )
    })
  })

  test("replacement source batches use entity kind and the full primary key", () => {
    withRecordedReader(({ db, reader, recorded }) => {
      reader.replacementObjectStates("employees", "materialization-1", [objectRef])

      expectRequestedFirstLookup(
        db,
        findRecorded(recorded, "requested_materializations", "SELECT rows.*"),
        "SEARCH rows",
        ["project_id=?", "source_id=?", "materialization_id=?", "entity_kind=?", "entity_key=?"]
      )
    })
  })
})

function withRecordedReader(
  run: (input: {
    readonly db: Database
    readonly reader: SqliteMaterializationStateReader
    readonly recorded: readonly RecordedQuery[]
  }) => void
): void {
  const db = new Database(":memory:")
  installFreshSqliteSchema(db)
  const recorded: RecordedQuery[] = []
  const reader = new SqliteMaterializationStateReader(recordingDatabase(db, recorded), projectId)
  try {
    run({ db, reader, recorded })
  } finally {
    db.close()
  }
}

function recordingDatabase(db: Database, recorded: RecordedQuery[]): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          const statement = target.query(sql)
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "all") {
                return (...bindings: SQLQueryBindings[]) => {
                  recorded.push({ sql, bindings })
                  return statementTarget.all(...bindings)
                }
              }
              if (statementProperty === "iterate") {
                return (...bindings: SQLQueryBindings[]) => {
                  recorded.push({ sql, bindings })
                  return statementTarget.iterate(...bindings)
                }
              }
              const value = Reflect.get(statementTarget, statementProperty, statementTarget)
              return typeof value === "function" ? value.bind(statementTarget) : value
            },
          })
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function findRecorded(
  recorded: readonly RecordedQuery[],
  ...fragments: readonly string[]
): RecordedQuery {
  const match = recorded.find(({ sql }) => fragments.every((fragment) => sql.includes(fragment)))
  expect(match).toBeDefined()
  return match!
}

function expectRequestedFirstLookup(
  db: Database,
  query: RecordedQuery,
  searchPrefix: string,
  keyFragments: readonly string[]
): void {
  const plan = db
    .query<QueryPlanRow, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...query.bindings)
  const lookupIndex = plan.findIndex(({ detail }) => detail.startsWith(searchPrefix))
  const requestedIndex = plan.findIndex(
    ({ detail }) => detail === "SCAN requested" || detail.startsWith("SCAN json_each")
  )

  expect(requestedIndex).toBeGreaterThanOrEqual(0)
  expect(lookupIndex).toBeGreaterThan(requestedIndex)
  for (const fragment of keyFragments) {
    expect(plan[lookupIndex]?.detail).toContain(fragment)
  }
}

import { Database, type SQLQueryBindings } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { OntologyLinkRef, OntologyObjectRef } from "@sixb/core/internal/materialization"
import { installFreshSqliteSchema } from "../src/migrations"
import {
  SQLITE_MATERIALIZATION_WORK_TABLE,
  SQLITE_REPLACEMENT_WORK_TABLE,
  SqliteMaterializationStateReader,
} from "../src/ontology-storage/materialization-state"

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
        findRecorded(recorded, "CROSS JOIN ontology_object_overrides AS overrides"),
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
        findRecorded(recorded, "CROSS JOIN ontology_link_overrides AS overrides", "'edge'"),
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

  test("prepares a linked replacement union once before paging it", () => {
    // Regression proof: restore per-page replacementLinkRows() construction and this records four
    // executions of the incident/replacement union (three one-row pages plus the terminal read).
    // The prepared implementation executes that union once, then keyset-pages its temp table.
    withRecordedReader(({ db, reader, recorded }) => {
      installReplacementWorkTables(db)
      insertReadyLinkCandidate(db, 3)

      const pages = [
        ...reader.replacementIdentities({
          sessionId: "session-1",
          sourceId: "employees",
          candidateMaterializationId: "candidate-1",
          previousMaterializationId: null,
          kind: "link",
          pageRows: 1,
        }),
      ]

      expect(pages).toHaveLength(3)
      expect(pages.flat()).toHaveLength(3)
      expect(recorded.filter(({ sql }) => sql.includes("WITH incident_objects AS")).length).toBe(1)
      expect(
        recorded.filter(
          ({ sql }) =>
            sql.includes(`FROM ${SQLITE_REPLACEMENT_WORK_TABLE}`) &&
            sql.includes("ORDER BY sort_key")
        ).length
      ).toBe(4)
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
              if (statementProperty === "run") {
                return (...bindings: SQLQueryBindings[]) => {
                  recorded.push({ sql, bindings })
                  return statementTarget.run(...bindings)
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

function installReplacementWorkTables(db: Database): void {
  db.run(`
    CREATE TEMP TABLE ${SQLITE_MATERIALIZATION_WORK_TABLE} (
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload))
    );
    CREATE TEMP TABLE ${SQLITE_REPLACEMENT_WORK_TABLE} (
      session_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      sort_key TEXT NOT NULL,
      diff_required INTEGER NOT NULL CHECK (diff_required IN (0, 1)),
      PRIMARY KEY (session_id, entity_kind, identity_key)
    );
    CREATE INDEX ontology_replacement_work_order
      ON ${SQLITE_REPLACEMENT_WORK_TABLE}(
        session_id, entity_kind, sort_key, identity_key
      );
  `)
}

function insertReadyLinkCandidate(db: Database, count: number): void {
  const timestamp = "2026-01-01T00:00:00.000Z"
  db.query(
    `INSERT INTO ontology_sources (
      project_id, source_id, materialization_id, projection_run_id,
      projection_kind, protocol, status, execution_token,
      dataset_id, dataset_version_id, dataset_version_created_at,
      projection_revision, ownership_hash, ontology_revision,
      root_count, assertion_count, created_at, ready_at, activated_at,
      terminal_at, last_commit_id, updated_at
    ) VALUES (?, 'employees', 'candidate-1', 'run-1',
      'object', 'replacement', 'ready', 'execution-1',
      'employees', 'version-1', ?, 'projection-revision', 'ownership-hash',
      'ontology-revision', ?, ?, ?, ?, NULL, NULL, NULL, ?)`
  ).run(projectId, timestamp, count, count, timestamp, timestamp, timestamp)

  const insert = db.query(
    `INSERT INTO ontology_source_rows (
      project_id, source_id, materialization_id,
      entity_kind, entity_key, entity_sort_key,
      root_kind, root_key, root_sort_key, staging_ordinal,
      root, assertion,
      object_type_id, primary_id,
      source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
      root_object_type_id, root_primary_id,
      root_source_type_id, root_source_primary_id, root_link_id,
      root_target_type_id, root_target_primary_id
    ) VALUES (?, 'employees', 'candidate-1',
      'link', json(?), ?, 'object', json(?), ?, ?, json(?), json(?),
      NULL, NULL, 'Employee', ?, 'timecards', 'Timecard', ?,
      'Employee', ?, NULL, NULL, NULL, NULL, NULL)`
  )
  for (let index = 0; index < count; index += 1) {
    const employeeId = `employee-${index}`
    const timecardId = `timecard-${index}`
    const root = { kind: "object", ref: { objectTypeId: "Employee", primaryId: employeeId } }
    const assertion = {
      kind: "link",
      ref: {
        source: root.ref,
        linkId: "timecards",
        target: { objectTypeId: "Timecard", primaryId: timecardId },
      },
    }
    insert.run(
      projectId,
      JSON.stringify(["link", "Employee", employeeId, "timecards", "Timecard", timecardId]),
      `entity-${index}`,
      JSON.stringify(["object", "Employee", employeeId]),
      `root-${index}`,
      index,
      JSON.stringify(root),
      JSON.stringify(assertion),
      employeeId,
      timecardId,
      employeeId
    )
  }
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

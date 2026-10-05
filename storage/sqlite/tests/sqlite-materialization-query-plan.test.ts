import { Database, type SQLQueryBindings } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { OntologyLinkRef, OntologyObjectRef } from "@sixb/core/internal/materialization"
import { installFreshSqliteSchema } from "../src/migrations"
import { SqliteMaterializationStateReader } from "../src/ontology-storage/materialization-state"
import {
  EXPAND_LINK_STATEMENTS,
  EXPAND_TOUCHED_STATEMENTS,
  identityRevision,
  TOUCHED_REFRESH_STATEMENTS,
} from "../src/ontology-storage/replacement-plans"

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
      const sourceRead = findRecorded(
        recorded,
        "CROSS JOIN ontology_source_roots AS roots",
        "CROSS JOIN ontology_source_rows AS rows"
      )
      expectRequestedFirstLookup(db, sourceRead, "SEARCH roots", ["project_id=?", "root_key=?"])
      expectRequestedFirstLookup(db, sourceRead, "SEARCH rows", ["root_id=?"])
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
      const sourceRead = findRecorded(
        recorded,
        "CROSS JOIN ontology_source_roots AS roots",
        "CROSS JOIN ontology_source_rows AS rows"
      )
      expectRequestedFirstLookup(db, sourceRead, "SEARCH roots", ["project_id=?", "root_key=?"])
      expectRequestedFirstLookup(db, sourceRead, "SEARCH rows", ["root_id=?"])
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

  // Regression proof: end migration 052 with `ANALYZE ontology_source_roots` again. On a fresh
  // install the statistics describe an empty table, and SQLite then reaches the roots through the
  // project's live-root index instead of each row's root id.
  test("link slot batches reach live roots through each requested row", () => {
    withRecordedReader(({ db, reader, recorded }) => {
      reader.linkSlotStates([{ source: objectRef, linkId: "timecards" }])

      const sourceRead = findRecorded(recorded, "rows.link_id = requested.link_id")
      expectRequestedFirstLookup(db, sourceRead, "SEARCH rows", [
        "source_type_id=?",
        "source_primary_id=?",
        "link_id=?",
      ])
      expectRequestedFirstLookup(db, sourceRead, "SEARCH roots", ["rowid=?"])
    })
  })

  test("point and link-scope revision batches use their complete lookup keys", () => {
    withRecordedReader(({ db, reader, recorded }) => {
      reader.exactPoints([
        {
          series: { object: objectRef, propertyId: "workedMinutes" },
          at: "2026-08-06T00:00:00.000Z",
        },
      ])
      reader.linkScopeRevisions([{ source: objectRef, linkId: "timecards" }])

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

  test("replacement source batches look up the candidate's roots by key", () => {
    withRecordedReader(({ db, reader, recorded }) => {
      reader.replacementObjectStates("employees", "materialization-1", [objectRef])

      const sourceRead = findRecorded(recorded, "requested_entities")
      expectRequestedFirstLookup(db, sourceRead, "SEARCH roots", ["version_id=?", "root_key=?"])
      expectRequestedFirstLookup(db, sourceRead, "SEARCH rows", ["root_id=?"])
    })
  })
})

describe("SQLite replacement plan query plans", () => {
  // Removal proof: compare a link's edge override by a bare `identity_key`, which resolves to the
  // override's own column and stops correlating; drop the `+` from the root's row lookup; or read
  // the latest points as the series' rows at their property's `MAX(at)`, which walks the history.
  test("identity revisions look every input up by the identity's own key", () => {
    const db = new Database(":memory:")
    installFreshSqliteSchema(db)
    try {
      for (const kind of ["object", "link"] as const) {
        const plan = db
          .query<QueryPlanRow, SQLQueryBindings[]>(
            `EXPLAIN QUERY PLAN SELECT identities.identity_key
             FROM ontology_replacement_plan_identities AS identities
             WHERE identities.version_id = $versionId AND identities.entity_kind = $entityKind
               AND identities.planned_revision IS NOT ${identityRevision(kind)}`
          )
          .all({ $projectId: projectId, $versionId: 1, $entityKind: kind })
          .map(({ detail }) => detail)

        // The only scan walks one object's telemetry property names, never a table.
        expect(
          plan.filter((detail) => detail.startsWith("SCAN") && detail !== "SCAN properties"),
          kind
        ).toEqual([])
        // A latest point is one seek in its own property's series.
        const points = plan.filter((detail) => detail.startsWith("SEARCH points"))
        expect(points.length, kind).toBeGreaterThan(0)
        expect(
          points.filter((detail) => !detail.includes("property_id=?")),
          kind
        ).toEqual([])
        expect(
          plan.filter(
            (detail) => detail.includes("SCALAR SUBQUERY") && !detail.startsWith("CORRELATED")
          ),
          kind
        ).toEqual([])
        if (kind === "link") {
          expect(plan).toContainEqual(expect.stringMatching(/^SEARCH overrides .*identity_key=\?/))
          expect(plan).toContainEqual(expect.stringMatching(/^SEARCH roots .*root_key=\?/))
          expect(plan).toContainEqual(expect.stringMatching(/^SEARCH rows .*\(root_id=\?\)/))
        }
      }
    } finally {
      db.close()
    }
  })
  // Removal proof: drop `INDEXED BY idx_links_target` or `idx_ontology_link_overrides_target`
  // from the incident statement; without statistics SQLite then searches the project's links or
  // overrides by `project_id` alone, once per incident object.
  test("link expansion seeks each incident object's links by its own key", () => {
    const db = new Database(":memory:")
    installFreshSqliteSchema(db)
    try {
      for (const [name, statement] of Object.entries(EXPAND_LINK_STATEMENTS)) {
        const plan = db
          .query<QueryPlanRow, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${statement}`)
          .all({ $projectId: projectId, $versionId: 1 })
          .map(({ detail }) => detail)
        const ctes = ["incident_objects", "incident_links", "scopes", "members"]
        expect(
          plan.filter(
            (detail) => detail.startsWith("SCAN") && !ctes.includes(detail.slice("SCAN ".length))
          ),
          name
        ).toEqual([])
        const seeks = plan.filter((detail) => /^SEARCH (links|overrides) /.test(detail))
        expect(seeks.length, name).toBeGreaterThan(0)
        expect(
          seeks.filter((detail) => !/(source|target)_(type_)?id=\?/.test(detail)),
          name
        ).toEqual([])
      }
    } finally {
      db.close()
    }
  })
  // Removal proof: drop the `touched` filter from a refresh statement, or the bound on
  // `expand_at` from link expansion; the statement then walks the plan's identities by version.
  test("refresh and link expansion seek only what changed, never the whole plan", () => {
    const db = new Database(":memory:")
    installFreshSqliteSchema(db)
    try {
      const statements = {
        "refresh.object": TOUCHED_REFRESH_STATEMENTS.object,
        "refresh.link": TOUCHED_REFRESH_STATEMENTS.link,
        "touched.incident": EXPAND_TOUCHED_STATEMENTS.incident,
        "touched.members": EXPAND_TOUCHED_STATEMENTS.members,
        "expand.incident": EXPAND_LINK_STATEMENTS.incident,
        "expand.members": EXPAND_LINK_STATEMENTS.members,
      }
      const ctes = [
        "touched",
        "candidates",
        "incident_objects",
        "incident_links",
        "scopes",
        "members",
      ]
      for (const [name, statement] of Object.entries(statements)) {
        const plan = db
          .query<QueryPlanRow, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${statement}`)
          .all({ $projectId: projectId, $versionId: 1 })
          .map(({ detail }) => detail)
        expect(
          plan.filter(
            (detail) =>
              detail.startsWith("SCAN") &&
              ![...ctes, "properties"].includes(detail.slice("SCAN ".length))
          ),
          name
        ).toEqual([])
        // A plan's identities are sought by key, by endpoint or by the expansion they wait for.
        const identityIndex = /USING (COVERING )?INDEX \w*ontology_replacement_plan_identities/
        const byKey = /(identity_key|source_key|target_key|expand_at)[=>]\?/
        expect(
          plan.filter((detail) => identityIndex.test(detail) && !byKey.test(detail)),
          name
        ).toEqual([])
      }
    } finally {
      db.close()
    }
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
    ({ detail }) =>
      detail === "SCAN requested" ||
      detail === "SCAN requested_entities" ||
      detail.startsWith("SCAN json_each")
  )

  expect(requestedIndex).toBeGreaterThanOrEqual(0)
  expect(lookupIndex).toBeGreaterThan(requestedIndex)
  for (const fragment of keyFragments) {
    expect(plan[lookupIndex]?.detail).toContain(fragment)
  }
}

import { expect, test } from "bun:test"
import postgresSchema from "../../pg/src/migrations/001-initial-schema.sql" with { type: "text" }
import sqliteSchema from "../src/migrations/001-initial-schema.sql" with { type: "text" }

const ontologyTables = [
  "ontology_commits",
  "ontology_sources",
  "ontology_source_rows",
  "ontology_overrides",
  "ontology_outbox",
] as const

test("SQLite and PostgreSQL ontology schemas have logical table and index parity", () => {
  expect(applicationTables(sqliteSchema).filter((name) => name.startsWith("ontology_"))).toEqual([
    ...ontologyTables,
  ])
  expect(applicationTables(postgresSchema).filter((name) => name.startsWith("ontology_"))).toEqual([
    ...ontologyTables,
  ])

  const parityTables = [...ontologyTables, "objects", "links", "timeseries", "projection_runs"]
  for (const table of parityTables) {
    expect(tableColumns(sqliteSchema, table), `SQLite/PostgreSQL columns for ${table}`).toEqual(
      tableColumns(postgresSchema, table)
    )
  }

  expect(applicationIndexes(sqliteSchema, parityTables)).toEqual(
    applicationIndexes(postgresSchema, parityTables).filter(
      ({ name }) => name !== "idx_objects_properties"
    )
  )
})

function applicationTables(schema: string): string[] {
  return [...schema.matchAll(/^CREATE TABLE ([a-z0-9_]+) \(/gm)].map((match) => match[1] ?? "")
}

function applicationIndexes(schema: string, tables: readonly string[]) {
  return [...schema.matchAll(/^CREATE (UNIQUE )?INDEX ([a-z0-9_]+)\s+ON ([a-z0-9_]+)\s*\(/gm)]
    .flatMap((match) => {
      const [, unique, name, table] = match
      if (!name || !table || !tables.includes(table)) return []
      return [{ name, table, unique: unique !== undefined }]
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function tableColumns(schema: string, table: string): string[] {
  const match = new RegExp(`^CREATE TABLE ${table} \\(([\\s\\S]*?)^\\);`, "m").exec(schema)
  if (!match?.[1]) throw new Error(`Missing table '${table}'.`)
  return match[1].split("\n").flatMap((line) => {
    const column = /^ {2}([a-z][a-z0-9_]*)\s/.exec(line)?.[1]
    if (!column || ["primary", "unique", "check", "foreign"].includes(column)) return []
    return [column]
  })
}

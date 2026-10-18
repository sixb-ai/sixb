import { describe, expect, test } from "bun:test"
import { sql } from "../src"

function createContext() {
  return {
    projectId: "demo",
    connectorId: "erpDb",
    signal: new AbortController().signal,
  }
}

describe("sql connector", () => {
  test("creates a sql adapter, runs queries, and closes the client on disconnect", async () => {
    const adapter = sql(":memory:")
    const client = await adapter.connect(createContext())

    await client`create table users (id integer primary key, name text)`
    await client`insert into users (name) values (${"Alice"})`

    const rows = await client`select name from users`

    expect(adapter.type).toBe("sql")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe("Alice")

    await adapter.disconnect?.(client)

    const closed = await client`select 1 as value`.catch((error: unknown) => error)
    expect(closed).toBeInstanceOf(Error)
    expect((closed as Error).message).toContain("Connection closed")
  })

  test("supports Bun SQL constructor options", async () => {
    const adapter = sql({ adapter: "sqlite", filename: ":memory:" })
    const client = await adapter.connect(createContext())

    const rows = await client`select ${1} as value`

    expect(rows[0]?.value).toBe(1)

    await adapter.disconnect?.(client)
  })

  test("rejects an empty connection string", () => {
    expect(() => sql("   ")).toThrow("[SixbSql] connection must not be empty.")
  })
})

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
  test("creates a sql adapter and runs queries", async () => {
    const adapter = sql(":memory:")
    const client = await adapter.connect(createContext())

    await client`create table users (id integer primary key, name text)`
    await client`insert into users (name) values (${"Alice"})`

    const rows = await client`select name from users`

    expect(adapter.type).toBe("sql")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe("Alice")

    await adapter.disconnect?.(client)
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

  test("closes the Bun SQL client on disconnect", async () => {
    const adapter = sql(":memory:")
    const client = await adapter.connect(createContext())

    await adapter.disconnect?.(client)

    try {
      await client`select 1 as value`
      throw new Error("Expected querying a closed SQL client to fail.")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("Connection closed")
    }
  })
})

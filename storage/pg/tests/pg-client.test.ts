import { describe, expect, test } from "bun:test"
import { createPgClient } from "../src/pg-client"

// The pool opens no connection until its first query, so configuration errors surface here
// without a database.
function client(connectionString: string, ssl?: "require" | "prefer") {
  return createPgClient({ connectionString, max: 1, schemaName: "public", ssl })
}

describe("createPgClient direct TLS", () => {
  test.each([
    "postgres://db.example:5432/app?sslnegotiation=direct&sslmode=require",
    "postgres://db.example:5432/app?sslnegotiation=direct&sslmode=verify-full",
    "postgres://db.example:5432/app?sslnegotiation=direct&sslrootcert=system",
  ])("accepts %s", async (connectionString) => {
    await client(connectionString).end()
  })

  test("accepts the ssl option as the sslmode", async () => {
    await client("postgres://db.example:5432/app?sslnegotiation=direct", "require").end()
  })

  test.each([
    ["postgres://db.example:5432/app?sslnegotiation=direct", "got no sslmode"],
    ["postgres://db.example:5432/app?sslnegotiation=direct&sslmode=prefer", 'got "prefer"'],
    ["postgres://db.example:5432/app?sslnegotiation=direct&sslmode=disable", 'got "disable"'],
  ])("refuses a mode that could fall back to plaintext: %s", (connectionString, message) => {
    expect(() => client(connectionString)).toThrow(message)
  })

  test("refuses several hosts", () => {
    expect(() =>
      client("postgres://a.example:5432,b.example:5432/app?sslnegotiation=direct&sslmode=require")
    ).toThrow("one TCP host:port")
  })
})

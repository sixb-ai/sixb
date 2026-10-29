import { describe, expect, test } from "bun:test"
import { createPgClient } from "../src/pg-client"

function databaseUrl(query: string): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error("[SixbPg] DATABASE_URL is required. Run `bun run test:e2e` from @sixb/pg.")
  }
  return `${url}?${query}`
}

describe("PostgreSQL direct TLS (sslnegotiation=direct)", () => {
  test("verifies the certificate under verify-full", async () => {
    // The test server presents a self-signed certificate.
    const sql = createPgClient({
      connectionString: databaseUrl("sslnegotiation=direct&sslmode=verify-full"),
      max: 1,
      schemaName: "public",
    })
    try {
      // Caught by hand: a porsager query runs only when its `then` is called, which Bun's
      // `expect(...).rejects` never does, so the matcher would wait forever.
      const error = await sql`SELECT 1`.then(
        () => null,
        (caught: unknown) => caught
      )
      expect(error).toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })
    } finally {
      await sql.end({ timeout: 0 })
    }
  })

  // Plain connections are accepted too, so this proves the direct path encrypts. To see it fail,
  // return `net.connect({ host, port })` instead of the TLS socket from `directTlsSocket`.
  test("opens an encrypted session", async () => {
    const sql = createPgClient({
      connectionString: databaseUrl("sslnegotiation=direct&sslmode=require"),
      max: 1,
      schemaName: "public",
    })
    try {
      const [session] = await sql<{ ssl: boolean }[]>`
        SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()
      `
      expect(session?.ssl).toBe(true)
    } finally {
      await sql.end({ timeout: 0 })
    }
  })
})

import { describe, expect, test } from "bun:test"
import { createPgClient } from "../src/pg-client"

const FIXTURE = `${import.meta.dir}/fixtures/tls-read.ts`

function databaseUrl(query: string): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error("[SixbPg] DATABASE_URL is required. Run `bun run test:e2e` from @sixb/pg.")
  }
  return `${url}?${query}`
}

describe("PostgreSQL direct TLS (sslnegotiation=direct)", () => {
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
      await sql.end()
    }
  })

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

  // To see this guard fail, run the fixture with "classic" instead of "direct" on Bun 1.4.0–1.4.2:
  // the SSLRequest upgrade path keeps every byte it receives (measured: +390 MB for 256 MB read,
  // against a flat ~90 MB for direct TLS whatever the volume).
  test("does not retain what it reads", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, FIXTURE, "direct"],
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
    const report = JSON.parse(stdout) as {
      readonly ssl: boolean
      readonly receivedMebibytes: number
      readonly grownMebibytes: number
    }
    expect(report.ssl).toBe(true)
    expect(report.grownMebibytes).toBeLessThan(report.receivedMebibytes / 2)
  }, 70_000)
})

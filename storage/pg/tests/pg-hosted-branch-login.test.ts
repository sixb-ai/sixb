import { expect, test } from "bun:test"
import { hostedBranchLoginUrl } from "../src/hosted-branches"

const login = { user: "sixb_branch_a_0123", password: "p@ss/word" }

// A production configured by host and port once gave its branches a URL with no TLS at all, so a
// branch in a remote sandbox reached production's instance in plain text.
// Guard check: return null from `sslModeOf` in `hosted-branches.ts`.
test("keeps production's TLS setting when production is configured by host and port", () => {
  const url = new URL(
    hostedBranchLoginUrl(
      { host: "db.internal", port: 6543, database: "shop", ssl: "require" },
      login
    )
  )

  expect(url.host).toBe("db.internal:6543")
  expect(url.pathname).toBe("/shop")
  expect(url.searchParams.get("sslmode")).toBe("require")
  expect(decodeURIComponent(url.username)).toBe(login.user)
  expect(decodeURIComponent(url.password)).toBe(login.password)

  expect(
    new URL(hostedBranchLoginUrl({ host: "db.internal", ssl: true }, login)).searchParams.get(
      "sslmode"
    )
  ).toBe("verify-full")
  expect(new URL(hostedBranchLoginUrl({ host: "db.internal" }, login)).search).toBe("")
})

test("keeps every parameter of production's connection string, its own sslmode first", () => {
  const url = new URL(
    hostedBranchLoginUrl(
      {
        connectionString:
          "postgres://prod:secret@db.example.com:5432/shop?sslmode=verify-full&sslrootcert=system",
        ssl: "require",
      },
      login
    )
  )

  expect(url.searchParams.get("sslmode")).toBe("verify-full")
  expect(url.searchParams.get("sslrootcert")).toBe("system")
  expect(decodeURIComponent(url.username)).toBe(login.user)
})

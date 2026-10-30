import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createInstanceApiClient } from "../src"
import { users } from "../src/commands/users"
import { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

const AVA = { id: "usr_ava", email: "ava@acme.com", status: "active" }

function startDirectory() {
  const requests: string[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      const email = url.searchParams.get("email")
      const users = email === "ava@acme.com" ? [AVA] : []
      return Response.json({ users, hasMore: false, total: users.length })
    },
  })

  const api = createInstanceApiClient({
    kind: "local",
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "sixb_pat_test.secret",
    profile: "test",
  })
  return { api, requests }
}

async function run(args: readonly string[]) {
  const { api, requests } = startDirectory()
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)

  try {
    await users(api, args)
    return { requests, output: stdout.mock.calls.map(([chunk]) => String(chunk)).join("") }
  } finally {
    stdout.mockRestore()
  }
}

describe("sixb users", () => {
  test("lists active members by default, with the CLI's page size", async () => {
    const { requests, output } = await run(["list"])

    expect(requests).toEqual(["/api/users?status=active&limit=20"])
    expect(JSON.parse(output)).toEqual({ users: [], hasMore: false, total: 0 })
  })

  test("searches by name or email with the list options", async () => {
    const { requests } = await run(["search", "Ava M", "--status", "all", "--limit", "5"])

    expect(requests).toEqual(["/api/users?status=all&limit=5&search=Ava+M"])
  })

  test("gets one member by id", async () => {
    const { requests } = await run(["get", "usr/1"])

    expect(requests).toEqual(["/api/users/usr%2F1"])
  })

  test("gets one member by email, keeping it out of the path", async () => {
    const { requests, output } = await run(["get", "ava@acme.com"])

    expect(requests).toEqual(["/api/users?email=ava%40acme.com"])
    expect(JSON.parse(output)).toEqual(AVA)
  })

  test("fails when no member has the email", async () => {
    const error = await run(["get", "dan@acme.com"]).catch((caught) => caught)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).body).toEqual({
      code: "not_found",
      message: "No member has the email 'dan@acme.com'.",
    })
  })

  test("rejects bad options before any request", async () => {
    const cases: readonly (readonly string[])[] = [
      ["list", "--status", "invited"],
      ["list", "--limit", "0"],
      ["list", "--limit", "201"],
      ["list", "--offset", "-1"],
      ["search", "   "],
      ["search"],
      ["get"],
      ["get", "  "],
      ["remove", "usr_1"],
    ]

    for (const args of cases) {
      const { api, requests } = startDirectory()
      await expect(users(api, args)).rejects.toBeInstanceOf(CliError)
      expect(requests).toEqual([])
      server?.stop(true)
    }
  })
})

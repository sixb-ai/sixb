import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createInstanceApiClient } from "../src"
import { users } from "../src/commands/users"
import { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

function startDirectory() {
  const requests: string[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      return Response.json({ users: [], hasMore: false, total: 0 })
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

  test("rejects bad options before any request", async () => {
    const cases: readonly (readonly string[])[] = [
      ["list", "--status", "invited"],
      ["list", "--limit", "0"],
      ["list", "--limit", "201"],
      ["list", "--offset", "-1"],
      ["search", "   "],
      ["search"],
      ["get"],
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

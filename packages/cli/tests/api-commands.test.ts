import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createInstanceApiClient, renderKeyValues, renderTable } from "../src"
import { dispatch } from "../src/commands"
import { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly body?: unknown
}

function startApi(responder?: (request: Request, url: URL) => Response | Promise<Response>): {
  readonly api: ReturnType<typeof createInstanceApiClient>
  readonly requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  server?.stop(true)
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text =
        request.method === "POST" || request.method === "PUT" || request.method === "PATCH"
          ? await request.text()
          : ""
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        ...(text ? { body: JSON.parse(text) } : {}),
      })
      if (responder) return responder(request, url)
      return Response.json({ ok: true })
    },
  })
  return {
    api: createInstanceApiClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: "sixb_at_session.secret",
    }),
    requests,
  }
}

async function runCommand(
  args: readonly string[],
  options: {
    readonly token?: string
    readonly responder?: (request: Request, url: URL) => Response | Promise<Response>
  } = {}
) {
  const { api: defaultApi, requests } = startApi(options.responder)
  const api = options.token
    ? createInstanceApiClient({ baseUrl: defaultApi.baseUrl, token: options.token })
    : defaultApi
  const chunks: string[] = []
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    const error = await dispatch(api, args[0] ?? "", args.slice(1)).then(
      () => undefined,
      (caught: unknown) => caught
    )
    return { requests, output: chunks.join(""), error }
  } finally {
    stdout.mockRestore()
  }
}

describe("sixb api escape hatch", () => {
  test("sends GET, POST, and DELETE requests to relative /api/ paths with query and JSON input", async () => {
    const get = await runCommand(["api", "GET", "/api/project", "--query", "expand=true"])
    expect(get.error).toBeUndefined()
    expect(get.requests).toEqual([{ method: "GET", path: "/api/project?expand=true" }])

    const post = await runCommand([
      "api",
      "post",
      "/api/share-grants",
      "--input",
      '{"definitionId":"share_1"}',
    ])
    expect(post.error).toBeUndefined()
    expect(post.requests).toEqual([
      { method: "POST", path: "/api/share-grants", body: { definitionId: "share_1" } },
    ])

    const del = await runCommand(["api", "DELETE", "/api/share-grants/grant_1"])
    expect(del.error).toBeUndefined()
    expect(del.requests).toEqual([{ method: "DELETE", path: "/api/share-grants/grant_1" }])
  })

  test("refuses non-/api/ paths, external origins, and unknown header flags", async () => {
    for (const args of [
      ["api", "GET", "https://attacker.invalid/api/project"],
      ["api", "GET", "/health"],
      ["api", "GET", "/api/project", "--header", "Authorization: secret"],
      ["api", "GET", "/api/project", "--input", "{}"],
    ]) {
      const result = await runCommand(args)
      expect(result.error).toBeInstanceOf(CliError)
      expect((result.error as CliError).exitCode).toBe(2)
      expect(result.requests).toHaveLength(0)
    }
  })
})

describe("sixb tokens and service-accounts", () => {
  test("lists, creates, and revokes personal access tokens", async () => {
    const listed = await runCommand(["tokens", "list"])
    expect(listed.error).toBeUndefined()
    expect(listed.requests).toEqual([{ method: "GET", path: "/api/auth/access-tokens" }])

    const created = await runCommand([
      "tokens",
      "create",
      "CI",
      "--expires-at",
      "2099-01-01T00:00:00.000Z",
      "--group",
      "eng",
    ])
    expect(created.error).toBeUndefined()
    expect(created.requests).toEqual([
      {
        method: "POST",
        path: "/api/auth/access-tokens",
        body: { name: "CI", expiresAt: "2099-01-01T00:00:00.000Z", groupIds: ["eng"] },
      },
    ])

    const revoked = await runCommand(["tokens", "revoke", "tok_1"])
    expect(revoked.error).toBeUndefined()
    expect(revoked.requests).toEqual([
      { method: "POST", path: "/api/auth/access-tokens/tok_1/revoke", body: {} },
    ])
  })

  test("refuses creating a token with a personal access token before calling the API", async () => {
    const result = await runCommand(["tokens", "create", "CI"], {
      token: "sixb_pat_existing.secret",
    })
    expect(result.error).toBeInstanceOf(CliError)
    expect((result.error as CliError).body.code).toBe("session_required")
    expect(result.requests).toHaveLength(0)
  })

  test("manages service accounts and their tokens", async () => {
    expect((await runCommand(["service-accounts", "list"])).requests).toEqual([
      { method: "GET", path: "/api/auth/service-accounts" },
    ])
    expect(
      (await runCommand(["service-accounts", "create", "Bot", "--id", "sa_bot"])).requests
    ).toEqual([
      { method: "POST", path: "/api/auth/service-accounts", body: { id: "sa_bot", name: "Bot" } },
    ])
    expect((await runCommand(["service-accounts", "disable", "sa_bot"])).requests).toEqual([
      { method: "POST", path: "/api/auth/service-accounts/sa_bot/disable", body: {} },
    ])
    expect((await runCommand(["service-accounts", "tokens", "list", "sa_bot"])).requests).toEqual([
      { method: "GET", path: "/api/auth/service-accounts/sa_bot/access-tokens" },
    ])
    expect(
      (await runCommand(["service-accounts", "tokens", "create", "sa_bot", "Deploy"])).requests
    ).toEqual([
      {
        method: "POST",
        path: "/api/auth/service-accounts/sa_bot/access-tokens",
        body: { name: "Deploy" },
      },
    ])
    expect(
      (await runCommand(["service-accounts", "tokens", "revoke", "sa_bot", "tok_2"])).requests
    ).toEqual([
      {
        method: "POST",
        path: "/api/auth/service-accounts/sa_bot/access-tokens/tok_2/revoke",
        body: {},
      },
    ])
  })
})

describe("expanded API coverage", () => {
  test("triggers syncs and pipelines, and cancels workflow runs", async () => {
    expect((await runCommand(["syncs", "run", "crm"])).requests).toEqual([
      { method: "POST", path: "/api/syncs/crm/runs", body: {} },
    ])
    expect((await runCommand(["pipelines", "run", "daily"])).requests).toEqual([
      { method: "POST", path: "/api/pipelines/daily/runs", body: {} },
    ])
    expect((await runCommand(["workflow-runs", "cancel", "run_1"])).requests).toEqual([
      { method: "POST", path: "/api/workflow-runs/run_1/cancel", body: {} },
    ])
  })

  test("covers artifacts CRUD, shares, logs, activity, and connectors", async () => {
    expect((await runCommand(["artifacts", "list", "--limit", "10"])).requests).toEqual([
      { method: "GET", path: "/api/artifacts?limit=10" },
    ])
    expect((await runCommand(["artifacts", "get", "art_1"])).requests).toEqual([
      { method: "GET", path: "/api/artifacts/art_1" },
    ])
    expect((await runCommand(["artifacts", "version", "art_1", "2"])).requests).toEqual([
      { method: "GET", path: "/api/artifacts/art_1/versions/2" },
    ])
    expect((await runCommand(["artifacts", "freeze", "art_1"])).requests).toEqual([
      { method: "POST", path: "/api/artifacts/art_1/freeze", body: {} },
    ])
    expect((await runCommand(["artifacts", "delete", "art_1"])).requests).toEqual([
      { method: "DELETE", path: "/api/artifacts/art_1" },
    ])

    expect((await runCommand(["shares", "list", "--definition", "inv"])).requests).toEqual([
      { method: "GET", path: "/api/share-grants?definitionId=inv" },
    ])
    expect((await runCommand(["shares", "revoke", "gr_1"])).requests).toEqual([
      { method: "DELETE", path: "/api/share-grants/gr_1" },
    ])

    expect(
      (await runCommand(["logs", "list", "--level", "error", "--limit", "5"])).requests
    ).toEqual([{ method: "GET", path: "/api/logs?limit=5&level=error" }])
    expect((await runCommand(["activity", "summary"])).requests).toEqual([
      { method: "GET", path: "/api/activity/summary" },
    ])
    expect((await runCommand(["connectors", "accounts", "github"])).requests).toEqual([
      { method: "GET", path: "/api/connectors/github/accounts" },
    ])
  })
})

describe("plain-text TTY formatters", () => {
  test("renders aligned tables and key-value summaries without React or OpenTUI", () => {
    const table = renderTable({
      subtitle: "1 visible",
      headers: ["Name", "ID"],
      rows: [["CI", "tok_1"]],
    })
    expect(table).toContain("1 visible")
    expect(table).toContain("Name  ID")
    expect(table).toContain("CI    tok_1")

    const kv = renderKeyValues({
      title: "Connected",
      items: [
        { label: "Project", value: "acme" },
        { label: "API", value: "https://api.acme.test" },
      ],
    })
    expect(kv).toContain("Connected")
    expect(kv).toContain("Project: acme")
    expect(kv).toContain("API    : https://api.acme.test")
  })
})

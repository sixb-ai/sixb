import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInstanceApiClient } from "../src"
import { artifacts } from "../src/commands/artifacts"
import { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

const anchor = { board: "welcome", element: "body>main:0>h1:0", label: "Welcome", revision: 3 }
const COMMENTS = [
  { id: "cmt_open", anchor, body: "Warmer title", authorName: "Ava" },
  {
    id: "cmt_done",
    anchor,
    body: "Bigger logo",
    authorName: "Ava",
    resolvedAt: "2026-11-08T09:00:00Z",
  },
  { id: "cmt_reply", parentId: "cmt_open", anchor, body: "Agreed", authorName: "Bob" },
]

/** The comments API, recording each request with its body. */
function startApi() {
  const requests: string[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.text() : ""
      requests.push(`${request.method} ${url.pathname}${body ? ` ${body}` : ""}`)
      if (request.method === "GET") return Response.json({ comments: COMMENTS })
      return Response.json({ id: "cmt_new" }, { status: request.method === "POST" ? 201 : 200 })
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
  const { api, requests } = startApi()
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)

  try {
    await artifacts(api, args)
    return { requests, output: stdout.mock.calls.map(([chunk]) => String(chunk)).join("") }
  } finally {
    stdout.mockRestore()
  }
}

describe("sixb artifacts comments", () => {
  // Guard proof: drop the status filter in threadsOf; the resolved thread is listed as open.
  test("lists the open threads by default, each with its replies", async () => {
    const { requests, output } = await run(["comments", "list", "art_1"])

    expect(requests).toEqual(["GET /api/artifacts/art_1/comments"])
    expect(JSON.parse(output)).toEqual({
      threads: [{ ...COMMENTS[0], replies: [COMMENTS[2]] }],
    })
  })

  test("lists the resolved threads, or all of them", async () => {
    const resolved = await run(["comments", "list", "art_1", "--status", "resolved"])
    expect(JSON.parse(resolved.output).threads.map(({ id }: { id: string }) => id)).toEqual([
      "cmt_done",
    ])

    const all = await run(["comments", "list", "art_1", "--status", "all"])
    expect(JSON.parse(all.output).threads.map(({ id }: { id: string }) => id)).toEqual([
      "cmt_open",
      "cmt_done",
    ])
  })

  test("resolves a comment, or opens it again", async () => {
    const resolved = await run(["comments", "resolve", "art_1", "cmt_open"])
    expect(resolved.requests).toEqual([
      'POST /api/artifacts/art_1/comments/cmt_open/resolve {"resolved":true}',
    ])

    const reopened = await run(["comments", "resolve", "art_1", "cmt_open", "--reopen"])
    expect(reopened.requests).toEqual([
      'POST /api/artifacts/art_1/comments/cmt_open/resolve {"resolved":false}',
    ])
  })

  test("replies to a comment, under it", async () => {
    const { requests } = await run([
      "comments",
      "reply",
      "art_1",
      "cmt_open",
      "  The chart is drawn by a script: I changed its data instead.  ",
    ])

    expect(requests).toEqual([
      'POST /api/artifacts/art_1/comments {"body":"The chart is drawn by a script: I changed its data instead.","parentId":"cmt_open"}',
    ])
  })

  test("refuses what it cannot send before any request", async () => {
    const cases: readonly (readonly string[])[] = [
      ["notes", "list", "art_1"],
      ["comments", "list"],
      ["comments", "list", "..", "--status", "open"],
      ["comments", "list", "art_1", "--status", "closed"],
      ["comments", "resolve", "art_1"],
      ["comments", "reply", "art_1", "cmt_open", "   "],
      ["comments", "reply", "art_1", "cmt_open", "x".repeat(4_001)],
      ["comments", "delete", "art_1", "cmt_open"],
    ]

    for (const args of cases) {
      const { api, requests } = startApi()
      const error = await artifacts(api, args).catch((caught: unknown) => caught)
      expect(error, args.join(" ")).toBeInstanceOf(CliError)
      expect(requests).toEqual([])
      server?.stop(true)
    }
  })
})

describe("sixb artifacts export", () => {
  /** The video route, answering each ask in turn with the next of `answers`, then the MP4. */
  function startVideoApi(answers: readonly unknown[]) {
    const requests: string[] = []
    let asked = 0
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requests.push(`${request.method} ${url.pathname}${url.search}`)
        if (request.method === "GET") return new Response("the mp4")
        const answer = answers[Math.min(asked, answers.length - 1)]
        asked += 1
        return Response.json(answer)
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

  async function exportWith(answers: readonly unknown[], args: readonly string[]) {
    const { api, requests } = startVideoApi(answers)
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const error = await artifacts(api, ["export", ...args]).then(
        () => undefined,
        (failure: unknown) => failure
      )
      return {
        error,
        requests,
        output: stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
      }
    } finally {
      stdout.mockRestore()
    }
  }

  const rendering = { status: "rendering", progress: { ready: 1, total: 4, assembling: false } }
  const ready = { status: "ready", durationMs: 7000, sizeBytes: 7 }

  test("asks for the MP4 of the latest version, and prints how far it has come", async () => {
    const { requests, output } = await exportWith([rendering], ["art_v1"])
    expect(requests).toEqual(["POST /api/artifacts/art_v1/versions/latest/video"])
    expect(JSON.parse(output)).toEqual(rendering)
  })

  test("downloads the MP4 once rendered, of the version asked for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sixb-export-"))
    try {
      const output = join(dir, "launch.mp4")
      const run = await exportWith([ready], ["art_v1", "--version", "2", "--output", output])
      expect(run.requests).toEqual([
        "POST /api/artifacts/art_v1/versions/2/video",
        "GET /api/artifacts/art_v1/versions/2/video",
      ])
      expect(readFileSync(output, "utf8")).toBe("the mp4")
      expect(JSON.parse(run.output)).toEqual({ ...ready, downloaded: true, output })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("says why it could not render, and asks anew with --retry", async () => {
    const failed = { status: "failed", reason: "Scene 'demo' could not be rendered." }
    const run = await exportWith([failed], ["art_v1", "--output", "unused.mp4"])
    expect(run.error).toBeInstanceOf(CliError)
    expect((run.error as CliError).message).toContain("Scene 'demo' could not be rendered.")
    expect(run.requests).toHaveLength(1)

    const retried = await exportWith([rendering], ["art_v1", "--retry"])
    expect(retried.requests).toEqual([
      "POST /api/artifacts/art_v1/versions/latest/video?retry=true",
    ])
    expect((await exportWith([], ["art_v1", "--version", "two"])).error).toBeInstanceOf(CliError)
  })
})

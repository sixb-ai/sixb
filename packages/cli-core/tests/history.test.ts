import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createInstanceApiClient } from "../src"
import { history } from "../src/commands/history"
import { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined
const threadId = process.env.SIXB_THREAD_ID

afterEach(() => {
  server?.stop(true)
  server = undefined
  if (threadId === undefined) delete process.env.SIXB_THREAD_ID
  else process.env.SIXB_THREAD_ID = threadId
})

const MESSAGES = [
  {
    seq: 1,
    role: "user",
    createdAt: "2026-10-31T14:03:00.000Z",
    authorPrincipal: { type: "user", id: "usr_ava" },
    parts: [
      { type: "text", text: `Fix the login page. ${"x".repeat(5_000)}` },
      {
        type: "file",
        fileRef: { blobId: "blob_1", fileName: "login.png", mediaType: "image/png" },
      },
    ],
  },
  {
    seq: 2,
    role: "assistant",
    createdAt: "2026-10-31T14:04:00.000Z",
    parts: [
      { type: "reasoning", text: "private thoughts" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "bash",
        input: { command: "ls src" },
        state: "output-available",
        output: { exitCode: 0, stdout: "login.tsx" },
      },
      { type: "text", text: "The page is fixed." },
    ],
  },
]

function startThread(
  page: { readonly offset: number; readonly limit: number },
  stored: readonly unknown[] = MESSAGES
) {
  const requests: string[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      const messages = stored.slice(page.offset, page.offset + page.limit)
      return Response.json({
        messages,
        authors: [{ type: "user", id: "usr_ava", displayName: "Ava" }],
        hasMore: page.offset + messages.length < 3,
        total: 3,
      })
    },
  })

  const api = createInstanceApiClient({
    kind: "local",
    baseUrl: `http://127.0.0.1:${server.port}`,
  })
  return { api, requests }
}

async function run(
  args: readonly string[],
  page = { offset: 0, limit: 20 },
  stored: readonly unknown[] = MESSAGES
) {
  const { api, requests } = startThread(page, stored)
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)

  try {
    await history(api, args)
    return { requests, output: stdout.mock.calls.map(([chunk]) => String(chunk)).join("") }
  } finally {
    stdout.mockRestore()
  }
}

describe("sixb history", () => {
  test("prints the run's conversation as text, oldest first, a page at a time", async () => {
    process.env.SIXB_THREAD_ID = "thread/1"
    const { requests, output } = await run(["--limit", "2"], { offset: 0, limit: 2 })

    expect(requests).toEqual(["/api/agent-threads/thread%2F1/messages?order=asc&offset=0&limit=2"])
    expect(output).toContain("── #1 user · Ava · 2026-10-31T14:03:00.000Z\nFix the login page.")
    expect(output).toContain("[file login.png, image/png]")
    expect(output).toContain(
      '── #2 assistant · 2026-10-31T14:04:00.000Z\n[bash] {"command":"ls src"}\n→ {"exitCode":0,"stdout":"login.tsx"}\nThe page is fixed.'
    )
    expect(output).not.toContain("private thoughts")
    // A long text is cut in a page, and says where it is whole.
    expect(output).toContain("more characters: sixb history 1]")
    expect(output.trimEnd().endsWith("Messages 1–2 of 3. Next: sixb history --offset 2")).toBe(true)
  })

  test("prints one message whole", async () => {
    process.env.SIXB_THREAD_ID = "thread_1"
    const { requests, output } = await run(["1"], { offset: 0, limit: 1 })

    expect(requests).toEqual(["/api/agent-threads/thread_1/messages?order=asc&offset=0&limit=1"])
    expect(output).toContain("x".repeat(5_000))
    expect(output).not.toContain("more characters")
  })

  // Reproduce: drop renderOutputFile from renderMessage; the call then shows only its cut copy.
  test("says where a call's whole output is when it was saved to a file", async () => {
    const env = { SIXB_CONTEXT_DIR: "/work/.sixb/agent", SIXB_API_BASE_URL: "https://api.test" }
    const before = { ...process.env }
    Object.assign(process.env, { SIXB_THREAD_ID: "thread_1", ...env })
    const saved = {
      id: "msg_2",
      seq: 1,
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "bash",
          input: { command: "cat build.log" },
          state: "output-available",
          output: { exitCode: 1, stdout: "start…[cut]…end" },
          outputFile: {
            fileRef: { blobId: "blob_2", sizeBytes: 213_456, fileName: "call_1.txt" },
            path: "tool-outputs/call_1.txt",
          },
        },
      ],
    }

    try {
      const { output } = await run(["1"], { offset: 0, limit: 1 }, [saved])

      expect(output).toContain(
        "  [whole output, 213,456 bytes: /work/.sixb/agent/tool-outputs/call_1.txt, written back to the sandbox at each run while the conversation shows this call; else: sixb files download url https://api.test/api/agent-threads/thread_1/messages/msg_2/files/content?path=%2Fparts%2F1%2FoutputFile%2FfileRef --output <file>]"
      )
    } finally {
      for (const key of Object.keys(env) as (keyof typeof env)[]) {
        if (before[key] === undefined) delete process.env[key]
        else process.env[key] = before[key]
      }
    }
  })

  // Reproduce: build the download link from SIXB_THREAD_ID again, or keep the sandbox path for
  // another conversation; the link then reads the run's own thread, or names a file not there.
  test("reads another conversation with --thread, and says how to read more of it", async () => {
    const env = { SIXB_CONTEXT_DIR: "/work/.sixb/agent", SIXB_API_BASE_URL: "https://api.test" }
    const before = { ...process.env }
    Object.assign(process.env, { SIXB_THREAD_ID: "thread_own", ...env })
    const saved = {
      id: "msg_2",
      seq: 2,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "bash",
          input: { command: "cat build.log" },
          state: "output-available",
          output: { exitCode: 0, stdout: "start…[cut]…end" },
          outputFile: {
            fileRef: { blobId: "blob_2", sizeBytes: 2_048, fileName: "call_1.txt" },
            path: "tool-outputs/call_1.txt",
          },
        },
      ],
    }

    try {
      const { requests, output } = await run(
        ["--thread", "thread/earlier", "--limit", "2"],
        { offset: 0, limit: 2 },
        [MESSAGES[0], saved]
      )

      expect(requests).toEqual([
        "/api/agent-threads/thread%2Fearlier/messages?order=asc&offset=0&limit=2",
      ])
      expect(output).toContain("more characters: sixb history --thread 'thread/earlier' 1]")
      expect(output).toContain(
        "  [whole output, 2,048 bytes: sixb files download url https://api.test/api/agent-threads/thread%2Fearlier/messages/msg_2/files/content?path=%2Fparts%2F0%2FoutputFile%2FfileRef --output <file>]"
      )
      expect(output).not.toContain("/work/.sixb/agent")
      expect(
        output
          .trimEnd()
          .endsWith("Messages 1–2 of 3. Next: sixb history --thread 'thread/earlier' --offset 2")
      ).toBe(true)
    } finally {
      for (const key of ["SIXB_CONTEXT_DIR", "SIXB_API_BASE_URL"] as const) {
        if (before[key] === undefined) delete process.env[key]
        else process.env[key] = before[key]
      }
    }
  })

  test("reads another conversation without a conversation of its own", async () => {
    delete process.env.SIXB_THREAD_ID
    const { requests, output } = await run(["--thread", "thread_2", "1"], { offset: 0, limit: 1 })

    expect(requests).toEqual(["/api/agent-threads/thread_2/messages?order=asc&offset=0&limit=1"])
    expect(output).toContain("── #1 user · Ava")
  })

  test("says when the conversation has no such message", async () => {
    process.env.SIXB_THREAD_ID = "thread_1"
    const error = await run(["7"], { offset: 6, limit: 1 }).catch((caught) => caught)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).body).toMatchObject({
      code: "not_found",
      message: "The conversation has no message #7.",
    })
  })

  test("needs a run that answers a conversation", async () => {
    delete process.env.SIXB_THREAD_ID
    const error = await run([]).catch((caught) => caught)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).body.message).toContain("SIXB_THREAD_ID is not set")
  })
})

const FOUND = {
  conversations: [
    {
      thread: {
        id: "thread_acme",
        title: "Reminder for Acme",
        createdAt: "2026-11-20T15:04:12.345Z",
        lastMessageAt: "2026-11-21T09:10:00.000Z",
        shared: true,
      },
      score: 0.82,
      turns: [
        {
          messageId: "msg_3",
          firstSeq: 3,
          lastSeq: 6,
          at: "2026-11-20T15:04:12.345Z",
          score: 0.82,
          excerpt: "Request: Draft a reminder for invoice 1042.\n\nAnswer: The reminder is ready.",
          artifacts: [{ id: "art_1", title: "Acme reminder" }],
        },
      ],
    },
    {
      thread: { id: "thread_q3", createdAt: "2026-11-12T08:00:00.000Z", shared: false },
      score: 0.41,
      turns: [
        {
          messageId: "msg_1",
          firstSeq: 1,
          lastSeq: 2,
          at: "2026-11-12T08:00:00.000Z",
          score: 0.41,
          excerpt: "Request: Summarize Q3.",
          artifacts: [],
        },
      ],
    },
  ],
  searchedFrom: "2026-10-01T00:00:00.000Z",
}

async function search(args: readonly string[], answer: unknown = FOUND) {
  const bodies: unknown[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push({ path: new URL(request.url).pathname, body: await request.json() })
      return Response.json(answer)
    },
  })
  const api = createInstanceApiClient({ kind: "local", baseUrl: `http://127.0.0.1:${server.port}` })
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)

  try {
    await history(api, ["search", ...args])
    return { bodies, output: stdout.mock.calls.map(([chunk]) => String(chunk)).join("") }
  } finally {
    stdout.mockRestore()
  }
}

describe("sixb history search", () => {
  test("lists the conversations found, each with its best turns, and how to read on", async () => {
    const { bodies, output } = await search(["reminder", "for", "late invoices", "--limit", "5"])

    expect(bodies).toEqual([
      { path: "/api/agent-threads/search", body: { text: "reminder for late invoices", limit: 5 } },
    ])
    expect(output).toBe(
      [
        "2 earlier conversations found, the closest first.",
        "",
        '── thread_acme · "Reminder for Acme"',
        "started 2026-11-20T15:04Z · last message 2026-11-21T09:10Z · shared",
        "  #3 · 2026-11-20T15:04Z · Request: Draft a reminder for invoice 1042. Answer: The reminder is ready.",
        '    Published: "Acme reminder" (artifact:art_1)',
        "    Read it: sixb history --thread thread_acme --offset 2 --limit 4",
        "",
        "── thread_q3 · untitled",
        "started 2026-11-12T08:00Z",
        "  #1 · 2026-11-12T08:00Z · Request: Summarize Q3.",
        "    Read it: sixb history --thread thread_q3 --offset 0 --limit 2",
        "",
        "A whole conversation: sixb history --thread <id>.",
        "Only turns from 2026-10-01T00:00:00.000Z on were searched: add --until 2026-10-01T00:00:00.000Z to search earlier ones.",
        "",
      ].join("\n")
    )
  })

  test("says when nothing matches", async () => {
    const { output } = await search(["anything"], { conversations: [] })
    expect(output).toBe("No earlier conversation matches.\n")
  })

  // Reproduce: send --since and --until as given; a date alone then reaches the API, which
  // refuses it, and --until 2026-11-21 leaves out the 21st.
  test("takes a date as a UTC day without a time zone, and a timestamp as its instant", async () => {
    const dates = await search(["invoices", "--since", "2026-11-20", "--until", "2026-11-21"])
    expect(dates.bodies).toEqual([
      {
        path: "/api/agent-threads/search",
        body: {
          text: "invoices",
          since: "2026-11-20T00:00:00.000Z",
          until: "2026-11-22T00:00:00.000Z",
        },
      },
    ])

    server?.stop(true)
    const instants = await search(["invoices", "--until", "2026-11-20T10:30+02:00"])
    expect(instants.bodies).toEqual([
      {
        path: "/api/agent-threads/search",
        body: { text: "invoices", until: "2026-11-20T08:30:00.000Z" },
      },
    ])
  })

  // Reproduce: read the day in UTC whatever $SIXB_TIME_ZONE says, or read the zone's offset once,
  // at UTC midnight; Sydney's October 4 then starts at 13:00Z, an hour early.
  test("takes a date as a day in the user's time zone", async () => {
    const before = process.env.SIXB_TIME_ZONE
    const window = async (timeZone: string, since: string, until: string) => {
      process.env.SIXB_TIME_ZONE = timeZone
      server?.stop(true)
      const { bodies } = await search(["invoices", "--since", since, "--until", until])
      const { body } = bodies[0] as { readonly body: Record<string, unknown> }
      return [body.since, body.until]
    }

    try {
      expect(await window("America/New_York", "2026-11-20", "2026-11-21")).toEqual([
        "2026-11-20T05:00:00.000Z",
        "2026-11-22T05:00:00.000Z",
      ])
      // Sydney's clocks go forward at 2:00 on October 4, 2026: the day starts at +10, ends at +11,
      // and its UTC midnight is already at +11.
      expect(await window("Australia/Sydney", "2026-10-04", "2026-10-04")).toEqual([
        "2026-10-03T14:00:00.000Z",
        "2026-10-04T13:00:00.000Z",
      ])
      expect(await window("Asia/Kolkata", "2026-11-20", "2026-11-20")).toEqual([
        "2026-11-19T18:30:00.000Z",
        "2026-11-20T18:30:00.000Z",
      ])
      // A zone Intl does not know reads as UTC.
      expect(await window("Mars/Olympus", "2026-11-20", "2026-11-20")).toEqual([
        "2026-11-20T00:00:00.000Z",
        "2026-11-21T00:00:00.000Z",
      ])
    } finally {
      if (before === undefined) delete process.env.SIXB_TIME_ZONE
      else process.env.SIXB_TIME_ZONE = before
    }
  })

  test.each([
    [["--since", "yesterday"], "--since must be a date (2026-11-20) or a timestamp"],
    [["--until", "2026-02-30"], "--until must be a date (2026-11-20) or a timestamp"],
    [["--since", "2026-11-20T10:00"], "--since must be a date (2026-11-20) or a timestamp"],
    [["--since", "2026-11-21", "--until", "2026-11-20"], "--since must be before --until."],
    [["--limit", "26"], "--limit must be an integer from 1 through 25."],
  ])("refuses %p before any request", async (flags, message) => {
    const error = await search(["invoices", ...flags]).catch((caught) => caught)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).body.message).toContain(message)
  })

  test("refuses empty or oversized text", async () => {
    for (const text of ["  ", "x".repeat(8_001)]) {
      const error = await search([text]).catch((caught) => caught)
      expect((error as CliError).body.message).toBe(
        "Search text must be nonempty and at most 8000 characters."
      )
    }
  })
})

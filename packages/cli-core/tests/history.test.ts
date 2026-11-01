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

function startThread(page: { readonly offset: number; readonly limit: number }) {
  const requests: string[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      const messages = MESSAGES.slice(page.offset, page.offset + page.limit)
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

async function run(args: readonly string[], page = { offset: 0, limit: 20 }) {
  const { api, requests } = startThread(page)
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

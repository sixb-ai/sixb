import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInstanceApiClient } from "../src"
import { memory } from "../src/commands/memory"
import { threads } from "../src/commands/threads"
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

function startThreadApi(
  page: { readonly offset: number; readonly limit: number } = { offset: 0, limit: 20 },
  stored: readonly unknown[] = MESSAGES
) {
  const requests: string[] = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      if (url.pathname === "/api/agent-threads") {
        return Response.json({ threads: [{ id: "thread_1", title: "Login fix" }] })
      }
      if (url.pathname.endsWith("/messages")) {
        const messages = stored.slice(page.offset, page.offset + page.limit)
        return Response.json({
          messages,
          authors: [{ type: "user", id: "usr_ava", displayName: "Ava" }],
          hasMore: page.offset + messages.length < 3,
          total: 3,
        })
      }
      return Response.json({ ok: true })
    },
  })

  const api = createInstanceApiClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
  })
  return { api, requests }
}

async function runThreads(
  args: readonly string[],
  page = { offset: 0, limit: 20 },
  stored: readonly unknown[] = MESSAGES
) {
  const { api, requests } = startThreadApi(page, stored)
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)

  try {
    await threads(api, args)
    return { requests, output: stdout.mock.calls.map(([chunk]) => String(chunk)).join("") }
  } finally {
    stdout.mockRestore()
  }
}

describe("sixb threads", () => {
  test("lists threads, gets thread metadata, runs, and approvals", async () => {
    const listed = await runThreads(["list", "--limit", "5", "--offset", "10"])
    expect(listed.requests).toEqual(["/api/agent-threads?limit=5&offset=10"])
    expect(JSON.parse(listed.output)).toEqual({ threads: [{ id: "thread_1", title: "Login fix" }] })

    expect((await runThreads(["get", "thread_1"])).requests).toEqual([
      "/api/agent-threads/thread_1",
    ])
    expect((await runThreads(["runs", "thread_1"])).requests).toEqual([
      "/api/agent-threads/thread_1/runs",
    ])
    expect((await runThreads(["approvals", "thread_1"])).requests).toEqual([
      "/api/agent-threads/thread_1/approvals",
    ])
  })

  test("prints conversation messages as text, oldest first, using SIXB_THREAD_ID by default", async () => {
    process.env.SIXB_THREAD_ID = "thread/1"
    const { requests, output } = await runThreads(["messages", "--limit", "2"], {
      offset: 0,
      limit: 2,
    })

    expect(requests).toEqual(["/api/agent-threads/thread%2F1/messages?order=asc&offset=0&limit=2"])
    expect(output).toContain("── #1 user · Ava · 2026-10-31T14:03:00.000Z\nFix the login page.")
    expect(output).toContain("[file login.png, image/png]")
    expect(output).toContain(
      '── #2 assistant · 2026-10-31T14:04:00.000Z\n[bash] {"command":"ls src"}\n→ {"exitCode":0,"stdout":"login.tsx"}\nThe page is fixed.'
    )
    expect(output).not.toContain("private thoughts")
    expect(output).toContain("more characters: sixb threads messages --seq 1]")
    expect(
      output.trimEnd().endsWith("Messages 1–2 of 3. Next: sixb threads messages --offset 2")
    ).toBe(true)
  })

  test("prints one message whole with --seq and supports explicit thread id and --json", async () => {
    delete process.env.SIXB_THREAD_ID
    const { requests, output } = await runThreads(["messages", "thread_1", "--seq", "1"], {
      offset: 0,
      limit: 1,
    })

    expect(requests).toEqual(["/api/agent-threads/thread_1/messages?order=asc&offset=0&limit=1"])
    expect(output).toContain("x".repeat(5_000))
    expect(output).not.toContain("more characters")

    const asJson = await runThreads(["messages", "thread_1", "--seq", "1", "--json"], {
      offset: 0,
      limit: 1,
    })
    expect(JSON.parse(asJson.output)).toMatchObject({ seq: 1, role: "user" })
  })

  // Reproduce: drop renderOutputFile from renderMessage; the call then shows only its cut copy.
  test("says where a call's whole output is when it was saved to a file", async () => {
    const env = { SIXB_CONTEXT_DIR: "/work/.sixb/agent", SIXB_API_URL: "https://api.test" }
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
      const { output } = await runThreads(["messages", "--seq", "1"], { offset: 0, limit: 1 }, [
        saved,
      ])

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

  test("says when the conversation has no such message", async () => {
    process.env.SIXB_THREAD_ID = "thread_1"
    const error = await runThreads(["messages", "--seq", "7"], { offset: 6, limit: 1 }).catch(
      (caught) => caught
    )
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({
      exitCode: 3,
      body: { code: "not_found", message: "The conversation has no message #7." },
    })
  })

  test("requires a thread id when SIXB_THREAD_ID is unset", async () => {
    delete process.env.SIXB_THREAD_ID
    const error = await runThreads(["messages"]).catch((caught) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({
      exitCode: 2,
      body: { code: "invalid_arguments" },
    })
  })
})

describe("sixb memory", () => {
  test("reads a memory repo directly with get and pulls into an explicit --dir", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          revision: 3,
          files: [{ path: "MEMORY.md", contents: "# Memory\n\n- Keep it simple\n" }],
        })
      },
    })
    const api = createInstanceApiClient({ baseUrl: `http://127.0.0.1:${server.port}` })
    const chunks: string[] = []
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })

    const dir = await mkdtemp(join(tmpdir(), "sixb-memory-dir-"))
    try {
      await memory(api, ["get", "user"])
      expect(JSON.parse(chunks.join(""))).toEqual({
        repo: "user",
        revision: 3,
        files: [{ path: "MEMORY.md", contents: "# Memory\n\n- Keep it simple\n" }],
      })

      chunks.length = 0
      await memory(api, ["pull", "user", "--dir", dir])
      expect(JSON.parse(chunks.join(""))).toMatchObject({
        repo: "user",
        revision: 3,
        updated: ["MEMORY.md"],
        conflicts: [],
      })
      expect(await readFile(join(dir, "user", "MEMORY.md"), "utf8")).toBe(
        "# Memory\n\n- Keep it simple\n"
      )
    } finally {
      stdout.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

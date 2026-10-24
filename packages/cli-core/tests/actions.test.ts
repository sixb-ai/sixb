import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createInstanceApiClient, reportError } from "../src"
import { actions } from "../src/commands/actions"
import { workflows } from "../src/commands/workflows"
import { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined
let releaseResponse: (() => void) | undefined

afterEach(() => {
  releaseResponse?.()
  releaseResponse = undefined
  server?.stop(true)
  server = undefined
})

describe("actions request", () => {
  // The API answers only once the Action has run, and an agent's command is killed after 30
  // seconds. Guard proof: drop `signal` from the `api.post` call in `src/commands/actions.ts`, and
  // the command waits for the response for as long as the run takes: this test times out. Send
  // `runId` only when `--run-id` is given, and the error has no run the server knows to name.
  test("stops waiting for a slow run and names it", async () => {
    const requested: Array<{ runId?: string }> = []
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requested.push((await request.json()) as { runId?: string })
        await released
        return Response.json({})
      },
    })
    const api = createInstanceApiClient({
      kind: "local",
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: "sixb_pat_test.secret",
      profile: "test",
    })

    const error = await actions(api, ["request", "slow"], 50).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CliError)
    const runId = requested[0]?.runId
    expect(runId).toStartWith("act_")
    expect((error as CliError).body).toEqual({
      code: "action_wait_timeout",
      message: `Action run '${runId}' did not finish within 0.05 seconds. It was not cancelled.`,
      hint:
        `Read it with 'sixb action-runs get ${runId}': its record exists once it has ended. ` +
        `A repeated request must pass '--run-id ${runId}', or the Action runs twice.`,
    })
  })
})

describe("a request held for approval", () => {
  // Guard proof: drop the `awaiting_approval` check in `writeRequestResult`; both commands exit 0,
  // and `a && b` runs `b` although `a` did not run.
  test("prints the API's answer and exits with code 4", async () => {
    const held = {
      status: "awaiting_approval",
      approval: { id: "apr_1", actionId: "mark-paid" },
      message: "The user approves or denies this in the conversation.",
    }
    const requested: Array<{ readonly path: string; readonly runId?: string }> = []
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { runId?: string }
        requested.push({ path: new URL(request.url).pathname, runId: body.runId })
        return Response.json(held, { status: 202 })
      },
    })
    const api = createInstanceApiClient({
      kind: "local",
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: "sixb_pat_test.secret",
      profile: "test",
    })
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      const action = await actions(api, ["request", "mark-paid"]).catch((error: unknown) => error)
      const workflow = await workflows(api, ["start", "send-reminders"]).catch(
        (error: unknown) => error
      )

      expect([reportError(action), reportError(workflow)]).toEqual([4, 4])
      expect(stdout.mock.calls.map(([text]) => JSON.parse(String(text)))).toEqual([held, held])
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
    expect(requested).toEqual([
      { path: "/api/actions/mark-paid", runId: expect.stringMatching(/^act_/) },
      { path: "/api/workflows/send-reminders/runs", runId: expect.stringMatching(/^run_/) },
    ])
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { createInstanceApiClient } from "../src"
import { actions } from "../src/commands/actions"
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

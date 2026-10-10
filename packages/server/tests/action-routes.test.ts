import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  type ActionDefinition,
  defineAction,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type SixbErrorContext,
  SixbHost,
} from "@sixb/core"
import { drainActionRuns } from "@sixb/core/internal/actions"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { decorateOperationScopedMethodForTesting } from "@sixb/core/internal/storage-operation-scope"
import { type ActionRunRecord, isTerminalActionRun } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [prop("id", "string", { required: true, primary: true }), prop("status", "string")],
})

async function freePort(): Promise<number> {
  const listener = createServer()
  return new Promise((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address()
      if (!address || typeof address === "string") return reject(new Error("Missing port"))
      listener.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function withActionServer(
  actions: readonly ActionDefinition[],
  run: (input: {
    readonly baseUrl: string
    readonly host: SixbHost
    readonly storage: InMemoryStorage
    readonly reports: readonly SixbErrorContext[]
  }) => Promise<void>
): Promise<void> {
  const storage = new InMemoryStorage()
  const reports: SixbErrorContext[] = []
  const host = new SixbHost({
    id: "action-routes",
    ontology: [Device],
    actions,
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    onError: (_error, context) => {
      reports.push(context)
    },
  })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = new SixbServer({
    host,
    hostname: "127.0.0.1",
    port,
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
  })
  await server.start()
  try {
    await run({ baseUrl, host, storage, reports })
  } finally {
    await server.stop()
  }
}

async function waitForTerminalRun(host: SixbHost, runId: string): Promise<ActionRunRecord> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const run = await host.storage.actionRuns?.getById({ projectId: host.id, id: runId })
    if (run && isTerminalActionRun(run)) return run
    if (Date.now() > deadline) throw new Error(`Action run '${runId}' did not finish.`)
    await Bun.sleep(10)
  }
}

function requestAction(
  baseUrl: string,
  actionId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`${baseUrl}/api/actions/${actionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}

describe("POST /api/actions/:actionId", () => {
  test("answers 409 while the run id is executing, then the terminal run", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const slow = defineAction("slow")
      .params({})
      .writeback(async () => {
        started.resolve()
        await release.promise
        return { done: true }
      })

    await withActionServer([slow], async ({ baseUrl }) => {
      const first = requestAction(baseUrl, "slow", { runId: "act_http" })
      await started.promise

      const inProgress = await requestAction(baseUrl, "slow", { runId: "act_http" })
      expect(inProgress.status).toBe(409)
      expect(await inProgress.json()).toEqual({
        error: "[Sixb] Action run 'act_http' is already in progress.",
        code: "action.run_in_progress",
      })

      release.resolve()
      const finished = await first
      expect(finished.status).toBe(200)
      const run = await finished.json()
      expect(run).toMatchObject({
        id: "act_http",
        status: "succeeded",
        writeback: { status: "succeeded", result: { done: true } },
      })

      const replayed = await requestAction(baseUrl, "slow", { runId: "act_http" })
      expect(replayed.status).toBe(200)
      expect(await replayed.json()).toEqual(run)
    })
  })

  test("answers a failed run with 200 and status failed", async () => {
    const failing = defineAction("failing")
      .params({})
      .writeback(() => {
        throw new Error("external system refused")
      })

    await withActionServer([failing], async ({ baseUrl }) => {
      const response = await requestAction(baseUrl, "failing", { runId: "act_failed" })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: "act_failed",
        status: "failed",
        phase: "writeback",
        error: {
          code: "action.phase_failed",
          details: { actionId: "failing", runId: "act_failed", phase: "writeback" },
        },
      })
    })
  })

  // Guard proof: drop the catch that calls `failRequest` in `ActionRunExecutor.execute`
  // (`core/src/actions/run/executor.ts`), and the request answers 400 with nothing reported.
  test("answers 500 without the run's own error when its outcome cannot be recorded", async () => {
    const leaky = defineAction("leaky")
      .params({})
      .writeback(() => {
        throw new Error("secret-token-123 rejected by upstream")
      })

    await withActionServer([leaky], async ({ baseUrl, host, storage, reports }) => {
      const restore = decorateOperationScopedMethodForTesting(
        storage.actionRuns,
        "finish",
        () => async () => {
          throw new Error("storage unavailable")
        }
      )
      let response: Response
      try {
        response = await requestAction(baseUrl, "leaky", { runId: "act_unrecorded" })
      } finally {
        restore()
      }

      expect(response.status).toBe(500)
      const body = await response.text()
      expect(JSON.parse(body)).toEqual({
        error:
          "[Sixb] Action run 'act_unrecorded' was requested, but its record could not be " +
          "returned. Request it again with the same runId to get it.",
        code: "internal.unexpected",
      })
      expect(body).not.toContain("secret-token-123")
      await flushSixbErrors(host)
      expect(reports).toMatchObject([
        {
          type: "run.failed",
          run: { runId: "act_unrecorded" },
          failure: { code: "action.phase_failed" },
        },
      ])
    })
  })

  // Guard proof: drop `runtime.stopping` from `HTTP_STATUS_BY_ERROR_CODE` (`utils/http.ts`), and
  // the refusal answers 500.
  test("answers 503 once the runtime is stopping, before persisting anything", async () => {
    const quick = defineAction("quick")
      .params({})
      .writeback(() => {})

    await withActionServer([quick], async ({ baseUrl, host }) => {
      await drainActionRuns(host, 1_000)

      const response = await requestAction(baseUrl, "quick", { runId: "act_stopping" })

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: "[Sixb] The runtime is stopping and starts no new Action run; retry the request.",
        code: "runtime.stopping",
      })
      expect(
        await host.storage.actionRuns?.getById({ projectId: host.id, id: "act_stopping" })
      ).toBeNull()
    })
  })

  // Guard proof: pass `signal: request.signal` to `sixb.actions.request` in
  // `routes/actions.ts`, and the disconnect cancels the run before its writeback finishes. The
  // short pause after the abort gives Bun the time to observe the closed socket.
  test("keeps running an action whose client disconnected", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const disconnected = defineAction("disconnected")
      .on(Device)
      .params({})
      .writeback(async ({ signal }) => {
        started.resolve()
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
        ])
        signal.throwIfAborted()
        return { status: "written" }
      })
      .edits(({ objects, subject, writeback }) => {
        objects(Device).byId(subject.primaryId).update({ status: writeback.status })
      })

    await withActionServer([disconnected], async ({ baseUrl, host }) => {
      await createTestSixb(host).objects.upsert("device", { id: "fan-1" })
      const client = new AbortController()
      const response = requestAction(
        baseUrl,
        "disconnected",
        {
          subject: { kind: "object", objectTypeId: "device", primaryId: "fan-1" },
          runId: "act_disconnected",
        },
        client.signal
      )
      await started.promise
      client.abort()
      await expect(response).rejects.toThrow()
      await Bun.sleep(50)

      release.resolve()
      const run = await waitForTerminalRun(host, "act_disconnected")
      expect(run.status).toBe("succeeded")
      const retried = await requestAction(baseUrl, "disconnected", {
        subject: { kind: "object", objectTypeId: "device", primaryId: "fan-1" },
        runId: "act_disconnected",
      })
      expect(retried.status).toBe(200)
      expect(await retried.json()).toMatchObject({ id: "act_disconnected", status: "succeeded" })
    })
  })

  // An Action may run for its whole 30-second deadline, past Bun's 10-second idle timeout. Bun 1.4.2
  // applies that timeout only to requests without a body, which this route rejects, so no socket
  // reproduces the cut today; this pins the request that keeps it from depending on Bun.
  // Guard proof: remove `server?.timeout(request, 0)` from `routes/actions.ts`.
  test("disables Bun's idle timeout for the request", async () => {
    const quick = defineAction("quick")
      .params({})
      .writeback(() => {})
    const host = new SixbHost({
      id: "action-routes",
      ontology: [],
      actions: [quick],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })
    const app = createSixbApi(
      new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
    )
    const timeouts: Array<{ readonly url: string; readonly seconds: number }> = []
    Object.assign(app, {
      server: {
        timeout(request: Request, seconds: number) {
          timeouts.push({ url: request.url, seconds })
        },
      },
    })

    const response = await app.fetch(
      new Request("http://localhost/api/actions/quick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "act_quick" }),
      })
    )

    expect(response.status).toBe(200)
    expect(timeouts).toEqual([{ url: "http://localhost/api/actions/quick", seconds: 0 }])
  })
})

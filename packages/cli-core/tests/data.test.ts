import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createInstanceApiClient } from "../src"
import { dispatch } from "../src/commands"
import { CliError } from "../src/output"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

/** Runs one command against a server that records each request and answers `{}`. */
async function run(args: readonly string[]) {
  const requests: string[] = []
  server?.stop(true)
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${decodeURIComponent(url.search)}`)
      return Response.json({})
    },
  })
  const api = createInstanceApiClient({
    kind: "local",
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: "sixb_pat_test.secret",
  })
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)
  try {
    const error = await dispatch(api, args[0] ?? "", args.slice(1)).then(
      () => undefined,
      (failure: unknown) => failure
    )
    return { requests, error }
  } finally {
    stdout.mockRestore()
  }
}

describe("sixb datasets", () => {
  test("reads the catalog, one dataset and its versions", async () => {
    expect((await run(["datasets", "list"])).requests).toEqual(["/api/datasets"])
    // An id is one path segment, whatever it holds.
    expect((await run(["datasets", "get", "raw/orders"])).requests).toEqual([
      "/api/datasets/raw%2Forders",
    ])
    expect((await run(["datasets", "versions", "orders"])).requests).toEqual([
      "/api/datasets/orders/versions?limit=20",
    ])
  })

  test("reads rows with a version, columns and a page", async () => {
    const { requests } = await run([
      "datasets",
      "rows",
      "orders",
      "--version",
      "v_2",
      "--columns",
      "id, total",
      "--limit",
      "50",
      "--offset",
      "100",
    ])

    expect(requests).toEqual([
      "/api/datasets/orders/rows?limit=50&versionId=v_2&columns=id,total&offset=100",
    ])
  })

  // Guard proof: encode ids with encodeURIComponent alone again; `..` requests /api/rows.
  test("refuses an id that would name another route, before any request", async () => {
    for (const args of [
      ["datasets", "rows", ".."],
      ["syncs", "get", "."],
    ]) {
      const { requests, error } = await run(args)
      expect({ args, requests, code: error instanceof CliError && error.body.code }).toEqual({
        args,
        requests: [],
        code: "invalid_arguments",
      })
    }
  })

  test("refuses bounds the server would reject, before any request", async () => {
    for (const args of [
      ["datasets", "versions", "orders", "--limit", "101"],
      ["datasets", "rows", "orders", "--limit", "1001"],
      ["datasets", "rows", "orders", "--columns", "id,,total"],
    ]) {
      const { requests, error } = await run(args)
      expect(error, args.join(" ")).toBeInstanceOf(CliError)
      expect(requests).toEqual([])
    }
  })
})

describe("sixb syncs and pipelines", () => {
  test("lists and gets definitions", async () => {
    expect((await run(["syncs", "list"])).requests).toEqual(["/api/syncs"])
    expect((await run(["pipelines", "get", "daily"])).requests).toEqual(["/api/pipelines/daily"])
  })

  test("lists runs with each kind's filters", async () => {
    expect(
      (await run(["sync-runs", "list", "--sync", "crm", "--dataset", "accounts"])).requests
    ).toEqual(["/api/sync-runs?syncId=crm&datasetId=accounts&limit=20&order=desc"])
    expect(
      (await run(["pipeline-runs", "list", "--pipeline", "daily", "--status", "failed"])).requests
    ).toEqual(["/api/pipeline-runs?pipelineId=daily&status=failed&limit=20&order=desc"])
    expect((await run(["pipeline-runs", "get", "run_1"])).requests).toEqual([
      "/api/pipeline-runs/run_1",
    ])
  })

  test("refuses what the API has no route for", async () => {
    for (const args of [
      ["sync-runs", "get", "run_1"],
      ["sync-runs", "list", "--pipeline", "daily"],
      ["pipeline-runs", "list", "--status", "waiting"],
    ]) {
      const { requests, error } = await run(args)
      expect(error, args.join(" ")).toBeInstanceOf(CliError)
      expect(requests).toEqual([])
    }
  })
})

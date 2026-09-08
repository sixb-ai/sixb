import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { CliError, runInstanceCli } from "../src"

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch")
  stdoutSpy = spyOn(process.stdout, "write")
})

afterEach(() => {
  fetchSpy.mockRestore()
  stdoutSpy.mockRestore()
})

// Regression proof: run this file against the parent revision of the parser fix.
// Duplicate options reach fetch, and trailing --help is treated as an object id.
describe("instance command argument admission", () => {
  test.each(
    [
      ["actions", "request", "example", "--run-id", "first", "--run-id", "second"],
      ["objects", "list", "--limit", "1", "--limit", "2"],
      ["objects", "inspect", "Customer", "alice", "--depth", "1", "--depth", "2"],
      ["objects", "links", "Customer", "alice", "--link", "a", "--link", "b"],
      ["objects", "get", "Customer", "alice", "--unknown"],
      ["ontology", "get", "--unknown"],
      ["actions", "get", "--unknown"],
      ["workflows", "get", "--unknown"],
      ["action-runs", "get", "--unknown"],
      ["telemetry", "latest", "Customer", "alice", "--unknown"],
      ["objects", "list", "--type", "--limit", "2"],
    ].map((args) => ({ args }))
  )("rejects invalid arguments before HTTP or file reads: %j", async ({ args }) => {
    fetchSpy.mockResolvedValue(Response.json({ ok: true }))
    stdoutSpy.mockImplementation(() => true)
    let caught: unknown
    try {
      await runInstanceCli({ args, mode: { kind: "local", baseUrl: "http://unused.test" } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CliError)
    expect(caught).toMatchObject({ body: { code: "invalid_arguments" }, exitCode: 2 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("rejects duplicate file options before opening either file", async () => {
    fetchSpy.mockResolvedValue(Response.json({ ok: true }))
    stdoutSpy.mockImplementation(() => true)
    await expect(
      runInstanceCli({
        args: ["objects", "query", "--file", "missing.json", "--file", "also-missing.json"],
        mode: { kind: "local", baseUrl: "http://unused.test" },
      })
    ).rejects.toMatchObject({
      body: { code: "invalid_arguments", message: "--file may only be provided once." },
      exitCode: 2,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each(
    [
      ["objects", "get", "Customer", "alice", "--help"],
      ["objects", "inspect", "Customer", "alice", "--help"],
      ["actions", "request", "example", "--file", "missing.json", "--help"],
      ["workflows", "start", "example", "--file", "missing.json", "--help"],
      ["files", "upload", "missing.file", "--help"],
      ["ontology", "get", "Customer", "--help"],
      ["telemetry", "latest", "Customer", "alice", "temperature", "-h"],
      ["action-runs", "get", "run", "--help"],
    ].map((args) => ({ args }))
  )("prints trailing help without effects: %j", async ({ args }) => {
    fetchSpy.mockResolvedValue(Response.json({ ok: true }))
    stdoutSpy.mockImplementation(() => true)
    await runInstanceCli({ args, mode: { kind: "local", baseUrl: "" } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(stdoutSpy).toHaveBeenCalled()
    expect(stdoutSpy.mock.calls[0]?.[0]).toContain("Usage:")
  })

  test("keeps option-looking ids after the separator literal", async () => {
    fetchSpy.mockResolvedValue(Response.json({ objects: [] }))
    stdoutSpy.mockImplementation(() => true)
    await runInstanceCli({
      args: ["objects", "get", "Customer", "--", "--help", "--profile"],
      mode: { kind: "local", baseUrl: "http://unused.test" },
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = fetchSpy.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe("string")
    expect(JSON.parse(String(body)).query.refs).toEqual([
      { objectTypeId: "Customer", primaryId: "--help" },
      { objectTypeId: "Customer", primaryId: "--profile" },
    ])
  })
})

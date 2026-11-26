import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  resolveSingleWorkerConcurrency,
  resolveSubagentConcurrency,
  resolveVectorConcurrency,
  resolveWorkerConcurrency,
} from "../src/lib/worker-concurrency"

const environmentVariables = [
  "SIXB_SYNC_WORKER_CONCURRENCY",
  "SIXB_AGENT_WORKER_CONCURRENCY",
  "SIXB_PIPELINE_WORKER_CONCURRENCY",
  "SIXB_PROJECTION_WORKER_CONCURRENCY",
  "SIXB_WORKFLOW_WORKER_CONCURRENCY",
  "SIXB_VECTOR_CONCURRENCY",
  "SIXB_SUBAGENT_CONCURRENCY",
  "SIXB_SUBAGENT_CONCURRENCY_PER_RUN",
] as const

const originalEnvironment = Object.fromEntries(
  environmentVariables.map((name) => [name, process.env[name]])
) as Record<(typeof environmentVariables)[number], string | undefined>

describe("worker concurrency configuration", () => {
  beforeEach(() => {
    for (const name of environmentVariables) {
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const name of environmentVariables) {
      const original = originalEnvironment[name]
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
  })

  test("leaves worker defaults in authority when nothing is configured", () => {
    expect(resolveSingleWorkerConcurrency("agent", undefined)).toEqual({})
    expect(resolveWorkerConcurrency()).toEqual({})
  })

  test("resolves a scalar for a single worker and lets the flag win over its environment", () => {
    process.env.SIXB_AGENT_WORKER_CONCURRENCY = "3"

    expect(resolveSingleWorkerConcurrency("agent", undefined)).toEqual({ agent: 3 })
    expect(resolveSingleWorkerConcurrency("agent", "8")).toEqual({ agent: 8 })
  })

  test("does not validate an environment value replaced by a typed CLI override", () => {
    process.env.SIXB_AGENT_WORKER_CONCURRENCY = "invalid"

    // Reverting to environment-first parsing makes this throw before the valid override is read.
    expect(resolveWorkerConcurrency(["agent=8"])).toEqual({ agent: 8 })
  })

  test("combines per-worker environments and repeatable typed overrides", () => {
    process.env.SIXB_AGENT_WORKER_CONCURRENCY = "3"
    process.env.SIXB_SYNC_WORKER_CONCURRENCY = "2"
    process.env.SIXB_WORKFLOW_WORKER_CONCURRENCY = "4"

    expect(resolveWorkerConcurrency(["agent=8", "projection=5", "agent=10"])).toEqual({
      agent: 10,
      sync: 2,
      projection: 5,
      workflow: 4,
    })
  })

  test("rejects malformed, zero, fractional, and unsafe concurrency values", () => {
    for (const value of ["", "0", "-1", "1.5", "many", "9007199254740992"]) {
      expect(() => resolveSingleWorkerConcurrency("sync", value)).toThrow(
        "Invalid worker concurrency"
      )
    }
  })

  test("rejects malformed mappings and unknown worker types", () => {
    expect(() => resolveWorkerConcurrency(["agent"])).toThrow("type=count")
    expect(() => resolveWorkerConcurrency(["unknown=2"])).toThrow(
      "Unknown worker concurrency type 'unknown'"
    )
  })

  test("resolves vector indexing concurrency apart from the worker types", () => {
    expect(resolveVectorConcurrency(undefined)).toBeUndefined()

    process.env.SIXB_VECTOR_CONCURRENCY = "2"
    expect(resolveVectorConcurrency(undefined)).toBe(2)
    expect(resolveVectorConcurrency("8")).toBe(8)
    expect(resolveWorkerConcurrency()).toEqual({})
    expect(() => resolveVectorConcurrency("0")).toThrow("--vector-concurrency")
  })

  test("resolves the agent worker's child agents per worker and per turn", () => {
    expect(resolveSubagentConcurrency({ perWorker: undefined, perRun: undefined })).toEqual({})

    process.env.SIXB_SUBAGENT_CONCURRENCY = "6"
    process.env.SIXB_SUBAGENT_CONCURRENCY_PER_RUN = "3"
    expect(resolveSubagentConcurrency({ perWorker: undefined, perRun: undefined })).toEqual({
      subagentConcurrency: 6,
      subagentConcurrencyPerRun: 3,
    })
    expect(resolveSubagentConcurrency({ perWorker: "8", perRun: "2" })).toEqual({
      subagentConcurrency: 8,
      subagentConcurrencyPerRun: 2,
    })
    expect(() => resolveSubagentConcurrency({ perWorker: "0", perRun: undefined })).toThrow(
      "--subagent-concurrency"
    )
    expect(() => resolveSubagentConcurrency({ perWorker: undefined, perRun: "x" })).toThrow(
      "--subagent-concurrency-per-run"
    )
  })
})

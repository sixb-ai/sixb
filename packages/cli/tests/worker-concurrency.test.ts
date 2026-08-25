import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  resolveSingleWorkerConcurrency,
  resolveWorkerConcurrency,
} from "../src/lib/worker-concurrency"

const environmentVariables = [
  "SIXB_SYNC_WORKER_CONCURRENCY",
  "SIXB_ACTION_WORKER_CONCURRENCY",
  "SIXB_AGENT_WORKER_CONCURRENCY",
  "SIXB_PIPELINE_WORKER_CONCURRENCY",
  "SIXB_PROJECTION_WORKER_CONCURRENCY",
  "SIXB_WORKFLOW_WORKER_CONCURRENCY",
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

  test("keeps the action worker's deliberate serial limit", () => {
    expect(resolveSingleWorkerConcurrency("action", undefined)).toEqual({})
    expect(() => resolveSingleWorkerConcurrency("action", "2")).toThrow(
      "Action worker concurrency is fixed at 1"
    )
    expect(() => resolveWorkerConcurrency(["action=2"])).toThrow(
      "Action worker concurrency is fixed at 1"
    )
  })
})

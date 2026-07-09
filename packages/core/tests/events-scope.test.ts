import { describe, expect, test } from "bun:test"
import { type DomainEvent, scopeKeysForEvent } from "../src"

// Loose fixtures: only the topic + payload fields the extractor reads matter.
function event(topic: string, type: string, payload: Record<string, unknown>): DomainEvent {
  return { type, topic, payload } as unknown as DomainEvent
}

describe("scopeKeysForEvent", () => {
  test("objects resolve objectTypeId + primaryId", () => {
    expect(
      scopeKeysForEvent(
        event("objects", "object.upserted", { objectTypeId: "device", primaryId: "fan-1" })
      )
    ).toEqual({ objectTypeId: "device", primaryId: "fan-1" })
  })

  test("telemetry resolves primaryId from objectId and carries propertyId", () => {
    expect(
      scopeKeysForEvent(
        event("telemetry", "telemetry.appended", {
          objectTypeId: "device",
          objectId: "fan-1",
          propertyId: "rpm",
        })
      )
    ).toEqual({ objectTypeId: "device", primaryId: "fan-1", propertyId: "rpm" })
  })

  test("links resolve identity from the source side and carry linkId", () => {
    expect(
      scopeKeysForEvent(
        event("links", "link.upserted", {
          sourceTypeId: "device",
          sourceId: "fan-1",
          linkId: "zone",
          targetTypeId: "Zone",
          targetId: "z1",
        })
      )
    ).toEqual({ objectTypeId: "device", primaryId: "fan-1", linkId: "zone" })
  })

  test("run topics carry only runId", () => {
    expect(
      scopeKeysForEvent(
        event("workflows", "workflow.run.started", { workflowId: "wf", runId: "r1" })
      )
    ).toEqual({ runId: "r1" })
    expect(
      scopeKeysForEvent(
        event("pipelines", "pipeline.run.started", { pipelineId: "p", runId: "r2" })
      )
    ).toEqual({ runId: "r2" })
    expect(
      scopeKeysForEvent(event("syncs", "sync.run.started", { syncId: "s", runId: "r3" }))
    ).toEqual({ runId: "r3" })
  })

  test("action topics carry action, run, and object subject scope", () => {
    expect(
      scopeKeysForEvent(
        event("actions", "action.requested", {
          actionId: "approveQuote",
          runId: "act-1",
          subject: { kind: "object", objectTypeId: "Quote", primaryId: "quote-1" },
        })
      )
    ).toEqual({
      actionId: "approveQuote",
      runId: "act-1",
      objectTypeId: "Quote",
      primaryId: "quote-1",
    })
  })

  test("global action topics carry action and run scope", () => {
    expect(
      scopeKeysForEvent(
        event("actions", "action.completed", {
          actionId: "refreshCache",
          runId: "act-2",
          subject: { kind: "none" },
        })
      )
    ).toEqual({ actionId: "refreshCache", runId: "act-2" })
  })

  test("rule topics carry rule scope", () => {
    expect(
      scopeKeysForEvent(
        event("rules", "rule.triggered", {
          ruleId: "x",
          subject: { objectTypeId: "d", primaryId: "1" },
        })
      )
    ).toEqual({ ruleId: "x" })
  })
})

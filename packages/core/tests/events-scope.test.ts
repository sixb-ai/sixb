import { expect, test } from "bun:test"
import type { DomainEvent } from "../src"
import { type EventScopeKeys, scopeKeysForEvent } from "../src/events/scope"

// Loose fixtures: only the topic + payload fields the extractor reads matter.
function event(topic: string, type: string, payload: Record<string, unknown>): DomainEvent {
  return { type, topic, payload } as unknown as DomainEvent
}

test.each<[string, DomainEvent, EventScopeKeys]>([
  [
    "objects resolve objectTypeId + primaryId",
    event("objects", "object.created", { objectTypeId: "device", primaryId: "fan-1" }),
    { objectTypeId: "device", primaryId: "fan-1" },
  ],
  [
    "telemetry resolves primaryId from objectId and carries propertyId",
    event("telemetry", "telemetry.appended", {
      objectTypeId: "device",
      objectId: "fan-1",
      propertyId: "rpm",
    }),
    { objectTypeId: "device", primaryId: "fan-1", propertyId: "rpm" },
  ],
  [
    "links resolve identity from the source side and carry linkId",
    event("links", "link.created", {
      sourceTypeId: "device",
      sourceId: "fan-1",
      linkId: "zone",
      targetTypeId: "Zone",
      targetId: "z1",
    }),
    { objectTypeId: "device", primaryId: "fan-1", linkId: "zone" },
  ],
  [
    "workflow runs carry only the run",
    event("workflows", "workflow.run.started", { workflowId: "wf", runId: "r1" }),
    { runId: "r1" },
  ],
  [
    "pipeline runs carry pipeline and run scope",
    event("pipelines", "pipeline.run.started", { pipelineId: "p", runId: "r2" }),
    { pipelineId: "p", runId: "r2" },
  ],
  [
    "sync runs carry sync and run scope",
    event("syncs", "sync.run.started", { syncId: "s", runId: "r3" }),
    { syncId: "s", runId: "r3" },
  ],
  [
    "rule topics carry rule scope",
    event("rules", "rule.triggered", {
      ruleId: "x",
      subject: { objectTypeId: "d", primaryId: "1" },
    }),
    { ruleId: "x" },
  ],
])("scopeKeysForEvent: %s", (_name, input, expected) => {
  expect(scopeKeysForEvent(input)).toEqual(expected)
})

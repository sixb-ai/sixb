import { expect, test } from "bun:test"
import { events } from "@sixb/core"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import { eventScheduleRouteKeyForSelector, routeKeysForEvent } from "../src/route-key"
import type { OrchestratorRouteKey } from "../src/types"

const base = {
  schemaVersion: 1,
  projectId: "test-project",
  occurredAt: "2026-04-18T02:00:00.000Z",
  cursor: "1",
} as const

const materialization = {
  correlationId: "correlation-1",
  origin: { kind: "runtime", requestId: "request-1" },
  executor: { type: "request", requestId: "request-1" },
  commitId: "commit-1",
  commitOrdinal: 0,
} as const

const cases: readonly [string, StoredDomainEvent, readonly OrchestratorRouteKey[]][] = [
  [
    "schedule.triggered routes by schedule id only",
    {
      ...base,
      id: "evt-schedule",
      type: "schedule.triggered",
      topic: "schedules",
      partitionKey: "nightly-orders",
      payload: {
        scheduleId: "nightly-orders",
        occurrenceAt: base.occurredAt,
        triggeredAt: base.occurredAt,
        occurrenceKey: `nightly-orders:${base.occurredAt}`,
      },
    },
    ["schedule.triggered:nightly-orders"],
  ],
  [
    "dataset.version.committed routes by dataset id, directly and to event schedules",
    {
      ...base,
      id: "evt-dataset",
      type: "dataset.version.committed",
      topic: "datasets",
      partitionKey: "raw.erp.orders",
      payload: {
        datasetId: "raw.erp.orders",
        versionId: "v-1",
        createdAt: base.occurredAt,
        producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
      },
    },
    [
      "dataset.version.committed:raw.erp.orders",
      "event-schedule:dataset.version.committed:raw.erp.orders",
    ],
  ],
  [
    "object events route to event schedules by object type",
    {
      ...base,
      ...materialization,
      id: "evt-object",
      type: "object.updated",
      topic: "objects",
      partitionKey: "Invoice:inv-1",
      payload: {
        objectTypeId: "Invoice",
        primaryId: "inv-1",
        properties: { amount: 700 },
        propertyChanges: { amount: { operation: "updated", before: 400, after: 700 } },
      },
    },
    ["event-schedule:object.updated:Invoice"],
  ],
  [
    "link events route to event schedules by source type and link",
    {
      ...base,
      ...materialization,
      id: "evt-link",
      type: "link.created",
      topic: "links",
      partitionKey: "Invoice:inv-1:payments",
      payload: {
        sourceTypeId: "Invoice",
        sourceId: "inv-1",
        linkId: "payments",
        targetTypeId: "Payment",
        targetId: "pay-1",
        properties: {},
        propertyChanges: {},
      },
    },
    ["event-schedule:link.created:Invoice:payments"],
  ],
  [
    "rule events route to event schedules by rule id",
    {
      ...base,
      id: "evt-rule",
      type: "rule.triggered",
      topic: "rules",
      partitionKey: "invoice.at-risk:Invoice:inv-1",
      payload: {
        ruleId: "invoice.at-risk",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-1" },
        triggeredAt: base.occurredAt,
      },
    },
    ["event-schedule:rule.triggered:invoice.at-risk"],
  ],
  [
    "member events route to one project-wide key per type",
    {
      ...base,
      id: "evt-joined",
      type: "user.joined",
      topic: "users",
      partitionKey: "usr_ava",
      payload: { user: { id: "usr_ava", email: "ava@acme.com", status: "active" } },
    },
    ["event-schedule:user.joined:users"],
  ],
]

test.each(cases)("routeKeysForEvent: %s", (_name, event, expected) => {
  expect(routeKeysForEvent(event)).toEqual([...expected])
})

test("a member event schedule listens on the key its events route to", () => {
  expect(eventScheduleRouteKeyForSelector("user.joined", events.users().joined())).toBe(
    "event-schedule:user.joined:users"
  )
})

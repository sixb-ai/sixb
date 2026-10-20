import { defineObjectType, prop } from "@sixb/core"
import {
  type BulkTelemetryHistory,
  type BulkTelemetryHistorySeries,
  bulkTelemetryHistoryQueryOptions,
  type TelemetryHistoryPoint,
  type TelemetryHistoryPoints,
  telemetryHistoryQueryOptions,
  usersQueryOptions,
} from "../src/hooks"

/**
 * Compile-time contract tests for token-based telemetry history hooks.
 *
 * This file is intentionally type-only (no runtime `bun:test` cases).
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const MetricSeries = defineObjectType({
  id: "MetricSeries",
  name: "Metric Series",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("value", "double", { mode: "telemetry" }),
    prop("online", "boolean", { mode: "telemetry" }),
  ],
})

const OtherMetricSeries = defineObjectType({
  id: "OtherMetricSeries",
  name: "Other Metric Series",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("value", "double", { mode: "telemetry" }),
  ],
})

const _numberHistory = telemetryHistoryQueryOptions({
  objectType: MetricSeries,
  objectId: "series-1",
  property: MetricSeries.p.value,
})

type _NumberHistory = Expect<
  Equal<
    TelemetryHistoryPoints<typeof MetricSeries.p.value>,
    readonly TelemetryHistoryPoint<number>[]
  >
>

type _BooleanHistory = Expect<
  Equal<
    TelemetryHistoryPoints<typeof MetricSeries.p.online>,
    readonly TelemetryHistoryPoint<boolean>[]
  >
>

const _bulkNumberHistory = bulkTelemetryHistoryQueryOptions({
  objectType: MetricSeries,
  objectIds: ["series-1", "series-2"],
  properties: [MetricSeries.p.value] as const,
})

type _BulkNumberHistory = Expect<
  Equal<
    BulkTelemetryHistory<readonly [typeof MetricSeries.p.value]>,
    readonly BulkTelemetryHistorySeries<number>[]
  >
>

type _BulkMixedHistory = Expect<
  Equal<
    BulkTelemetryHistory<readonly [typeof MetricSeries.p.value, typeof MetricSeries.p.online]>,
    readonly BulkTelemetryHistorySeries<number | boolean>[]
  >
>

telemetryHistoryQueryOptions({
  objectType: MetricSeries,
  objectId: "series-1",
  // @ts-expect-error static properties cannot be used as telemetry history properties
  property: MetricSeries.p.name,
})

telemetryHistoryQueryOptions({
  objectType: MetricSeries,
  objectId: "series-1",
  // @ts-expect-error telemetry property tokens must belong to the selected object type
  property: OtherMetricSeries.p.value,
})

bulkTelemetryHistoryQueryOptions({
  objectType: MetricSeries,
  objectIds: ["series-1"],
  // @ts-expect-error static properties cannot be used as telemetry history properties
  properties: [MetricSeries.p.name],
})

bulkTelemetryHistoryQueryOptions({
  objectType: MetricSeries,
  objectIds: ["series-1"],
  // @ts-expect-error telemetry property tokens must belong to the selected object type
  properties: [OtherMetricSeries.p.value],
})

// The directory page carries the profile fields the server returns.
type UsersPage = Awaited<ReturnType<NonNullable<ReturnType<typeof usersQueryOptions>["queryFn"]>>>
type _userProfile = Expect<
  Equal<
    UsersPage["users"][number],
    {
      id: string
      email: string
      displayName?: string
      avatarUrl?: string
      status: "active" | "suspended"
    }
  >
>

// @ts-expect-error the directory lists active, suspended, or all members.
usersQueryOptions({ status: "invited" })

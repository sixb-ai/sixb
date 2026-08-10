import { describe, expect, test } from "bun:test"
import {
  change,
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineSchedule,
  defineSync,
  events,
  noopLogger,
  prop,
  Sixb,
  type SyncDefinition,
  type SyncReadContext,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {
      query(sql: string) {
        return sql
      },
    }
  },
})

const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string")],
})

const rawOrderEventsDataset = defineDataset("raw.erp.order-events", {
  schema: [col("eventId", "string")],
})

const rawOrdersCopyDataset = defineDataset("raw.erp.orders.copy", {
  schema: [col("orderId", "string")],
})

const keyedOrdersDataset = defineDataset("raw.erp.keyed-orders", {
  schema: [col("orderId", "string"), col("status", "string")],
  primaryKey: "orderId",
})

const RoomReading = defineObjectType({
  id: "RoomReading",
  name: "Room reading",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})

describe("defineSync", () => {
  test("rejects empty ids", () => {
    expect(() => defineSync("")).toThrow("Sync id must not be empty")
  })

  test("defaults to batch snapshot mode", () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)

    expect(sync.kind).toBe("sync")
    expect(sync.config).toEqual({
      kind: "batch",
      mode: "snapshot",
    })
    expect(sync.target).toEqual({
      kind: "dataset",
      dataset: rawOrdersDataset,
    })
  })

  test("preserves append mode", () => {
    const sync = defineSync("sync-order-events", { mode: "append" })
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrderEventsDataset)

    expect(sync.config.mode).toBe("append")
  })

  test("preserves merge mode for a keyed dataset", () => {
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => [
        change.upsert({ orderId: "ord_1", status: "open" }),
        change.delete({ orderId: "ord_2" }),
      ])
      .intoDataset(keyedOrdersDataset)

    expect(sync.config).toEqual({ kind: "batch", mode: "merge" })
  })

  test("rejects an unkeyed merge target defensively", () => {
    expect(() =>
      defineSync("sync-orders-merge", { mode: "merge" })
        .from(erpDb)
        .read(() => [])
        .intoDataset(rawOrdersDataset as never)
    ).toThrow("Merge sync dataset 'raw.erp.orders' must define a primaryKey")
  })

  test("attaches schedule via .when()", () => {
    const nightly = defineSchedule("nightly").cron("0 0 * * *")
    const sync = defineSync("sync-order-events")
      .when(nightly)
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrderEventsDataset)

    expect(sync.triggers).toEqual([{ type: "schedule", scheduleId: "nightly" }])
  })

  test("triggers is empty when .when() is not called", () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)

    expect(sync.triggers).toEqual([])
  })

  test("accumulates multiple triggers via .when() (OR semantics)", () => {
    const hourly = defineSchedule("hourly").cron("0 * * * *")
    const upstream = defineSync("sync-upstream")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const upstreamSucceeded = defineSchedule("upstream-succeeded").on(
      events.sync(upstream).succeeded()
    )
    const sync = defineSync("sync-order-events")
      .when(hourly)
      .when(upstreamSucceeded)
      .from(erpDb)
      .read(() => [])
      .intoDataset(defineDataset("raw.erp.order-events", { schema: [col("id", "string")] }))

    expect(sync.triggers).toEqual([
      { type: "schedule", scheduleId: "hourly" },
      { type: "schedule", scheduleId: "upstream-succeeded" },
    ])
  })

  test("rejects non-schedule values in .when()", () => {
    expect(() =>
      defineSync("sync-order-events").when({ type: "dataset.updated" } as never)
    ).toThrow("Sync .when(...) only accepts schedules")
  })

  test("rejects invalid modes", () => {
    expect(() => defineSync("sync-orders", { mode: "invalid" as never })).toThrow(
      "Invalid sync mode"
    )
  })

  test("validates dataset target names", () => {
    expect(() =>
      defineSync("sync-orders")
        .from(erpDb)
        .read(() => [])
        .intoDataset({ kind: "dataset", id: "   ", schema: { columns: [] } } as never)
    ).toThrow("Sync dataset id must not be empty")
  })

  test("exposes typed checkpoints to read handlers", async () => {
    type OrdersCheckpoint = { cursor: string }
    const checkpoints: OrdersCheckpoint[] = []
    const sync = defineSync("sync-orders", { mode: "append" })
      .checkpoint<OrdersCheckpoint>()
      .from(erpDb)
      .read((_client, context) => {
        if (context.checkpoint) {
          checkpoints.push(context.checkpoint)
        }
        context.setCheckpoint({ cursor: "cursor-2" })
        return []
      })
      .intoDataset(rawOrdersDataset)

    let nextCheckpoint: OrdersCheckpoint | undefined
    await sync.read(
      {
        query(sql: string) {
          return sql
        },
      },
      {
        projectId: "project-1",
        syncId: "sync-orders",
        signal: new AbortController().signal,
        blobs: createTestRuntimeDeps().blobStorage,
        logger: noopLogger,
        checkpoint: { cursor: "cursor-1" },
        setCheckpoint(next) {
          nextCheckpoint = next
        },
      }
    )

    expect(checkpoints).toEqual([{ cursor: "cursor-1" }])
    expect(nextCheckpoint).toEqual({ cursor: "cursor-2" })
  })

  test("stores the connector and read handler", async () => {
    const calls: SyncReadContext[] = []
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(async (client, context) => {
        calls.push(context)
        return client.query("select * from orders")
      })
      .intoDataset(rawOrdersDataset)

    const result = await sync.read(
      {
        query(sql: string) {
          return sql
        },
      },
      {
        projectId: "project-1",
        syncId: "sync-orders",
        signal: new AbortController().signal,
        blobs: createTestRuntimeDeps().blobStorage,
        logger: noopLogger,
      }
    )

    expect(sync.connector).toBe(erpDb)
    expect(result).toBe("select * from orders")
    expect(calls).toHaveLength(1)
  })
})

describe("Sixb sync registration", () => {
  test("exposes sync definitions and lookup by id", () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)

    const sixb = new Sixb({
      ontology: [Room],
      datasets: [rawOrdersDataset],
      syncs: [sync],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.syncs.list().map((definition) => definition.id)).toEqual(["sync-orders"])
    expect(sixb.syncs.getById("sync-orders")).toBe(sync)
    expect(sixb.syncs.getById("missing-sync")).toBeNull()
  })

  test("rejects duplicate sync ids", () => {
    const sync1 = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const sync2 = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersCopyDataset)
    const syncs: SyncDefinition[] = [sync1, sync2]
    const runtimeDeps = createTestRuntimeDeps()

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset, rawOrdersCopyDataset],
          syncs,
          ...runtimeDeps,
        })
    ).toThrow("Duplicate sync id: sync-orders")
  })

  test("rejects references to unregistered schedules", () => {
    const missing = defineSchedule("missing").cron("0 * * * *")
    const sync = defineSync("sync-orders")
      .when(missing)
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset],
          syncs: [sync],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("Sync 'sync-orders' references unknown schedule 'missing'")
  })

  test("allows only one registered writer for a keyed dataset", () => {
    const first = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => [])
      .intoDataset(keyedOrdersDataset)
    const second = defineSync("snapshot-keyed-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(keyedOrdersDataset)

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [keyedOrdersDataset],
          syncs: [first, second],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(
      "Keyed dataset 'raw.erp.keyed-orders' has multiple registered writers: sync 'sync-keyed-orders' and sync 'snapshot-keyed-orders'"
    )
  })

  test("counts pipeline outputs as keyed dataset writers", () => {
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => [])
      .intoDataset(keyedOrdersDataset)
    const step = definePipelineStep("copy-keyed-orders")
      .inputs({ orders: rawOrdersDataset })
      .output(keyedOrdersDataset)
      .run(() => {})
    const pipeline = definePipeline("orders-pipeline").then(step)

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset, keyedOrdersDataset],
          syncs: [sync],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("sync 'sync-keyed-orders' and pipeline 'orders-pipeline' step 'copy-keyed-orders'")
  })

  test("validates the registered merge target instead of trusting the builder copy", () => {
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => [])
      .intoDataset(keyedOrdersDataset)
    const unkeyedRegisteredCopy = defineDataset(keyedOrdersDataset.id, {
      schema: keyedOrdersDataset.schema.columns,
    })

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [unkeyedRegisteredCopy],
          syncs: [sync],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("Merge sync 'sync-keyed-orders' targets dataset 'raw.erp.keyed-orders'")
  })

  test("rejects telemetry projections backed by merge-written datasets", () => {
    const readings = defineDataset("raw.room-readings", {
      schema: [
        col("id", "string"),
        col("room_id", "string"),
        col("observed_at", "timestamp"),
        col("temperature", "float64"),
      ],
      primaryKey: "id",
    })
    const sync = defineSync("sync-room-readings", { mode: "merge" })
      .from(erpDb)
      .read(() => [])
      .intoDataset(readings)
    const projection = defineProjection("room-temperatures", RoomReading.p.temperature)
      .fromDataset(readings)
      .points({ objectId: "room_id", at: "observed_at", value: "temperature" })

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [RoomReading] as never,
          datasets: [readings],
          syncs: [sync],
          projections: [projection],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("Telemetry projection 'room-temperatures' cannot read merge-written dataset")
  })
})

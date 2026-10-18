import { describe, expect, test } from "bun:test"
import {
  change,
  col,
  type DatasetDefinition,
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
} from "../src"
import { createTestSixb } from "../src/testing"
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
  test("defaults to batch snapshot mode without triggers", () => {
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
    expect(sync.triggers).toEqual([])
  })

  test("preserves append and keyed merge modes", () => {
    const append = defineSync("sync-order-events", { mode: "append" })
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrderEventsDataset)
    const merge = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => [
        change.upsert({ orderId: "ord_1", status: "open" }),
        change.delete({ orderId: "ord_2" }),
      ])
      .intoDataset(keyedOrdersDataset)

    expect(append.config).toEqual({ kind: "batch", mode: "append" })
    expect(merge.config).toEqual({ kind: "batch", mode: "merge" })
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

  test.each([
    ["an empty id", () => defineSync(""), "Sync id must not be empty"],
    [
      "an unkeyed merge target",
      () =>
        defineSync("sync-orders-merge", { mode: "merge" })
          .from(erpDb)
          .read(() => [])
          .intoDataset(rawOrdersDataset as never),
      "Merge sync dataset 'raw.erp.orders' must define a primaryKey",
    ],
    [
      "a non-schedule value in .when()",
      () => defineSync("sync-order-events").when({ type: "dataset.updated" } as never),
      "Sync .when(...) only accepts schedules",
    ],
    [
      "an invalid mode",
      () => defineSync("sync-orders", { mode: "invalid" as never }),
      "Invalid sync mode",
    ],
    [
      "an empty dataset target name",
      () =>
        defineSync("sync-orders")
          .from(erpDb)
          .read(() => [])
          .intoDataset({ kind: "dataset", id: "   ", schema: { columns: [] } } as never),
      "Sync dataset id must not be empty",
    ],
  ] as const)("rejects %s", (_case, define, message) => {
    expect(define).toThrow(message)
  })

  test("stores the connector and passes typed checkpoints to its read handler", async () => {
    type OrdersCheckpoint = { cursor: string }
    const checkpoints: OrdersCheckpoint[] = []
    const sync = defineSync("sync-orders", { mode: "append" })
      .checkpoint<OrdersCheckpoint>()
      .from(erpDb)
      .read((client, context) => {
        if (context.checkpoint) {
          checkpoints.push(context.checkpoint)
        }
        context.setCheckpoint({ cursor: "cursor-2" })
        return client.query("select * from orders") as never
      })
      .intoDataset(rawOrdersDataset)

    let nextCheckpoint: OrdersCheckpoint | undefined
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
        checkpoint: { cursor: "cursor-1" },
        setCheckpoint(next) {
          nextCheckpoint = next
        },
      }
    )

    expect(sync.connector).toBe(erpDb)
    expect(result).toBe("select * from orders")
    expect(checkpoints).toEqual([{ cursor: "cursor-1" }])
    expect(nextCheckpoint).toEqual({ cursor: "cursor-2" })
  })
})

describe("SixbHost sync registration", () => {
  test("exposes sync definitions and lookup by id", () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)

    const sixb = createTestSixb({
      ontology: [Room],
      datasets: [rawOrdersDataset],
      syncs: [sync],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.syncs.list().map((definition) => definition.id)).toEqual(["sync-orders"])
    expect(sixb.syncs.getById("sync-orders")).toBe(sync)
    expect(sixb.syncs.getById("missing-sync")).toBeNull()
  })

  const syncInto = (
    id: string,
    dataset: DatasetDefinition,
    mode: "snapshot" | "merge" = "snapshot"
  ) =>
    defineSync(id, { mode })
      .from(erpDb)
      .read(() => [])
      .intoDataset(dataset as never)
  const readings = defineDataset("raw.room-readings", {
    schema: [
      col("id", "string"),
      col("room_id", "string"),
      col("observed_at", "timestamp"),
      col("temperature", "float64"),
    ],
    primaryKey: "id",
  })

  test.each([
    [
      "duplicate sync ids",
      {
        datasets: [rawOrdersDataset, rawOrdersCopyDataset],
        syncs: [
          syncInto("sync-orders", rawOrdersDataset),
          syncInto("sync-orders", rawOrdersCopyDataset),
        ],
      },
      "Duplicate sync id: sync-orders",
    ],
    [
      "references to unregistered schedules",
      {
        datasets: [rawOrdersDataset],
        syncs: [
          defineSync("sync-orders")
            .when(defineSchedule("missing").cron("0 * * * *"))
            .from(erpDb)
            .read(() => [])
            .intoDataset(rawOrdersDataset),
        ],
      },
      "Sync 'sync-orders' references unknown schedule 'missing'",
    ],
    [
      "a second registered writer for a keyed dataset",
      {
        datasets: [keyedOrdersDataset],
        syncs: [
          syncInto("sync-keyed-orders", keyedOrdersDataset, "merge"),
          syncInto("snapshot-keyed-orders", keyedOrdersDataset),
        ],
      },
      "Keyed dataset 'raw.erp.keyed-orders' has multiple registered writers: sync 'sync-keyed-orders' and sync 'snapshot-keyed-orders'",
    ],
    [
      "a pipeline output as a second keyed dataset writer",
      {
        datasets: [rawOrdersDataset, keyedOrdersDataset],
        syncs: [syncInto("sync-keyed-orders", keyedOrdersDataset, "merge")],
        pipelines: [
          definePipeline("orders-pipeline").then(
            definePipelineStep("copy-keyed-orders")
              .inputs({ orders: rawOrdersDataset })
              .output(keyedOrdersDataset)
              .run(() => {})
          ),
        ],
      },
      "sync 'sync-keyed-orders' and pipeline 'orders-pipeline' step 'copy-keyed-orders'",
    ],
    [
      // The registered merge target is validated instead of the builder's copy.
      "a merge sync whose registered target is unkeyed",
      {
        datasets: [
          defineDataset(keyedOrdersDataset.id, { schema: keyedOrdersDataset.schema.columns }),
        ],
        syncs: [syncInto("sync-keyed-orders", keyedOrdersDataset, "merge")],
      },
      "Merge sync 'sync-keyed-orders' targets dataset 'raw.erp.keyed-orders'",
    ],
    [
      "telemetry projections backed by merge-written datasets",
      {
        ontology: [RoomReading],
        datasets: [readings],
        syncs: [syncInto("sync-room-readings", readings, "merge")],
        projections: [
          defineProjection("room-temperatures", RoomReading.p.temperature)
            .fromDataset(readings)
            .points({ objectId: "room_id", at: "observed_at", value: "temperature" }),
        ],
      },
      "Telemetry projection 'room-temperatures' cannot read merge-written dataset",
    ],
  ] as const)("rejects %s", (_case, definitions, message) => {
    expect(() =>
      createTestSixb({ ontology: [], ...definitions, ...createTestRuntimeDeps() } as never)
    ).toThrow(message)
  })
})

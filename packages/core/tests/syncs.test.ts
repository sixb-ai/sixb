import { describe, expect, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineSchedule,
  defineSync,
  noopLogger,
  prop,
  Sixb,
  type SyncDefinition,
  type SyncReadContext,
  syncFinished,
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
    const sync = defineSync("sync-order-events")
      .when(hourly)
      .when(syncFinished("sync-upstream"))
      .from(erpDb)
      .read(() => [])
      .intoDataset(defineDataset("raw.erp.order-events", { schema: [col("id", "string")] }))

    expect(sync.triggers).toEqual([
      { type: "schedule", scheduleId: "hourly" },
      { type: "sync.finished", syncId: "sync-upstream", status: "succeeded" },
    ])
  })

  test("accepts RunTrigger directly via .when()", () => {
    const sync = defineSync("sync-order-events")
      .when(syncFinished("sync-other"))
      .from(erpDb)
      .read(() => [])
      .intoDataset(defineDataset("raw.erp.order-events", { schema: [col("id", "string")] }))

    expect(sync.triggers).toEqual([
      { type: "sync.finished", syncId: "sync-other", status: "succeeded" },
    ])
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

    expect(sixb.getSyncDefinitions().map((definition) => definition.id)).toEqual(["sync-orders"])
    expect(sixb.getSyncById("sync-orders")).toBe(sync)
    expect(sixb.getSyncById("missing-sync")).toBeNull()
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
})

import { col, defineConnector, defineDataset, defineSync, type SyncDefinition } from "../src"

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
  schema: [col("id", "int64")],
})

const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(async (db, context) => {
    const _queryResult: string = db.query("select 1")
    const _projectId: string = context.projectId
    const _syncId: string = context.syncId
    const _signal: AbortSignal = context.signal

    // @ts-expect-error connector client typing flows into sync read handlers
    db.nonexistent()

    const _checkpoint: undefined = context.checkpoint

    // @ts-expect-error checkpoint setters are only exposed after .checkpoint<T>()
    context.setCheckpoint({ cursor: "next" })

    // @ts-expect-error sync read context should not expose the Pario runtime
    context.pario

    return [{ id: 1 }]
  })
  .intoDataset(rawOrdersDataset)

const syncOrdersWithCheckpoint = defineSync("sync-orders-with-checkpoint")
  .checkpoint<{ cursor: string }>()
  .from(erpDb)
  .read(async (db, context) => {
    const _queryResult: string = db.query("select 1")
    const _checkpoint: { cursor: string } | undefined = context.checkpoint

    context.setCheckpoint({ cursor: "next" })

    // @ts-expect-error checkpoint must match the type supplied to .checkpoint<T>()
    context.setCheckpoint({ page: 2 })

    return [{ id: 1 }]
  })
  .intoDataset(rawOrdersDataset)

const _syncDefinitions: SyncDefinition[] = [syncOrders, syncOrdersWithCheckpoint]
const _connector = syncOrders.connector
const _checkpointConnector = syncOrdersWithCheckpoint.connector

void _syncDefinitions
void _connector
void _checkpointConnector

import { col, defineConnector, defineDataset, defineSync } from "../src"

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

    // @ts-expect-error sync read context should not expose the Pario runtime
    context.pario

    return [{ id: 1 }]
  })
  .intoDataset(rawOrdersDataset)

const _connector = syncOrders.connector

void _connector

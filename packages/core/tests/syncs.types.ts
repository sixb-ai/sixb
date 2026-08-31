import {
  type BatchSyncConfig,
  type BlobInfo,
  change,
  col,
  defineConnector,
  defineDataset,
  defineSync,
  type FileRef,
  type SyncDefinition,
  type SyncMode,
} from "../src"

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

const social = defineConnector("social", {
  type: "social-oauth",
  authentication: {
    type: "oauth2",
    authorizationUrl() {
      return "https://provider.test/oauth"
    },
    exchangeCode() {
      return { accessToken: "access" }
    },
    refresh() {
      return { accessToken: "refreshed" }
    },
  },
  discoverAccounts() {
    return [{ id: "account-a", label: "Account A" }]
  },
  connect(context) {
    return {
      accountId: context.account.id,
    }
  },
})

const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("id", "int64")],
})

const keyedOrdersDataset = defineDataset("raw.erp.keyed-orders", {
  schema: [col("id", "string"), col("status", "string")],
  primaryKey: "id",
})

const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(async (db, context) => {
    const _queryResult: string = db.query("select 1")
    const _projectId: string = context.projectId
    const _syncId: string = context.syncId
    const _signal: AbortSignal = context.signal
    const _fileRef: FileRef = await context.blobs.put({
      body: new Uint8Array([1, 2, 3]),
      fileName: "orders.csv",
      mediaType: "text/csv",
      logicalPath: "erp/orders.csv",
    })
    const _blobInfo: BlobInfo | null = await context.blobs.stat(_fileRef.blobId)
    const _stream: ReadableStream<Uint8Array> = await context.blobs.open(_fileRef.blobId)

    // @ts-expect-error connector client typing flows into sync read handlers
    db.nonexistent()

    const _checkpoint: undefined = context.checkpoint
    const _connection: undefined = context.connection

    // @ts-expect-error checkpoint setters are only exposed after .checkpoint<T>()
    context.setCheckpoint({ cursor: "next" })

    // @ts-expect-error sync read context should not expose the Sixb runtime
    context.sixb

    // @ts-expect-error sync blob context exposes only put, stat, and open
    context.blobs.delete(_fileRef.blobId)

    return [{ id: 1 }]
  })
  .intoDataset(rawOrdersDataset)

const _snapshotMode: "snapshot" = syncOrders.config.mode

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

const syncManagedAccounts = defineSync("sync-managed-accounts")
  .checkpoint<{ cursor: string }>()
  .from(social)
  .read((client, context) => {
    const _clientAccountId: string = client.accountId
    const _connectionId: string = context.connection.id
    const _connectorId: string = context.connection.connectorId
    const _slot: string = context.connection.slot
    const _accountId: string = context.connection.account.id
    const _ownerType: "project" = context.connection.owner.type
    const _checkpoint: { cursor: string } | undefined = context.checkpoint
    context.setCheckpoint({ cursor: "next" })
    return [{ id: 1 }]
  })
  .intoDataset(rawOrdersDataset)

const mergeOrders = defineSync("merge-orders", { mode: "merge" })
  .checkpoint<{ cursor: string }>()
  .from(erpDb)
  .read(async function* (_db, context) {
    const _checkpoint: { cursor: string } | undefined = context.checkpoint
    yield change.upsert({ id: "ord_1", status: "open" })
    yield change.delete({ id: "ord_2" })
    context.setCheckpoint({ cursor: "next" })
  })
  .intoDataset(keyedOrdersDataset)

const _mergeMode: "merge" = mergeOrders.config.mode

const mergeOptions = { mode: "merge" } satisfies BatchSyncConfig
const mergeOrdersFromSatisfiedOptions = defineSync("merge-orders-satisfied", mergeOptions)
  .from(erpDb)
  .read(() => [change.delete({ id: "ord_2" })])
  .intoDataset(keyedOrdersDataset)
const _satisfiedMergeMode: "merge" = mergeOrdersFromSatisfiedOptions.config.mode

const annotatedMergeOptions: BatchSyncConfig = { mode: "merge" }
const mergeOrdersFromAnnotatedOptions = defineSync("merge-orders-annotated", annotatedMergeOptions)
  .from(erpDb)
  .read(() => [change.delete({ id: "ord_2" })])
  .intoDataset(keyedOrdersDataset)
const _annotatedMode: SyncMode = mergeOrdersFromAnnotatedOptions.config.mode
// Regression guard: restoring the former SyncModeFromConfig conditional makes this directive
// unused because the annotated merge config is falsely narrowed to snapshot.
// @ts-expect-error an annotated config must remain SyncMode, never a false snapshot literal
const _falseSnapshotMode: "snapshot" = mergeOrdersFromAnnotatedOptions.config.mode

defineSync("invalid-merge-row", { mode: "merge" })
  .from(erpDb)
  // @ts-expect-error merge readers must return MergeChange values, not raw rows
  .read(() => [{ id: "ord_1", status: "open" }])
  .intoDataset(keyedOrdersDataset)

defineSync("invalid-merge-target", { mode: "merge" })
  .from(erpDb)
  .read(() => [change.delete({ id: "ord_1" })])
  // @ts-expect-error merge syncs require a dataset with a primary key
  .intoDataset(rawOrdersDataset)

const _syncDefinitions: SyncDefinition[] = [
  syncOrders,
  syncOrdersWithCheckpoint,
  syncManagedAccounts,
  mergeOrders,
]
const _connector = syncOrders.connector
const _checkpointConnector = syncOrdersWithCheckpoint.connector

void _syncDefinitions
void _connector
void _checkpointConnector
void _snapshotMode
void _mergeMode
void _satisfiedMergeMode
void _annotatedMode
void _falseSnapshotMode

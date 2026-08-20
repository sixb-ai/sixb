import { defineConnector, defineObjectType } from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
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

const sixb = createTestSixb({
  ontology: [Room],
  connectors: [erpDb],
  ...createTestRuntimeDeps(),
})

const db = await sixb.connector(erpDb)
const _queryResult: string = db.query("select 1")

// @ts-expect-error connector clients are typed from the registered connector definition
db.nonexistent()

void sixb

const managed = defineConnector("managed", {
  mode: "managed",
  type: "oauth",
  authorizationUrl() {
    return "https://provider.test/oauth"
  },
  exchangeCode() {
    return { accessToken: "access" }
  },
  refresh() {
    return { accessToken: "refreshed" }
  },
  discoverAccounts() {
    return [{ id: "account", label: "Account" }]
  },
  connect(context) {
    return { accountId: context.account.id }
  },
})

const managedSixb = createTestSixb({
  ontology: [Room],
  connectors: [managed],
  ...createTestRuntimeDeps(),
})

// @ts-expect-error managed connectors never select an implicit default connection
await managedSixb.connector(managed)
const managedClient = await managedSixb.connector(managed, {
  owner: { type: "project" },
  slot: "social",
})
const _managedAccountId: string = managedClient.accountId

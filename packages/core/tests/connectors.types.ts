import { defineConnector, defineObjectType, type OAuthConnectorAdapter } from "../src"
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

// @ts-expect-error static connectors do not accept a persistent connection selector
await sixb.connector(erpDb, { owner: { type: "project" }, slot: "primary" })

// @ts-expect-error connector clients are typed from the registered connector definition
db.nonexistent()

void sixb

function oauthAccounts() {
  return {
    type: "oauth",
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
      return [{ id: "account", label: "Account" }]
    },
    connect(context) {
      return { accountId: context.account.id }
    },
  } satisfies OAuthConnectorAdapter
}

const oauth = defineConnector("oauth", oauthAccounts())

const oauthSixb = createTestSixb({
  ontology: [Room],
  connectors: [oauth],
  ...createTestRuntimeDeps(),
})

// @ts-expect-error OAuth connectors never select an implicit default connection
await oauthSixb.connector(oauth)
const oauthClient = await oauthSixb.connector(oauth, {
  owner: { type: "project" },
  slot: "social",
})
const _oauthAccountId: string = oauthClient.accountId

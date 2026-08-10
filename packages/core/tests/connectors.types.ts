import { defineConnector, defineObjectType, Sixb } from "../src"
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

const sixb = new Sixb({
  ontology: [Room],
  connectors: [erpDb],
  ...createTestRuntimeDeps(),
})

const db = await sixb.connectors.connect(erpDb)
const _queryResult: string = db.query("select 1")

// @ts-expect-error connector clients are typed from the registered connector definition
db.nonexistent()

void sixb

import { describe, expect, test } from "bun:test"
import {
  ConnectorNotFoundError,
  defineConnector,
  defineObjectType,
  type OntologySource,
  prop,
  SixbHost,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

describe("connectors", () => {
  test("connects lazily and caches the connected client", async () => {
    let connectCount = 0

    const erpDb = defineConnector("erpDb", {
      type: "test",
      connect(context) {
        connectCount += 1
        return {
          connectorId: context.connectorId,
          projectId: context.projectId,
        }
      },
    })

    const sixb = createTestSixb({
      ontology: [Room],
      connectors: [erpDb],
      ...createTestRuntimeDeps(),
    })

    expect(connectCount).toBe(0)

    const first = await sixb.connector(erpDb)
    const second = await sixb.connector(erpDb)

    expect(connectCount).toBe(1)
    expect(first).toBe(second)
    expect(first.connectorId).toBe("erpDb")
    expect(first.projectId).toBe("default")
  })

  test("disconnects connected clients and reconnects on next access", async () => {
    let connectCount = 0
    let disconnectCount = 0

    const erpDb = defineConnector("erpDb", {
      type: "test",
      connect() {
        connectCount += 1
        return { instance: connectCount }
      },
      disconnect() {
        disconnectCount += 1
      },
    })

    const host = new SixbHost<readonly OntologySource[]>({
      ontology: [Room],
      connectors: [erpDb],
      ...createTestRuntimeDeps(),
    })
    const sixb = createTestSixb(host)
    const first = await sixb.connector(erpDb)
    await host.closeConnectors()
    const second = await sixb.connector(erpDb)

    expect(disconnectCount).toBe(1)
    expect(connectCount).toBe(2)
    expect(first).not.toBe(second)
  })

  test("lists connectors and gets them by id", () => {
    const erpDb = defineConnector("erpDb", {
      type: "test",
      connect() {
        return { ok: true }
      },
    })

    const hubspot = defineConnector("hubspot", {
      type: "test",
      connect() {
        return { ok: true }
      },
    })

    const host = new SixbHost({
      ontology: [Room],
      connectors: [erpDb, hubspot],
      ...createTestRuntimeDeps(),
    })

    expect(host.definitions.connectors.list().map((connector) => connector.id)).toEqual([
      "erpDb",
      "hubspot",
    ])
    expect(host.definitions.connectors.getById("erpDb")).toBe(erpDb)
    expect(host.definitions.connectors.getById("missing")).toBeNull()
  })

  test("rejects an unknown connector with ConnectorNotFoundError", async () => {
    const unknown = defineConnector("unknown", {
      type: "test",
      connect() {
        return { ok: true }
      },
    })

    const sixb = createTestSixb({
      ontology: [Room],
      connectors: [],
      ...createTestRuntimeDeps(),
    })

    await expect(sixb.connector(unknown)).rejects.toBeInstanceOf(ConnectorNotFoundError)
    await expect(sixb.connector(unknown)).rejects.toThrow("Unknown connector 'unknown'")
  })

  test("rejects an unregistered connector definition instance", async () => {
    const registered = defineConnector("erpDb", {
      type: "test",
      connect() {
        return { kind: "registered" as const }
      },
    })

    const imposter = defineConnector("erpDb", {
      type: "test",
      connect() {
        return { kind: "imposter" as const }
      },
    })

    const sixb = createTestSixb({
      ontology: [Room],
      connectors: [registered],
      ...createTestRuntimeDeps(),
    })

    await expect(sixb.connector(imposter)).rejects.toThrow("not the registered definition instance")
  })
})

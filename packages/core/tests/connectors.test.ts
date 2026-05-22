import { describe, expect, test } from "bun:test"
import { ConnectorNotFoundError, defineConnector, defineObjectType, Pario, prop } from "../src"
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

    const pario = new Pario({
      ontology: [Room],
      connectors: [erpDb],
      ...createTestRuntimeDeps(),
    })

    expect(connectCount).toBe(0)

    const first = await pario.connector(erpDb)
    const second = await pario.connector(erpDb)

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

    const pario = new Pario({
      ontology: [Room],
      connectors: [erpDb],
      ...createTestRuntimeDeps(),
    })

    const first = await pario.connector(erpDb)
    await pario.disconnectConnectors()
    const second = await pario.connector(erpDb)

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

    const pario = new Pario({
      ontology: [Room],
      connectors: [erpDb, hubspot],
      ...createTestRuntimeDeps(),
    })

    expect(pario.listConnectors().map((connector) => connector.id)).toEqual(["erpDb", "hubspot"])
    expect(pario.getConnectorById("erpDb")).toBe(erpDb)
    expect(pario.getConnectorById("missing")).toBeNull()
  })

  test("rejects an unknown connector with ConnectorNotFoundError", async () => {
    const unknown = defineConnector("unknown", {
      type: "test",
      connect() {
        return { ok: true }
      },
    })

    const pario = new Pario({
      ontology: [Room],
      connectors: [],
      ...createTestRuntimeDeps(),
    })

    await expect(pario.connector(unknown)).rejects.toBeInstanceOf(ConnectorNotFoundError)
    await expect(pario.connector(unknown)).rejects.toThrow("Unknown connector 'unknown'")
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

    const pario = new Pario({
      ontology: [Room],
      connectors: [registered],
      ...createTestRuntimeDeps(),
    })

    await expect(pario.connector(imposter)).rejects.toThrow(
      "not the registered definition instance"
    )
  })
})

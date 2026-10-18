import { describe, expect, test } from "bun:test"
import { ConnectorNotFoundError, defineConnector, defineObjectType, prop, SixbHost } from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

describe("connectors", () => {
  test("connects lazily, caches the client until closed, and reconnects on next access", async () => {
    let connectCount = 0
    let disconnectCount = 0

    const erpDb = defineConnector("erpDb", {
      type: "test",
      connect(context) {
        connectCount += 1
        return {
          connectorId: context.connectorId,
          projectId: context.projectId,
          instance: connectCount,
        }
      },
      disconnect() {
        disconnectCount += 1
      },
    })

    const host = new SixbHost({
      ontology: [Room],
      connectors: [erpDb],
      ...createTestRuntimeDeps(),
    })
    const sixb = createTestSixb(host)
    expect(connectCount).toBe(0)

    const first = await sixb.connector(erpDb)
    expect(await sixb.connector(erpDb)).toBe(first)
    expect(connectCount).toBe(1)
    expect(first).toMatchObject({ connectorId: "erpDb", projectId: "default" })

    await host.closeConnectors()
    const second = await sixb.connector(erpDb)
    expect(disconnectCount).toBe(1)
    expect(connectCount).toBe(2)
    expect(second).not.toBe(first)
  })

  test("rejects unknown connectors and unregistered definition instances", async () => {
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
    const unknown = defineConnector("unknown", {
      type: "test",
      connect() {
        return { ok: true }
      },
    })

    const sixb = createTestSixb({
      ontology: [Room],
      connectors: [registered],
      ...createTestRuntimeDeps(),
    })

    const missing = sixb.connector(unknown)
    await expect(missing).rejects.toBeInstanceOf(ConnectorNotFoundError)
    await expect(missing).rejects.toThrow("Unknown connector 'unknown'")
    await expect(sixb.connector(imposter)).rejects.toThrow("not the registered definition instance")
  })
})

import { describe, expect, test } from "bun:test"
import { defineConnector, SixbHost } from "../src"
import { ConnectorService } from "../src/connectors/service"
import { InMemoryStorage } from "../src/storage/in-memory"
import { createHarness } from "./connector-connections.fixture"
import { createTestRuntimeDeps } from "./test-runtime-deps"

describe("connector connection startup validation", () => {
  test("requires connection storage and explicit protection for durable providers", () => {
    const harness = createHarness()
    expect(() => new ConnectorService("project", [harness.connector])).toThrow(
      "storage.connectorConnections"
    )
    expect(
      () =>
        new ConnectorService("project", [harness.connector], {
          storage: new InMemoryStorage(),
        })
    ).not.toThrow()

    const durableStorage = new InMemoryStorage()
    Object.defineProperty(durableStorage.connectorConnections, "durability", {
      value: "durable",
    })
    expect(
      () => new ConnectorService("project", [harness.connector], { storage: durableStorage })
    ).toThrow("connectorConnections.encryptionKey")
  })

  test("validates encryption only when OAuth connections need it", () => {
    const harness = createHarness()
    expect(
      () =>
        new SixbHost({
          ontology: [],
          connectors: [harness.connector],
          connectorConnections: {
            encryptionKey: Buffer.from(new Uint8Array(31)).toString("base64url"),
          },
          ...createTestRuntimeDeps(),
        })
    ).toThrow("exactly 32 random bytes")

    const staticConnector = defineConnector("static", {
      type: "static",
      connect() {
        return {}
      },
    })
    expect(
      () =>
        new SixbHost({
          ontology: [],
          connectors: [staticConnector],
          connectorConnections: { encryptionKey: "unused" },
          ...createTestRuntimeDeps(),
        })
    ).not.toThrow()
  })
})

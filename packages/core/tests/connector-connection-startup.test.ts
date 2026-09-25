import { describe, expect, test } from "bun:test"
import { col, defineConnector, defineDataset, defineSync, defineWebhook, SixbHost } from "../src"
import { ConnectorService } from "../src/connectors/service"
import { InMemoryStorage } from "../src/storage/in-memory"
import { createHarness, encryptionKey } from "./connector-connections.fixture"
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

  test("accepts OAuth Syncs and ordinary webhook definitions", () => {
    const harness = createHarness()
    const dataset = defineDataset("accounts", { schema: [col("id", "string")] })
    const sync = defineSync("accounts")
      .from(harness.connector)
      .read(() => [])
      .intoDataset(dataset)

    expect(
      () =>
        new SixbHost({
          ontology: [],
          connectors: [harness.connector],
          datasets: [dataset],
          syncs: [sync],
          connectorConnections: { encryptionKey },
          ...createTestRuntimeDeps(),
        })
    ).not.toThrow()

    Object.defineProperty(harness.connector.adapter, "webhooks", {
      value: [
        defineWebhook("events")
          .post()
          .json()
          .handle(() => {}),
      ],
    })
    expect(
      () =>
        new SixbHost({
          ontology: [],
          connectors: [harness.connector],
          connectorConnections: { encryptionKey },
          ...createTestRuntimeDeps(),
        })
    ).not.toThrow()
  })
})

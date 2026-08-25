import { describe, expect, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  defineSync,
  SixbHost,
  type SyncDefinition,
} from "../src"
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
        new SixbHost<readonly []>({
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
        new SixbHost<readonly []>({
          ontology: [],
          connectors: [staticConnector],
          connectorConnections: { encryptionKey: "unused" },
          ...createTestRuntimeDeps(),
        })
    ).not.toThrow()
  })

  test("rejects OAuth sync and webhook surfaces explicitly", () => {
    const harness = createHarness()
    const dataset = defineDataset("accounts", { schema: [col("id", "string")] })
    const staticConnector = defineConnector("static", {
      type: "static",
      connect() {
        return {}
      },
    })
    const sync = defineSync("accounts")
      .from(staticConnector)
      .read(() => [])
      .intoDataset(dataset)
    const oauthSync = { ...sync, connector: harness.connector } as unknown as SyncDefinition

    expect(
      () =>
        new SixbHost<readonly []>({
          ontology: [],
          connectors: [harness.connector],
          datasets: [dataset],
          syncs: [oauthSync],
          connectorConnections: { encryptionKey },
          ...createTestRuntimeDeps(),
        })
    ).toThrow("cannot use OAuth connector")

    Object.defineProperty(harness.connector.adapter, "webhooks", { value: [] })
    expect(
      () =>
        new SixbHost<readonly []>({
          ontology: [],
          connectors: [harness.connector],
          connectorConnections: { encryptionKey },
          ...createTestRuntimeDeps(),
        })
    ).toThrow("cannot register webhooks")
  })
})

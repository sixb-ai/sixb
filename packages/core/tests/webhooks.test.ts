import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type ConnectorDefinition,
  createSixb,
  defineConnector,
  defineWebhook,
  InMemoryStorage,
  type OntologySource,
  Sixb,
  type SixbOptions,
  type Storage,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href
const tempRoots = new Set<string>()

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
  tempRoots.clear()
})

describe("webhooks", () => {
  test("builds json webhooks with runtime body parsing", () => {
    const schema = {
      parse(value: unknown): { name: string } {
        if (!isRecord(value) || typeof value.name !== "string") {
          throw new Error("name is required")
        }

        return { name: value.name }
      },
    }

    const webhook = defineWebhook("events")
      .post()
      .json(schema)
      .idempotencyKey(({ body }) => body.name)
      .handle(({ body }) => ({ status: 200, body }))

    expect(webhook.kind).toBe("webhook")
    expect(webhook.method).toBe("POST")
    expect(webhook.body.format).toBe("json")
    expect(webhook.body.parse({ name: "Ada" })).toEqual({ name: "Ada" })
    expect(() => webhook.body.parse({})).toThrow("name is required")
  })

  test("rejects invalid webhook builders early", () => {
    expect(() => defineWebhook("")).toThrow("[Sixb] Webhook id must not be empty.")
    expect(() =>
      defineWebhook("events")
        .post()
        .json({ parse: "nope" } as never)
    ).toThrow("[Sixb] Webhook JSON schema must provide parse(value).")
  })

  test("lists and resolves connector-scoped webhooks", () => {
    const webhook = defineWebhook("events")
      .post()
      .raw()
      .handle(() => {})
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [webhook],
      connect() {
        return { ok: true }
      },
    })

    const sixb = createRuntime([connector])
    const [registered] = sixb.listWebhooks()

    expect(registered).toEqual({
      connector,
      webhook,
      route: "/api/webhooks/github/events",
    })
    expect(sixb.getWebhookById("github", "events")).toBe(registered)
    expect(sixb.getWebhookById("github", "missing")).toBeNull()
  })

  test("fails startup on duplicate webhook ids per connector", () => {
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .raw()
          .handle(() => {}),
        defineWebhook("events")
          .post()
          .text()
          .handle(() => {}),
      ],
      connect() {
        return {}
      },
    })

    expect(() => createRuntime([connector])).toThrow(
      "[Sixb] Duplicate webhook id 'events' for connector 'github'."
    )
  })

  test("fails startup on duplicate computed webhook routes", () => {
    const first = defineConnector("edge/gateway", {
      type: "test",
      webhooks: [
        defineWebhook("telemetry")
          .post()
          .raw()
          .handle(() => {}),
      ],
      connect() {
        return {}
      },
    })
    const second = defineConnector("edge", {
      type: "test",
      webhooks: [
        defineWebhook("gateway/telemetry")
          .post()
          .raw()
          .handle(() => {}),
      ],
      connect() {
        return {}
      },
    })

    expect(() => createRuntime([first, second])).toThrow(
      "[Sixb] Duplicate webhook route '/api/webhooks/edge/gateway/telemetry'"
    )
  })

  test("requires delivery storage when a webhook uses idempotency", () => {
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .raw()
          .idempotencyKey(() => "delivery-id")
          .handle(() => {}),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const storageWithoutDeliveries: Storage = {
      ...storage,
      transaction: storage.transaction.bind(storage),
      webhookDeliveries: undefined,
    }

    expect(() => createRuntime([connector], storageWithoutDeliveries)).toThrow(
      "[Sixb] Webhook idempotency requires storage.webhookDeliveries"
    )
  })

  test("discovers webhooks through discovered connectors", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/sensor.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true })],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "connectors/edge.ts",
      `import { defineConnector, defineWebhook, webhookConnector } from "${coreModuleUrl}"

export const edgeGateway = defineConnector(
  "edgeGateway",
  webhookConnector({
    webhooks: [defineWebhook("telemetry").post().json().handle(() => {})],
  })
)
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.listWebhooks().map((webhook) => webhook.route)).toEqual([
      "/api/webhooks/edgeGateway/telemetry",
    ])
    expect(sixb.getWebhookById("edgeGateway", "telemetry")?.webhook.id).toBe("telemetry")
  })
})

function createRuntime(
  connectors: readonly ConnectorDefinition[],
  storage: Storage = new InMemoryStorage()
): Sixb<readonly OntologySource[]> {
  const SixbConstructor = Sixb as unknown as new (
    options: SixbOptions<readonly OntologySource[]>
  ) => Sixb<readonly OntologySource[]>

  const runtimeDeps = createTestRuntimeDeps()
  return new SixbConstructor({
    ontology: [],
    connectors,
    ...runtimeDeps,
    storage,
  })
}

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-webhooks-"))
  tempRoots.add(projectRoot)
  return projectRoot
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(projectRoot, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, "utf-8")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

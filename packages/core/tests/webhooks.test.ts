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
  SixbHost,
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
  test("rejects invalid webhook builders early", () => {
    expect(() => defineWebhook("")).toThrow("[Sixb] Webhook id must not be empty.")
    expect(() =>
      defineWebhook("events")
        .post()
        .json({ parse: "nope" } as never)
    ).toThrow("[Sixb] Webhook JSON schema must provide parse(value).")
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

    const [registered] = sixb.listWebhooks()
    expect(sixb.listWebhooks()).toHaveLength(1)
    expect(registered?.route).toBe("/api/webhooks/edgeGateway/telemetry")
    expect(registered?.connector.id).toBe("edgeGateway")
    expect(registered?.webhook.id).toBe("telemetry")
    expect(sixb.getWebhookById("edgeGateway", "telemetry")).toBe(registered!)
    expect(sixb.getWebhookById("edgeGateway", "missing")).toBeNull()
  })
})

function createRuntime(connectors: readonly ConnectorDefinition[]) {
  return new SixbHost({ ontology: [], connectors, ...createTestRuntimeDeps() })
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

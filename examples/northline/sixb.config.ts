import { mkdirSync, writeFileSync } from "node:fs"
import { magicLink } from "@sixb/auth-magic-link"
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"
import { SqliteStorage } from "@sixb/sqlite"
import { imageModels, languageModels } from "./ai/models"
import { lookupResponsePolicy } from "./ai/tools"
import { productionRuntime } from "./lib/runtime/production"
import { localAdmins } from "./security/groups/local-admins"

const localLakePath = ".sixb/lake"
mkdirSync(localLakePath, { recursive: true })

// Production roles and `sixb deploy` set NODE_ENV=production; `sixb dev` does not.
const production = process.env.NODE_ENV === "production" ? productionRuntime() : null

export const sixb = createSixb({
  id: "northline",
  models: { language: languageModels, image: imageModels },
  tools: [lookupResponsePolicy],
  broker: production?.broker ?? new InMemoryBroker(),
  storage: production?.storage ?? new SqliteStorage({ path: ".sixb" }),
  lakeStorage:
    production?.lakeStorage ??
    new DuckLakeStorage({
      catalog: { type: "duckdb", path: `${localLakePath}/catalog.ducklake` },
      dataPath: `${localLakePath}/data`,
    }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: production?.queues ?? new InMemoryQueues(),
  // A public demo: anyone with the link can use it, deployed or not. Local only:
  // NORTHLINE_AUTH=magic-link signs in as you@example.com, a local admin, to see Settings.
  auth:
    process.env.NORTHLINE_AUTH === "magic-link"
      ? magicLink({
          allowedDomains: ["example.com"],
          bootstrapUsers: ["you@example.com"],
          bootstrapGroups: [localAdmins],
          rateLimit: false,
          async sendMagicLink({ url }) {
            // The dev footer makes the terminal link hard to copy, so it also lands in a file.
            writeFileSync(".sixb/sign-in-link.txt", `${url}\n`)
            console.log(`[Northline] Sign-in link: ${url}`)
          },
        })
      : {
          id: "northline",
          kind: "disabled",
          disabled: true,
          allowDisabledInProduction: true,
        },
  sandboxes:
    process.env.SIXB_SANDBOX_PROVIDER === "smolvm"
      ? new SmolvmSandboxFactory({
          image: process.env.SIXB_AGENT_IMAGE ?? "/opt/sixb/agent.tar",
          timeout: 30_000,
        })
      : new LocalSandboxFactory({ timeout: 30_000 }),
  onError(error, context) {
    let failure: string
    if (context.type === "run.failed") {
      failure = `${context.runKind} run '${context.run.runId}' failed with ${context.failure.code}`
    } else if (context.type === "action.phase.failed") {
      failure = `action '${context.actionId}' phase '${context.phase}' failed with ${context.failure.code}`
    } else if (context.type === "event.delivery.failed") {
      failure = `event delivery failed with ${context.failure.code} after ${context.attempts} attempt(s)`
    } else if (context.type === "vector.indexing.failed") {
      failure = `vector profile '${context.profile}' on '${context.objectTypeId}:${context.primaryId}' failed with ${context.failure.code}`
    } else {
      failure = `${context.source} rule evaluation failed with ${context.failure.code}`
    }
    console.error(`[Northline] ${failure} (${context.notificationId}):`, error)
  },
})

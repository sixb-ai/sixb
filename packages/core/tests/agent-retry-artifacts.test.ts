import { expect, test } from "bun:test"
import type { FileRef, SandboxFactory } from "../src"
import { SixbHost } from "../src"
import type { ArtifactVersionInput } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const unusedSandboxes: SandboxFactory = {
  create: async () => {
    throw new Error("Must not create a sandbox")
  },
  resume: async () => {
    throw new Error("Must not resume a sandbox")
  },
}

// Regression proof: drop the `deleteVersionsByOrigin` call from `retryAgentRun`; the failed turn's
// version survives the retry and this test fails.
test("retrying a failed turn removes the artifact versions it published", async () => {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "artifacts-retry",
    ontology: [],
    ...deps,
    sandboxes: unusedSandboxes,
    models: { language: [testLanguageModel()] },
  })
  const sixb = createTestSixb(host)
  const { storage } = deps

  const requested = await sixb.agent.runs.request({ text: "Write the Q3 report" })
  const failedRun = requested.run
  const threadId = failedRun.threadId
  await storage.agents.runs.start({
    projectId: host.id,
    id: failedRun.id,
    execution: { token: "owner", queueLeaseExpiresAt: new Date("2099-01-01") },
  })

  const owner = { type: "user", id: "usr_owner" } as const
  const earlier = { threadId, runId: "run_earlier" }
  const failed = { threadId, runId: failedRun.id }
  await storage.artifacts.create({
    projectId: host.id,
    id: "art_report",
    kind: "document",
    owner,
    version: version({ author: owner, origin: earlier }),
  })
  await storage.artifacts.publish({
    projectId: host.id,
    artifactId: "art_report",
    kind: "document",
    version: version({ author: owner, origin: failed, title: "Draft from the failed turn" }),
  })
  await storage.artifacts.create({
    projectId: host.id,
    id: "art_new",
    kind: "document",
    owner,
    version: version({ author: owner, origin: failed }),
  })

  await storage.agents.runs.finish({
    projectId: host.id,
    id: failedRun.id,
    executionToken: "owner",
    status: "failed",
  })
  await sixb.agent.runs.retry(failedRun.id)

  expect(await storage.artifacts.get({ projectId: host.id, id: "art_report" })).toMatchObject({
    title: "Q3 report",
    latestVersion: 1,
  })
  expect(
    await storage.artifacts.getVersion({ projectId: host.id, artifactId: "art_report", version: 2 })
  ).toBeNull()
  expect(await storage.artifacts.get({ projectId: host.id, id: "art_new" })).toBeNull()
})

function version(overrides: Partial<ArtifactVersionInput>): ArtifactVersionInput {
  return {
    title: "Q3 report",
    entry: "document.md",
    files: [{ path: "document.md", file: fileRef() }],
    outline: { kind: "document", headings: [] },
    references: [],
    author: { type: "user", id: "usr_owner" },
    createdAt: new Date("2026-10-17T10:00:00.000Z"),
    ...overrides,
  }
}

function fileRef(): FileRef {
  const hex = "d".repeat(64)
  return {
    blobId: `blob_${hex}`,
    digest: `sha256:${hex}`,
    sizeBytes: 9,
    mediaType: "text/markdown",
  }
}

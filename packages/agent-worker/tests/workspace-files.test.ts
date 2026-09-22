import { afterEach, expect, test } from "bun:test"
import type { Sandbox } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { prepareAgentSandboxApiContext } from "../src/sandbox-api-context"
import { workspaceRunFilesScript } from "../src/workspace-files"

const sandboxes: Sandbox[] = []
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.destroy()
})

async function repository(): Promise<Sandbox> {
  const sandbox = await new LocalSandboxFactory({
    isolation: "none",
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).create()
  sandboxes.push(sandbox)
  expect((await sandbox.runCommand("git", ["init", "-q"])).exitCode).toBe(0)
  return sandbox
}

async function clean(sandbox: Sandbox, hasSource = true) {
  return sandbox.runCommand("bash", ["-c", workspaceRunFilesScript(hasSource)])
}

test("git add . stages only project files across creation and resume", async () => {
  // Regression proof: remove the exclusion setup from workspaceRunFilesScript; git add stages
  // the real run context below and the tracked-file guard then refuses the save.
  const sandbox = await repository()
  await sandbox.writeFiles([
    { path: ".git/info/exclude", contents: "existing-local-rule" },
    { path: "project.txt", contents: "user work" },
  ])
  for (const runId of ["first", "resumed"]) {
    expect((await clean(sandbox)).exitCode).toBe(0)
    await prepareAgentSandboxApiContext({
      sandbox,
      projectId: "test",
      runId,
      apiBaseUrl: "https://gateway.invalid/synthetic-capability",
      skills: [],
      attachments: {
        entries: [],
        promptTextByPartKey: new Map(),
        modelFileDataByPartKey: new Map(),
        manifestJson: "{}",
        sandboxFiles: [
          {
            key: "attachment",
            path: ".sixb/agent/attachments/private.txt",
            bytes: new TextEncoder().encode("private"),
            fileRef: { blobId: "blob_test", digest: "sha256:test", sizeBytes: 7 },
          },
        ],
      },
    })
    expect((await sandbox.runCommand("git", ["add", "."])).exitCode).toBe(0)
    expect((await sandbox.runCommand("git", ["ls-files"])).stdout.trim()).toBe("project.txt")
    expect((await clean(sandbox)).exitCode).toBe(0)
    expect((await sandbox.runCommand("test", ["-e", ".sixb/agent"])).exitCode).toBe(1)
    expect((await sandbox.runCommand("cat", ["project.txt"])).stdout).toBe("user work")
  }
  expect((await sandbox.runCommand("cat", [".git/info/exclude"])).stdout).toBe(
    "existing-local-rule\n/.sixb/agent/\n"
  )
})

test("refuses already staged runtime files without removing them", async () => {
  const sandbox = await repository()
  await sandbox.writeFiles([{ path: ".sixb/agent/context/run.json", contents: "preserve" }])
  expect((await sandbox.runCommand("git", ["add", "."])).exitCode).toBe(0)
  expect((await clean(sandbox)).exitCode).not.toBe(0)
  expect((await sandbox.runCommand("cat", [".sixb/agent/context/run.json"])).stdout).toBe(
    "preserve"
  )
})

test.each([
  "!/.sixb/agent/\n",
  "!/.sixb/agent/\n/.sixb/agent/context/\n",
])("refuses repository rules that override the directory exclusion: %s", async (rules) => {
  const sandbox = await repository()
  await sandbox.writeFiles([{ path: ".gitignore", contents: rules }])
  expect((await clean(sandbox)).exitCode).not.toBe(0)
})

test.each([
  ".sixb",
  ".git/info",
  ".git/info/exclude",
])("refuses redirected %s without changing its target", async (path) => {
  const sandbox = await repository()
  await sandbox.writeFiles([{ path: "preserved/marker", contents: "untouched" }])
  // Only remove Git's empty default metadata in this disposable test repository.
  if (path === ".git/info") {
    expect((await sandbox.runCommand("rm", [".git/info/exclude"])).exitCode).toBe(0)
    expect((await sandbox.runCommand("rmdir", [".git/info"])).exitCode).toBe(0)
  } else if (path === ".git/info/exclude") {
    expect((await sandbox.runCommand("rm", [path])).exitCode).toBe(0)
  }
  const target = `${sandbox.workingDirectory}/preserved${path.endsWith("exclude") ? "/marker" : ""}`
  expect((await sandbox.runCommand("ln", ["-s", target, path])).exitCode).toBe(0)
  expect((await clean(sandbox)).exitCode).not.toBe(0)
  expect((await sandbox.runCommand("cat", ["preserved/marker"])).stdout).toBe("untouched")
})

test("source-free cleanup does not require Git metadata", async () => {
  const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create()
  sandboxes.push(sandbox)
  await sandbox.writeFiles([{ path: ".sixb/agent/old.txt", contents: "old run" }])
  expect((await clean(sandbox, false)).exitCode).toBe(0)
  expect((await sandbox.runCommand("test", ["-e", ".sixb/agent"])).exitCode).toBe(1)
})

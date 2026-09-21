import { expect, test } from "bun:test"
import type { Sandbox } from "../src/sandboxes"
import { initializeSandboxEnvironment, sandboxProjectDirectory } from "../src/sandboxes/environment"

function fixture() {
  const commands: { command: string; args: readonly string[]; cwd?: string }[] = []
  const files: string[] = []
  let exitCode = 0
  const sandbox: Sandbox = {
    id: "test",
    provider: "test",
    status: "running",
    workingDirectory: "/guest",
    async runCommand(command, args = [], options) {
      commands.push({ command, args, cwd: options?.cwd })
      return { exitCode, stdout: "", stderr: "", durationMs: 0 }
    },
    async writeFiles(batch) {
      files.push(...batch.map((file) => file.path))
    },
    async stop() {},
    async destroy() {},
  }
  return {
    sandbox,
    commands,
    files,
    fail: () => {
      exitCode = 1
    },
  }
}

test("initializes a Git project once and returns its command/file directory", async () => {
  const f = fixture()
  const project = await initializeSandboxEnvironment(f.sandbox, {
    source: { type: "git", url: "https://example.com/app.git", revision: "feature" },
    setup: ["install-dependencies"],
  })
  expect(f.commands).toEqual([
    {
      command: "git",
      args: ["clone", "--", "https://example.com/app.git", "repository"],
      cwd: undefined,
    },
    { command: "git", args: ["checkout", "feature", "--"], cwd: "/guest/repository" },
    { command: "bash", args: ["-lc", "install-dependencies"], cwd: "/guest/repository" },
  ])
  await project.writeFiles([{ path: "notes.txt", contents: "draft" }])
  expect(f.files).toEqual(["/guest/repository/notes.txt"])
  expect(sandboxProjectDirectory(f.sandbox, true).workingDirectory).toBe(project.workingDirectory)
  expect(f.commands).toHaveLength(3)
})

test("source-free environments need no Git operations or nested directory", async () => {
  const f = fixture()
  const project = await initializeSandboxEnvironment(f.sandbox, { setup: ["prepare"] })
  expect(project).toBe(f.sandbox)
  expect(f.commands).toEqual([{ command: "bash", args: ["-lc", "prepare"], cwd: undefined }])
})

test("does not initialize after cancellation or proceed after a failed command", async () => {
  // Regression proof: remove throwIfAborted or exitCode validation from the initializer.
  const f = fixture()
  await expect(
    initializeSandboxEnvironment(f.sandbox, { setup: ["prepare"] }, AbortSignal.abort())
  ).rejects.toThrow()
  expect(f.commands).toHaveLength(0)
  f.fail()
  await expect(
    initializeSandboxEnvironment(f.sandbox, { setup: ["first", "second"] })
  ).rejects.toThrow("initialization failed")
  expect(f.commands).toHaveLength(1)
})

test("rejects unsafe source input before sending commands", async () => {
  const f = fixture()
  await expect(
    initializeSandboxEnvironment(f.sandbox, {
      source: { type: "git", url: "https://secret@example.com/app.git" },
    })
  ).rejects.toThrow("credential-free HTTPS")
  expect(f.commands).toHaveLength(0)
})

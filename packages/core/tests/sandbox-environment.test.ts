import { expect, test } from "bun:test"
import type { Sandbox } from "../src/sandboxes"
import {
  initializeSandboxEnvironment,
  sandboxCreationEnvironment,
  sandboxProjectDirectory,
} from "../src/sandboxes/environment"

test("creation selects static defaults, explicit replacements and explicit empty environments", () => {
  const config = { setup: ["default"] }
  expect(sandboxCreationEnvironment(config, {})).toEqual(config)
  expect(sandboxCreationEnvironment(config, { environment: { setup: ["override"] } })).toEqual({
    setup: ["override"],
  })
  expect(sandboxCreationEnvironment(config, { environment: {} })).toEqual({})
})

test("creation never resolves dynamic recipes without execution authority", () => {
  const config = {
    resolve: () => {
      throw new Error("must not run")
    },
  }
  expect(() => sandboxCreationEnvironment(config, {})).toThrow("execution-resolved")
  expect(sandboxCreationEnvironment(config, { environment: {} })).toEqual({})
})

test("creation rejects invalid input, cancellation and denied source access before provisioning", () => {
  expect(() => sandboxCreationEnvironment({}, { environment: null as never })).toThrow(
    "environment"
  )
  expect(() => sandboxCreationEnvironment({}, { signal: AbortSignal.abort() })).toThrow()
  const source = { type: "git" as const, url: "https://example.com/app.git" }
  expect(() => sandboxCreationEnvironment({ source }, {})).toThrow("denies the source")
  expect(() =>
    sandboxCreationEnvironment({ source, network: { mode: "all" } }, { network: { mode: "none" } })
  ).toThrow("denies the source")
  expect(
    sandboxCreationEnvironment(
      { source },
      {
        network: { mode: "restricted", allow: [{ name: "source", origin: "https://example.com" }] },
      }
    )
  ).toEqual({ source })
})

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

test("source authentication cannot be silently skipped by direct creation", () => {
  const source = { type: "git" as const, url: "https://example.com/app.git" }
  const config = {
    source,
    network: { mode: "all" as const },
    auth: {
      authorize: async () => {
        throw new Error("must not obtain authority")
      },
    },
  }
  expect(() => sandboxCreationEnvironment(config, {})).toThrow("execution-prepared")
  expect(() => sandboxCreationEnvironment(config, { environment: { source } })).toThrow(
    "execution-prepared"
  )
  expect(sandboxCreationEnvironment(config, { environment: {} })).toEqual({})
  expect(() =>
    sandboxCreationEnvironment(
      { source: { ...source, access: "write" }, network: { mode: "all" } },
      {}
    )
  ).toThrow("execution-prepared")
  expect(
    sandboxCreationEnvironment(config, {
      requestCredentials: [
        {
          origin: "https://example.com",
          path: "/app.git/info/refs",
          method: "GET",
          headers: { Authorization: "test" },
        },
      ],
    })
  ).toEqual({ source })
})

test("initializes a Git project once in its own directory, and a source-free one in place", async () => {
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

  const sourceFree = fixture()
  const inPlace = await initializeSandboxEnvironment(sourceFree.sandbox, { setup: ["prepare"] })
  expect(inPlace).toBe(sourceFree.sandbox)
  expect(sourceFree.commands).toEqual([
    { command: "bash", args: ["-lc", "prepare"], cwd: undefined },
  ])
})

test("sends no command for unsafe source input or after cancellation, and none past a failure", async () => {
  // Regression proof: remove throwIfAborted or exitCode validation from the initializer.
  const f = fixture()
  await expect(
    initializeSandboxEnvironment(f.sandbox, {
      source: { type: "git", url: "https://secret@example.com/app.git" },
    })
  ).rejects.toThrow("credential-free HTTPS")
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

test("a checkout's sandbox still serves: start runs in the checkout, url and keepAlive pass through", async () => {
  const started: { command: string; cwd?: string }[] = []
  const kept: number[] = []
  const session: Sandbox = {
    ...fixture().sandbox,
    start: async (command, _args, options) => {
      started.push({ command, cwd: options?.cwd })
      return { exited: Promise.resolve(0), kill: async () => {} }
    },
    url: (port) => `http://127.0.0.1:${port}`,
    keepAlive: async (ms) => {
      kept.push(ms)
    },
  }
  // Drop the passthrough in sandboxProjectDirectory and a branch's runtime has nowhere to start.
  const project = sandboxProjectDirectory(session, true)
  await project.start?.("sixb", [], { cwd: "apps/ops" })
  await project.start?.("sixb")
  await project.keepAlive?.(60_000)

  expect(started).toEqual([
    { command: "sixb", cwd: "/guest/repository/apps/ops" },
    { command: "sixb", cwd: "/guest/repository" },
  ])
  expect(project.url?.(4310)).toBe("http://127.0.0.1:4310")
  expect(kept).toEqual([60_000])
})

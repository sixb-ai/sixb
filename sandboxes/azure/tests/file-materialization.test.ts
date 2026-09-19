import { expect, test } from "bun:test"
import { SandboxNotRunningError } from "@sixb/core/sandboxes"
import { type AzureSandboxClient, AzureSandboxRequestError } from "../src/azure-client"
import { AzureSandbox } from "../src/azure-sandbox"
import { prepareFiles } from "../src/file-materialization"

const root = "/run/sixb-00000000-0000-0000-0000-000000000000"
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const events: string[] = []
  const uploads: { path: string; contents: string | Uint8Array; mode?: number }[] = []
  let deleted = false
  let stopped = false
  const client: AzureSandboxClient = {
    create: async () => {
      throw new Error("unused")
    },
    get: async () => {
      if (deleted) throw new AzureSandboxRequestError("get", "http", 404)
      return { id: "sandbox", state: stopped ? "Stopped" : "Running" }
    },
    stop: async () => {
      events.push("stop")
      stopped = true
    },
    delete: async () => {
      events.push("delete")
      deleted = true
    },
    setEgressPolicy: async () => {},
    writeFile: async (_id, path, contents, mode) => {
      events.push("upload")
      uploads.push({ path, contents, mode })
    },
    execute: async (_id, command) => {
      expect(command).toContain(" files ")
      events.push("publish")
      return { exitCode: 0, stdout: '{"state":"files-written"}', stderr: "" }
    },
  }
  const sandbox = new AzureSandbox(
    "sandbox",
    client,
    { workingDirectory: "/workspace" },
    { teardownTimeoutMs: 100, pollIntervalMs: 1 },
    root
  )
  return { sandbox, client, events, uploads }
}

test("prepares all files before I/O and snapshots only the selected byte view", () => {
  const bytes = new Uint8Array([99, 0, 255, 99])
  const files = prepareFiles("/workspace", [
    { path: "/workspace/nested/../binary", contents: bytes.subarray(1, 3), mode: 0 },
    { path: "雪.txt", contents: "héllo" },
  ])
  bytes.fill(42)
  expect(files[0]).toEqual({ path: "binary", contents: new Uint8Array([0, 255]), mode: 0 })
  expect(new TextDecoder().decode(files[1]!.contents)).toBe("héllo")
})

test("invalid paths, modes and contents reject the entire batch without uploads", async () => {
  const { sandbox, uploads } = fixture()
  for (const path of [
    "",
    "../out",
    "/workspace-other/out",
    "/tmp/out",
    ".",
    "bad\0name",
    "directory/",
  ]) {
    await expect(
      sandbox.writeFiles([
        { path: "valid", contents: "first" },
        { path, contents: "bad" },
      ])
    ).rejects.toThrow()
  }
  for (const mode of [-1, 0o10000, 1.5, Number.NaN]) {
    await expect(sandbox.writeFiles([{ path: "file", contents: "x", mode }])).rejects.toThrow(
      "mode"
    )
  }
  // @ts-expect-error Exercise the JavaScript caller boundary as well as typed callers.
  await expect(sandbox.writeFiles([{ path: "file", contents: 123 }])).rejects.toThrow("contents")
  expect(uploads).toEqual([])
  expect(sandbox.status).toBe("running")
})

test("empty batch is a no-op only for a running handle", async () => {
  const { sandbox, events } = fixture()
  await sandbox.writeFiles([])
  expect(events).toEqual([])
  await sandbox.stop()
  await expect(sandbox.writeFiles([])).rejects.toBeInstanceOf(SandboxNotRunningError)
})

test("uploads bytes only to protected generated paths and puts final modes in the manifest", async () => {
  const { sandbox, uploads, events } = fixture()
  await sandbox.writeFiles([
    { path: "nested/雪", contents: new Uint8Array([0, 255]), mode: 0o755 },
    { path: "empty", contents: "", mode: 0 },
  ])
  expect(uploads).toHaveLength(3)
  for (const upload of uploads) {
    expect(upload.path).toStartWith(`${root}/files-`)
    expect(upload.mode).toBe(0o600)
  }
  expect(uploads[0]!.contents).toEqual(new Uint8Array([0, 255]))
  expect(uploads[1]!.contents).toEqual(new Uint8Array())
  expect(JSON.parse(String(uploads[2]!.contents))).toEqual([
    { path: "nested/雪", mode: 493 },
    { path: "empty", mode: 0 },
  ])
  expect(events).toEqual(["upload", "upload", "upload", "publish"])
})

test("concurrent batches publish in order", async () => {
  const { sandbox, client, events } = fixture()
  const entered = deferred()
  const release = deferred()
  const publish = client.execute
  client.execute = async (...args) => {
    entered.resolve()
    await release.promise
    return publish(...args)
  }
  const first = sandbox.writeFiles([{ path: "file", contents: "first" }])
  const second = sandbox.writeFiles([{ path: "file", contents: "second" }])
  await entered.promise
  expect(events).toEqual(["upload", "upload"])
  release.resolve()
  await Promise.all([first, second])
  expect(events).toEqual(["upload", "upload", "publish", "upload", "upload", "publish"])
})

test("confirmed policy rejection leaves session and subsequent batches usable", async () => {
  const { sandbox, client, events } = fixture()
  const publish = client.execute
  client.execute = async () => ({
    exitCode: 0,
    stdout: '{"state":"files-rejected","reason":"unsafe-path"}',
    stderr: "",
  })
  await expect(sandbox.writeFiles([{ path: "link", contents: "x" }])).rejects.toThrow("symlink")
  expect(sandbox.status).toBe("running")
  expect(events).not.toContain("delete")
  client.execute = publish
  await sandbox.writeFiles([{ path: "safe", contents: "x" }])
})

for (const phase of ["upload", "publish", "response"]) {
  test(`uncertain ${phase} closes and reclaims without replay`, async () => {
    const { sandbox, client, events } = fixture()
    if (phase === "upload")
      client.writeFile = async () => {
        events.push("failed-upload")
        throw new Error("secret transport body")
      }
    else
      client.execute = async () => {
        events.push("failed-publish")
        if (phase === "publish") throw new Error("secret")
        return { exitCode: 0, stdout: "malformed", stderr: "" }
      }
    await expect(sandbox.writeFiles([{ path: "file", contents: "x" }])).rejects.toThrow(
      "was reclaimed"
    )
    expect(events.filter((event) => event.startsWith("failed-"))).toHaveLength(1)
    expect(events.filter((event) => event === "delete")).toHaveLength(1)
    expect(sandbox.status).toBe("failed")
    await expect(sandbox.writeFiles([])).rejects.toBeInstanceOf(SandboxNotRunningError)
  })
}

test("stop before queued writes prevents any file request", async () => {
  const { sandbox, uploads } = fixture()
  const write = sandbox
    .writeFiles([{ path: "file", contents: "x" }])
    .catch((error: unknown) => error)
  await sandbox.stop()
  expect(await write).toBeInstanceOf(SandboxNotRunningError)
  expect(uploads).toEqual([])
})

for (const teardown of ["stop", "destroy"] as const) {
  test(`${teardown} during upload prevents publication and waits for reclamation`, async () => {
    const { sandbox, client, events } = fixture()
    const entered = deferred()
    const release = deferred()
    client.writeFile = async () => {
      entered.resolve()
      await release.promise
    }
    const write = sandbox
      .writeFiles([{ path: "file", contents: "x" }])
      .catch((error: unknown) => error)
    await entered.promise
    const closing = sandbox[teardown]()
    release.resolve()
    expect(String(await write)).toContain("was reclaimed")
    await closing
    expect(events).not.toContain("publish")
    expect(events).toContain("delete")
    expect(sandbox.status).toBe("stopped")
  })

  test(`${teardown} waits for an issued publication to finish before cloud teardown`, async () => {
    const { sandbox, client, events } = fixture()
    const entered = deferred()
    const release = deferred()
    client.execute = async (_id, _command, _cwd, options) => {
      expect(options?.signal).toBeUndefined()
      entered.resolve()
      await release.promise
      events.push("published")
      return { exitCode: 0, stdout: '{"state":"files-written"}', stderr: "" }
    }
    const write = sandbox.writeFiles([{ path: "file", contents: "x" }])
    await entered.promise
    const closing = sandbox[teardown]()
    // Let an incorrectly unguarded teardown reach the fake cloud before releasing publication.
    await Bun.sleep(0)
    expect(events).not.toContain(teardown === "stop" ? "stop" : "delete")
    release.resolve()
    await Promise.all([write, closing])
    // Negative control: remove the inFlight wait in stopRemote; cloud stop precedes publication.
    expect(events.indexOf("published")).toBeLessThan(
      events.indexOf(teardown === "stop" ? "stop" : "delete")
    )
  })
}

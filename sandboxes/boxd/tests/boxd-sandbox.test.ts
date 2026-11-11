import { afterEach, describe, expect, jest, test } from "bun:test"
import { ConflictError } from "@boxd-sh/sdk"
import {
  GUEST_CREDENTIAL_PATHS,
  SandboxError,
  SandboxNotRunningError,
  type SandboxRequestCredential,
  SandboxStateUnavailableError,
} from "@sixb/core/sandboxes"
import { BoxdSandboxFactory } from "../src"
import { machineSpec } from "../src/boxd-client"
import { persistentMachineName, SANDBOX_NAME_LABEL } from "../src/boxd-sandbox-factory"
import { GUEST_PATHS } from "../src/guest"
import { FakeBoxd } from "./boxd-sdk-fixture"

const API = "https://api.example.com"
const SECRET = "Bearer secret-run-token"
const credential: SandboxRequestCredential = {
  origin: API,
  path: { prefix: "/api/" },
  method: ["GET", "POST"],
  headers: { Authorization: SECRET },
}
const network = { mode: "restricted" as const, allow: [{ name: "api", origin: API }] }

function factory(
  boxd: FakeBoxd,
  options: ConstructorParameters<typeof BoxdSandboxFactory>[0] = {}
) {
  return new BoxdSandboxFactory(options, () => boxd)
}

afterEach(() => {
  jest.useRealTimers()
})

describe("machines", () => {
  // Guard proof: drop `.isolated()` from machineSpec in src/boxd-client.ts; this test fails.
  test("are created isolated, with the session's egress in their spec from the first boot", () => {
    const spec = machineSpec({
      name: "sixb-x",
      labels: { team: "ops" },
      egress: ["api.example.com"],
      size: "2x8",
    }).resolve()
    expect(spec.isolated).toBe(true)
    expect(spec.egress).toEqual(["api.example.com"])
    expect(spec.labels).toEqual({ team: "ops" })
    expect(spec.size).toBe("2x8")
    // `all` leaves egress out: unrestricted.
    expect(machineSpec({ name: "sixb-y", labels: {} }).resolve().egress).toBeUndefined()
  })

  test("waits until ready, then prepares the guest before anything else runs", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd, {
      org: "acme",
      size: "4x16",
      labels: { team: "ops" },
    }).create({ network })

    expect(boxd.creates[0]).toMatchObject({
      org: "acme",
      size: "4x16",
      egress: ["api.example.com"],
      labels: { team: "ops" },
    })
    expect(boxd.creates[0]?.name).toMatch(/^sixb-[0-9a-f]{20}$/)
    expect(boxd.calls.slice(1, 3)).toEqual([`ready ${sandbox.id}`, `exec ${sandbox.id}`])
    expect(boxd.commands[0]).toContain("'/workspace'")
    expect(boxd.commands[0]).toContain(GUEST_PATHS.home)
    expect(sandbox.workingDirectory).toBe("/workspace")
    expect(sandbox.provider).toBe("boxd")
  })

  test("map none and an empty allow list to no egress, and all to unrestricted", async () => {
    const boxd = new FakeBoxd()
    const sandboxes = factory(boxd)
    await sandboxes.create()
    await sandboxes.create({ network: { mode: "restricted", allow: [] } })
    await sandboxes.create({ network: { mode: "all" } })
    expect(boxd.creates.map((request) => request.egress)).toEqual([["none"], ["none"], undefined])
  })

  test("are deleted when an ephemeral create fails after provisioning", async () => {
    const boxd = new FakeBoxd()
    boxd.script = (line) => (line.includes("command -v setpriv") ? { exitCode: 20 } : undefined)
    const error = await factory(boxd)
      .create()
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).toContain("passwordless sudo")
    expect(boxd.calls).toContain("delete machine-1")
    expect(boxd.machines.size).toBe(0)
  })

  test("reject a system directory as the working directory before creating anything", async () => {
    const boxd = new FakeBoxd()
    for (const workingDirectory of ["/", "/tmp", "/home/boxd", "/etc/app", "/usr"]) {
      const error = await factory(boxd)
        .create({ workingDirectory })
        .catch((caught) => caught)
      expect(error).toBeInstanceOf(SandboxError)
    }
    expect(boxd.creates).toHaveLength(0)
    await factory(boxd).create({ workingDirectory: "/tmp/run" })
    await factory(boxd).create({ workingDirectory: "/srv/app" })
    expect(boxd.creates).toHaveLength(2)
  })
})

describe("commands", () => {
  test("run as the unprivileged user with exactly the sandbox and call env", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd, { env: { A: "factory", B: "factory" } }).create({
      env: { B: "create" },
    })
    boxd.script = () => ({ stdout: "out", stderr: "err", exitCode: 3 })
    const result = await sandbox.runCommand("echo", ["it's"], { env: { C: "call" }, cwd: "src" })

    expect(result).toMatchObject({ exitCode: 3, stdout: "out", stderr: "err" })
    const line = boxd.commands.at(-1) ?? ""
    expect(line.startsWith("'sudo' '-n' '/usr/bin/env' '-i'")).toBe(true)
    expect(line).toContain("'--reuid=65534'")
    expect(line).toContain("'--no-new-privs'")
    expect(line).toContain("'A=factory' 'B=create' 'C=call'")
    // The image's Node may live where the command user can't go: bootstrap links it here.
    expect(line).toContain(`'PATH=${GUEST_PATHS.node}/bin:/usr/local/sbin:`)
    expect(boxd.commands[0]).toContain(`'${GUEST_PATHS.node}'`)
    expect(line).toContain("'/workspace/src' 'echo' 'it'\\''s'")
  })

  test("time out: the command is killed, keeps its output and is marked timedOut", async () => {
    jest.useFakeTimers()
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd, { timeout: 60_000 }).create()
    boxd.script = () => "hang"
    const running = sandbox.runCommand("sleep", ["30"], { timeout: 1_000 })
    jest.advanceTimersByTime(1_000)
    const result = await running

    expect(result).toMatchObject({
      exitCode: 137,
      timedOut: true,
      stdout: "partial out\n",
      stderr: "partial err\n",
    })
    expect(boxd.closed).toHaveLength(1)
  })

  test("abort kills the command without marking it timed out", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    boxd.script = () => "hang"
    const controller = new AbortController()
    const running = sandbox.runCommand("sleep", ["30"], { signal: controller.signal })
    controller.abort()
    const result = await running
    expect(result.exitCode).toBe(137)
    expect(result.timedOut).toBeUndefined()
  })

  test("report a failed call as a SandboxError, never as a command's exit", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    boxd.script = () => new Error("connection reset")
    const error = await sandbox.runCommand("true").catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).toContain("connection reset")
  })

  test("reject env names the guest can't carry", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    const error = await sandbox
      .runCommand("true", [], { env: { "A=B": "x" } })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
  })
})

describe("files", () => {
  test("upload to staging and are copied into place by the command user", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    await sandbox.writeFiles([
      { path: "notes/a.txt", contents: "hello" },
      { path: "/workspace/run.sh", contents: "#!/bin/sh\n", mode: 0o755 },
    ])

    expect(boxd.uploads.map((upload) => upload.path.startsWith(`${GUEST_PATHS.files}/`))).toEqual([
      true,
      true,
    ])
    const line = boxd.commands.at(-1) ?? ""
    expect(line).toContain("'--reuid=65534'")
    expect(line).toContain("'/workspace/notes/a.txt' ''")
    expect(line).toContain("'/workspace/run.sh' '755'")
    // The bytes go through the upload alone.
    expect(line).not.toContain("hello")
    expect(line).toContain("rm -f --")
  })

  test("an empty batch does nothing", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    const before = boxd.calls.length
    await sandbox.writeFiles([])
    expect(boxd.calls.length).toBe(before)
  })
})

describe("request credentials", () => {
  // Guard proof: pass the install step its full env (drop `commands.fileEnv` in
  // installCredentials); the secret reaches a command line and this test fails.
  test("are installed through uploads before setup runs, and never in a command line", async () => {
    const boxd = new FakeBoxd()
    boxd.script = (line) =>
      line.includes("forwarder.pid") && line.includes("SIXB_GUEST_STATE")
        ? { exitCode: 10 }
        : undefined
    const sandbox = await factory(boxd, { setup: ["make setup"] }).create({
      network,
      requestCredentials: [credential],
    })

    const credentials = boxd.uploads.find((upload) => upload.contents.includes(SECRET))
    expect(credentials?.path.startsWith(`${GUEST_PATHS.staging}/`)).toBe(true)
    for (const line of boxd.commands) expect(line).not.toContain("secret-run-token")
    expect(boxd.commands.some((line) => line.includes("'setsid' '-f'"))).toBe(true)
    const place = boxd.commands.findIndex((line) => line.includes(GUEST_CREDENTIAL_PATHS.state))
    const setup = boxd.commands.findIndex((line) => line.includes("make setup"))
    expect(place).toBeGreaterThan(0)
    expect(setup).toBeGreaterThan(place)
    expect(sandbox.credentialedUrl?.(API)).toMatch(
      /^unix:\/var\/lib\/sixb-forward\/[0-9a-f]+\.sock$/
    )
  })

  test("are rejected for an origin the network does not allow, before provisioning", async () => {
    const boxd = new FakeBoxd()
    const sandboxes = factory(boxd)
    for (const options of [
      { requestCredentials: [credential] },
      {
        network: { mode: "restricted" as const, allow: [{ name: "x", origin: "https://x.dev" }] },
        requestCredentials: [credential],
      },
    ]) {
      const error = await sandboxes.create(options).catch((caught) => caught)
      expect(error).toBeInstanceOf(SandboxError)
      expect(error.message).not.toContain("secret-run-token")
    }
    expect(boxd.creates).toHaveLength(0)
  })

  test("a failed install names the machine, not what it was given", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create({ network })
    boxd.script = (line) =>
      line.includes("install -m") ? { exitCode: 1, stderr: SECRET } : undefined
    const error = await sandbox.setRequestCredentials?.([credential]).catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).not.toContain("secret")
  })

  test("a factory default is refused", () => {
    expect(
      () =>
        new BoxdSandboxFactory({ requestCredentials: [credential] } as never, () => new FakeBoxd())
    ).toThrow("never as a factory default")
  })
})

describe("lifecycle", () => {
  // Guard proof: drop confirmHibernated() from stopRemote(); the resume right after stop finds
  // the machine still going down and the persistence test below fails.
  test("stop hibernates once for every caller, and later operations reject", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    await Promise.all([sandbox.stop(), sandbox.stop()])
    expect(boxd.calls.filter((call) => call.startsWith("hibernate"))).toHaveLength(1)
    expect(sandbox.status).toBe("stopped")
    const error = await sandbox.runCommand("true").catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxNotRunningError)
    const write = await sandbox.writeFiles([{ path: "a", contents: "b" }]).catch((caught) => caught)
    expect(write).toBeInstanceOf(SandboxNotRunningError)
  })

  test("destroy deletes the machine by id, once, and treats an absent machine as gone", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    await sandbox.destroy()
    await sandbox.destroy()
    expect(boxd.calls.filter((call) => call.startsWith("delete"))).toEqual([`delete ${sandbox.id}`])

    const other = await factory(boxd).create()
    boxd.machines.delete(other.id)
    await other.destroy()
  })

  test("destroy still deletes when hibernating fails", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create()
    boxd.failHibernate = new Error("busy")
    await sandbox.destroy()
    expect(boxd.machines.has(sandbox.id)).toBe(false)
  })
})

describe("persistence", () => {
  const name = `sixb-sb-${"a".repeat(64)}`

  test("names the machine after a digest and keeps the sandbox name in a label", async () => {
    const boxd = new FakeBoxd()
    await factory(boxd).create({ persistence: { name } })
    const request = boxd.creates[0]
    expect(request?.name).toBe(persistentMachineName("sixb-", name))
    expect(request?.name.length).toBeLessThanOrEqual(63)
    expect(request?.labels[SANDBOX_NAME_LABEL]).toBe(name)
  })

  test("an existing name fails and nothing is overwritten", async () => {
    const boxd = new FakeBoxd()
    boxd.failCreate = new ConflictError("name taken", 6)
    const error = await factory(boxd)
      .create({ persistence: { name } })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).toContain("already exists")
  })

  // Guard proof: delete instead of hibernate in create()'s persistent catch; this test fails.
  test("a failed persistent create keeps the machine asleep instead of deleting it", async () => {
    const boxd = new FakeBoxd()
    boxd.script = (line) => (line.includes("command -v setpriv") ? { exitCode: 1 } : undefined)
    await factory(boxd)
      .create({ persistence: { name } })
      .catch(() => {})
    expect(boxd.calls).toContain("hibernate machine-1")
    expect(boxd.calls.some((call) => call.startsWith("delete"))).toBe(false)
  })

  test("stop removes credentials and egress before hibernating", async () => {
    const boxd = new FakeBoxd()
    const sandbox = await factory(boxd).create({
      persistence: { name },
      network,
      requestCredentials: [credential],
    })
    await sandbox.stop()
    const id = sandbox.id
    const egress = boxd.calls.lastIndexOf(`egress ${id} ["none"]`)
    expect(egress).toBeGreaterThan(0)
    expect(boxd.calls.indexOf(`hibernate ${id}`)).toBeGreaterThan(egress)
    const emptied = boxd.uploads.at(-2)
    expect(emptied?.contents).toBe("[]")
  })

  test("resume wakes the machine and applies this session, without replaying setup", async () => {
    const boxd = new FakeBoxd()
    const sandboxes = factory(boxd, { setup: ["make setup"] })
    const created = await sandboxes.create({ persistence: { name } })
    await created.stop()
    const before = boxd.commands.length

    const resumed = await sandboxes.resume(name, { network, requestCredentials: [credential] })
    expect(resumed.id).toBe(created.id)
    expect(boxd.calls).toContain(`wake ${created.id}`)
    expect(boxd.egress.get(created.id)).toEqual(["api.example.com"])
    expect(boxd.commands.slice(before).some((line) => line.includes("make setup"))).toBe(false)
    expect(boxd.uploads.some((upload) => upload.contents.includes(SECRET))).toBe(true)
  })

  test("resume starts a stopped machine", async () => {
    const boxd = new FakeBoxd()
    const id = "machine-9"
    boxd.seed({
      id,
      name: persistentMachineName("sixb-", name),
      status: "stopped",
      labels: { [SANDBOX_NAME_LABEL]: name },
    })
    await factory(boxd).resume(name)
    expect(boxd.calls).toContain(`start ${id}`)
  })

  test("resume of a missing name is missing state; a running one is refused", async () => {
    const boxd = new FakeBoxd()
    const sandboxes = factory(boxd)
    const missing = await sandboxes.resume(name).catch((caught) => caught)
    expect(missing).toBeInstanceOf(SandboxStateUnavailableError)

    await sandboxes.create({ persistence: { name } })
    const running = await sandboxes.resume(name).catch((caught) => caught)
    expect(running).toBeInstanceOf(SandboxError)
    expect(running).not.toBeInstanceOf(SandboxStateUnavailableError)
    expect(running.message).toContain("must be stopped")
  })

  test("resume never classifies a transport failure as missing state", async () => {
    const boxd = new FakeBoxd()
    boxd.failGet = new Error("unavailable")
    const error = await factory(boxd)
      .resume(name)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error).not.toBeInstanceOf(SandboxStateUnavailableError)
  })

  test("resume refuses a machine whose label names another sandbox", async () => {
    const boxd = new FakeBoxd()
    boxd.seed({
      id: "machine-9",
      name: persistentMachineName("sixb-", name),
      status: "hibernated",
      labels: { [SANDBOX_NAME_LABEL]: "another" },
    })
    const error = await factory(boxd)
      .resume(name)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxStateUnavailableError)
    expect(boxd.calls).not.toContain("wake machine-9")
  })

  test("resume takes session options only", async () => {
    const error = await factory(new FakeBoxd())
      .resume(name, { persistence: { name } } as never)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
  })
})

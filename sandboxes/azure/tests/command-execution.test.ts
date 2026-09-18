import { expect, test } from "bun:test"
import { type CommandResult, SandboxNotRunningError } from "@sixb/core/sandboxes"
import { type AzureSandboxClient, AzureSandboxRequestError } from "../src/azure-client"
import { AzureSandbox } from "../src/azure-sandbox"
import { resolveCommand, shellQuote } from "../src/command-execution"

const root = "/run/sixb-00000000-0000-0000-0000-000000000000"
const finished = { exitCode: 7, stdout: "out\n", stderr: "err\n", durationMs: 12.5 }
const done = (result: CommandResult = finished) => ({ state: "done", result })
function fixture(
  handler: (action: string, id: string, payload: string | undefined) => unknown | Promise<unknown>
) {
  const calls: string[] = []
  let deleted = false
  let stopped = false
  const client: AzureSandboxClient = {
    create: async () => {
      throw new Error("unused")
    },
    get: async () => {
      calls.push("get")
      if (deleted) throw new AzureSandboxRequestError("get", "http", 404)
      return { id: "sandbox", state: stopped ? "Stopped" : "Running" }
    },
    execute: async (_id, command, cwd) => {
      expect(cwd).toBe("/")
      const match = command.match(
        / (start|status|cancel) '[^']+' ([0-9a-f-]+)(?: ([A-Za-z0-9+/=]+))?$/
      )
      if (!match) throw new Error("invalid control command")
      const action = match[1]!
      calls.push(action)
      const body = await handler(action, match[2]!, match[3])
      return { exitCode: 0, stdout: JSON.stringify(body), stderr: "" }
    },
    delete: async () => {
      calls.push("delete")
      deleted = true
    },
    stop: async () => {
      calls.push("stop")
      stopped = true
    },
    writeFile: async () => {},
    setEgressPolicy: async () => {},
  }
  const sandbox = new AzureSandbox(
    "sandbox",
    client,
    {
      workingDirectory: "/workspace",
      env: { BASE: "base", OVERRIDE: "old" },
      timeout: 500,
    },
    { teardownTimeoutMs: 100, pollIntervalMs: 1 },
    root
  )
  return { sandbox, calls, client }
}

test("command resolution snapshots literal argv, cwd, environment and timeout precedence", () => {
  const args = ["", "a b", "'\"$`", "line\nnext", "雪", "$(touch /tmp/no)"]
  const env = { OVERRIDE: "new", SPECIAL: "'\n$HOME" }
  const resolved = resolveCommand(
    { workingDirectory: "/work", env: { BASE: "yes", OVERRIDE: "old" }, timeout: 100 },
    "a=b",
    args,
    { cwd: "sub", env, timeout: 200 }
  )
  args.push("mutated")
  env.OVERRIDE = "mutated"
  expect(resolved.args).toHaveLength(6)
  expect(resolved.command).toBe("a=b")
  expect(resolved.cwd).toBe("/work/sub")
  expect(resolved.timeoutMs).toBe(200)
  expect(resolved.env).toEqual({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    BASE: "yes",
    OVERRIDE: "new",
    SPECIAL: "'\n$HOME",
  })
  expect(shellQuote("a'b")).toBe("'a'\\''b'")
})

test("pre-aborted calls and invalid inputs never dispatch or reclaim", async () => {
  const { sandbox, calls } = fixture(() => {
    throw new Error("unexpected")
  })
  expect((await sandbox.runCommand("true", [], { signal: AbortSignal.abort() })).exitCode).toBe(137)
  await expect(sandbox.runCommand("bad\0")).rejects.toThrow("command")
  await expect(sandbox.runCommand("true", ["bad\0"])).rejects.toThrow("arguments")
  await expect(sandbox.runCommand("true", [], { env: { "bad=name": "v" } })).rejects.toThrow("env")
  await expect(sandbox.runCommand("true", [], { timeout: 0 })).rejects.toThrow("timeout")
  expect(calls).toEqual([])
  expect(sandbox.status).toBe("running")
})

test("preserves result, sends only explicit environment and never retries start", async () => {
  const { sandbox, calls } = fixture((action, _id, payload) => {
    if (action === "start") {
      const input = JSON.parse(Buffer.from(payload!, "base64").toString())
      expect(input).toMatchObject({
        command: "printf",
        args: ["$HOME", ""],
        cwd: "/workspace",
        timeoutMs: 500,
      })
      expect(input.env).toEqual({
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        BASE: "base",
        OVERRIDE: "new",
      })
      return { state: "accepted" }
    }
    return done()
  })
  expect(await sandbox.runCommand("printf", ["$HOME", ""], { env: { OVERRIDE: "new" } })).toEqual(
    finished
  )
  expect(calls).toEqual(["start", "status"])
})

test("guest timeout preserves partial output and leaves session reusable", async () => {
  let timeout = true
  const { sandbox } = fixture((action) =>
    action === "start"
      ? { state: "accepted" }
      : done(timeout ? { ...finished, exitCode: 137, timedOut: true } : finished)
  )
  expect(await sandbox.runCommand("sleep", ["20"])).toMatchObject({
    exitCode: 137,
    stdout: "out\n",
    timedOut: true,
  })
  timeout = false
  expect(await sandbox.runCommand("true")).toEqual(finished)
  expect(sandbox.status).toBe("running")
})

test("abort during start waits for cancellation confirmation and supports reuse", async () => {
  const abort = new AbortController()
  let cancelling = true
  const { sandbox, calls } = fixture((action) => {
    if (action === "start") {
      if (cancelling) abort.abort()
      return { state: "accepted" }
    }
    return done({ ...finished, exitCode: cancelling ? 137 : 7 })
  })
  const result = await sandbox.runCommand("sleep", ["20"], { signal: abort.signal })
  expect(result.exitCode).toBe(137)
  expect(result.timedOut).toBeUndefined()
  expect(calls).toEqual(["start", "cancel"])
  cancelling = false
  expect((await sandbox.runCommand("true")).exitCode).toBe(7)
})

for (const failure of ["lost-start", "bad-result", "failed-supervisor"]) {
  test(`${failure} reclaims the VM without replaying execution`, async () => {
    const { sandbox, calls } = fixture((action) => {
      if (failure === "lost-start") throw new Error("secret failure")
      if (action === "start") return { state: "accepted" }
      return failure === "bad-result"
        ? { state: "done", result: { exitCode: 0 } }
        : { state: "failed" }
    })
    await expect(sandbox.runCommand("true")).rejects.toThrow("was reclaimed")
    expect(calls.filter((call) => call === "start")).toHaveLength(1)
    expect(calls.filter((call) => call === "delete")).toHaveLength(1)
    expect(sandbox.status).toBe("failed")
    await expect(sandbox.runCommand("true")).rejects.toBeInstanceOf(SandboxNotRunningError)
    await sandbox.destroy()
    expect(calls.filter((call) => call === "delete")).toHaveLength(1)
  })
}

test("cancellation failure reports unconfirmed VM reclamation", async () => {
  const abort = new AbortController()
  const { sandbox, client } = fixture((action) => {
    if (action === "start") {
      abort.abort()
      return { state: "accepted" }
    }
    throw new Error("private transport")
  })
  client.delete = async () => {
    throw new AzureSandboxRequestError("delete", "http", 403)
  }
  await expect(sandbox.runCommand("sleep", [], { signal: abort.signal })).rejects.toThrow(
    "sandbox sandbox deletion could not be confirmed"
  )
  expect(sandbox.status).toBe("failed")
})

for (const operation of ["stop", "destroy"] as const) {
  test(`${operation} cancels in-flight work before cloud teardown`, async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { sandbox, calls } = fixture(async (action) => {
      if (action === "start") {
        await gate
        return { state: "accepted" }
      }
      return done({ ...finished, exitCode: 137 })
    })
    const run = sandbox.runCommand("sleep", ["20"])
    const teardown = sandbox[operation]()
    release?.()
    expect((await run).exitCode).toBe(137)
    await teardown
    // Negative control: remove closing.abort() in stop/destroy; cancel will be absent.
    expect(calls.indexOf("cancel")).toBeGreaterThan(-1)
    expect(calls.indexOf("cancel")).toBeLessThan(
      calls.indexOf(operation === "stop" ? "stop" : "delete")
    )
    expect(sandbox.status).toBe("stopped")
  })
}

test("concurrent commands have distinct control identities", async () => {
  const ids = new Set<string>()
  const { sandbox } = fixture((action, id) => {
    if (action === "start") {
      ids.add(id)
      return { state: "accepted" }
    }
    return done()
  })
  await Promise.all([sandbox.runCommand("one"), sandbox.runCommand("two")])
  expect(ids.size).toBe(2)
})

test("unconfirmed cancellation is bounded and reclaims rather than reporting success", async () => {
  const abort = new AbortController()
  const { sandbox, calls } = fixture((action) => {
    if (action === "start") {
      abort.abort()
      return { state: "accepted" }
    }
    return { state: "pending" }
  })
  await expect(sandbox.runCommand("sleep", [], { signal: abort.signal })).rejects.toThrow(
    "was reclaimed"
  )
  expect(calls).toContain("cancel")
  expect(calls).toContain("delete")
  expect(sandbox.status).toBe("failed")
})

test("completion winning an abort race preserves its real exit code", async () => {
  const abort = new AbortController()
  const { sandbox } = fixture((action) => {
    if (action === "start") return { state: "accepted" }
    abort.abort()
    return done()
  })
  expect(await sandbox.runCommand("true", [], { signal: abort.signal })).toEqual(finished)
  expect(sandbox.status).toBe("running")
})

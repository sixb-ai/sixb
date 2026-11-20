import { describe, expect, test } from "bun:test"
import type { DeployEvent } from "@sixb/core/deploy"
import { deployRelease } from "../src/operations"
import { event, type ReleasePlan } from "../src/plan"
import { RemoteScriptError, type RemoteShell, type RunOptions } from "../src/transport"
import { release } from "./fixtures/release"

/** A server that answers the deploy's scripts, and replays `log` when the deploy is followed. */
class FakeShell implements RemoteShell {
  readonly uploads = new Map<string, string>()
  readonly scripts: string[] = []

  constructor(private readonly log: readonly string[] | Error) {}

  async run(script: string, options: RunOptions = {}): Promise<void> {
    this.scripts.push(script)
    const say = (line: string) => options.onLine?.(line, "stdout")
    if (script.includes("mktemp -d")) {
      say("/home/deploy")
      say("/home/deploy/northline/deploy/incoming/r.abc")
    } else if (script.startsWith("umask 077 && cat > ")) {
      const path = script.slice("umask 077 && cat > ".length).replaceAll("'", "")
      this.uploads.set(path, options.stdin ? await new Response(options.stdin).text() : "")
    } else if (script.includes("tar -x")) {
      if (options.stdin) await new Response(options.stdin).text()
    } else if (script.startsWith("setsid nohup")) {
      say("4242")
    } else if (script.startsWith("tail ")) {
      if (this.log instanceof Error) throw this.log
      for (const line of this.log) say(line)
    }
  }

  async close(): Promise<void> {}
}

const source = {
  commit: "c2c2c2c2c2c2c2",
  ref: "main",
  projectPath: "examples/northline",
  archives: [{ path: ".", open: () => new Blob(["tar"]).stream() }],
}

async function deploy(shell: FakeShell) {
  const events: DeployEvent[] = []
  const error = await deployRelease(shell, release, source, {
    name: "northline",
    deployedBy: "ci",
    report: (reported) => events.push(reported),
  }).catch((failure: unknown) => failure)
  return { events, error }
}

describe("deploying from the laptop", () => {
  test("uploads the plan and the bootstrap, then follows the release's progress to its end", async () => {
    const shell = new FakeShell([
      event({ step: "Prepare release", status: "running" }),
      "building…",
      event({ step: "Prepare release", status: "done" }),
      event({ exit: 0 }),
    ])

    const { events, error } = await deploy(shell)

    expect(error).toBeUndefined()
    expect(events[0]).toMatchObject({ type: "steps" })
    expect(events.slice(1)).toEqual([
      { type: "step", index: 0, status: "running" },
      { type: "step", index: 0, status: "done" },
      { type: "step", index: 1, status: "running" },
      { type: "output", line: "building…" },
      { type: "step", index: 1, status: "done" },
    ])
    const [planPath, planText] = [...shell.uploads].find(([path]) => path.endsWith(".json")) ?? []
    const plan = JSON.parse(planText ?? "{}") as ReleasePlan
    expect(planPath).toStartWith("/home/deploy/northline/deploy/runs/")
    expect(plan).toMatchObject({ projectPath: "examples/northline" })
    expect(plan.record).toMatchObject({ commit: "c2c2c2c2c2c2c2", ref: "main", deployedBy: "ci" })
    expect([...shell.uploads.keys()].some((path) => path.endsWith(".sh"))).toBe(true)
    // Detached from this connection: a dropped laptop never leaves half a deploy.
    expect(shell.scripts.find((script) => script.startsWith("setsid nohup bash"))).toContain(
      "< /dev/null &"
    )
  })

  test("fails with the runner's own explanation", async () => {
    const shell = new FakeShell([
      "[SshTarget] The API did not answer http://127.0.0.1:3012/ready within 90 seconds.",
      "The previous release is still serving.",
      event({ exit: 1 }),
    ])

    const { error } = await deploy(shell)

    expect(String(error)).toContain("The API did not answer")
  })

  test("says the deploy carries on when the connection drops while following it", async () => {
    const { error } = await deploy(new FakeShell(new RemoteScriptError("Connection closed", 255)))

    expect(String(error)).toContain("carries on on the server")
    expect(String(error)).toContain("/home/deploy/northline/deploy/runs/")
  })
})

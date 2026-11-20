import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blocksDeploy, CHECK_MARKER, parseCheckOutput, renderCheckScript } from "../src/check"
import { LocalShell } from "../src/transport"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function syntaxErrors(script: string): Promise<string> {
  const child = Bun.spawn(["bash", "-n"], { stdin: new Blob([script]), stderr: "pipe" })
  await child.exited
  return new Response(child.stderr).text()
}

const context = { name: "northline", location: "sixb@203.0.113.10" }
const line = (id: string, status: string, detail: string) =>
  [CHECK_MARKER, id, status, detail].join("\t")

describe("server checks", () => {
  test("render as a script bash accepts", async () => {
    const script = renderCheckScript({
      name: "northline",
      projectPath: "examples/northline",
      ports: [
        { service: "api", port: 3002 },
        { service: "app", port: 3001 },
      ],
    })
    expect(await syntaxErrors(script)).toBe("")
    expect(script).toContain("project=\"$HOME\"/'northline/code/examples/northline'")
  })

  // Reproduce: drop the version check; on Ubuntu's Caddy 2.6 every deploy then passes the checks
  // and fails at "Update routes", where `caddy validate` rejects `stream_close_delay`.
  test("stop a deploy on a Caddy older than 2.7, and compare versions as numbers", async () => {
    const caddyCheck = async (version: string) => {
      const home = await mkdtemp(join(tmpdir(), "sixb-check-caddy-"))
      tempDirs.push(home)
      const tools = join(home, "tools")
      await mkdir(tools)
      await writeFile(join(tools, "caddy"), `#!/bin/sh\necho "v${version} h1:abc="\n`, {
        mode: 0o755,
      })

      const child = Bun.spawn(
        ["bash", "-c", renderCheckScript({ ...context, projectPath: ".", ports: [] })],
        {
          env: { HOME: home, USER: "sixb", PATH: `${tools}:/usr/bin:/bin` },
          stdout: "pipe",
          stderr: "ignore",
        }
      )
      const output = await new Response(child.stdout).text()
      await child.exited

      const [check] = parseCheckOutput(output.split("\n"), context).filter(
        (entry) => entry.id === "server.caddy"
      )
      return check
    }

    expect(await caddyCheck("2.10.2")).toMatchObject({ label: "Caddy version", status: "ok" })

    const old = await caddyCheck("2.6.2")
    expect(old).toMatchObject({ status: "manual", detail: "2.6.2 is older than 2.7" })
    expect(old && blocksDeploy(old)).toBe(true)
    expect(old?.remedy).toContain("caddyserver.com/docs/install")
  })

  test("read back with labels, and with what to do about each", () => {
    const checks = parseCheckOutput(
      [
        "Welcome to Ubuntu",
        line("server.os", "ok", "Ubuntu 24.04.4 LTS"),
        line("server.routes", "fixable", "/etc/caddy/sixb.d/sixb is missing or not writable"),
        line("project.env", "manual", "/home/sixb/northline/code/.env does not exist"),
        line("project.port.api", "manual", "3002 is in use by another program"),
        line("server.admin-api", "warning", "Caddy's admin API listens on localhost:2019"),
      ],
      context
    )

    expect(checks.map((check) => [check.label, check.status])).toEqual([
      ["Server", "ok"],
      ["Caddy routes", "fixable"],
      [".env", "manual"],
      ["api port", "manual"],
      ["Caddy admin API", "warning"],
    ])
    expect(checks[1]?.remedy).toBe("See https://docs.sixb.ai/deployment/host-requirements.")
    expect(checks[2]?.remedy).toContain(
      "ssh sixb@203.0.113.10 'install -m 600 /dev/null /home/sixb/northline/code/.env'"
    )
    expect(checks.filter(blocksDeploy).map((check) => check.id)).toEqual([
      "server.routes",
      "project.env",
      "project.port.api",
    ])
  })
})

describe("a project with a source", () => {
  async function checkWithHome(home: string, envFromSource: boolean): Promise<string[]> {
    const lines: string[] = []
    const script = renderCheckScript({
      name: "northline",
      projectPath: ".",
      ports: [],
      envFromSource,
    })
    // Other checks fail on a machine that isn't a server, which says nothing about these two.
    await new LocalShell({ HOME: home }).run(script, {
      onLine: (line, stream) => {
        if (stream === "stdout") lines.push(line)
      },
    })
    return lines
      .map((text) => text.split("\t"))
      .filter(([marker, id]) => marker === CHECK_MARKER && id?.includes("env"))
      .map(([, id, status]) => `${id} ${status}`)
  }

  // Reproduce: remove the `envFromSource` branch in renderCheckScript. A first deploy then stops on
  // a missing .env that the deploy itself is about to write.
  test("needs the token instead of .env", async () => {
    const home = await mkdtemp(join(tmpdir(), "sixb-check-"))
    tempDirs.push(home)

    expect(await checkWithHome(home, true)).toEqual(["project.env-token fixable"])
    expect(await checkWithHome(home, false)).toEqual(["project.env manual"])
  })

  test("reads a missing token back as a problem to fix", () => {
    const [check] = parseCheckOutput(
      [line("project.env-token", "fixable", "/home/sixb/northline/env-token has no token")],
      context
    )

    expect(check).toMatchObject({
      label: "Source token",
      status: "fixable",
      remedy: "See https://docs.sixb.ai/deployment/host-requirements.",
    })
    expect(check && blocksDeploy(check)).toBe(true)
  })
})

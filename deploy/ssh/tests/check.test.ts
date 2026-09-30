import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blocksDeploy, CHECK_MARKER, parseCheckOutput, renderCheckScript } from "../src/check"
import { pickPublicKey, renderAdminScript } from "../src/setup"

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
    expect(checks[1]?.remedy).toBe("Run `sixb deploy setup`.")
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

describe("setup", () => {
  test("renders an admin script bash accepts", async () => {
    const script = renderAdminScript({
      user: "sixb",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dev@laptop",
      admin: "ademattos",
    })
    expect(await syntaxErrors(script)).toBe("")
    expect(script).toContain("%sixb-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy")
    expect(script).toContain("import /etc/caddy/sixb.d/*.caddy")
  })

  test("authorizes the key given, else the first one SSH would offer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sixb-setup-"))
    tempDirs.push(dir)
    await writeFile(join(dir, "id_ed25519.pub"), "ssh-ed25519 AAAA offered\n")
    await writeFile(join(dir, "chosen.pub"), "ssh-ed25519 AAAA chosen\n")

    expect(
      await pickPublicKey({
        identityFiles: [join(dir, "id_rsa"), join(dir, "id_ed25519")],
      })
    ).toEqual({ text: "ssh-ed25519 AAAA offered", source: join(dir, "id_ed25519.pub") })
    expect(
      await pickPublicKey({ key: join(dir, "chosen"), identityFiles: [join(dir, "id_ed25519")] })
    ).toEqual({ text: "ssh-ed25519 AAAA chosen", source: join(dir, "chosen.pub") })
  })
})

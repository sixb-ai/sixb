import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isPrivateAddress, renderProbe } from "../src/check"
import { type JudgeInput, judge, parseFacts } from "../src/check/judge"
import { LocalShell } from "../src/transport"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const input: JudgeInput = {
  name: "shop",
  ports: [3001, 3002],
  settings: "env-token",
  chromium: false,
}

/** What a cell from the infra template reports. */
const healthy: Record<string, string> = {
  "os.id": "ubuntu",
  "os.like": "debian",
  "os.name": "Ubuntu 24.04.3 LTS",
  "os.systemd": "yes",
  "os.arch": "x86_64",
  "os.missing": "",
  "account.name": "deploy",
  "account.home": "/home/deploy",
  "account.uid": "1000",
  linger: "yes",
  "caddy.version": "2.10.2",
  "caddy.reload": "yes",
  "caddy.routes": "/etc/caddy/sixb.d/deploy",
  "caddy.routes-writable": "yes",
  "caddy.routes-imported": "yes",
  "caddy.caddyfile-imports": "yes",
  "file.env-token": "600 54",
  "file.shared-env": "600 2048",
  "file.legacy-env": "missing",
  "deployments.others": "",
  "port.3001": "own",
  "port.3002": "free",
  "disk.free-kb": "70000000",
}

function checks(overrides: Record<string, string>, options: Partial<JudgeInput> = {}) {
  return judge(new Map(Object.entries({ ...healthy, ...overrides })), { ...input, ...options })
}

function statusOf(id: string, overrides: Record<string, string>, options?: Partial<JudgeInput>) {
  const check = checks(overrides, options).find((candidate) => candidate.id === id)
  return check && `${check.status}: ${check.detail}`
}

describe("judging the host", () => {
  test("a server from the infra template passes every check", () => {
    expect(checks({}).filter((check) => check.status !== "ok")).toEqual([])
  })

  test.each([
    ["not Debian-like", "server", { "os.id": "fedora", "os.like": "", "os.name": "Fedora 41" }],
    ["no systemd", "server", { "os.systemd": "no" }],
    ["a CPU Bun has no build for", "server", { "os.arch": "riscv64" }],
    ["a missing tool", "server", { "os.missing": "flock unzip" }],
    ["lingering off", "linger", { linger: "no" }],
    ["no Caddy", "caddy", { "caddy.version": "" }],
    ["Caddy before 2.7, compared as numbers", "caddy", { "caddy.version": "2.6.10" }],
    ["routes not imported", "caddy", { "caddy.caddyfile-imports": "no" }],
    ["no reload rights", "caddy", { "caddy.reload": "no" }],
    ["no env token", "settings", { "file.env-token": "missing" }],
    ["an empty env token", "settings", { "file.env-token": "600 0" }],
    ["an env token others can read", "settings", { "file.env-token": "644 54" }],
    ["an env token its group can read", "settings", { "file.env-token": "640 54" }],
    ["a port another program holds", "ports", { "port.3002": "other" }],
    ["another deployment", "deployments", { "deployments.others": "blog" }],
    ["an account that is root", "account", { "account.name": "root", "account.uid": "0" }],
  ])("fails on %s", (_name, id, overrides) => {
    expect(statusOf(id, overrides)).toStartWith("fail")
  })

  test("names each problem, and points every failure at the host requirements", () => {
    const caddy = checks({ "caddy.version": "2.6.2", "caddy.reload": "no" }).find(
      (check) => check.id === "caddy"
    )
    expect(caddy?.detail).toBe(
      "Caddy 2.6.2 is older than 2.7; sudo systemctl reload caddy is not allowed"
    )
    expect(caddy?.remedy).toBe("See https://docs.sixb.ai/deployment/host-requirements.")
  })

  test("Caddy 2.10 is newer than 2.7", () => {
    expect(statusOf("caddy", { "caddy.version": "2.10.0" })).toStartWith("ok")
  })

  test("a project without a source needs .env instead, here or in the old code folder", () => {
    const noSource = { settings: "env-file" } as const
    expect(statusOf("settings", { "file.env-token": "missing" }, noSource)).toStartWith("ok")
    expect(
      statusOf("settings", { "file.shared-env": "missing", "file.legacy-env": "600 10" }, noSource)
    ).toStartWith("ok")
    expect(statusOf("settings", { "file.shared-env": "missing" }, noSource)).toBe(
      "fail: no .env on the server"
    )
  })

  test("checks Chromium only for a project that prints with it", () => {
    const missing = {
      "chromium.checked": "system libraries",
      "chromium.missing": "libatk-1.0.so.0",
    }
    expect(statusOf("chromium", missing)).toBeUndefined()
    expect(statusOf("chromium", missing, { chromium: true })).toBe(
      "fail: missing libatk-1.0.so.0 (system libraries)"
    )
    expect(statusOf("chromium", { "chromium.missing": "" }, { chromium: true })).toStartWith("ok")
  })

  // Reproduce: judge "identity" as "env-token"; a server reading with its managed identity then
  // fails the check for a file it never uses.
  test("needs no env token when the source reads with the server's own identity", () => {
    const nothing = { "file.env-token": "missing", "file.shared-env": "missing" }
    expect(statusOf("settings", nothing, { settings: "identity" })).toBe(
      "ok: the source reads with the server's own identity"
    )
  })

  test("hands a server with nothing set up the commands that set it up, for its account", () => {
    const unset = checks({
      "os.missing": "flock ss",
      linger: "no",
      "caddy.version": "",
      "caddy.caddyfile-imports": "no",
      "caddy.routes-imported": "no",
      "caddy.routes-writable": "no",
      "caddy.reload": "no",
    })
    const commandsOf = (id: string) => unset.find((check) => check.id === id)?.commands

    expect(commandsOf("server")).toEqual(["apt-get install -y util-linux iproute2"])
    expect(commandsOf("linger")).toEqual(["loginctl enable-linger deploy"])
    expect(commandsOf("caddy")?.slice(3)).toEqual([
      "grep -qxF 'import /etc/caddy/sixb.d/*.caddy' /etc/caddy/Caddyfile || echo 'import /etc/caddy/sixb.d/*.caddy' >> /etc/caddy/Caddyfile",
      "install -d -m 0755 /etc/caddy/sixb.d",
      "echo 'import /etc/caddy/sixb.d/deploy/*.caddy' > /etc/caddy/sixb.d/deploy.caddy",
      "install -d -m 0755 -o deploy -g deploy /etc/caddy/sixb.d/deploy",
      "echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy' > /etc/sudoers.d/deploy",
      "chmod 440 /etc/sudoers.d/deploy",
      "systemctl reload caddy",
    ])
    expect(commandsOf("caddy")?.[2]).toBe("apt-get update && apt-get install -y caddy")
  })

  test("fixes only what is missing", () => {
    const caddy = checks({ "caddy.reload": "no" }).find((check) => check.id === "caddy")
    expect(caddy?.commands).toEqual([
      "echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy' > /etc/sudoers.d/deploy",
      "chmod 440 /etc/sudoers.d/deploy",
      "systemctl reload caddy",
    ])
    expect(checks({}).some((check) => check.commands)).toBe(false)
  })

  // Reproduce: drop `pasteable`; a home the server reports with a `;` in it then lands in a command
  // pasted into a root shell.
  test("gives no commands for an account or home that would need quoting", () => {
    const odd = checks({
      "account.home": "/home/x;rm -rf /",
      "account.name": "dep loy",
      linger: "no",
      "caddy.reload": "no",
      "file.env-token": "644 54",
    })
    for (const id of ["linger", "caddy", "settings"]) {
      expect(odd.find((check) => check.id === id)?.commands).toBeUndefined()
    }
    expect(odd.find((check) => check.id === "linger")?.status).toBe("fail")
  })

  test("names the deployment's files in what fixes its settings", () => {
    const loose = checks({ "file.env-token": "644 54" }).find((check) => check.id === "settings")
    expect(loose?.commands).toEqual(["chmod 600 /home/deploy/shop/env-token"])
    const missing = checks({ "file.env-token": "missing" }).find((c) => c.id === "settings")
    expect(missing?.remedy).toContain("/home/deploy/shop/env-token, mode 600")
  })

  test("takes a settings file only its owner can read, writable or not", () => {
    expect(statusOf("settings", { "file.env-token": "400 54" })).toStartWith("ok")
  })

  test("warns about a nearly full disk", () => {
    expect(statusOf("disk", { "disk.free-kb": "1048576" })).toBe("warning: 1024 MB free")
  })
})

describe("the probe", () => {
  // Reproduce: source /etc/os-release outside its subshell. On Linux its NAME replaces the
  // deployment's, and the settings facts then read another folder.
  test("reports facts the judge reads, as the deploy account, changing nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "sixb-probe-"))
    tempDirs.push(home)
    await mkdir(join(home, "northline", "shared"), { recursive: true })
    await writeFile(join(home, "northline", "shared", ".env"), "A=1\n")
    // A deployment from before releases, in a monorepo: its .env sits in the project's folder.
    await mkdir(join(home, "northline", "code", "apps", "northline"), { recursive: true })
    await writeFile(join(home, "northline", "code", "apps", "northline", ".env"), "A=1\n")
    const units = join(home, ".config", "systemd", "user")
    await mkdir(units, { recursive: true })
    for (const unit of ["sixb-northline@.service", "sixb-blog.service", "sixb-blog@.service"]) {
      await writeFile(join(units, unit), "")
    }

    const lines: string[] = []
    const shell = new LocalShell({ HOME: home, USER: "deploy" })
    const probe = renderProbe({
      name: "northline",
      projectPath: "apps/northline",
      ports: [3001, 3002],
      chromium: true,
    })
    await shell.run(probe, { onLine: (line, stream) => stream === "stdout" && lines.push(line) })
    const facts = parseFacts(lines)

    expect(facts.get("os.arch")).toBeTruthy()
    expect(facts.get("file.env-token")).toBe("missing")
    expect(facts.get("file.shared-env")).not.toBe("missing")
    expect(facts.get("file.legacy-env")).not.toBe("missing")
    expect(facts.get("deployments.others")).toBe("blog")
    expect(facts.get("caddy.routes")).toBe("/etc/caddy/sixb.d/deploy")
    expect(facts.get("account.uid")).toMatch(/^\d+$/)
    expect(facts.get("account.home")).toBe(home)
    expect(facts.has("port.3001")).toBe(true)
    expect(facts.get("chromium.checked")).toBe("system libraries")
  })
})

describe("DNS", () => {
  test.each([
    ["100.109.12.127", true],
    ["10.108.0.5", true],
    ["172.16.4.1", true],
    ["192.168.1.10", true],
    ["fd7a:115c:a1e0::1", true],
    ["159.89.254.216", false],
    ["172.32.0.1", false],
    ["2604:a880:400::1", false],
  ])("%s is private: %p", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blocksDeploy, CHECK_MARKER, parseCheckOutput, renderCheckScript } from "../src/check"
import { ensureEnvToken, pickPublicKey, renderAdminScript } from "../src/setup"
import { LocalShell, RemoteScriptError } from "../src/transport"

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
  test("needs the token instead of .env, and setup fixes it", async () => {
    const home = await mkdtemp(join(tmpdir(), "sixb-check-"))
    tempDirs.push(home)

    expect(await checkWithHome(home, true)).toEqual(["project.env-token fixable"])
    expect(await checkWithHome(home, false)).toEqual(["project.env manual"])
  })

  test("reads a missing token back as something setup can fix", () => {
    const [check] = parseCheckOutput(
      [line("project.env-token", "fixable", "/home/sixb/northline/env-token has no token")],
      context
    )

    expect(check).toMatchObject({
      label: "Source token",
      status: "fixable",
      remedy: "Run `sixb deploy setup`.",
    })
    expect(check && blocksDeploy(check)).toBe(true)
  })

  describe("ensureEnvToken", () => {
    async function server() {
      const home = await mkdtemp(join(tmpdir(), "sixb-check-"))
      tempDirs.push(home)
      return {
        shell: new LocalShell({ HOME: home }),
        path: join(home, "northline", "env-token"),
        home,
      }
    }

    // Reproduce: put the token in the script. Any process on the server can read a command's arguments.
    test("installs the token only its owner can read, sent on standard input", async () => {
      const { shell, path } = await server()
      const scripts: string[] = []

      const installed = await ensureEnvToken(
        {
          run: (script, options) => {
            scripts.push(script)
            return shell.run(script, options)
          },
          close: async () => {},
        },
        "northline",
        async () => "dp.st.prd.secret"
      )

      expect(installed).toBe(true)
      expect(await readFile(path, "utf8")).toBe("dp.st.prd.secret\n")
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(scripts.join("\n")).not.toContain("dp.st.prd.secret")
    })

    // Reproduce: go by the checks setup started with. On a fresh server those stop at SSH, so setup
    // exits 0 without a token and the deploy after it stops.
    test("a server that has one keeps it, without creating another", async () => {
      const { shell, path, home } = await server()
      await mkdir(join(home, "northline"))
      await writeFile(path, "existing\n")

      const installed = await ensureEnvToken(shell, "northline", async () => {
        throw new Error("Creates a token nobody needs.")
      })

      expect(installed).toBe(false)
      expect(await readFile(path, "utf8")).toBe("existing\n")
    })

    test("replaces an empty file, which can't authenticate", async () => {
      const { shell, path, home } = await server()
      await mkdir(join(home, "northline"))
      await writeFile(path, "")

      expect(await ensureEnvToken(shell, "northline", async () => "new")).toBe(true)
      expect(await readFile(path, "utf8")).toBe("new\n")
    })

    // Reproduce: remove `set -e`. `mv` then succeeds, an empty file replaces the token, and setup
    // says it installed one.
    test("a write that fails installs nothing and says so", async () => {
      const { shell, path, home } = await server()
      await mkdir(join(home, "northline"))
      await mkdir(`${path}.new`)

      const error = await ensureEnvToken(shell, "northline", async () => "new").catch((e) => e)

      expect(error).toBeInstanceOf(Error)
      expect(await Bun.file(path).exists()).toBe(false)
    })

    // Reproduce: treat every failure as a missing token. Each dropped connection then creates a
    // token in Doppler that nothing uses.
    test("a connection that fails isn't read as a missing token", async () => {
      let created = 0
      const failing = {
        run: async () => {
          throw new RemoteScriptError("ssh failed", 255)
        },
        close: async () => {},
      }

      const error = await ensureEnvToken(failing, "northline", async () => {
        created += 1
        return "new"
      }).catch((e) => e)

      expect(error).toBeInstanceOf(RemoteScriptError)
      expect(created).toBe(0)
    })
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

  test("keeps apt quiet, except when it fails", async () => {
    const script = renderAdminScript({ user: "sixb", publicKey: "ssh-ed25519 AAAA", admin: "root" })
    const quiet = script.split("\n").find((line) => line.startsWith("quiet()")) ?? ""
    const run = async (command: string) => {
      const child = Bun.spawn(["bash", "-c", `${quiet}\n${command}`], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, output: stdout + stderr }
    }

    expect(await run("quiet echo pages of apt")).toEqual({ exitCode: 0, output: "" })
    expect(await run("quiet sh -c 'echo E: Unable to locate package; exit 100'")).toEqual({
      exitCode: 100,
      output: "E: Unable to locate package\n",
    })
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

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addKey, listKeys, removeKeysWhere } from "../src/access"
import { generateCiKey, knownHostsLines, renderCiInstall } from "../src/ci"
import { parsePublicKey } from "../src/keys"
import { LocalShell } from "../src/transport"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-ci-test-"))
  tempDirs.push(dir)
  return dir
}

async function leftoverKeyDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("sixb-ci-key-"))
}

describe("a CI key", () => {
  test("is made fresh, and leaves nothing on disk", async () => {
    const before = await leftoverKeyDirs()
    const pair = await generateCiKey("sixb-ci:northline@github:acme/shop")

    expect(pair.privateKey).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----")
    expect(parsePublicKey(pair.publicKey)).toMatchObject({
      type: "ssh-ed25519",
      comment: "sixb-ci:northline@github:acme/shop",
    })
    expect(await leftoverKeyDirs()).toEqual(before)
  })

  test("is authorized restricted, and replacing it keeps every other key", async () => {
    const home = await tempDir()
    await mkdir(join(home, ".ssh"), { mode: 0o700 })
    const shell = new LocalShell({ HOME: home })
    const comment = "sixb-ci:northline@github:acme/shop"
    const person = await generateCiKey("anthony@mbp")
    await addKey(shell, person.publicKey)

    const first = await addKey(shell, (await generateCiKey(comment)).publicKey, "restrict")
    const second = await addKey(shell, (await generateCiKey(comment)).publicKey, "restrict")
    expect(first.restricted).toBe(true)
    expect(first.line).toStartWith("restrict ssh-ed25519 ")

    const retired = await removeKeysWhere(
      shell,
      (key) => key.comment === comment && key.fingerprint !== second.fingerprint
    )
    expect(retired.map((key) => key.fingerprint)).toEqual([first.fingerprint])
    expect((await listKeys(shell)).map((key) => key.fingerprint)).toEqual([
      parsePublicKey(person.publicKey).fingerprint,
      second.fingerprint,
    ])
    expect(await removeKeysWhere(shell, (key) => key.comment === "nobody")).toEqual([])
  })
})

describe("the runner's SSH setup", () => {
  test("pins the host keys under the name and port CI connects to", () => {
    expect(knownHostsLines(["ssh-ed25519 AAAA"], "203.0.113.10", 22)).toEqual([
      "203.0.113.10 ssh-ed25519 AAAA",
    ])
    expect(knownHostsLines(["ssh-ed25519 AAAA"], "203.0.113.10", 2222)).toEqual([
      "[203.0.113.10]:2222 ssh-ed25519 AAAA",
    ])
  })

  test("installs the key where ssh finds it for the target's host, refusing unknown host keys", async () => {
    const home = await tempDir()
    const script = renderCiInstall({ host: "myvm", hostname: "203.0.113.10", port: 2222 }).join(
      "\n"
    )
    const child = Bun.spawn(["bash", "-euo", "pipefail", "-c", script], {
      env: {
        HOME: home,
        PATH: process.env.PATH,
        SIXB_DEPLOY_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n",
        SIXB_DEPLOY_KNOWN_HOSTS: "[203.0.113.10]:2222 ssh-ed25519 AAAA",
      },
    })
    expect(await child.exited).toBe(0)

    expect((await stat(join(home, ".ssh/sixb_deploy"))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(home, ".ssh/sixb_known_hosts"), "utf8")).toBe(
      "[203.0.113.10]:2222 ssh-ed25519 AAAA\n"
    )
    const resolved = Bun.spawn(["ssh", "-G", "-F", join(home, ".ssh/config"), "sixb@myvm"], {
      stdout: "pipe",
    })
    const options = new Map(
      (await new Response(resolved.stdout).text())
        .split("\n")
        .map((line) => [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)] as const)
    )
    expect(options.get("hostname")).toBe("203.0.113.10")
    expect(options.get("port")).toBe("2222")
    expect(options.get("identityfile")).toBe("~/.ssh/sixb_deploy")
    expect(options.get("stricthostkeychecking")).toBe("true")
  })
})

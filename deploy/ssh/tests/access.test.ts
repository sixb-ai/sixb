import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addKey, listKeys, removeKeys } from "../src/access"
import { parseAuthorizedKey, parsePublicKey } from "../src/keys"
import { LocalShell, type RemoteShell } from "../src/transport"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-access-"))
  tempDirs.push(dir)
  return dir
}

/** A fresh key pair made by ssh-keygen, with its public line and the fingerprint it reports. */
async function keyPair(comment: string): Promise<{ line: string; fingerprint: string }> {
  const dir = await tempDir()
  const path = join(dir, "key")
  await Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path]).exited
  const fingerprint = await new Response(
    Bun.spawn(["ssh-keygen", "-l", "-f", `${path}.pub`], { stdout: "pipe" }).stdout
  ).text()
  return {
    line: (await readFile(`${path}.pub`, "utf8")).trim(),
    fingerprint: fingerprint.split(" ")[1] ?? "",
  }
}

async function server(): Promise<{ home: string; shell: RemoteShell }> {
  const home = await tempDir()
  await mkdir(join(home, ".ssh"), { mode: 0o700 })
  return { home, shell: new LocalShell({ HOME: home }) }
}

describe("public keys", () => {
  test("fingerprint the way ssh-keygen does", async () => {
    const { line, fingerprint } = await keyPair("dev@laptop")
    expect(parsePublicKey(line)).toMatchObject({
      type: "ssh-ed25519",
      fingerprint,
      comment: "dev@laptop",
      restricted: false,
    })
  })

  test("read options, and refuse what is not a key", async () => {
    const { line } = await keyPair("ci")
    expect(parseAuthorizedKey(`restrict,command="true" ${line}`)?.restricted).toBe(true)
    expect(parseAuthorizedKey("# a comment")).toBeNull()

    const [, encoded] = line.split(" ")
    expect(() => parsePublicKey(`ssh-rsa ${encoded} wrong type`)).toThrow("not an SSH public key")
    expect(() => parsePublicKey("hello")).toThrow("not an SSH public key")
  })
})

describe("access", () => {
  test("adds a key once, lists it, and keeps the file's other lines", async () => {
    const { home, shell } = await server()
    const first = await keyPair("anthony@mbp")
    const second = await keyPair("quentin@mbp")
    await writeFile(join(home, ".ssh/authorized_keys"), `# managed by hand\n${first.line}\n`)

    await addKey(shell, second.line)
    await addKey(shell, second.line)

    expect((await listKeys(shell)).map((key) => key.comment)).toEqual([
      "anthony@mbp",
      "quentin@mbp",
    ])
    const content = await readFile(join(home, ".ssh/authorized_keys"), "utf8")
    expect(content).toStartWith("# managed by hand\n")
    expect(content.match(/quentin@mbp/g)?.length).toBe(1)
  })

  test("removes by comment or fingerprint, but never the last key", async () => {
    const { shell } = await server()
    const first = await keyPair("anthony@mbp")
    const second = await keyPair("quentin@mbp")
    await addKey(shell, first.line)
    await addKey(shell, second.line)

    expect((await removeKeys(shell, second.fingerprint)).map((key) => key.comment)).toEqual([
      "quentin@mbp",
    ])
    await expect(removeKeys(shell, "anthony@mbp")).rejects.toThrow("would remove every key")
    await expect(removeKeys(shell, "nobody")).rejects.toThrow("No authorized key")
  })

  test("refuses to overwrite a change made since it read the file", async () => {
    const { home, shell } = await server()
    const first = await keyPair("anthony@mbp")
    const second = await keyPair("quentin@mbp")
    await addKey(shell, first.line)

    // Someone else authorizes a key between this command's read and its write.
    const racing: RemoteShell = {
      run: async (script, options) => {
        if (script.includes("sha256sum")) {
          await writeFile(join(home, ".ssh/authorized_keys"), `${first.line}\nssh-ed25519 other\n`)
        }
        return shell.run(script, options)
      },
      close: () => shell.close(),
    }
    await expect(addKey(racing, second.line)).rejects.toThrow("changed while this ran")
  })
})

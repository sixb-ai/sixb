import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isGeneratedEnvFile, readEnvFile, writeEnvFile } from "../src/lib/env-file"

const directories: string[] = []

afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function envPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-env-file-"))
  directories.push(dir)
  return join(dir, ".env")
}

describe("writeEnvFile", () => {
  // The values a real project holds, each of which a naive writer corrupts on Bun 1.4.4: `$` expands
  // even in single quotes, and `\\` and `\"` aren't escapes in double quotes.
  test("every value survives Bun's own parser", async () => {
    const values = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text is the point.
      PASSWORD: "pa$$word$HOME${HOME}",
      WINDOWS_PATH: "C:\\temp\\new",
      LITERAL_BACKSLASH_N: "a\\nb",
      PEM: "-----BEGIN KEY-----\nabc=\n-----END KEY-----\n",
      LOOKS_LIKE_A_LINE: "x\nFOO=bar\n# comment",
      QUOTES: `say "hi" and 'bye'`,
      JSON: '{"a":"b$c"}',
      HASH: "a#b # c",
      PADDED: "  padded  ",
      EQUALS: "a=b=c",
      UNICODE: "é✓😀",
      EMPTY: "",
    }
    const path = await envPath()

    await writeEnvFile(path, values, "dev")

    expect(await readEnvFile(path)).toEqual(values)
  })

  // Reproduce: remove the comparison in writeEnvFile. `.env` is then replaced, and the value after
  // the trailing backslash disappears into it.
  test.each([
    ["ends in a backslash", "abc\\"],
    ["has a carriage return", "a\r\nb"],
    ["uses all three quotes", `'"\``],
  ])("leaves .env alone when a value %s, naming only the variable", async (_case, value) => {
    const path = await envPath()
    await writeEnvFile(path, { KEEP: "old" }, "dev")

    const error = await writeEnvFile(path, { BAD: value, OTHER: "secret-other" }, "dev").catch(
      (failure) => failure
    )

    expect(String(error)).toContain("can't hold the value of BAD")
    expect(String(error)).not.toContain(value)
    expect(String(error)).not.toContain("secret-other")
    expect(await readEnvFile(path)).toEqual({ KEEP: "old" })
  })

  test("a name that isn't one can't add lines to the file", async () => {
    const path = await envPath()

    const error = await writeEnvFile(path, { "A\nINJECTED": "1" }, "dev").catch((f) => f)

    expect(String(error)).toContain("can't hold the value of")
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("replaces a file only its owner can read, leaving no temporary behind", async () => {
    const path = await envPath()
    await writeFile(path, "OLD=1\n", { mode: 0o644 })

    await writeEnvFile(path, { NEW: "2" }, "dev")

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readEnvFile(path)).toEqual({ NEW: "2" })
    const entries = await Array.fromAsync(
      new Bun.Glob(".env*").scan({ cwd: join(path, ".."), dot: true })
    )
    expect(entries).toEqual([".env"])
  })

  // Reproduce: use a temporary named per process. A killed pull's copy of the values then stays.
  test("clears what a killed pull left behind", async () => {
    const path = await envPath()
    await writeFile(`${path}.pull.tmp`, "LEFT=behind\n", { mode: 0o600 })

    await writeEnvFile(path, { A: "1" }, "dev")

    expect(await Bun.file(`${path}.pull.tmp`).exists()).toBe(false)
  })

  test("says it's generated, and where personal values go", async () => {
    const path = await envPath()

    await writeEnvFile(path, { A: "1" }, "dev")

    expect(await isGeneratedEnvFile(path)).toBe(true)
    expect((await readFile(path, "utf8")).split("\n")[0]).toContain(".env.local")
  })
})

describe("isGeneratedEnvFile", () => {
  test("is false for a hand-written file and a missing one", async () => {
    const path = await envPath()
    expect(await isGeneratedEnvFile(path)).toBe(false)

    await writeFile(path, "A=1\n")
    expect(await isGeneratedEnvFile(path)).toBe(false)
  })
})

describe("readEnvFile", () => {
  // Reproduce: remove the access check. Bun reads this as empty, so a pull thinks it has nothing to
  // lose and replaces the only copy of a value.
  test("fails on a file it can't open, rather than reading it as empty", async () => {
    const path = await envPath()
    await writeFile(path, "ONLY_COPY=1\n", { mode: 0o000 })

    const error = await readEnvFile(path).catch((failure) => failure)

    expect(String(error)).toContain("Could not read")
  })

  test("holds the file's values and none of this process's", async () => {
    const path = await envPath()
    await writeFile(path, 'A=1\nB="two"\nC=$A-three\n')

    expect(await readEnvFile(path)).toEqual({ A: "1", B: "two", C: "1-three" })
  })
})

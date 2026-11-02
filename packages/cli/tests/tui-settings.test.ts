import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setFoldersAllowed } from "../src/runner/allowed-folders"
import { loadSettings, saveSettings } from "../src/tui/settings"

// Messages from the web decide what runs on this computer, so the choice belongs to one folder
// and nothing else `sixb` saves may undo it.

const FOLDER = "/work/secrets"
const OTHER = "/work/q3-close"

let configHome: string
let previousConfigHome: string | undefined

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "sixb-tui-settings-"))
  await mkdir(join(configHome, "sixb"), { recursive: true })
  previousConfigHome = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(async () => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousConfigHome
  await rm(configHome, { recursive: true, force: true })
})

describe("messages from the web", () => {
  // Guard proof: answer true from isFolderAllowed for an absent list, as `sixb` first did; a message
  // from a stolen sign-in runs in a folder nobody chose.
  test("are off until a folder is chosen, in that folder alone, until it's forgotten", async () => {
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(false)

    await setFoldersAllowed([FOLDER], true)
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(true)
    expect((await loadSettings(OTHER)).continueFromWeb).toBe(false)

    await setFoldersAllowed([OTHER], true)
    await setFoldersAllowed([FOLDER], false)
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(false)
    expect((await loadSettings(OTHER)).continueFromWeb).toBe(true)
  })

  // Guard proof: write continueFromWeb in saveSettings and read it in loadSettings; another sixb
  // saving its model turns messages on or off in folders it was never open in.
  test("are kept apart from the settings another sixb saves", async () => {
    await setFoldersAllowed([FOLDER], true)
    const another = await loadSettings(OTHER)
    await saveSettings({ ...another, reasoning: "high" })

    const stored = await readFile(join(configHome, "sixb", "tui.json"), "utf-8")
    expect(JSON.parse(stored)).not.toHaveProperty("continueFromWeb")
    expect(await loadSettings(FOLDER)).toMatchObject({ continueFromWeb: true, reasoning: "high" })
  })

  // Guard proof: answer true from isFolderAllowed's failure; a damaged list runs turns anywhere.
  test("stay off when the list can't be read", async () => {
    await writeFile(join(configHome, "sixb", "allowed-folders.json"), "{ damaged")
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(false)
  })

  // Guard proof: name the temporary file for the process alone, in setFoldersAllowed; a quick off and
  // on in one sixb share it, and the second write fails or the wrong one lands.
  test("take two quick changes without failing either", async () => {
    await Promise.all([setFoldersAllowed([FOLDER], true), setFoldersAllowed([OTHER], true)])

    expect(await readdir(join(configHome, "sixb"))).toEqual(["allowed-folders.json"])
  })

  // Guard proof: read the list as empty when it can't be parsed, in setFoldersAllowed; the write
  // that follows forgets every folder chosen before.
  test("refuse a new choice rather than overwrite a list they can't read", async () => {
    const path = join(configHome, "sixb", "allowed-folders.json")
    await writeFile(path, "{ damaged")

    expect(await setFoldersAllowed([FOLDER], true).catch((error: unknown) => error)).toBeInstanceOf(
      Error
    )
    expect(await readFile(path, "utf-8")).toBe("{ damaged")
    expect(await readdir(join(configHome, "sixb"))).toEqual(["allowed-folders.json"])
  })
})

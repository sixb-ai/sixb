import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isFolderAllowed, setFoldersAllowed } from "../src/runner/allowed-folders"
import { loadSettings, saveSettings } from "../src/tui/settings"

// Messages from the web decide what runs on this computer, so the choice belongs to one folder in
// one project, and nothing else `sixb` saves may undo it.

const FOLDER = "/work/secrets"
const OTHER = "/work/q3-close"
const PROJECT = {
  apiUrl: "https://api.acme.test",
  project: { id: "acme", timeZone: "UTC", locale: "en" },
}

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
    expect(await isFolderAllowed(PROJECT, FOLDER)).toBe(false)

    await setFoldersAllowed(PROJECT, [FOLDER], true)
    expect(await isFolderAllowed(PROJECT, FOLDER)).toBe(true)
    expect(await isFolderAllowed(PROJECT, OTHER)).toBe(false)

    await setFoldersAllowed(PROJECT, [OTHER], true)
    await setFoldersAllowed(PROJECT, [FOLDER], false)
    expect(await isFolderAllowed(PROJECT, FOLDER)).toBe(false)
    expect(await isFolderAllowed(PROJECT, OTHER)).toBe(true)
  })

  // Guard proof: key the list by the folder alone, or by the project's id alone, in keyOf; a folder
  // chosen for one project takes messages from a stolen sign-in to another, or to any server that
  // reports the same id.
  test("in one project say nothing about another, at another address or with another id", async () => {
    const sameIdElsewhere = { ...PROJECT, apiUrl: "https://api.other.test" }
    const anotherId = { ...PROJECT, project: { ...PROJECT.project, id: "globex" } }
    await setFoldersAllowed(PROJECT, [FOLDER], true)

    expect(await isFolderAllowed(sameIdElsewhere, FOLDER)).toBe(false)
    expect(await isFolderAllowed(anotherId, FOLDER)).toBe(false)

    await setFoldersAllowed(anotherId, [FOLDER], true)
    await setFoldersAllowed(PROJECT, [FOLDER], false)
    expect(await isFolderAllowed(anotherId, FOLDER)).toBe(true)
    expect(await isFolderAllowed(PROJECT, FOLDER)).toBe(false)
  })

  // Guard proof: write continueFromWeb in saveSettings and read it in loadSettings; another sixb
  // saving its model turns messages on or off in folders it was never open in.
  test("are kept apart from the settings another sixb saves", async () => {
    await setFoldersAllowed(PROJECT, [FOLDER], true)
    const another = await loadSettings()
    await saveSettings({ ...another, reasoning: "high" })

    const stored = await readFile(join(configHome, "sixb", "tui.json"), "utf-8")
    expect(JSON.parse(stored)).not.toHaveProperty("continueFromWeb")
    expect(await loadSettings()).toMatchObject({ continueFromWeb: false, reasoning: "high" })
    expect(await isFolderAllowed(PROJECT, FOLDER)).toBe(true)
  })

  // Guard proof: answer true from isFolderAllowed's failure; a damaged list runs turns anywhere.
  test("stay off when the list can't be read", async () => {
    await writeFile(join(configHome, "sixb", "allowed-folders.json"), "{ damaged")
    expect(await isFolderAllowed(PROJECT, FOLDER)).toBe(false)
  })

  // Guard proof: name the temporary file for the process alone, in setFoldersAllowed; a quick off and
  // on in one sixb share it, and the second write fails or the wrong one lands.
  test("take two quick changes without failing either", async () => {
    await Promise.all([
      setFoldersAllowed(PROJECT, [FOLDER], true),
      setFoldersAllowed(PROJECT, [OTHER], true),
    ])

    expect(await readdir(join(configHome, "sixb"))).toEqual(["allowed-folders.json"])
  })

  // Guard proof: read the list as empty when it can't be parsed, in setFoldersAllowed; the write
  // that follows forgets every folder chosen before.
  test("refuse a new choice rather than overwrite a list they can't read", async () => {
    const path = join(configHome, "sixb", "allowed-folders.json")
    await writeFile(path, "{ damaged")

    expect(
      await setFoldersAllowed(PROJECT, [FOLDER], true).catch((error: unknown) => error)
    ).toBeInstanceOf(Error)
    expect(await readFile(path, "utf-8")).toBe("{ damaged")
    expect(await readdir(join(configHome, "sixb"))).toEqual(["allowed-folders.json"])
  })
})

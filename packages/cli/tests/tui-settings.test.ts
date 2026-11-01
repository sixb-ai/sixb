import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSettings, rememberWebMessages, saveSettings } from "../src/tui/settings"

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
  test("are on until turned off, in that folder alone, until turned back on", async () => {
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(true)

    await rememberWebMessages(FOLDER, false)
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(false)
    expect((await loadSettings(OTHER)).continueFromWeb).toBe(true)

    await rememberWebMessages(OTHER, false)
    await rememberWebMessages(FOLDER, true)
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(true)
    expect((await loadSettings(OTHER)).continueFromWeb).toBe(false)
  })

  // Guard proof: write continueFromWeb in saveSettings and read it in loadSettings, as it first
  // was; another sixb saving its model turns messages back on where they were turned off.
  test("stay off when another sixb, with them on, saves its settings", async () => {
    await rememberWebMessages(FOLDER, false)
    const another = await loadSettings(OTHER)
    await saveSettings({ ...another, reasoning: "high" })

    const stored = await readFile(join(configHome, "sixb", "tui.json"), "utf8")
    expect(JSON.parse(stored)).not.toHaveProperty("continueFromWeb")
    expect(await loadSettings(FOLDER)).toMatchObject({ continueFromWeb: false, reasoning: "high" })
  })

  // Guard proof: answer true from webMessagesOnIn's catch; a damaged file runs turns here that the
  // person had turned off.
  test("stay off when the choice can't be read", async () => {
    await writeFile(join(configHome, "sixb", "web-messages-off.json"), "{ damaged")
    expect((await loadSettings(FOLDER)).continueFromWeb).toBe(false)
  })
})

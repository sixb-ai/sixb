import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { readConfig, resolveConfigPath, resolveProfile, updateConfig } from "../src/lib/profiles"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function tempConfigRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sixb-profiles-"))
  tempDirectories.push(path)
  return path
}

describe("Sixb profiles", () => {
  test("uses XDG_CONFIG_HOME and safely creates a private config", async () => {
    const root = await tempConfigRoot()
    const options = { env: { XDG_CONFIG_HOME: root } }
    expect(resolveConfigPath(options)).toBe(join(root, "sixb", "config.json"))
    expect(await readConfig(options)).toEqual({ version: 1, profiles: {} })

    await updateConfig(
      () => ({
        version: 1,
        currentProfile: "production",
        profiles: {
          production: {
            apiUrl: "https://api.example.com/api",
            projectId: "acme",
            token: "secret-value",
          },
        },
      }),
      options
    )

    const configPath = resolveConfigPath(options)
    expect((await stat(dirname(configPath))).mode & 0o777).toBe(0o700)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      currentProfile: "production",
      profiles: {
        production: {
          apiUrl: "https://api.example.com",
          projectId: "acme",
          token: "secret-value",
        },
      },
    })
  })

  test("resolves explicit URLs without inheriting stored credentials", async () => {
    const root = await tempConfigRoot()
    const options = { env: { XDG_CONFIG_HOME: root } }
    await updateConfig(
      () => ({
        version: 1,
        currentProfile: "production",
        profiles: {
          production: {
            apiUrl: "https://stored.example.com",
            projectId: "acme",
            token: "stored-secret",
          },
        },
      }),
      options
    )

    expect(
      await resolveProfile({
        apiUrl: "https://adhoc.example.com/api",
        env: { XDG_CONFIG_HOME: root, SIXB_API_TOKEN: "environment-secret" },
      })
    ).toEqual({ apiUrl: "https://adhoc.example.com", source: "api-url-flag" })
  })

  test("resolves profile and environment precedence", async () => {
    const root = await tempConfigRoot()
    await updateConfig(
      () => ({
        version: 1,
        currentProfile: "current",
        profiles: {
          current: { apiUrl: "https://current.example.com", projectId: "current" },
          selected: {
            apiUrl: "https://selected.example.com",
            projectId: "selected",
            token: "profile-token",
          },
        },
      }),
      { env: { XDG_CONFIG_HOME: root } }
    )

    expect(
      await resolveProfile({
        profile: "selected",
        env: { XDG_CONFIG_HOME: root, SIXB_API_URL: "https://env.example.com" },
      })
    ).toMatchObject({
      apiUrl: "https://selected.example.com",
      token: "profile-token",
      profile: "selected",
      source: "profile-flag",
    })

    expect(
      await resolveProfile({
        env: {
          XDG_CONFIG_HOME: root,
          SIXB_API_URL: "https://env.example.com",
          SIXB_API_TOKEN: "environment-token",
        },
      })
    ).toMatchObject({
      apiUrl: "https://env.example.com",
      token: "environment-token",
      source: "environment",
    })
  })
})

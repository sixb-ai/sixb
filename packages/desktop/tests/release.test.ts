import { describe, expect, test } from "bun:test"
import {
  appleSigning,
  findDeveloperIdentity,
  notarizationIssues,
  parseKeychainList,
} from "../src/mac"
import { releaseUrl, renderMacFeed } from "../src/release"

describe("macOS release", () => {
  test("feeds the updater the current version and the archive it updates from", () => {
    const feed = JSON.parse(
      renderMacFeed({
        appUrl: "https://ops.example.com/",
        version: "1.2.0",
        publishedAt: new Date("2026-11-16T12:00:00Z"),
      })
    )
    expect(feed).toEqual({
      currentRelease: "1.2.0",
      releases: [
        {
          version: "1.2.0",
          updateTo: {
            version: "1.2.0",
            name: "1.2.0",
            notes: "",
            pub_date: "2026-11-16T12:00:00.000Z",
            url: "https://ops.example.com/__sixb/desktop/darwin/app-1.2.0.zip",
          },
        },
      ],
    })
  })

  test("serves a release from the app's origin, whatever path the app URL names", () => {
    expect(releaseUrl("https://ops.example.com/home", "darwin", "install.dmg")).toBe(
      "https://ops.example.com/__sixb/desktop/darwin/install.dmg"
    )
  })
})

describe("Apple signing", () => {
  test("builds unsigned with no Apple variable set", async () => {
    expect(await appleSigning({})).toBeNull()
  })

  test("names what is missing when only some of the variables are set", async () => {
    const error = await appleSigning({ APPLE_API_KEY: "key", APPLE_CERTIFICATE: "p12" }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("APPLE_API_KEY_ID, APPLE_API_ISSUER")
  })

  test("picks the first Developer ID Application identity, by fingerprint", () => {
    const output = [
      '  1) 1111111111111111111111111111111111111111 "Apple Development: Jamie Rivera (AAAA)"',
      '  2) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Example, Inc. (TEAM)"',
      "     2 valid identities found",
    ].join("\n")
    expect(findDeveloperIdentity(output)).toBe("ABCDEF0123456789ABCDEF0123456789ABCDEF01")
    expect(findDeveloperIdentity("     0 valid identities found")).toBeNull()
  })

  test("reads the keychain search list it puts back afterwards", () => {
    const output =
      '    "/Users/me/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'
    expect(parseKeychainList(output)).toEqual([
      "/Users/me/Library/Keychains/login.keychain-db",
      "/Library/Keychains/System.keychain",
    ])
  })

  test("says what Apple found when it refuses to notarize", () => {
    const log = JSON.stringify({
      status: "Invalid",
      issues: [
        {
          severity: "error",
          path: "Ops.dmg/Ops.app/Contents/Resources/runner/sixb-runner",
          message: "The executable does not have the hardened runtime enabled.",
        },
      ],
    })
    expect(notarizationIssues(log)).toBe(
      "Ops.dmg/Ops.app/Contents/Resources/runner/sixb-runner: The executable does not have the hardened runtime enabled."
    )
    expect(notarizationIssues("not json")).toBe("")
  })
})

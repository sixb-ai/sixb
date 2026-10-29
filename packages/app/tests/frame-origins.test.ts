import { describe, expect, test } from "bun:test"
import { readAppFrameOrigins } from "../src/frame-origins"

const read = (value: string | undefined) => readAppFrameOrigins({ SIXB_APP_FRAME_ORIGINS: value })

describe("readAppFrameOrigins", () => {
  test("lists nothing when the variable is unset or blank", () => {
    expect(readAppFrameOrigins({})).toEqual([])
    expect(read(undefined)).toEqual([])
    expect(read(" , ")).toEqual([])
  })

  test("normalizes each origin as the browser compares it", () => {
    expect(
      read(
        " https://Contoso.SharePoint.com/ ,https://www.youtube-nocookie.com:443,,http://localhost:6006, https://bücher.example"
      )
    ).toEqual([
      "https://contoso.sharepoint.com",
      "https://www.youtube-nocookie.com",
      "http://localhost:6006",
      "https://xn--bcher-kva.example",
    ])
    expect(read("https://a.example,https://A.example/")).toEqual(["https://a.example"])
  })

  // Reproduce: drop the `*` check, and the error no longer says why the entry is refused.
  test("refuses a wildcard, which would admit sites nobody listed", () => {
    for (const entry of ["https://*.sharepoint.com", "*", "https://*"]) {
      expect(() => read(entry)).toThrow(`'${entry}' is a wildcard`)
    }
  })

  // Reproduce: drop the CSP_HOST check, and the first entries reach the policy as written.
  test("refuses anything but one exact http(s) origin", () => {
    for (const entry of [
      "https://x.example;script-src",
      "https://x.example'",
      "https://x.example.",
      "https://[::1]:8443",
      "'self'",
      "https:",
      "data:",
      "ftp://x.example",
      "x.example",
      "https://user:secret@x.example",
      "https://x.example/embed",
      "https://x.example/?id=1",
      "https://x.example/#viewer",
    ]) {
      expect(() => read(entry), entry).toThrow(`'${entry}' is not an origin`)
    }
  })

  test("names the variable in each error", () => {
    expect(() => read("https://ok.example,https://x.example/embed")).toThrow(
      "[SixbCustomApp] SIXB_APP_FRAME_ORIGINS: 'https://x.example/embed'"
    )
  })
})

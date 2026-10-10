import { describe, expect, test } from "bun:test"
import { hostOf, normalizeWorkspaceAddress } from "../src/lib/workspace-address"

describe("normalizeWorkspaceAddress", () => {
  test("gives a bare host https", () => {
    expect(normalizeWorkspaceAddress("acme-api.sixb.app")).toBe("https://acme-api.sixb.app")
    expect(normalizeWorkspaceAddress("  acme-api.sixb.app  ")).toBe("https://acme-api.sixb.app")
  })

  test("gives a local host http, the way a development server serves", () => {
    expect(normalizeWorkspaceAddress("localhost:3002")).toBe("http://localhost:3002")
    expect(normalizeWorkspaceAddress("192.168.1.20:3002")).toBe("http://192.168.1.20:3002")
    expect(normalizeWorkspaceAddress("studio.local")).toBe("http://studio.local")
    expect(normalizeWorkspaceAddress("LOCALHOST:3002")).toBe("http://localhost:3002")
  })

  test("keeps the scheme someone typed", () => {
    expect(normalizeWorkspaceAddress("https://localhost:3002")).toBe("https://localhost:3002")
    expect(normalizeWorkspaceAddress("http://acme-api.sixb.app")).toBe("http://acme-api.sixb.app")
  })

  test("keeps a path prefix and drops trailing slashes, the query and the fragment", () => {
    expect(normalizeWorkspaceAddress("acme.com/sixb/")).toBe("https://acme.com/sixb")
    expect(normalizeWorkspaceAddress("https://acme.com///")).toBe("https://acme.com")
    expect(normalizeWorkspaceAddress("https://acme.com/?tab=1#top")).toBe("https://acme.com")
  })

  test("says what is wrong with an address it cannot use", () => {
    expect(() => normalizeWorkspaceAddress("   ")).toThrow("Enter your workspace address.")
    expect(() => normalizeWorkspaceAddress("not an address")).toThrow(
      "That doesn't look like a workspace address."
    )
    expect(() => normalizeWorkspaceAddress("ftp://acme.com")).toThrow(
      "A workspace address starts with http:// or https://."
    )
  })
})

describe("hostOf", () => {
  test("shows the host and port of a base URL", () => {
    expect(hostOf("https://acme-api.sixb.app")).toBe("acme-api.sixb.app")
    expect(hostOf("http://localhost:3002/sixb")).toBe("localhost:3002")
  })

  test("shows the text as it is when it is not a URL", () => {
    expect(hostOf("acme")).toBe("acme")
  })
})

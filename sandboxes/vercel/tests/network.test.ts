import { describe, expect, test } from "bun:test"
import { SandboxError } from "@sixb/core"
import type {
  SandboxNetworkPolicy,
  SandboxRequestCredential,
  SandboxRequestMethod,
} from "@sixb/core/sandboxes"
import { toVercelNetworkPolicy, withRequestCredentials } from "../src/network"

const credential: SandboxRequestCredential = {
  origin: "https://github.com",
  path: "/acme/repo.git/info/refs",
  method: "GET",
  headers: { Authorization: "Basic test" },
}

const api: SandboxRequestCredential = {
  origin: "https://api.github.com",
  path: { prefix: "/" },
  method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  headers: { Authorization: "Bearer test" },
}

const restricted: SandboxNetworkPolicy = {
  mode: "restricted",
  allow: [
    { name: "git", origin: "https://github.com" },
    { name: "api", origin: "https://api.github.com" },
  ],
}

const inject =
  (...credentials: SandboxRequestCredential[]) =>
  () =>
    withRequestCredentials(restricted, credentials)

describe("credential injection policy", () => {
  // Drop `Host` from the transform in withRequestCredentials to watch the mapping tests fail.
  test("uses exact path and method without replacing unrelated egress rules", () => {
    expect(
      withRequestCredentials(
        {
          mode: "restricted",
          allow: [
            { name: "github", origin: "https://github.com" },
            { name: "npm", origin: "https://registry.npmjs.org" },
          ],
        },
        [credential]
      )
    ).toEqual({
      allow: {
        "github.com": [
          {
            match: { path: { exact: "/acme/repo.git/info/refs" }, method: ["GET"] },
            transform: [{ headers: { Authorization: "Basic test", Host: "github.com" } }],
          },
        ],
        "registry.npmjs.org": [],
      },
    })
  })

  test("maps a path prefix to startsWith with every listed method", () => {
    expect(withRequestCredentials(restricted, [credential, api])).toEqual({
      allow: {
        "github.com": [
          {
            match: { path: { exact: "/acme/repo.git/info/refs" }, method: ["GET"] },
            transform: [{ headers: { Authorization: "Basic test", Host: "github.com" } }],
          },
        ],
        "api.github.com": [
          {
            match: {
              path: { startsWith: "/" },
              method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            },
            transform: [{ headers: { Authorization: "Bearer test", Host: "api.github.com" } }],
          },
        ],
      },
    })
  })

  test("keeps unrestricted access only when explicitly requested", () => {
    expect(withRequestCredentials({ mode: "all" }, [credential])).toMatchObject({
      allow: { "*": [] },
    })
    expect(withRequestCredentials({ mode: "all" }, [])).toBe("allow-all")
  })

  test.each([
    [{ origin: "https://evil.com" }, "evil.com is not in the sandbox network"],
    [{ origin: "http://github.com" }, "must be an https:// origin"],
    [{ origin: "https://github.com:444" }, "without path, port or user info"],
    [{ origin: "https://github.com/acme" }, "without path, port or user info"],
    [{ path: "/acme/../other" }, 'must not contain "." or ".." segments'],
    [{ path: "/acme/%2e%2e/other" }, 'must not contain "?", "#", "%"'],
    [{ path: "/acme/repo?secret=x" }, 'must not contain "?", "#", "%"'],
    [{ headers: { Authorization: "secret\r\nHeader: value" } }, "single-line value"],
    [{ headers: { Authorization: "secret", Host: "evil.com" } }, "may only set Authorization"],
  ])("rejects malformed or unapproved destinations: %j", (override, reason) => {
    const attempt = () =>
      withRequestCredentials(
        { mode: "restricted", allow: [{ name: "git", origin: "https://github.com" }] },
        [{ ...credential, ...override }]
      )

    expect(attempt).toThrow(SandboxError)
    expect(attempt).toThrow("[Sandbox] Invalid request credential: ")
    expect(attempt).toThrow(reason)
    // The reason names the broken rule, never the header value.
    expect(attempt).not.toThrow("secret")
  })

  test("cannot add access to a blocked domain", () => {
    expect(() => withRequestCredentials({ mode: "none" }, [credential])).toThrow(
      "the sandbox network allows no domain"
    )
  })

  // Remove the wildcard check in credentialHost to watch this test fail: an `all` network has
  // no allow list that could reject the host first.
  test.each([
    ["https://*", "wildcard hosts are not allowed"],
    ["https://*.github.com", "wildcard hosts are not allowed"],
    // The URL parser decodes the escape, so the origin no longer reads as written.
    ["https://%2A.github.com", "without path, port or user info"],
  ])("rejects a wildcard host even when the network allows every domain: %p", (origin, reason) => {
    const attempt = () => withRequestCredentials({ mode: "all" }, [{ ...api, origin }])

    expect(attempt).toThrow(SandboxError)
    expect(attempt).toThrow(reason)
  })

  // Remove the `endsWith("/")` check in selectPath to watch "/repos" fail here, and the
  // printable-ASCII check in requestPath to watch the tab, DEL and non-ASCII cases fail.
  test.each([
    ["", 'path prefix must end with "/"'],
    ["/repos", 'path prefix must end with "/"'],
    ["repos/", 'path must start with a single "/"'],
    ["//", 'path must start with a single "/"'],
    ["/repos/../", 'must not contain "." or ".." segments'],
    ["/repos/./", 'must not contain "." or ".." segments'],
    ["/repos/%2e%2e/", 'must not contain "?", "#", "%"'],
    ["/repos/?q=x/", 'must not contain "?", "#", "%"'],
    ["/repos/#x/", 'must not contain "?", "#", "%"'],
    ["/repos\\x/", 'must not contain "?", "#", "%"'],
    ["/repos x/", "printable ASCII"],
    ["/repos\tx/", "printable ASCII"],
    ["/repos\x7f/", "printable ASCII"],
    ["/répos/", "printable ASCII"],
  ])("rejects an unsafe path prefix: %p", (prefix, reason) => {
    expect(inject({ ...api, path: { prefix } })).toThrow(SandboxError)
    expect(inject({ ...api, path: { prefix } })).toThrow(reason)
  })

  // Accept any object with a string `prefix` in isPrefixOnly to watch this test fail.
  test("rejects a path object with keys other than prefix", () => {
    const widened = { prefix: "/repos/", exact: "/repos/acme" }
    const empty = {}

    // @ts-expect-error A path object needs `prefix`.
    expect(inject({ ...api, path: empty })).toThrow("object with only `prefix`")
    expect(inject({ ...api, path: widened })).toThrow("object with only `prefix`")
  })

  // Drop any one method check in selectMethods to watch this test fail, and use `method` instead
  // of `Array.from(method)` to watch the sparse list pass: `every` skips holes.
  test("rejects methods outside the contract, and never reads an empty list as any", () => {
    const withMethod = (method: SandboxRequestCredential["method"]) => inject({ ...api, method })
    const sparse: SandboxRequestMethod[] = []
    sparse[1] = "GET"

    expect(withMethod([])).toThrow("method list must not be empty")
    expect(withMethod(["GET", "GET"])).toThrow("method list must not repeat a method")
    expect(withMethod(sparse)).toThrow("method must be one of GET, POST, PUT, PATCH, DELETE")
    // @ts-expect-error HEAD is not an injectable method.
    expect(withMethod("HEAD")).toThrow("method must be one of")
    // @ts-expect-error OPTIONS is not an injectable method.
    expect(withMethod(["OPTIONS"])).toThrow("method must be one of")
    // @ts-expect-error Methods are uppercase.
    expect(withMethod(["get"])).toThrow("method must be one of")

    expect(withMethod("PATCH")).not.toThrow()
  })

  // Return false from overlaps() to watch the overlapping cases pass, and compare exact paths
  // with startsWith to watch the last two unambiguous cases fail.
  test("rejects two credentials that could match the same request", () => {
    const exact: SandboxRequestCredential = {
      ...api,
      path: "/repos/acme/repo/pulls",
      method: "POST",
    }
    const at = (path: SandboxRequestCredential["path"]) => ({
      ...api,
      path,
      method: "GET" as const,
    })

    expect(inject(credential, credential)).toThrow("overlaps another credential on github.com")
    expect(inject(api, exact)).toThrow("overlaps another credential on api.github.com")
    expect(inject(exact, api)).toThrow("overlaps another credential on api.github.com")
    expect(inject(api, at({ prefix: "/repos/" }))).toThrow("overlaps another credential")

    // A method or a path that no other credential selects stays unambiguous.
    expect(inject(credential, { ...credential, method: "POST" })).not.toThrow()
    expect(inject({ ...api, method: "GET" }, { ...exact, method: "POST" })).not.toThrow()
    expect(inject({ ...api, path: { prefix: "/users/" } }, exact)).not.toThrow()
    expect(inject(credential, api)).not.toThrow()
    expect(inject(at("/repos/"), at({ prefix: "/repos/x/" }))).not.toThrow()
    expect(inject(at("/repos"), at("/repos/x"))).not.toThrow()
  })
})

describe("toVercelNetworkPolicy", () => {
  test("maps deny-all (including an empty restricted allow list) and allow-all modes", () => {
    expect(toVercelNetworkPolicy(undefined)).toBe("deny-all")
    expect(toVercelNetworkPolicy({ mode: "none" })).toBe("deny-all")
    expect(toVercelNetworkPolicy({ mode: "restricted", allow: [] })).toBe("deny-all")
    expect(toVercelNetworkPolicy({ mode: "all" })).toBe("allow-all")
  })

  test("maps HTTPS restricted targets to domain allow rules", () => {
    expect(
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [
          { name: "sixb-api", origin: "https://api.example.com:443" },
          { name: "assets", origin: "https://assets.example.com" },
        ],
      })
    ).toEqual({ allow: ["api.example.com", "assets.example.com"] })
  })

  test("maps IP targets to subnet allow rules", () => {
    expect(
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [
          { name: "gateway", origin: "http://10.0.0.5:3002" },
          { name: "v6", origin: "https://[2001:db8::1]:8443" },
        ],
      })
    ).toEqual({ subnets: { allow: ["10.0.0.5/32", "2001:db8::1/128"] } })
  })

  test("rejects loopback targets because Vercel runs remotely", () => {
    expect(() =>
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [{ name: "local", origin: "http://127.0.0.1:3002" }],
      })
    ).toThrow("cannot reach restricted target")
  })

  // Remove the wildcard check in toVercelNetworkPolicy to watch this test fail.
  test.each([
    "https://*",
    "https://*.npmjs.org",
  ])("rejects a wildcard target, which Vercel would read as every matching domain: %p", (origin) => {
    expect(() =>
      toVercelNetworkPolicy({ mode: "restricted", allow: [{ name: "any", origin }] })
    ).toThrow("uses a wildcard host")
  })

  test("rejects plain HTTP hostname targets because Vercel domain filtering is TLS-only", () => {
    expect(() =>
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [{ name: "api", origin: "http://api.example.com" }],
      })
    ).toThrow("plain HTTP")
  })
})

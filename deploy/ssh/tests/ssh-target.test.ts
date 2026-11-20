import { describe, expect, test } from "bun:test"
import { SshTarget, type SshTargetOptions } from "@sixb/deploy-ssh"

describe("SshTarget", () => {
  test("deploys as the account it names, with the live slot on fixed loopback ports", () => {
    const target = new SshTarget({ host: "203.0.113.10", user: "deploy" })

    expect(target.kind).toBe("ssh")
    expect(target.location).toBe("deploy@203.0.113.10")
    expect(target.listenAddress("app")).toEqual({ host: "127.0.0.1", port: 3001 })
    expect(target.listenAddress("api")).toEqual({ host: "127.0.0.1", port: 3002 })
  })

  // Reproduce: default `user` to an account name; SSH then ignores the `User` the config sets.
  test("leaves the account to SSH when it names none", () => {
    expect(new SshTarget({ host: "shop-prod" }).location).toBe("shop-prod")
  })

  test("accepts an IPv6 address", () => {
    expect(new SshTarget({ host: "2001:db8::10", user: "deploy" }).location).toBe(
      "deploy@2001:db8::10"
    )
  })

  test.each([
    ["keeps the user out of host", { host: "deploy@203.0.113.10" }, "includes a user"],
    ["keeps the SSH port out of host", { host: "203.0.113.10:2222" }, "includes a port"],
    [
      "refuses a host ssh would read as an option",
      { host: "-oProxyCommand=touch /tmp/pwned" },
      "is not a hostname or IP address",
    ],
    ["never deploys as root", { user: "root" }, "never run as root"],
    ["refuses what isn't an account name", { user: "Deploy User" }, "is not a Linux account name"],
    ["says why `ports` went", { ports: { api: 3012 } }, "Remove `ports`: a server runs one"],
    ["refuses unknown options", { dir: "/srv/northline" }, "Unknown option 'dir'"],
  ])("%s", (_name, options, message) => {
    const invalid: unknown = { host: "203.0.113.10", ...options }
    expect(() => new SshTarget(invalid as SshTargetOptions)).toThrow(message)
  })
})

import { describe, expect, test } from "bun:test"
import { SshTarget, type SshTargetOptions } from "@sixb/deploy-ssh"

describe("SshTarget", () => {
  test("deploys as sixb, with each HTTP service on its default loopback port", () => {
    const target = new SshTarget({ host: "203.0.113.10" })

    expect(target.kind).toBe("ssh")
    expect(target.location).toBe("sixb@203.0.113.10")
    expect(target.listenAddress("app")).toEqual({ host: "127.0.0.1", port: 3001 })
    expect(target.listenAddress("api")).toEqual({ host: "127.0.0.1", port: 3002 })
  })

  test("takes a walled-off user and ports for a shared server", () => {
    const target = new SshTarget({
      host: "ops.example.com",
      user: "sixb-eastcoast",
      ports: { api: 3032 },
    })

    expect(target.location).toBe("sixb-eastcoast@ops.example.com")
    expect(target.listenAddress("api").port).toBe(3032)
    expect(target.listenAddress("app").port).toBe(3001)
  })

  test("accepts an IPv6 address", () => {
    expect(new SshTarget({ host: "2001:db8::10" }).location).toBe("sixb@2001:db8::10")
  })

  test.each([
    ["never deploys as root", { user: "root" }, "Deployments never run as root"],
    ["keeps the user out of host", { host: "deploy@203.0.113.10" }, "includes a user"],
    ["keeps the SSH port out of host", { host: "203.0.113.10:2222" }, "includes a port"],
    [
      "refuses a host ssh would read as an option",
      { host: "-oProxyCommand=touch /tmp/pwned" },
      "is not a hostname or IP address",
    ],
    ["checks user names", { user: "Sixb" }, "is not a Linux user name"],
    ["checks port ranges", { ports: { api: 80 } }, "ports.api must be a port from 1024"],
    ["checks port services", { ports: { docs: 4000 } }, "ports.docs is not an HTTP service"],
    ["refuses unknown options", { dir: "/srv/northline" }, "Unknown option 'dir'"],
  ])("%s", (_name, options, message) => {
    const invalid: unknown = { host: "203.0.113.10", ...options }
    expect(() => new SshTarget(invalid as SshTargetOptions)).toThrow(message)
  })
})

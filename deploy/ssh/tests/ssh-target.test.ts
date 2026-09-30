import { describe, expect, test } from "bun:test"
import { SshTarget, type SshTargetOptions } from "@sixb/deploy-ssh"

function rejects(options: unknown, message: string): void {
  expect(() => new SshTarget(options as SshTargetOptions)).toThrow(message)
}

describe("SshTarget", () => {
  test("deploys as sixb, with each HTTP service on its default loopback port", () => {
    const target = new SshTarget({ host: "203.0.113.10" })

    expect(target.kind).toBe("ssh")
    expect(target.location).toBe("sixb@203.0.113.10")
    expect(target.listenAddress("atlas")).toEqual({ host: "127.0.0.1", port: 3000 })
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

  test("never deploys as root", () => {
    rejects({ host: "203.0.113.10", user: "root" }, "Deployments never run as root")
  })

  test("keeps the user and the SSH port out of host", () => {
    rejects({ host: "deploy@203.0.113.10" }, "includes a user")
    rejects({ host: "203.0.113.10:2222" }, "includes a port")
  })

  test("refuses a host ssh would read as an option", () => {
    rejects({ host: "-oProxyCommand=touch /tmp/pwned" }, "is not a hostname or IP address")
  })

  test("checks users and ports", () => {
    rejects({ host: "203.0.113.10", user: "Sixb" }, "is not a Linux user name")
    rejects({ host: "203.0.113.10", ports: { api: 80 } }, "ports.api must be a port from 1024")
    rejects({ host: "203.0.113.10", ports: { docs: 4000 } }, "ports.docs is not an HTTP service")
    rejects({ host: "203.0.113.10", dir: "/srv/northline" }, "Unknown option 'dir'")
  })
})

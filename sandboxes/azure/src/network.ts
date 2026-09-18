import { isIP } from "node:net"
import { SandboxError, type SandboxNetworkPolicy } from "@sixb/core/sandboxes"
import type { AzureEgressPolicy } from "./azure-client"

/** Azure's inspected host rules are only used for public HTTPS origins on port 443. */
export function resolveNetwork(policy: SandboxNetworkPolicy | undefined): {
  readonly policy: SandboxNetworkPolicy
  readonly egress: AzureEgressPolicy
} {
  if (policy === undefined || policy.mode === "none") return denyAll()
  if (policy.mode === "all") {
    return {
      policy: { mode: "all" },
      egress: { defaultAction: "Allow", trafficInspection: "None", hostRules: [] },
    }
  }
  if (policy.mode !== "restricted" || !Array.isArray(policy.allow)) {
    throw new SandboxError("[Sandbox] Azure network policy is invalid.")
  }
  if (policy.allow.length === 0) return denyAll()
  const hosts = new Set<string>()
  const allow = policy.allow.map((target) => {
    let url: URL
    try {
      url = new URL(target.origin)
    } catch {
      throw new SandboxError("[Sandbox] Azure restricted targets require a public HTTPS origin.")
    }
    const host = url.hostname
    if (
      isIP(host.replace(/^\[|\]$/g, "")) ||
      !host.includes(".") ||
      /\.(localhost|local|internal|test|invalid)$/.test(host) ||
      !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
      host.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))
    ) {
      throw new SandboxError(
        "[Sandbox] Azure runs remotely; restricted targets require public DNS names, not loopback, private names, IP addresses, or wildcard hosts. Use a public HTTPS gateway."
      )
    }
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new SandboxError(
        "[Sandbox] Azure restricted targets support only HTTPS origins on port 443, without credentials, paths, queries, or fragments."
      )
    }
    hosts.add(host)
    return Object.freeze({ name: target.name, origin: url.origin })
  })
  return {
    policy: Object.freeze({ mode: "restricted", allow: Object.freeze(allow) }),
    egress: {
      defaultAction: "Deny",
      trafficInspection: "Full",
      hostRules: [...hosts].map((pattern) => ({ pattern, action: "Allow" })),
    },
  }
}

function denyAll(): ReturnType<typeof resolveNetwork> {
  return {
    policy: { mode: "none" },
    egress: { defaultAction: "Deny", trafficInspection: "Full", hostRules: [] },
  }
}

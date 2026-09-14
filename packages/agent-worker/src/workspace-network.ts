import { createSixbError } from "@sixb/core/internal/errors"
import type { SandboxNetworkPolicy, SandboxNetworkTarget } from "@sixb/core/sandboxes"

/** Workspace policies extend the required API/repository access, never replace it. */
export function workspaceNetwork(
  policy: unknown,
  apiOrigin: string,
  repositoryOrigin: string
): SandboxNetworkPolicy {
  const invalid = () =>
    createSixbError(
      "agent.execution_failed",
      "[SixbAgentWorker] Workspace network must be none, all, or restricted with named HTTP(S) origins."
    )
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  const allow: SandboxNetworkTarget[] = [
    { name: "sixb-api", origin: apiOrigin },
    { name: "workspace-repository", origin: repositoryOrigin },
  ]
  if (policy !== undefined) {
    if (!record(policy)) throw invalid()
    if (policy.mode === "all" || policy.mode === "none") {
      if (Object.keys(policy).some((key) => key !== "mode")) throw invalid()
      if (policy.mode === "all") return { mode: "all" }
    } else if (policy.mode === "restricted") {
      if (
        Object.keys(policy).some((key) => key !== "mode" && key !== "allow") ||
        !Array.isArray(policy.allow)
      )
        throw invalid()
      for (const target of policy.allow) {
        if (
          !record(target) ||
          Object.keys(target).some((key) => key !== "name" && key !== "origin") ||
          typeof target.name !== "string" ||
          !target.name.trim() ||
          typeof target.origin !== "string"
        )
          throw invalid()
        let url: URL
        try {
          url = new URL(target.origin)
        } catch {
          throw invalid()
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw invalid()
        allow.push({ name: target.name, origin: url.origin })
      }
    } else {
      throw invalid()
    }
  }
  return {
    mode: "restricted",
    allow: allow.filter(
      (target, index) => allow.findIndex((item) => item.origin === target.origin) === index
    ),
  }
}

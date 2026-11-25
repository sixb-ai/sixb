import type { SixbHostView } from "../runtime/host"
import { isBranchHostingStorage } from "./data"

/** Why production cannot run branches yet: what the Console says, and the worker refuses. */
export interface BranchesUnavailable {
  readonly code: "storage" | "source" | "sandboxes" | "sandbox-shares-host" | "sandbox-env"
  /** What is missing, said as the rest of a sentence that starts with "Branches need…". */
  readonly message: string
}

/**
 * What production lacks to run its git branches, or null when it has it all: PostgreSQL storage,
 * the project's repository, and a sandbox that keeps a branch away from production.
 */
export function branchesUnavailable(
  host: Pick<
    SixbHostView,
    "storage" | "source" | "sandboxes" | "sandboxDefinition" | "sandboxRecipeEnv"
  >,
  environment: string | undefined = process.env.NODE_ENV
): BranchesUnavailable | null {
  if (!host.storage.hostedBranches || !isBranchHostingStorage(host.storage)) {
    return {
      code: "storage",
      message: "@sixb/pg for production's storage: branches live on its instance",
    }
  }
  if (!host.source) {
    return {
      code: "source",
      message: "the project's repository: name it with createSixb({ source: { repository } })",
    }
  }
  if (!host.sandboxes) {
    return {
      code: "sandboxes",
      message: "a sandbox factory: pass one to createSixb({ sandboxes })",
    }
  }
  if (!host.sandboxes.runsBranches) {
    return {
      code: "sandboxes",
      message:
        "a sandbox provider that runs branches, serving their ports: @sixb/sandboxes-vercel or @sixb/sandboxes-smolvm",
    }
  }
  if (host.sandboxDefinition?.auth && host.sandboxes.forwardsRequestCredentials) {
    return {
      code: "sandboxes",
      message:
        "a sandbox provider whose commands carry the source's credentials themselves to clone a private repository: this one hands them to a forwarder git does not use. Use @sixb/sandboxes-vercel, or drop the sandbox factory's auth for a public repository",
    }
  }
  if (host.sandboxes.resume && (!host.sandboxes.destroy || !host.sandboxes.stop)) {
    return {
      code: "sandboxes",
      message:
        "a sandbox provider that stops and deletes a saved sandbox by name (stop, destroy), as it resumes them: a branch's sandbox goes with the branch, and a dead worker's session is stopped",
    }
  }
  if (environment === "production" && host.sandboxes.sharesHost) {
    return {
      code: "sandbox-shares-host",
      message:
        "a sandbox that keeps branches from this host's network and files in production: use @sixb/sandboxes-vercel or @sixb/sandboxes-smolvm, as @sixb/sandboxes-local runs a branch on this host itself",
    }
  }
  if (host.sandboxRecipeEnv.length > 0) {
    return {
      code: "sandbox-env",
      message: `a sandbox recipe without env (it sets ${host.sandboxRecipeEnv.join(", ")}): its provider gives that env to every sandbox, a branch's too, and a branch runs only with the project's dev values`,
    }
  }
  return null
}

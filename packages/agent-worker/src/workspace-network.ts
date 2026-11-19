import { FRAME_CDN_ALLOWLIST } from "@sixb/core/internal/artifacts/frames"
import { createSixbError } from "@sixb/core/internal/errors"
import type { SandboxNetworkPolicy, SandboxNetworkTarget } from "@sixb/core/sandboxes"

/**
 * The CDNs an artifact's frame loads its libraries, stylesheets and fonts from, as a render sandbox
 * reaches them: a run reaches them by default, so that what it checks in its sandbox, a video's
 * motion and a deck's fonts, is what the app and the export show.
 */
export const FRAME_CDN_TARGETS: readonly SandboxNetworkTarget[] = FRAME_CDN_ALLOWLIST.map(
  (origin) => ({ name: new URL(origin).hostname, origin })
)

/**
 * The network of an agent run sandbox. Sixb always adds what the run needs: its API, the
 * repository the agent clones, fetches and pushes, and the origins source auth issues credentials
 * for. Without a policy, the run also reaches the frame CDNs; a restricted policy lists only what
 * the project adds on top, and leaves them out unless it lists them; `all` already covers them.
 */
export function workspaceNetwork(
  policy: SandboxNetworkPolicy | undefined,
  apiOrigin: string,
  repositoryOrigin?: string,
  credentialOrigins: readonly string[] = []
): SandboxNetworkPolicy {
  if (policy?.mode === "all") return policy

  if (policy?.mode === "none") {
    throw createSixbError(
      "agent.execution_failed",
      '[SixbAgentWorker] Sandbox network mode "none" cannot run an agent: the agent needs the Sixb API. Use { mode: "restricted", allow: [...] } with the origins the project needs; Sixb adds its own.'
    )
  }

  const required: SandboxNetworkTarget[] = [
    { name: "sixb-api", origin: apiOrigin },
    ...(repositoryOrigin ? [{ name: "workspace-repository", origin: repositoryOrigin }] : []),
    ...credentialOrigins.map((origin) => ({ name: "workspace-auth", origin })),
  ]

  // Project targets come first: an origin the project already lists keeps the project's name.
  const allow = policy ? [...policy.allow, ...required] : [...required, ...FRAME_CDN_TARGETS]

  return {
    mode: "restricted",
    allow: allow.filter(
      (target, index) => allow.findIndex((item) => item.origin === target.origin) === index
    ),
  }
}

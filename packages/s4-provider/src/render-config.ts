/**
 * Renders the canonical `s4.config.ts` source that wires S4 against a Pario
 * server. This is the single source of truth for the Pario/S4 wiring shape.
 *
 * Consumers write the returned string to a file and point `S4_CONFIG` at it:
 *
 * - `images/agent-runner/Dockerfile` bakes it at `/etc/s4.config.ts`
 * - `SmolVmSandboxFactory` overlays it at `/workspace/s4.config.ts` per-run
 * - `LocalSandboxFactory` writes it to a per-sandbox tmp dir on the host
 *
 * The rendered config reads `PARIO_API_URL` and `PARIO_RUN_TOKEN` from env, so
 * per-run state (base URL, auth) is pushed by the factory at `sandbox.create()`
 * time; no rebuild needed.
 */
export interface RenderParioS4ConfigOptions {
  readonly mountPath?: string
  readonly defaultBaseUrl?: string
}

export const DEFAULT_PARIO_S4_MOUNT_PATH = "/pario"
export const DEFAULT_PARIO_S4_BASE_URL = "http://127.0.0.1:3000"

export function renderParioS4ConfigSource(options: RenderParioS4ConfigOptions = {}): string {
  const mountPath = options.mountPath ?? DEFAULT_PARIO_S4_MOUNT_PATH
  const defaultBaseUrl = options.defaultBaseUrl ?? DEFAULT_PARIO_S4_BASE_URL
  return `import { createParioRemoteS4Provider } from "@pario/s4-provider"
import { mount } from "@s4/runtime"

export default {
  mounts: [
    mount(${JSON.stringify(mountPath)}, createParioRemoteS4Provider({
      baseUrl: process.env.PARIO_API_URL ?? ${JSON.stringify(defaultBaseUrl)},
      headers: process.env.PARIO_RUN_TOKEN
        ? { authorization: \`Bearer \${process.env.PARIO_RUN_TOKEN}\` }
        : undefined,
    })),
  ],
}
`
}

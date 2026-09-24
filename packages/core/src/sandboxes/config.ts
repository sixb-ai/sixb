import type { ParamsConfig } from "../shared/params/types"
import { captureEnvironment, type SandboxConfig } from "./configuration"
import { SandboxError } from "./errors"

/** Extract only the common recipe; provider credentials and infrastructure stay on the factory. */
export function sandboxConfig<TParams extends ParamsConfig>(
  options: SandboxConfig<TParams>
): SandboxConfig<TParams> {
  if (options.params !== undefined && options.resolve === undefined) {
    throw new SandboxError("[Sixb] Sandbox params require a resolve function.")
  }
  if (options.resolve !== undefined && typeof options.resolve !== "function") {
    throw new SandboxError("[Sixb] Sandbox resolve must be a function.")
  }
  if (
    options.resolve !== undefined &&
    (options.source !== undefined || options.setup !== undefined)
  ) {
    throw new SandboxError("[Sixb] Use either static source/setup or resolve, not both.")
  }
  const environment = captureEnvironment({
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.network === undefined ? {} : { network: options.network }),
  })
  return Object.freeze({
    ...environment,
    ...(options.params === undefined ? {} : { params: structuredClone(options.params) }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
  })
}

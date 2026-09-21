import type { ParamsConfig } from "../shared/params/types"
import type { SandboxConfig } from "./configuration"

/** Extract only the common recipe; provider credentials and infrastructure stay on the factory. */
export function sandboxConfig<TParams extends ParamsConfig>(
  options: SandboxConfig<TParams>
): SandboxConfig<TParams> {
  return {
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.network === undefined ? {} : { network: options.network }),
  }
}

import type { S4Provider } from "@s4/core"
import { createParioS4Api } from "./api"
import { createParioS4RouteProvider } from "./routes/index"
import type { CreateParioRemoteS4ProviderOptions } from "./types"

export function createParioRemoteS4Provider(
  options: CreateParioRemoteS4ProviderOptions
): S4Provider {
  return createParioS4RouteProvider(createParioS4Api(options))
}

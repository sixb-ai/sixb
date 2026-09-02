import type { SixbApiClientConfig } from "./api-client"
import { type ResolveProfileInput, resolveProfile } from "./profiles"

export interface ResolveProfileApiClientConfigOptions extends ResolveProfileInput {}

export async function resolveProfileApiClientConfig(
  options: ResolveProfileApiClientConfigOptions = {}
): Promise<SixbApiClientConfig> {
  const resolved = await resolveProfile(options)

  return {
    apiUrl: resolved.apiUrl,
    apiUrlSource: formatApiUrlSource(resolved),
    ...(resolved.token
      ? {
          token: resolved.token,
          tokenSource: resolved.tokenSource ?? "profile",
        }
      : {}),
  }
}

function formatApiUrlSource(resolved: Awaited<ReturnType<typeof resolveProfile>>): string {
  switch (resolved.source) {
    case "api-url-flag":
      return "--api-url"
    case "profile-flag":
      return `profile:${resolved.profile}`
    case "environment":
      return "SIXB_API_URL"
    case "profile-environment":
      return `SIXB_PROFILE:${resolved.profile}`
    case "current-profile":
      return `profile:${resolved.profile}`
    case "default":
      return "default"
  }
}

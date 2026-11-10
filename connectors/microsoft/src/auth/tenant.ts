import { MicrosoftConfigurationError } from "../errors"

/** The shared `common`, `organizations` and `consumers` authorities would admit any tenant. */
export function assertSpecificTenant(tenantId: string): string {
  if (
    !/^[a-zA-Z0-9.-]+$/.test(tenantId) ||
    ["common", "organizations", "consumers", ".", ".."].includes(tenantId.toLowerCase())
  ) {
    throw new MicrosoftConfigurationError(
      "tenantId must identify a specific tenant (GUID or verified domain)."
    )
  }
  return tenantId
}

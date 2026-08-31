import type { ConnectorAccountCandidate } from "@sixb/core"
import type { LinkedinHttp } from "./http"
import { createAdAccountUsersResource } from "./resources/ad-account-users"
import { createAdAccountsResource } from "./resources/ad-accounts"
import { createOrganizationAclsResource } from "./resources/organization-acls"
import { createOrganizationsResource } from "./resources/organizations"
import type { LinkedinConnectedAccount } from "./types/client"
import type { LinkedinOrganizationUrn, LinkedinSponsoredAccountUrn } from "./types/common"
import type { LinkedinAccountType } from "./types/options"

export async function discoverLinkedinAccounts(
  accountType: LinkedinAccountType,
  http: LinkedinHttp
): Promise<readonly ConnectorAccountCandidate[]> {
  return accountType === "organization" ? discoverOrganizations(http) : discoverAdAccounts(http)
}

export function connectedLinkedinAccount(
  accountType: LinkedinAccountType,
  account: ConnectorAccountCandidate
): LinkedinConnectedAccount {
  if (accountType === "organization") {
    assertUrn(account.id, "urn:li:organization:", "organization")
    return accountMetadata(accountType, account.id as LinkedinOrganizationUrn, account)
  }
  assertUrn(account.id, "urn:li:sponsoredAccount:", "ad account")
  return accountMetadata(accountType, account.id as LinkedinSponsoredAccountUrn, account)
}

export function assertDiscoveryScopes(
  accountType: LinkedinAccountType,
  scopes: readonly string[]
): void {
  if (accountType !== "organization" && accountType !== "ad-account") {
    throw new Error("[SixbLinkedin] accountType must be 'organization' or 'ad-account'.")
  }
  const accepted = accountType === "organization" ? ["rw_organization_admin"] : ["r_ads", "rw_ads"]
  if (!accepted.some((scope) => scopes.includes(scope))) {
    throw new Error(
      accountType === "organization"
        ? "[SixbLinkedin] organization account discovery requires rw_organization_admin."
        : "[SixbLinkedin] ad-account discovery requires r_ads or rw_ads."
    )
  }
}

async function discoverOrganizations(http: LinkedinHttp): Promise<ConnectorAccountCandidate[]> {
  const acls = createOrganizationAclsResource(http)
  const organizations = createOrganizationsResource(http)
  const urns = new Set<LinkedinOrganizationUrn>()
  for await (const acl of acls.listAllForAuthenticatedMember({ state: "APPROVED" })) {
    const urn = acl.organizationTarget ?? acl.organization
    if (urn) urns.add(urn)
  }

  const accounts: ConnectorAccountCandidate[] = []
  for (const urn of urns) {
    const organization = await organizations.get(numericUrnId(urn, "urn:li:organization:"))
    accounts.push({
      id: urn,
      label: organization.localizedName ?? localizedValue(organization.name) ?? urn,
      description: organization.vanityName
        ? `LinkedIn Page · linkedin.com/company/${organization.vanityName}`
        : "LinkedIn Page",
    })
  }
  return accounts
}

async function discoverAdAccounts(http: LinkedinHttp): Promise<ConnectorAccountCandidate[]> {
  const users = createAdAccountUsersResource(http)
  const adAccounts = createAdAccountsResource(http)
  const urns = new Set<LinkedinSponsoredAccountUrn>()
  for await (const user of users.listAllByAuthenticatedUser()) urns.add(user.account)

  const accounts: ConnectorAccountCandidate[] = []
  for (const urn of urns) {
    const account = await adAccounts.get(numericUrnId(urn, "urn:li:sponsoredAccount:"))
    accounts.push({
      id: urn,
      label: account.name,
      description: ["LinkedIn ad account", account.status, account.currency]
        .filter(Boolean)
        .join(" · "),
    })
  }
  return accounts
}

function localizedValue(
  value: { readonly localized: Readonly<Record<string, string>> } | undefined
) {
  return value ? Object.values(value.localized)[0] : undefined
}

function numericUrnId(urn: string, prefix: string): string {
  assertUrn(urn, prefix, "account")
  return urn.slice(prefix.length)
}

function assertUrn(value: string, prefix: string, field: string): void {
  const id = value.startsWith(prefix) ? value.slice(prefix.length) : ""
  if (!/^\d+$/.test(id) || id === "0") {
    throw new Error(`[SixbLinkedin] selected ${field} has an invalid LinkedIn URN.`)
  }
}

function accountMetadata<TType extends LinkedinAccountType, TId extends string>(
  type: TType,
  id: TId,
  account: ConnectorAccountCandidate
) {
  return {
    type,
    id,
    label: account.label,
    ...(account.description === undefined ? {} : { description: account.description }),
    ...(account.avatarUrl === undefined ? {} : { avatarUrl: account.avatarUrl }),
  }
}

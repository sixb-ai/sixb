import { writeJson } from "@sixb/cli-core"
import {
  createAuthServiceAccount,
  createAuthServiceAccountAccessToken,
  disableAuthServiceAccount,
  type ListAuthServiceAccountsResponse,
  listAuthServiceAccountAccessTokens,
  listAuthServiceAccounts,
  revokeAuthServiceAccountAccessToken,
} from "@sixb/client"
import { createCliSixbClient, unwrapSixbApiResult } from "../lib/api-client"
import { resolveProfileApiClientConfig } from "../lib/profile-api-client"
import { KeyValueResultView, renderStatic, SecretResultView, TableResultView } from "../ui"
import {
  formatDate,
  formatGroups,
  normalizeGroupIds,
  resolveExpiration,
} from "./access-token-utils"

type ServiceAccount = ListAuthServiceAccountsResponse["serviceAccounts"][number]

export interface ServiceAccountCommandOptions {
  readonly positionals?: readonly string[]
  readonly apiUrl?: string
  readonly token?: string
  readonly profile?: string
  readonly id?: string
  readonly name?: string
  readonly description?: string
  readonly expiresAt?: string
  readonly expiresIn?: string
  readonly groupIds?: readonly string[]
  readonly json?: boolean
}

export async function runServiceAccount(options: ServiceAccountCommandOptions = {}) {
  const command = options.positionals?.[0]
  if (command === "token") {
    await runServiceAccountToken(options)
    return
  }

  if (command === "list") {
    await listServiceAccounts(options)
    return
  }

  if (command === "create") {
    await createServiceAccount(options)
    return
  }

  if (command === "disable") {
    await disableServiceAccount(options)
    return
  }

  throw new Error("Usage: sixb service-account <list|create|disable|token>")
}

async function listServiceAccounts(options: ServiceAccountCommandOptions) {
  const client = createCliSixbClient(await resolveProfileApiClientConfig(options))
  const result = unwrapSixbApiResult(await listAuthServiceAccounts({ client }))

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <TableResultView
      title="Service accounts"
      subtitle={`${result.serviceAccounts.length} visible`}
      headers={["Name", "ID", "Status", "Groups", "Updated"]}
      rows={result.serviceAccounts.map(serviceAccountRow)}
      emptyMessage="No service accounts."
    />
  )
}

async function createServiceAccount(options: ServiceAccountCommandOptions) {
  const name = options.name?.trim() || options.positionals?.[1]?.trim()
  if (!name) {
    throw new Error("Usage: sixb service-account create --name <name> [--id <id>] [--group <id>]")
  }

  const id = options.id?.trim()
  const description = options.description?.trim()
  const groupIds = normalizeGroupIds(options.groupIds)
  const client = createCliSixbClient(await resolveProfileApiClientConfig(options))
  const result = unwrapSixbApiResult(
    await createAuthServiceAccount({
      client,
      body: {
        ...(id ? { id } : {}),
        name,
        ...(description ? { description } : {}),
        ...(groupIds.length > 0 ? { groupIds } : {}),
      },
    })
  )

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <KeyValueResultView
      title="Created service account"
      items={[
        { label: "Name", value: result.serviceAccount.name },
        { label: "ID", value: result.serviceAccount.id },
        { label: "Status", value: result.serviceAccount.status },
        { label: "Groups", value: formatGroups(result.serviceAccount.groupIds) },
      ]}
    />
  )
}

async function disableServiceAccount(options: ServiceAccountCommandOptions) {
  const serviceAccountId = options.id?.trim() || options.positionals?.[1]?.trim()
  if (!serviceAccountId) {
    throw new Error("Usage: sixb service-account disable <service-account-id>")
  }

  const client = createCliSixbClient(await resolveProfileApiClientConfig(options))
  const result = unwrapSixbApiResult(
    await disableAuthServiceAccount({
      client,
      path: { serviceAccountId },
    })
  )

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <KeyValueResultView
      title="Disabled service account"
      items={[
        { label: "Name", value: result.serviceAccount.name },
        { label: "ID", value: result.serviceAccount.id },
        { label: "Status", value: result.serviceAccount.status },
      ]}
    />
  )
}

async function runServiceAccountToken(options: ServiceAccountCommandOptions) {
  const action = options.positionals?.[1]
  if (action === "list") {
    await listServiceAccountTokens(options)
    return
  }

  if (action === "create") {
    await createServiceAccountToken(options)
    return
  }

  if (action === "revoke") {
    await revokeServiceAccountToken(options)
    return
  }

  throw new Error("Usage: sixb service-account token <list|create|revoke> <service-account-id>")
}

async function listServiceAccountTokens(options: ServiceAccountCommandOptions) {
  const serviceAccountId = requireServiceAccountId(
    options,
    "Usage: sixb service-account token list <service-account-id>"
  )
  const client = createCliSixbClient(await resolveProfileApiClientConfig(options))
  const result = unwrapSixbApiResult(
    await listAuthServiceAccountAccessTokens({
      client,
      path: { serviceAccountId },
    })
  )

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <TableResultView
      title="Service-account tokens"
      subtitle={serviceAccountId}
      headers={["Name", "ID", "Status", "Groups", "Last used", "Expires"]}
      rows={result.accessTokens.map((token) => [
        token.name,
        token.id,
        token.status,
        formatGroups(token.groupIds),
        formatDate(token.lastUsedAt),
        formatDate(token.expiresAt),
      ])}
      emptyMessage="No service-account tokens."
    />
  )
}

async function createServiceAccountToken(options: ServiceAccountCommandOptions) {
  const serviceAccountId = requireServiceAccountId(
    options,
    "Usage: sixb service-account token create <service-account-id> --name <name>"
  )
  const name = options.name?.trim() || options.positionals?.[3]?.trim()
  if (!name) {
    throw new Error("Usage: sixb service-account token create <service-account-id> --name <name>")
  }

  const expiresAt = resolveExpiration(options)
  const groupIds = normalizeGroupIds(options.groupIds)
  const client = createCliSixbClient(await resolveProfileApiClientConfig(options))
  const result = unwrapSixbApiResult(
    await createAuthServiceAccountAccessToken({
      client,
      path: { serviceAccountId },
      body: {
        name,
        expiresAt,
        ...(groupIds.length > 0 ? { groupIds } : {}),
      },
    })
  )

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <SecretResultView
      title="Created service-account token"
      subtitle={serviceAccountId}
      items={[
        { label: "Name", value: result.accessToken.name },
        { label: "ID", value: result.accessToken.id },
        { label: "Expires", value: formatDate(result.accessToken.expiresAt) },
        { label: "Groups", value: formatGroups(result.accessToken.groupIds) },
      ]}
      secret={result.tokenValue}
    />
  )
}

async function revokeServiceAccountToken(options: ServiceAccountCommandOptions) {
  const serviceAccountId = requireServiceAccountId(
    options,
    "Usage: sixb service-account token revoke <service-account-id> <token-id>"
  )
  const tokenId = options.id?.trim() || options.positionals?.[3]?.trim()
  if (!tokenId) {
    throw new Error("Usage: sixb service-account token revoke <service-account-id> <token-id>")
  }

  const client = createCliSixbClient(await resolveProfileApiClientConfig(options))
  const result = unwrapSixbApiResult(
    await revokeAuthServiceAccountAccessToken({
      client,
      path: { serviceAccountId, tokenId },
    })
  )

  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <KeyValueResultView
      title="Revoked service-account token"
      subtitle={serviceAccountId}
      items={[
        { label: "Name", value: result.accessToken.name },
        { label: "ID", value: result.accessToken.id },
        { label: "Status", value: result.accessToken.status },
      ]}
    />
  )
}

function requireServiceAccountId(options: ServiceAccountCommandOptions, usage: string): string {
  const serviceAccountId = options.positionals?.[2]?.trim()
  if (!serviceAccountId) {
    throw new Error(usage)
  }

  return serviceAccountId
}

function serviceAccountRow(serviceAccount: ServiceAccount): readonly string[] {
  return [
    serviceAccount.name,
    serviceAccount.id,
    serviceAccount.status,
    formatGroups(serviceAccount.groupIds),
    formatDate(serviceAccount.updatedAt),
  ]
}

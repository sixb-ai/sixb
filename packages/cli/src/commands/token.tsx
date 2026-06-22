import {
  createAuthPersonalAccessToken,
  listAuthAccessTokens,
  revokeAuthAccessToken,
} from "@sixb/client"
import { createCliSixbClient, resolveApiClientConfig, unwrapSixbApiResult } from "../lib/api-client"
import { KeyValueResultView, renderStatic, SecretResultView, TableResultView } from "../ui"
import {
  formatDate,
  formatGroups,
  normalizeGroupIds,
  resolveExpiration,
} from "./access-token-utils"

export interface TokenCommandOptions {
  readonly action?: string
  readonly positionals?: readonly string[]
  readonly apiUrl?: string
  readonly token?: string
  readonly id?: string
  readonly name?: string
  readonly expiresAt?: string
  readonly expiresIn?: string
  readonly groupIds?: readonly string[]
  readonly json?: boolean
}

export async function runToken(options: TokenCommandOptions = {}) {
  const action = options.action ?? "list"
  if (action === "list") {
    await listTokens(options)
    return
  }

  if (action === "create") {
    await createToken(options)
    return
  }

  if (action === "revoke") {
    await revokeToken(options)
    return
  }

  throw new Error("Usage: sixb token <list|create|revoke>")
}

async function listTokens(options: TokenCommandOptions) {
  const client = createCliSixbClient(resolveApiClientConfig(options))
  const result = unwrapSixbApiResult(await listAuthAccessTokens({ client }))

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  await renderStatic(
    <TableResultView
      title="Personal access tokens"
      subtitle={`${result.accessTokens.length} visible`}
      headers={["Name", "ID", "Status", "Groups", "Last used", "Expires"]}
      rows={result.accessTokens.map((token) => [
        token.name,
        token.id,
        token.status,
        formatGroups(token.groupIds),
        formatDate(token.lastUsedAt),
        formatDate(token.expiresAt),
      ])}
      emptyMessage="No personal access tokens."
    />
  )
}

async function createToken(options: TokenCommandOptions) {
  const name = options.name?.trim() || options.positionals?.[1]?.trim()
  if (!name) {
    throw new Error("Usage: sixb token create --name <name> [--expires-in 90d] [--group <id>]")
  }

  const expiresAt = resolveExpiration(options)
  const groupIds = normalizeGroupIds(options.groupIds)
  const client = createCliSixbClient(resolveApiClientConfig(options))
  const result = unwrapSixbApiResult(
    await createAuthPersonalAccessToken({
      client,
      body: {
        name,
        expiresAt,
        ...(groupIds.length > 0 ? { groupIds } : {}),
      },
    })
  )

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  await renderStatic(
    <SecretResultView
      title="Created personal access token"
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

async function revokeToken(options: TokenCommandOptions) {
  const tokenId = options.id?.trim() || options.positionals?.[1]?.trim()
  if (!tokenId) {
    throw new Error("Usage: sixb token revoke <token-id>")
  }

  const client = createCliSixbClient(resolveApiClientConfig(options))
  const result = unwrapSixbApiResult(
    await revokeAuthAccessToken({
      client,
      path: { tokenId },
    })
  )

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  await renderStatic(
    <KeyValueResultView
      title="Revoked personal access token"
      items={[
        { label: "Name", value: result.accessToken.name },
        { label: "ID", value: result.accessToken.id },
        { label: "Status", value: result.accessToken.status },
      ]}
    />
  )
}

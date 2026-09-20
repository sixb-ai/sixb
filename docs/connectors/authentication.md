# Authentication

Use environment variables for API keys and service accounts. Use OAuth when users connect their own accounts.

## API keys

Keep secrets on the backend. For a REST API, resolve the header when each request is sent:

```ts
rest({
  baseUrl: "https://api.example.com",
  headers: () => ({ authorization: `Bearer ${process.env.API_TOKEN}` }),
})
```

## Define an OAuth connector

For OAuth, Sixb owns state, PKCE, encrypted credentials, refresh coordination, and account
selection. The adapter owns the provider protocol and the client exposed to application code.

```ts
import { defineConnector } from "@sixb/core"

export const socialConnector = defineConnector("social", {
  type: "social",
  authentication: {
    type: "oauth2",
    authorizationUrl(context, { state, codeChallenge, codeChallengeMethod }) {
      const url = new URL("https://social.example/oauth/authorize")
      url.searchParams.set("redirect_uri", context.redirectUri)
      url.searchParams.set("state", state)
      if (codeChallenge !== undefined && codeChallengeMethod !== undefined) {
        url.searchParams.set("code_challenge", codeChallenge)
        url.searchParams.set("code_challenge_method", codeChallengeMethod)
      }
      return url
    },
    exchangeCode(context, input) {
      return exchangeSocialCode({
        ...input,
        redirectUri: context.redirectUri,
        signal: context.signal,
      })
    },
    refresh(context, credentials) {
      return refreshSocialToken(credentials, { signal: context.signal })
    },
    revoke(context, credentials) {
      return revokeSocialGrant(credentials, { signal: context.signal })
    },
  },
  discoverAccounts(context, credentials) {
    return listSocialAccounts(credentials, { signal: context.signal })
  },
  connect({ account, tokenSource, signal }) {
    return {
      async request(path: string) {
        const token = await tokenSource.get()
        const response = await fetch(`https://social.example/accounts/${account.id}/${path}`, {
          headers: { authorization: `${token.tokenType ?? "Bearer"} ${token.accessToken}` },
          signal,
        })
        if (response.status === 401) token.invalidate()
        return response
      },
    }
  },
})
```

Trusted primitive executions resolve one stable project connection by its application-defined
slot:

```ts
const social = await sixb.connector(socialConnector, {
  owner: { type: "project" },
  slot: "organic-marketing",
})
```

Each returned token invalidates only its own credential revision, so a late `401` cannot refresh a
newer token. Provider failures that affect a grant can be classified explicitly:

| `ConnectorOAuthError` kind | Use when |
| --- | --- |
| `retryable` | The adapter guarantees that the provider made no external change. |
| `terminal` | The provider definitively rejected the grant or credential. |
| `ambiguous` | The provider may have changed state, or the adapter cannot prove otherwise. |

Unclassified errors are treated as `ambiguous` and fail closed. Throw, for example,
`new ConnectorOAuthError("retryable", "Social provider is unavailable", { cause })` only when
retrying the unchanged operation is safe. `revoke()` must be idempotent: an already revoked or
invalid grant resolves successfully.

Managing an OAuth connection requires an authenticated request whose role grants the connector:

```ts
can.manage(socialConnector)
// or: can.manage(every.connector())
```

Syncs automatically read every connected account for an OAuth connector. The handler receives
non-secret connection metadata through `context.connection`; no connection selector is required
in the Sync definition. See [OAuth connector fan-out](../syncs/overview.md#oauth-connector-fan-out).

OAuth webhooks can resolve connected accounts inside their handler. See [Managed OAuth webhooks](webhooks.md#managed-oauth-webhooks).

## Provider-specific OAuth options

PKCE defaults to S256. Disable it explicitly for providers whose OAuth flow does not support it:

```ts
authentication: {
  type: "oauth2",
  pkce: "disabled",
  // authorizationUrl, exchangeCode, refresh, and revoke as above.
},
```

Restart any in-flight authorization after changing this setting.

### Callback parameters

Declare the extra callback parameters your provider returns. Store grant-specific data in
`authorizationContext` for account discovery, refresh, and revocation.

```ts
authentication: {
  type: "oauth2",
  callbackParameters: ["tenant"],
  // Other OAuth methods as above.
  async exchangeCode(context, input) {
    const tenant = input.callbackParameters?.tenant
    if (!tenant) throw new Error("[Acme] OAuth callback is missing its tenant.")

    const credentials = await exchangeAcmeCode(context, input)
    return {
      ...credentials,
      authorizationContext: { tenant },
    }
  },
},
async discoverAccounts(context, credentials) {
  const tenant = credentials.authorizationContext?.tenant
  if (typeof tenant !== "string") throw new Error("[Acme] Missing tenant context.")

  // Verify access with the provider before offering the account.
  const account = await getAcmeTenant(credentials, tenant, { signal: context.signal })
  return [{ id: account.id, label: account.name }]
},
```

Sixb forwards only declared parameters and rejects duplicate values. The adapter validates required
values; OAuth fields such as `state`, `code`, and `error` remain framework-owned.

`authorizationContext` must be a JSON object; it is stored securely with the credentials.

- **Refresh:** omit context to preserve it, return an object to replace it, or `{}` to clear it.
- **Reauthorization:** uses fresh context and verifies that existing connected accounts remain available.

## Protect OAuth credentials

When at least one OAuth connector uses durable connector storage, Sixb encrypts its tokens at rest.
`SqliteStorage` and `PostgresStorage` provide that durable storage automatically. Provide the
canonical base64url encoding of 32 random bytes through `createSixb()`:

```ts
const connectorEncryptionKey = process.env.SIXB_CONNECTOR_ENCRYPTION_KEY

if (!connectorEncryptionKey) {
  throw new Error("[SixbConfig] SIXB_CONNECTOR_ENCRYPTION_KEY is required")
}

export const sixb = createSixb({
  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL }),
  connectorConnections: { encryptionKey: connectorEncryptionKey },
})
```

The storage provider owns persistence; `connectorConnections` only configures credential
protection. Static connectors still require neither.

Generate the value once, then store it in the deployment's secret manager:

```bash
bun -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"))'
```

Every process sharing the same connector database must receive the same key. Do not commit,
replace, or lose it: existing OAuth credentials would become unreadable.

Static connectors do not need this setting. It can also be omitted with ephemeral connector
storage, where both the stored credentials and Sixb's process-local protection disappear on
restart.

## Connect an OAuth account from an app

Sixb owns the OAuth callback, state, PKCE exchange, durable run, and lifecycle transitions. The
application keeps control of its interface through one headless hook:

```tsx
import { useConnectorConnection } from "@sixb/client/hooks"

export function SocialConnection() {
  const social = useConnectorConnection({
    connectorId: "social",
    slot: "organic-marketing",
  })

  return (
    <>
      <button onClick={social.connect} disabled={!social.canConnect}>
        {social.connection?.account.label ?? "Connect social account"}
      </button>

      {social.status === "selecting_account" &&
        social.accounts.map((account) => (
          <button key={account.id} onClick={() => social.selectAccount(account.id)}>
            {account.label}
          </button>
        ))}
    </>
  )
}
```

`slot` is the stable application role filled by the connection, not the provider account id. For
example, `organic-marketing`, `customer-support`, or `brand-france` can each resolve a different
account later through `sixb.connector(...)`. Project ownership is implicit in V1.

Register this server-owned callback URL with the OAuth provider:

```text
https://<sixb-api-origin>/auth/connectors/callback
```

By default, OAuth returns to the current page while preserving unrelated query parameters and the
URL hash. Keep the hook mounted there: it resumes the run from the non-secret callback identity and
exposes `selecting_account` when the application must present provider accounts. The hook also
exposes `disconnect()`, `revoke()`, and `needs_reauthorization`; Sixb imposes the protocol, not its
visual representation.

Selecting an account for an occupied slot returns a replacement conflict. Detect it with
`isConnectorReplacementRequired(connection.error?.cause)`, ask for confirmation in the
application, then retry with `selectAccount(accountId, { replace: true })`.

To expose another account from the same OAuth grant, start a selection run from an existing
connection. The provider authorization is not repeated:

```tsx
import { useAddConnectorConnection } from "@sixb/client/hooks"

const addAccount = useAddConnectorConnection({
  connectorId: "social",
  fromConnectionId: socialConnection.id,
  slot: "paid-marketing",
})

addAccount.mutate()
```

The returned run is already waiting for `account_selection`. Use `useConnectorConnectionRun` and
`useSelectConnectorAccount` when building this advanced multi-slot flow.

A connection run records the interactive execution: `waiting`, `running`, then a terminal status.
Its terminal record is secret-free and retained without automatic cleanup in V1.

| Client operation | Effect |
| --- | --- |
| `listConnectorConnections()` | Lists known connections and their current lifecycle status. |
| `addConnectorConnection()` | Selects another account through an existing OAuth grant. |
| `disconnectConnectorConnection()` | Disconnects one account; the last usage also schedules grant revocation. |
| `reauthorizeConnectorConnection()` | Starts a new OAuth run for an existing grant. |
| `revokeConnectorConnection()` | Revokes the grant and disconnects every account sharing it. |

Management routes require a browser session, CSRF protection, and `can.manage(connector)`.
Authorization ids and OAuth credentials are never exposed.

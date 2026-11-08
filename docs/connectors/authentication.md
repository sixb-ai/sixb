# OAuth connectors

OAuth connectors let users authorize your app to access their accounts in external services.
Sixb handles authorization, account selection, and token refresh.

## Configure a connector

Export an OAuth connector from `connectors/`. Follow its [package README](library.md) for the
provider credentials and scopes. For example:

```ts
import { defineConnector } from "@sixb/core"
import { linkedin } from "@sixb/connector-linkedin"

export const linkedinAds = defineConnector("linkedin-ads", linkedin({
  clientId: process.env.LINKEDIN_CLIENT_ID!,
  clientSecret: process.env.LINKEDIN_CLIENT_SECRET!,
  accountType: "ad-account",
  scopes: ["r_ads", "r_ads_reporting"],
}))
```

Register this callback URL with the provider, using your Sixb API's origin:

```text
https://<sixb-api-origin>/auth/connectors/callback
```

With persistent storage, set `connectorConnections.encryptionKey` in your `createSixb()` config:

```ts
connectorConnections: {
  encryptionKey: process.env.SIXB_CONNECTOR_ENCRYPTION_KEY!,
},
```

Generate the key once and store it as a deployment secret. Keep the same key across restarts and
all processes sharing the database. Losing or replacing it makes existing credentials unreadable.

```bash
bun -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"))'
```

## Connect an account

Use `useConnectorConnection` in your app to start authorization. The user must be signed in with a
role that grants `can.manage(linkedinAds)`.

When the user returns from the provider, Sixb connects the account if there's only one, and the
hook reports `connected`. Otherwise it reports `selecting_account` and your app shows a choice:

| Accounts the user authorized | Result |
|---|---|
| One, and the slot is free or already holds it | Connected |
| One, and the slot holds a different account | `selecting_account`; pass `{ replace: true }` to `selectAccount` to replace it |
| Several | `selecting_account` |
| None | `error` |

```tsx
import { useConnectorConnection } from "@sixb/client/hooks"

export function ConnectLinkedIn() {
  const linkedin = useConnectorConnection({
    connectorId: "linkedin-ads",
    slot: "marketing",
  })

  return (
    <>
      <button onClick={linkedin.connect} disabled={!linkedin.canConnect}>
        {linkedin.connection?.account.label ?? "Connect LinkedIn"}
      </button>

      {linkedin.status === "selecting_account" &&
        linkedin.accounts.map((account) => (
          <button key={account.id} onClick={() => linkedin.selectAccount(account.id)}>
            {account.label}
          </button>
        ))}
    </>
  )
}
```

`slot` names how your app uses the account, such as `marketing` or `customer-support`.
Keep this component mounted on the page users return to after authorization so the hook can
finish the connection or resume account selection. Show the connected account's label so users can
spot a wrong sign-in: `disconnect()` frees the slot for another account. The hook also exposes
`error` for your interface.

## Use the account

In backend code, pass the connector and the same slot to get its authenticated client:

```ts
import { linkedinAds } from "./connectors/linkedin"

const client = await sixb.connector(linkedinAds, {
  owner: { type: "project" },
  slot: "marketing",
})
```

[Syncs](../syncs/overview.md#sync-connected-accounts) read all connected accounts automatically,
so you don't need to select a slot in a sync definition.

## Let people connect their own accounts

By default an OAuth connector's accounts belong to the project. To let each person connect their
own account, such as their own mailbox, add `owners` to the definition:

```ts
export const gmail = defineConnector("gmail", google({ auth: { oauth } }), {
  owners: ["user"],
})
```

Use `["project", "user"]` to allow both. Then any signed-in member can connect their own account,
without `can.manage`:

```tsx
const gmail = useConnectorConnection({ connectorId: "gmail", owner: "me" })
```

`owner: "me"` fills the member's own `default` slot. Pass `slot` to give one person several
accounts.

| Who | Can |
|---|---|
| The member who connected it | See it, reconnect it, revoke it and disconnect it |
| Other members | Nothing: to them it doesn't exist |
| Members with `can.manage(gmail)` | See every connection with its owner, and disconnect any of them. Only the owner can reconnect or revoke it |

A personal connection is read only by [syncs](../syncs/overview.md#sync-connected-accounts) and
[webhooks](webhooks.md). `sixb.connector()` opens project connections only, so no action or tool
can act with someone else's account. A sync writes everyone's rows into the same dataset: use
`connection.owner` or `connection.account` to record whose they are, and
[roles](../auth/authorization.md#grant-only-some-objects) to decide who sees them.

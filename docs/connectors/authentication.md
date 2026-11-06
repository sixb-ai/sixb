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

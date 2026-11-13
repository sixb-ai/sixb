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

A project connection is one account the whole project shares. A personal connection is one
person's own account, such as their mailbox or calendar: each person connects it themselves, and
Sixb acts as them whenever it uses it.

### Allow personal connections

Add `owners` to the connector's definition:

```ts
export const gmail = defineConnector("gmail", google({ auth: { oauth } }), {
  owners: ["user"],
})
```

`["user"]` allows only personal connections. `["project", "user"]` allows both.

### Connect an account

Any signed-in member can connect their own account, without `can.manage(gmail)`. Pass
`owner: "me"` to `useConnectorConnection`:

```tsx
const connection = useConnectorConnection({ connectorId: "gmail", owner: "me" })
```

The account fills the member's `default` slot. Pass `slot` to let one person connect several
accounts, such as `work` and `personal`.

A personal connection belongs to the member who connected it:

| Who | Can |
|---|---|
| The member who connected it | See it, reconnect it, revoke it, and disconnect it |
| Members with `can.manage(gmail)` | See every connection and its owner, and disconnect any of them |
| Other members | Nothing. To them, it doesn't exist |

Only the owner can reconnect or revoke a connection, because both act on their own sign-in. A
personal connection's account can't fill a project slot; connect it again for the project.

When a member is [suspended](../auth/members.md#when-someone-leaves), Sixb revokes the grants
behind their connections, and syncs and actions stop using them at once. The connections stay,
revoked, and the member connects again if they are reactivated. A revocation the provider refuses
is logged, and Sixb still never uses the connection; disconnect it to delete its tokens.

### Bring each person's data in

[Syncs](../syncs/overview.md#sync-connected-accounts) read every connected account, personal
ones included, and [webhooks](webhooks.md) receive their events. Everyone's rows land in the same
dataset, so have the sync write each row's owner and slot. `connection.owner` is
`{ type: "user", id }` for a personal connection and `{ type: "project" }` otherwise; write its `id`
and `connection.slot` on each row. Map the id to a
[`ref.user()`](../ontology/properties.md#reference-a-user) property with
[`userRef.fromId`](../projections/overview.md#point-to-members), and use
[roles](../auth/authorization.md#grant-only-some-objects) to show each person only their own.

### React when someone connects

[Schedules](../schedules/overview.md#run-on-an-event) can start work when a connection of an OAuth
connector becomes usable or stops being usable:

| Selector | Fires when | `reason` |
|---|---|---|
| `events.connector(gmail).connected()` | Someone connects an account, replaces the one in a slot, or reconnects | `"connected"`, `"replaced"`, `"reconnected"` |
| `events.connector(gmail).disconnected()` | Sixb can no longer use the connection: it was disconnected, its grant revoked, or its owner suspended | `"disconnected"`, `"revoked"`, `"suspended"` |

The event carries the `connection`: its `id`, `owner`, `slot` and `account`. This workflow runs a
person's first setup as soon as they connect:

```ts
const gmailConnected = defineSchedule("gmail-connected").on(events.connector(gmail).connected())

export const setUpMailbox = defineWorkflow("set-up-mailbox")
  .input({ connectionId: "string" })
  .when(gmailConnected, ({ event }) => ({ connectionId: event.connection.id }))
  .then(setUpStep)
```

In the step, `sixb.connector.connections(gmail)` lists the connections the run may use, following
[the same rule as `sixb.connector()`](#which-runs-can-use-a-connection). A run no one requested,
like this one, gets them all:

```ts
for (const { connection, client } of await sixb.connector.connections(gmail).list()) {
  if (connection.id !== input.connectionId) continue
  await (await client()).gmail.labels.create("me", { name: "Sixb" })
}
```

`forAccount(accountId)` returns the connections of one account instead. Sixb announces each change
once, after it is saved. An announcement lost to a broker outage or a crash is not repeated, so
pair a `connected` schedule with a timed one that checks every connection.

### Act with a person's account

To change something in a person's account, open their connection in an action or a workflow
step: pass its owner and slot to `sixb.connector()`. Every call the client makes then goes out as
that person.

#### Change the account a row came from

A row that came from someone's account names the account to write to. This action labels a
message in the mailbox it came from. Its `Message` type has an `owner` property, a
[`ref.user()`](../ontology/properties.md#reference-a-user), and a `slot` string property, both
filled by the sync. The connector has the `gmail.modify` scope:

```ts
export const labelMessage = defineAction("labelMessage")
  .on(Message)
  .params({ labelId: param("string") })
  .writeback(async ({ target, params, sixb }) => {
    const client = await sixb.connector(gmail, {
      owner: target.properties.owner,
      slot: target.properties.slot,
    })

    await client.gmail.messages.modify("me", target.properties.gmailId, {
      addLabelIds: [params.labelId],
    })
  })
```

`"me"` is Gmail's name for the connected mailbox. The owner can run this action on their own
messages, and so can a workflow that an incoming message starts.

#### Act for the person who asked

When no row names the account, such as when sending a new message, use the person who requested
the run. Every handler receives them as
[`requestedBy`](../actions/overview.md#know-who-requested-the-run):

```ts
export const sendEmail = defineAction("sendEmail")
  .params({ raw: param("string") })
  .writeback(async ({ params, requestedBy, sixb }) => {
    if (requestedBy?.type !== "user") throw new Error("Only a member can send email.")

    const client = await sixb.connector(gmail, { owner: requestedBy, slot: "default" })
    await client.gmail.messages.send("me", { raw: params.raw })
  })
```

#### Which runs can use a connection

Sixb checks each `sixb.connector()` call against who requested the run:

| The run was requested by | It can use |
|---|---|
| The owner, from the app, the API, their agent conversation, or a workflow they started | Their own connections |
| Anyone else, including members with `can.manage(gmail)` and service accounts | No personal connections |
| No one: an event, a schedule, a webhook, or a [shared link](../auth/shared-access.md) started it | Any person's connection your code names |

If Ben runs `labelMessage` on one of Ada's messages, the run fails, even when a role lets him see
the message. To tell him why, reject the request in `.validate()`:

```ts
.validate(({ target, requestedBy }) => {
  if (requestedBy && requestedBy.id !== target.properties.owner.id) {
    return { error: "Only the message's owner can label it." }
  }
})
```

#### Keep writebacks safe

A run no one requested can use anyone's connection, so the owner your code passes decides whose
account changes:

- **Take the owner from the row or from `requestedBy`, never from a parameter.** In a run started
  by a shared link or an event, a parameter would let its sender choose any account.
- **Let only the sync write the owner property.** Anyone who can edit it can point a row at
  someone else's account.
- **Give shared links and workflow AI tasks only the rows they need.** They can change the
  account of every row they can act on.

#### Handle failures

| When | `sixb.connector()` or the call fails with |
|---|---|
| The person has no connection in that slot | `connector.not_found` |
| The connection needs reconnecting | `connector.authorization_required`, until the owner reconnects |
| Someone else requested the run | An authorization error |

An error thrown in `.writeback()` fails the run with `action.phase_failed` and goes to
[`onError`](../logging/overview.md#report-failures). Show the person their connection's status
with `useConnectorConnection` so they can reconnect it.

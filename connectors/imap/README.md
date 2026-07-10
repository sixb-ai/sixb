# `@sixb/connector-imap`

Read-only IMAP connector for Sixb. It opens a short-lived TLS session for each operation instead
of keeping a fragile socket in the connector runtime cache.

```ts
import { imap } from "@sixb/connector-imap"
import { defineConnector } from "@sixb/core"

export const mail = defineConnector(
  "mail",
  imap({
    host: "imap.example.com",
    auth: {
      user: process.env.IMAP_USER!,
      pass: process.env.IMAP_PASSWORD!,
    },
  })
)
```

Use the resolved client inside a function, sync, action, or workflow:

```ts
const client = await sixb.connector(mail)

await client.withMailbox("INBOX", async (mailbox) => {
  const state = mailbox.state()
  const messages = await mailbox.listMessages({
    afterUid: lastUid,
    limit: 100,
    headers: ["auto-submitted", "list-id", "list-unsubscribe"],
  })

  console.log(state.uidValidity, messages[0]?.headers["list-id"])
})
```

Requested header names are validated and deduplicated case-insensitively. Returned keys are
lowercase and repeated fields remain separate values. Header interpretation belongs to the
consumer; the connector only transports the requested metadata.

All mailbox sessions use IMAP `EXAMINE`; the client does not expose any write or flag mutation
method. Consume a stream returned by `downloadPart()` before the `withMailbox()` callback ends.

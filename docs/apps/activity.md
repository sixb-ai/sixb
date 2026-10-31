# App activity

See who uses your app, what they view and what they do there. Turn it on in `createSixb()`:

```ts
activity: { enabled: true }
```

Then open **Settings › Activity** from the user menu. Reading it takes
`can.observe(project.activity)` in a [role](../auth/authorization.md):

```ts
export const productActivity = defineRole("product.activity", {
  grantedTo: [product],
  grants: [can.observe(project.activity)],
})
```

Sixb records signed-in users and shared-link visitors. An app without sign-in records nothing.

## Visits

- A visit groups the tabs of one sign-in. It ends after 30 minutes without activity
  (`activity.idleTimeoutMs`, from 1 minute to 24 hours) or after 24 hours.
- A user counts once per period. Shared-link visitors have no account: they are counted apart,
  by the share they opened.
- Periods cover the last 24 hours, 7 days or 30 days. A user's calendar covers a year, and a day
  opens its visits. Days are in UTC.
- A visit keeps how it arrived: the `utm_source`, `utm_medium` and `utm_campaign` of your links,
  otherwise the referring site, otherwise **Direct**.

## What a visit shows

A visit's timeline lists, by time and filterable by kind:

| Entry | What it shows |
| --- | --- |
| Pages | Route patterns, such as `/invoices/:invoiceId` |
| Interactions | The elements you [mark](#track-interactions) |
| Actions and workflows | The runs the visit's session started, with their outcome |
| Agent runs | Status, messages and cost; the [conversation](#read-a-conversation) with `agent.threads` |

Above it, the connection names the browser and system, or the shared link. A user's view also
lists their sign-ins with the visits each opened.

Each page view is a step, with what happened on that page under it and a mark when it is a revisit.

An action names its object, and links to its run, only if you may read them. A visit shows at most
200 page views and interactions and 200 runs, and says when it stops short.

## Track interactions

Mark what people click, or call `trackSixbEvent` for what is not a click:

```tsx
<Button data-sixb-track="invoices.export">Export</Button>
```

```ts
import { trackSixbEvent } from "@sixb/client/browser"

trackSixbEvent("invoices.filter.applied")
```

- Names are constants in lowercase dotted segments, such as `invoices.row.open`. Names that look
  like values, such as `invoices.123`, are refused: never put an id or user input in a name.
- Sixb records the name, the page and the time, never the element's text or a value.
- Call `trackSixbEvent` in response to something the person did, not on each keystroke.

## Read a conversation

`can.observe(agent.threads)` opens, read-only, the conversation behind a visit's Agent run: its
messages, tools, files and the artifacts published in it.

> The agent answers with the permissions of the person talking to it. This grant shows everything
> the agent showed them, **whatever your own permissions**. Grant it only to people who may read
> all of it.

Opening a conversation from a visit also takes `can.observe(project.activity)`. Access tokens
cannot read other users' conversations.

## Privacy and limits

- Never recorded: URLs and their values, page contents, form values, element text and IP addresses.
- The built-in Console and Settings pages are not recorded.
- Use SQLite or PostgreSQL to keep history across restarts. It has no automatic expiration.
- Browsers can fail to deliver events: use activity to understand usage, not as an audit trail.

# App activity

See who uses your app, what they view and what they do there. Turn it on in `createSixb()`:

```ts
activity: { enabled: true }
```

Then open **Observability › Activity** from the user menu. Reading it takes
`can.observe(project.activity)` in a [role](../auth/authorization.md):

```ts
export const productActivity = defineRole("product.activity", {
  grantedTo: [product],
  grants: [can.observe(project.activity)],
})
```

Sixb records signed-in users and shared-link visitors. An app without sign-in records nothing.

## What a visit shows

A visit's timeline lists, by time, the pages viewed and what the visitor did in the meantime:

- **Actions** they applied, with their outcome. An action links to its run under
  **Observability › Runs** only when you may read that run, and names the object it applied to only
  when you can read that object yourself.
- **Workflows** they started, and everything those ran, even after the visit ended, linking to
  their run likewise.
- **Agent runs** from the chat: their status, how many messages the conversation holds and what
  the run cost, subagents and tools included.

Filter the timeline by kind. Above it, the visit's connection names the browser and system it
signed in with, or the shared link a visitor opened. A visit belongs to one browser session, so the
same person's other browser, used at the same time, shows its own visits.

A timeline never shows a conversation's title or messages, page contents, form values, IP addresses
or the raw user agent. Requests that only read data leave no run, so they show only as the pages
that made them. A visit shows at most 200 page views and 200 recorded executions: past either, its
timeline stops at the last one it could show complete, and says so.

## Visits

- A visit groups the tabs of one sign-in. It ends after 30 minutes without activity
  (`activity.idleTimeoutMs`, from 1 minute to 24 hours) or after 24 hours.
- A user counts once per period. Shared-link visitors have no account: they are counted apart,
  by the share they opened.
- Periods cover the last 24 hours, 7 days or 30 days. A user's calendar covers a year, and a day
  opens its visits. Days are in UTC.
- A visit keeps how it arrived: the `utm_source`, `utm_medium` and `utm_campaign` of your links,
  otherwise the referring site, otherwise **Direct**.

Select a visit to see the pages viewed in it, as route patterns such as `/invoices/:invoiceId`.

## Privacy and limits

- Never recorded: URLs and their values, page contents, form values and IP addresses.
- The built-in Data, Observability, Ontology and Settings pages are not recorded.
- Use SQLite or PostgreSQL to keep history across restarts. It has no automatic expiration.
- Browsers can fail to deliver events: use activity to understand usage, not as an audit trail.

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
| Actions and workflows | The runs the visit's session started, with their outcome |
| Agent runs | Status, messages and cost |

Above it, the connection names the browser and system, or the shared link. A user's view also
lists their sign-ins with the visits each opened.

An action names its object, and links to its run, only if you may read them. A visit shows at most
200 page views and 200 runs, and says when it stops short.

## Privacy and limits

- Never recorded: URLs and their values, page contents, form values and IP addresses.
- The built-in Data, Observability, Ontology and Settings pages are not recorded.
- Use SQLite or PostgreSQL to keep history across restarts. It has no automatic expiration.
- Browsers can fail to deliver events: use activity to understand usage, not as an audit trail.

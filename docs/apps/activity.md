# App activity

See who uses your app: their visits, and the pages they view in them. Turn it on in your
`createSixb()` configuration:

```ts
activity: { enabled: true }
```

Sixb then records signed-in users and shared-link visitors in your app's pages. An app without
sign-in records nothing: there is nobody to attribute a visit to. Open
**Observability › Activity** from the user menu to read it. Reading takes
`can.observe(project.activity)` in a [role](../auth/authorization.md):

```ts
// security/roles/product.ts
import { can, defineGroup, defineRole, project } from "@sixb/core"

export const product = defineGroup("product")

export const productActivity = defineRole("product.activity", {
  grantedTo: [product],
  grants: [can.observe(project.activity)],
})
```

## What the page shows

Choose the last 24 hours, 7 days or 30 days to see unique users, visits, shared-link visits and
page views, then the visits themselves, latest activity first. Select a visit to see the pages
viewed in it. Filter by a user to see their year as a calendar of active days, and select a day to
list its visits.

A user counts once in a period, however many browsers they use. Shared-link visitors have no
account: their visits are counted per shared-link session and shown with the link they opened,
never as users.

## Visits

Tabs sharing a sign-in belong to the same visit. After 30 minutes without activity, coming back
starts a new visit, which opens on the page the person returned to. Set `activity.idleTimeoutMs` to
change that duration, from 1 minute to 24 hours. A visit also ends after 24 hours, however active:
the next page view or activity starts another. Switching back to a tab keeps the visit going
without counting another page view.

A visit appears in every period it was active in, so one that crosses midnight counts on both days.
Days are in UTC.

## What is recorded

Pages are recorded as route patterns such as `/invoices/:invoiceId`, never as URLs: their values,
the page contents and form values are not collected. The built-in Data, Observability, Ontology and
Settings pages are tools for your team, so opening them is not recorded; Home, the agent, object
pages, artifacts and your own pages are.

A visit also keeps how it arrived. Add `utm_source`, `utm_medium` and `utm_campaign` to the links you
distribute, such as `?utm_source=newsletter&utm_medium=email&utm_campaign=launch`, with consistent
labels of up to 100 characters and no personal data. Without them, Sixb keeps the external site that
referred the visit, or shows **Direct**. The source stays fixed for the whole visit.

## Storage and limits

Use SQLite or PostgreSQL storage to keep history across restarts; in-memory storage loses it. History
has no automatic expiration. A period covers up to 31 days at a time and the calendar one year.

Recording is off by default, and covers visits and page views, not clicks or actions. Browsers can
fail to deliver some of it, so use activity to understand usage, not as an audit trail.

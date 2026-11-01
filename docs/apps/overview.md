# Building Apps

An app is a React interface for your Sixb project. Build pages that display your data and let users
interact with your domain model.

## Create a page

Add `app/page.tsx` to your project. Export a React component to serve it at `/`.

File: `app/page.tsx`

```tsx
export default function HomePage() {
  return (
    <main>
      <h1>My app</h1>
      <a href="/invoices">View invoices</a>
    </main>
  )
}
```

Start the development server and open the app URL printed in your terminal:

```bash
bun sixb dev
```

Sixb serves your app alongside the API and rebuilds it when you edit a page or stylesheet. It
configures routing, authentication, and the query client for you. A project without an `app/`
folder still has an app: Home, the agent, and the built-in sections, in the default
[sidebar](#add-a-sidebar).

Until you add `app/page.tsx`, Sixb serves a home page where people ask the project's agent. Without
a configured agent, it shows the app's name. An `app/layout.tsx` with no pages is enough to serve
it.

## Add routes

Each `page.tsx` or `page.ts` defines a route through its default export:

| File | Route |
| --- | --- |
| `app/page.tsx` | `/` |
| `app/invoices/page.tsx` | `/invoices` |
| `app/invoices/[invoiceId]/page.tsx` | `/invoices/:invoiceId` |

Use `[name]` for a dynamic segment and read its value with `useParams`:

File: `app/invoices/[invoiceId]/page.tsx`

```tsx
import { useParams } from "react-router-dom"

export default function InvoicePage() {
  const { invoiceId } = useParams()
  return <h1>Invoice {invoiceId}</h1>
}
```

Use ordinary `<a href="/invoices">` links between pages. Sixb handles client-side navigation for
known app routes. Files and folders beginning with `_` are ignored by routing.

[Shared access](../auth/shared-access.md) reuses these same pages with restricted
permissions. Open a shared URL with `<a href={url}>`, rather than programmatic router navigation.

## Add a layout

An optional `app/layout.tsx` wraps every page; without one, your pages render without a frame. A
project with no `app/` pages and no layout gets the default [sidebar](#add-a-sidebar). A layout in a
subdirectory, such as `app/invoices/layout.tsx`, wraps only that route and its descendants. Layouts
receive `children` and stay mounted while navigating between their pages.

File: `app/layout.tsx`

```tsx
import type { PropsWithChildren } from "react"

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <>
      <nav>
        <a href="/">Home</a>
        <a href="/invoices">Invoices</a>
      </nav>
      {children}
    </>
  )
}
```

The root layout is also loaded during app generation. Avoid accessing `window` or `document` at
module scope. Set the page title and app icons through [Customization](customization.md). Its
`toolViews` export shows your agent tools in the chat; see
[Show a tool in the chat](../models/tools-and-authorization.md#show-a-tool-in-the-chat).

## Add a sidebar

`AppShell` frames every page with a sidebar: the app's name, **Search**, your navigation, and a
menu for the signed-in user with the [Console](#console), [Settings](#settings), theme switching,
and sign-out. Opening a section swaps
the sidebar for its pages, with a link back. When the project has an agent, it waits docked beside
every page but Home and its own pages. Sixb includes its styles, so it needs no stylesheet of yours.

File: `app/layout.tsx`

```tsx
import { AppShell } from "@sixb/app"
import { FileText, MapPin } from "lucide-react"
import type { PropsWithChildren } from "react"

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <AppShell
      nav={[
        {
          group: "Operations",
          items: [
            { label: "Quotes", href: "/quotes", icon: FileText },
            { label: "Job sites", href: "/sites", icon: MapPin },
          ],
        },
      ]}
    >
      {children}
    </AppShell>
  )
}
```

| Prop | Default | Purpose |
| --- | --- | --- |
| `nav` | none | Links and groups, or your own sidebar content |
| `brand` | The app's title and icon | Top of the sidebar |
| `header` | `<SearchCommand />` | Content below the brand; pass `null` to remove search |
| `footer` | none | Content above the user menu |
| `userMenu` | `<UserMenu />` | Pass `null` to remove it |
| `agent` | `<AgentDock />` | Beside every page; pass `null` to remove the docked agent |
| `variant`, `collapsible`, `side`, `defaultOpen` | `"inset"`, `"icon"`, `"left"`, `true` | Passed to the `@sixb/ui` sidebar |

The sidebar collapses to icons with ⌘B or the toggle at its foot, so give each nav item an `icon`.
A custom `brand` can show something smaller while collapsed with Tailwind's
`group-data-[collapsible=icon]:` variant.

To build your own sidebar, use the same parts with the `@sixb/ui` sidebar components:
`AppShellProvider`, `Brand`, `NavItems`, `SearchCommand`, `SectionNav`, `UserMenu`, and
`AgentDock`.

| Part | Shows |
| --- | --- |
| `SearchCommand` | A **Search** button, and ⌘K anywhere: your `pages`, Artifacts, every section page the person may open, and objects as they type |
| `SectionNav` | The open section's pages with a link back, and its `fallback` everywhere else |
| `UserMenu` | The person, Artifacts, the sections they may open, theme switching, and sign-out |
| `AgentDock` | The project's agent, collapsed beside the page until opened; nothing without an agent |

Wrap your own navigation in `SectionNav` so that opening the Console or Settings swaps it for the
section's pages, and keep your header and footer around it:

```tsx
import { SectionNav, UserMenu } from "@sixb/app"
import { Sidebar, SidebarContent, SidebarFooter } from "@sixb/ui/components"

<Sidebar>
  <SidebarContent>
    <SectionNav fallback={<OperationsNav />} />
  </SidebarContent>
  <SidebarFooter>
    <UserMenu />
  </SidebarFooter>
</Sidebar>
```

Without a `SectionNav`, a section shows its pages as tabs above the page, so a sidebar with only
`UserMenu` still reaches every page. With authentication off nobody signs in, and the menu's button
reads **Sign-in off**. `useSections()` returns the same sections for drawing your own.

Section pages bring their own margins, and a dataset's rows and a pipeline's canvas fill the
height they are given. If your layout wraps pages in padding or a maximum width, leave it off while
`useCurrentSection()` returns a section. A page of yours that replaces a section page counts as one
too, so give it margins of its own:

```tsx
const inSection = useCurrentSection() !== null

<main className="min-h-0 flex-1 overflow-y-auto">
  <div className={inSection ? "h-full" : "mx-auto max-w-6xl px-6 py-8"}>{children}</div>
</main>
```

Add your own items to the user menu with `UserMenu.Item`; they appear below the sections:

```tsx
<UserMenu>
  <UserMenu.Item href="/release-notes">Release notes</UserMenu.Item>
</UserMenu>
```

Read the signed-in user with `useCurrentUser()`, which returns `null` when nobody is signed in or
authentication is off. `useSignOut()` returns a function that signs the user out.

## Settings

Every app includes Settings, built from the same parts, for everyone signed in. Their own pages
are always there; a Project page appears to whoever may do what it is for, by a
[membership policy](../auth/members.md) or a [grant](../auth/authorization.md). A page of your own
at the same path replaces the built-in one: `app/settings/members/page.tsx` replaces Members.

| Group | Page | Path | Shows |
| --- | --- | --- | --- |
| Your account | Personal | `/settings/personal` | Their name (editable unless their identity provider sets it), email and groups, the theme, and where they are signed in |
| Your account | Developers | `/settings/developers` | Their [personal access tokens](../auth/members.md#service-accounts-and-tokens) |
| Your account | Memory | `/settings/memory` | What [the agent remembers](../models/overview.md#it-remembers) of them and of the project, with its history, to correct or delete |
| Project | Members | `/settings/members` | **People**: members and invitations their membership policy covers, by group. **Groups**: who is in each. **Service accounts**: accounts for automation and their tokens. Each tab is for those whose policy lets them invite, assign groups or suspend, or, for Service accounts, holds `serviceAccounts` |
| Project | Usage | `/settings/usage` | This month's [usage limits](../models/usage-and-limits.md), then cost, tokens and every model call for a date range; for those with `can.observe(agent.usage)` |
| Project | Activity | `/settings/activity` | Who [uses the app](activity.md): visits, the pages viewed in them, and each user's active days; for those with `can.observe(project.activity)` |

Changing limits on Usage needs `can.manage(agent.usage)`, and reading other users' conversations
from Activity needs `can.observe(agent.threads)` as well.

Settings needs a signed-in person, so it is absent when authentication is off.

## Console

Every app includes the Console, in the user menu for [those granted it](#choose-who-sees-the-console):
how data reaches the project, what the project models, and the logs its runs write. The sidebar lists Data and Ontology under their own headings,
counting what each holds, then Logs.

| Group | Page | Path | Shows |
| --- | --- | --- | --- |
| Data | Connectors | `/console/connectors` | Each connector's syncs, and its webhooks and deliveries |
| Data | Syncs | `/console/syncs` | Each sync's runs, with **Sync now** to start one |
| Data | Datasets | `/console/datasets` | Each dataset's rows at any version across the whole page; **Details** shows what writes it, what reads it, its schema, and the run that wrote the version shown and the versions it was computed from |
| Data | Pipelines | `/console/pipelines` | Each pipeline as a canvas of datasets and steps; select a dataset to see its rows, open **Runs** for each run's step results, and **Run now** to start one |
| Data | Projections | `/console/projections` | Which dataset columns fill each object, link, or telemetry field, and its runs |
| Ontology | Object types | `/console/object-types` | Each type with its properties, links and actions, searchable by any of them |
| Ontology | Objects | `/console/objects` | The objects updated last and a card per type; one type's objects, searchable, filtered and sorted, as cards or a table |
| Ontology | Graph | `/console/graph` | The types and the links between them; select one to inspect it |
| Ontology | Actions | `/console/actions` | Each action with its latest run, applied from its card; **Runs** lists every action run, filtered by action and status |
| Ontology | Workflows | `/console/workflows` | Each workflow with its latest run |
| Ontology | Rules | `/console/rules` | Each rule, what it watches, and how many objects it holds active |
| | Logs | `/console/logs` | Logs as runs write them, filtered by kind and level and searchable |

Each item opens a page under its list, such as `/console/syncs/crm-accounts`. As with Settings, a
page of your own at the same path replaces the built-in one.

Each run sits with what ran: a sync's on its sync, a pipeline's on its pipeline, a projection's on
its projection and a webhook delivery on its connector. A workflow or action run opens its own page,
such as `/console/workflows/runs/run_123` or `/console/actions/runs/run_456`: its input and output,
each step with what it read and wrote, and its logs. An action run opens from **Actions › Runs**. A step that waits for someone's response links
to its workflow's page, which answers it.

An object type opens its own page, such as `/console/object-types/Deal`: what it inherits and what
extends it, then its properties, vectors, links, actions and the
[projections](../projections/overview.md) that fill it. A rule opens its definition and the objects
it holds active.

A workflow opens as a canvas of its steps, such as `/console/workflows/review-deal`. **Run
workflow** starts one with a form for its input. **Runs** lists its runs; selecting one draws each
step's status on the canvas, and selecting a step shows what it read and wrote. A step waiting for
someone's response shows the form that answers it.

Each page shows what the API lets the person read. Runs follow the grants of what ran, such as
`can.run` on a workflow or `can.apply` on an action. A connector's webhooks and their deliveries
need [`can.manage`](../auth/authorization.md) on the connector, and **Sync now** and **Run now**
need `can.run` on the sync or pipeline, and logs need `can.observe(project.logs)`. See
[Authorization](../auth/authorization.md).

To start a sync from your own pages, use `SyncButton`. It turns into **Syncing…** until the run
ends.

```tsx
import { SyncButton } from "@sixb/app"

<SyncButton sync="crm-accounts" showStatus />
```

| Prop | Default | Purpose |
| --- | --- | --- |
| `sync` | required | The sync's id |
| `showStatus` | `false` | Shows when it last synced, or that it failed, beside the button |
| `variant`, `size` | `"outline"`, `"sm"` | Passed to the `@sixb/ui` button |

## Object pages

Every object has a page at `/objects/:objectTypeId/:primaryId`, such as `/objects/Deal/D-48231`,
whatever section a person can see: its properties, its telemetry live with a trend over time, the
objects it links to and those that link to it, and its type's actions. References to an object
anywhere in the app open its page. For those who can open the [Console](#console), the sidebar
stays on it, with Objects current. As with any built-in page, a page of your own at the same path
replaces it.

Each property's name is marked with where its value comes from: imported by a projection, edited,
or set by telemetry. Selecting it shows the trail behind the value: the edit, who asked for it and
the imported value it replaced, or the projection, the dataset version it applied and the datasets
upstream of it. Steps the person cannot see are only counted. See [Lineage](../objects/lineage.md).

What the page shows follows the person's grants: `can.view` on the type to read the object, and
`can.apply` on an action to run it. See [Authorization](../auth/authorization.md).

## Choose who sees the Console

The Console is for the people who build and run the project. Grant it with
`can.observe(project.console)` in a [role](../auth/authorization.md):

File: `security/roles/developers.ts`

```ts
import { can, defineRole, every, project } from "@sixb/core"
import { developers } from "../groups/developers"

export const developerAccess = defineRole("developer.access", {
  grantedTo: [developers],
  grants: [can.observe(project.console), can.observe(project.logs), can.run(every.workflow())],
})
```

The grant only opens the Console. Each of its pages shows what the person's other grants allow,
such as `can.observe(project.logs)` for Logs. Someone without it doesn't see the Console in the
user menu, and its URLs lead to `/`. Object pages stay open either way.

With authentication off nobody is signed in, and the Console is open.

## Add styles

Put app-wide styles in `app/globals.css`. Use plain CSS or your preferred components.

To use the optional `@sixb/ui` components and theme, install Tailwind in your project:

```bash
bun add tailwindcss @tailwindcss/cli
```

Then include the UI stylesheet and your app's source files:

File: `app/globals.css`

```css
@import "@sixb/ui/globals.css";
@source "./**/*.{ts,tsx}";
```

Override theme variables such as `--background`, `--foreground`, and `--primary` after the import.
For agent chat interfaces, use the agent components from `@sixb/app`.

## Add assets

Place images, fonts, and other static files in `app/public/`. Reference them from the root:
`app/public/logo.svg` is available at `/logo.svg`.

## Embed another site

A page frames only what the API serves, where artifacts open. To show another site in an
`<iframe>`, such as a video player or a document viewer, list its origin on the app server:

File: `.env`

```dotenv
SIXB_APP_FRAME_ORIGINS=https://www.youtube-nocookie.com,https://contoso.sharepoint.com
```

- Give each site's exact origin: scheme, host, and optional port. A wildcard, a path, or a
  scheme alone stops the app server at startup.
- List every site the frame loads, including those it redirects to.
- An artifact's frame may navigate to the sites listed here, so list only sites you trust with
  your data.
- Set it wherever the app server runs, in development and in production, then restart it. A frame
  of a site the list leaves out stays blank, and the browser console names the variable.

Continue with [Querying data](querying-data.md) and [Running actions](actions.md) to connect your
pages to the domain model. See [Deployment](../deployment/overview.md#start-services) when you are
ready to build and serve the app in production.

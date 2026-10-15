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
configures routing, authentication, and the query client for you.

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

An optional `app/layout.tsx` wraps every page. A layout in a subdirectory, such as
`app/invoices/layout.tsx`, wraps only that route and its descendants. Layouts receive `children`
and stay mounted while navigating between their pages.

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
module scope. Set the page title and app icons through [Customization](customization.md).

## Add a sidebar

`AppShell` frames every page with a sidebar: the app's name, **Search**, your navigation, and a
menu for the signed-in user with [Data](#data), [Observability](#observability),
[Ontology](#ontology), [Settings](#settings), theme switching, and sign-out. Opening a section swaps
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
| `SearchCommand` | A **Search** button, and ⌘K anywhere: your `pages`, every section page the person may open, and objects as they type |
| `SectionNav` | The open section's pages with a link back, and its `fallback` everywhere else |
| `UserMenu` | The person, the sections they may open, theme switching, and sign-out |
| `AgentDock` | The project's agent, collapsed beside the page until opened; nothing without an agent |

Wrap your own navigation in `SectionNav` so that opening Data or Settings swaps it for the
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

Every app includes Settings, built from the same parts. A page of your own at the same path
replaces the built-in one: `app/settings/members/page.tsx` replaces Members.

| Group | Page | Path | Shows |
| --- | --- | --- | --- |
| Your account | Personal | `/settings/personal` | The person's name, email, and groups, the theme, and where they are signed in |
| Your account | Developers | `/settings/developers` | Their [personal access tokens](../auth/members.md#service-accounts-and-tokens) |
| Project | Members | `/settings/members` | Members and invitations their [membership policy](../auth/members.md) covers |
| Project | Service accounts | `/settings/service-accounts` | Service accounts and their tokens, with the `serviceAccounts` policy operation |

Settings needs a signed-in person, so it is absent when authentication is off.

## Data

Every app includes Data, in the user menu: how data reaches the project, from each connector to the
objects it fills, and what failed on the way.

| Page | Path | Shows |
| --- | --- | --- |
| Connectors | `/data/connectors` | Each connector's syncs, and its webhooks and deliveries |
| Syncs | `/data/syncs` | Each sync's runs, with **Sync now** to start one |
| Datasets | `/data/datasets` | Each dataset's rows at any version across the whole page; **Details** shows what writes it, what reads it, and its schema |
| Pipelines | `/data/pipelines` | Each pipeline as a canvas of datasets and steps; select a dataset to see its rows, open **Runs** for each run's step results, and **Run now** to start one |
| Projections | `/data/projections` | Which dataset columns fill each object, link, or telemetry field, and its runs |

Each item opens a page under its list, such as `/data/syncs/crm-accounts`. As with Settings, a page
of your own at the same path replaces the built-in one.

The pages show what the API lets each person read. A connector's webhooks and their deliveries
need [`can.manage`](../auth/authorization.md) on the connector, and **Sync now** and **Run now**
need `can.run` on the sync or pipeline.

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

## Observability

Every app includes Observability, in the user menu: what ran, what it wrote while it worked, and
what its model calls cost.

| Page | Path | Shows |
| --- | --- | --- |
| Runs | `/observability/runs` | Every run, a tab per kind: workflows, actions, syncs, pipelines, projections and webhook deliveries, filtered by what ran and its status |
| Logs | `/observability/logs` | Logs as runs write them, filtered by kind and level and searchable |
| AI usage | `/observability/ai-usage` | This month's [usage limits](../models/usage-and-limits.md), then cost, tokens and every model call for a date range |

A workflow or action run opens its own page, such as `/observability/runs/workflows/run_123`: its
input and output, each step with what it read and wrote, and its logs. A step that waits for
someone's response links to its workflow's page under [Ontology](#ontology), which answers it, for
those who can open Ontology. A sync, pipeline, projection or webhook run opens the page under
[Data](#data) that shows it.

Each page shows what the API lets the person read. Runs follow the grants of what ran, such as
`can.run` on a workflow or `can.apply` on an action. Logs need `can.observe("logs")`, AI usage
needs `can.observe(agent.usage)`, and changing limits needs `can.manage(agent.usage)`. See
[Authorization](../auth/authorization.md).

## Ontology

Every app includes Ontology, in the user menu: what your project models and the logic that acts on
it. The sidebar counts each.

| Group | Page | Path | Shows |
| --- | --- | --- | --- |
| Model | Object types | `/ontology/object-types` | Each type with its properties, links and actions, searchable by any of them |
| Model | Objects | `/ontology/objects` | The objects updated last and a card per type; one type's objects, searchable, filtered and sorted, as cards or a table |
| Model | Graph | `/ontology/graph` | The types and the links between them; select one to inspect it |
| Logic | Actions | `/ontology/actions` | Each action with its latest run; apply one from its card |
| Logic | Workflows | `/ontology/workflows` | Each workflow with its latest run |
| Logic | Rules | `/ontology/rules` | Each rule, what it watches, and how many objects it holds active |

An object type opens its own page, such as `/ontology/object-types/Deal`: what it inherits and
what extends it, then its properties, vectors, links, actions and the
[projections](../projections/overview.md) that fill it. A rule opens its definition and the objects
it holds active.

A workflow opens as a canvas of its steps, such as `/ontology/workflows/review-deal`. **Run
workflow** starts one with a form for its input. **Runs** lists its runs; selecting one draws each
step's status on the canvas, and selecting a step shows what it read and wrote. A step waiting for
someone's response shows the form that answers it.

## Object pages

Every object has a page at `/objects/:objectTypeId/:primaryId`, such as `/objects/Deal/D-48231`,
whatever section a person can see: its properties, its telemetry live with a trend over time, the
objects it links to and those that link to it, and its type's actions. References to an object
anywhere in the app open its page. For those who can open [Ontology](#ontology), the sidebar stays
on it, with Objects current. As with any built-in page, a page of your own at the same path
replaces it.

What the page shows follows the person's grants: `can.view` on the type to read the object, and
`can.apply` on an action to run it. See [Authorization](../auth/authorization.md).

## Choose who sees a section

Export `visibility` from `app/layout.tsx` to show a section only to some groups:

File: `app/layout.tsx`

```tsx
import type { AppVisibility } from "@sixb/app"
import { admins } from "../security/groups/admins"

export const visibility = {
  settings: [admins],
  data: [admins],
  observability: [admins],
  ontology: [admins],
} satisfies AppVisibility
```

| Key | Hides |
| --- | --- |
| `settings` | Members and Service accounts |
| `data` | Every Data page |
| `observability` | Every Observability page |
| `ontology` | Every Ontology page; object pages stay open |

| Value | Who sees them |
| --- | --- |
| Not set | Everyone |
| `[admins, staff]` | Members of those groups |
| `[]` | Nobody |

Personal and Developers stay open to everyone signed in. With authentication off nobody is signed
in, so `visibility` does not apply and Data, Observability and Ontology are open. A hidden page
leaves the navigation, and its URL leads to `/`. Visibility only hides screens: the API still checks each
person's permissions.

The browser loads `app/layout.tsx`, so the group files it imports must take `defineGroup` from
`@sixb/core/security`:

File: `security/groups/admins.ts`

```ts
import { defineGroup } from "@sixb/core/security"

export const admins = defineGroup("admins", { label: "Admins" })
```

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

Continue with [Querying data](querying-data.md) and [Running actions](actions.md) to connect your
pages to the domain model. See [Deployment](../deployment/overview.md#start-services) when you are
ready to build and serve the app in production.

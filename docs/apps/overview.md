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

`AppShell` frames every page with a sidebar: the app's name, your navigation, and a menu for the
signed-in user with theme switching and sign-out. Sixb includes its styles, so it needs no
stylesheet of yours.

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
| `header`, `footer` | none | Content below the brand and above the user menu |
| `userMenu` | `<UserMenu />` | Pass `null` to remove it |
| `variant`, `collapsible`, `side`, `defaultOpen` | `"inset"`, `"offcanvas"`, `"left"`, `true` | Passed to the `@sixb/ui` sidebar |

To build your own sidebar, use the same parts with the `@sixb/ui` sidebar components:
`AppShellProvider`, `Brand`, `NavItems`, and `UserMenu`. Add your own items to the user menu with
`UserMenu.Item`:

```tsx
<UserMenu>
  <UserMenu.Item href="/release-notes">Release notes</UserMenu.Item>
</UserMenu>
```

Read the signed-in user with `useCurrentUser()`, which returns `null` when nobody is signed in or
authentication is off. `useSignOut()` returns a function that signs the user out.

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

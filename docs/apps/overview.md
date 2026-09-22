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
For agent chat interfaces, use `@sixb/agent-ui`.

## Add assets

Place images, fonts, and other static files in `app/public/`. Reference them from the root:
`app/public/logo.svg` is available at `/logo.svg`.

Continue with [Querying data](querying-data.md) and [Running actions](actions.md) to connect your
pages to the domain model. See [Deployment](../deployment/overview.md#start-services) when you are
ready to build and serve the app in production.

# Building Apps

An app is the custom web interface for your sixb project. It turns your objects,
telemetry, actions, and workflows into the screens people use to get work done.

An app is optional. Add an `app/` directory and sixb serves a React single-page
app alongside the API. With no `app/`, your project is API-only.

## Mental model

You write React pages under `app/`. sixb scans the directory, generates a router
and an app shell, and serves it. There is no separate framework to configure: the
file tree is the routing table, and sixb wires up everything the pages need to
talk to the API.

| You provide | sixb wires up |
| --- | --- |
| `app/**/page.tsx` route components | React Router (file-based routing) |
| `app/layout.tsx` (optional) | TanStack Query (`QueryClientProvider`) |
| `app/globals.css` (optional) | Auth session + cookies, CSRF handling |
| `app/public/` static assets | Same-origin `<a>` click interception (SPA nav) |

Pages fetch data with the typed hooks from `@sixb/client/hooks` and render with
your own components or `@sixb/ui`. See [querying data](querying-data.md).

## File-based routing

Put your app in `app/`. Each `page.tsx` (or `page.ts`) becomes a route.

```txt
app/
  page.tsx                  -> /
  projects/page.tsx         -> /projects
  review/[id]/page.tsx      -> /review/:id
  layout.tsx                -> root wrapper and metadata
  globals.css               -> app styles
  public/logo.svg           -> /logo.svg
```

Routing rules:

| Pattern | Route |
| --- | --- |
| `app/page.tsx` | `/` |
| `app/about/page.tsx` | `/about` |
| `app/remote/[id]/page.tsx` | `/remote/:id` |

- Only `page.tsx` and `page.ts` create routes.
- A folder named `[param]` becomes a dynamic segment `:param`.
- Files or folders starting with `_` are ignored — use the prefix for components,
  helpers, or routes you do not want mounted.
- The route component is the page module's `default` export.

```tsx
import { listObjectsOptions } from "@sixb/client/hooks"
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"

export default function HomePage() {
  const query = useQuery(
    listObjectsOptions({
      query: { objectTypeId: "project", limit: "50" },
    })
  )

  return (
    <main className="mx-auto grid max-w-3xl gap-3 p-6">
      {query.data?.map((object) => (
        <Card key={`${object.objectTypeId}:${object.primaryId}`}>
          <CardHeader>
            <CardTitle>{object.primaryId}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary">{object.objectTypeId}</Badge>
          </CardContent>
        </Card>
      ))}
    </main>
  )
}
```

Read the dynamic segment with React Router's `useParams` inside a
`[id]/page.tsx` component.

### Navigation

A plain same-origin `<a href="/...">` is intercepted and routed client-side when
its `href` matches a known route, so you get SPA navigation without React Router's
`<Link>`. Links to `/api`, `/auth`, `/ws`, `/docs`, cross-origin URLs, `download`
links, and modified clicks fall through to native navigation.

## Layout and metadata

`app/layout.tsx` is optional. Its `default` export wraps every route, and its
named `metadata` export sets the document title, description, and favicon.

```tsx
import type { AppMetadata } from "@sixb/app"
import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Operations",
  description: "Project operations console.",
  favicon: "/logo.svg",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
```

`AppMetadata` fields are all optional:

| Field | Type | Purpose |
| --- | --- | --- |
| `title` | `string` | Document `<title>` |
| `description` | `string` | `<meta name="description">` |
| `favicon` | `string` | `<link rel="icon" href>` (e.g. a `public/` path) |

## Styles and theming

Use `app/globals.css` for app-wide styles. Plain CSS bundles as-is.

To use `@sixb/ui` components and theme tokens, import its stylesheet. sixb detects
the Tailwind at-rules and `@sixb/ui` import and runs the Tailwind pipeline for
you. Override the CSS variables after the import to re-theme the components.

```css
@import "@sixb/ui/globals.css";
@source "./**/*.{ts,tsx}";

:root {
  --primary: #1f7a5a;
  --primary-foreground: #ffffff;
  --ring: #1f7a5a;
}
```

Using Tailwind features requires the CLI in your project:

```bash
bun add tailwindcss @tailwindcss/cli
```

Bringing your own UI? Keep `globals.css` plain CSS and skip the install.

## Running

During development, `bun sixb dev` starts the app alongside the API whenever
`app/` has routes. Edits to `.ts`, `.tsx`, and `.css` files rebuild automatically.

```bash
bun sixb dev
```

For production, build the project, then serve the compiled app:

```bash
bun run build
bun sixb app
```

## In this section

- [Querying data](querying-data.md) — fetch objects, telemetry, and actions from
  pages with the typed `@sixb/client/hooks`.
- [Typed client](../client/overview.md) — the generated client the hooks are built
  on, for non-app callers.
- [Authentication](../auth/authentication.md) — how the app shell establishes the
  auth session that pages run inside.

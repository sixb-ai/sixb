# Building Apps

An app is the custom web interface for your sixb project. It turns your customers,
projects, invoices, telemetry, actions, and workflows into the screens your team
uses to get work done.

Apps are optional. Add an `app/` directory and sixb serves a React single-page app
alongside the API. With no `app/`, your project is API-only.

## Mental model

You write React pages under `app/`. sixb scans the directory, generates a router
and an app shell, and serves it. There is no separate framework to configure: the
file tree is the routing table, and sixb wires up everything pages need to talk to
the API.

| You provide | sixb wires up |
| --- | --- |
| `app/**/page.tsx` route components | React Router (file-based routing) |
| `app/layout.tsx` (optional) | TanStack Query (`QueryClientProvider`) |
| `app/globals.css` (optional) | Auth session + cookies, CSRF handling |
| `app/public/` static assets | Same-origin `<a>` click interception (SPA nav) |

Pages fetch data with the typed hooks from `@sixb/client/hooks` and the typed
query builder from `@sixb/client/query`, then render with your own components or
`@sixb/ui`. See [querying data](querying-data.md).

> `app/` is not discovered by `createSixb()` — it is built and served separately
> by the CLI. Your ontology, datasets, functions, and the rest stay in their own
> top-level directories.

## File-based routing

Put your app in `app/`. Each `page.tsx` (or `page.ts`) becomes a route.

```txt
app/
  page.tsx                       -> /
  projects/page.tsx              -> /projects
  invoices/page.tsx              -> /invoices
  review/[interventionId]/page.tsx -> /review/:interventionId
  layout.tsx                     -> root wrapper and metadata
  globals.css                    -> app styles
  public/logo.svg                -> /logo.svg
```

Routing rules:

| Pattern | Route |
| --- | --- |
| `app/page.tsx` | `/` |
| `app/invoices/page.tsx` | `/invoices` |
| `app/review/[interventionId]/page.tsx` | `/review/:interventionId` |

- Only `page.tsx` and `page.ts` create routes.
- A folder named `[param]` becomes a dynamic segment `:param`. Read it with React
  Router's `useParams` inside the `[param]/page.tsx` component.
- Files or folders starting with `_` are ignored — use the prefix for components,
  helpers, or routes you do not want mounted.
- The route component is the page module's `default` export.

Here's a projects listing page. It builds a typed query for active projects and
renders each one as a card:

```tsx
import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import type { TwinObject } from "@sixb/core/query"
import { Project } from "../../ontology/project"

type ProjectRow = TwinObject<typeof Project, readonly []>

const activeProjects = objects(Project)
  .query()
  .where((project) => project.p.status.in(["active", "paused"]))
  .orderBy(Project.p.deadline, "asc")

function ProjectCard({ project }: { project: ProjectRow }) {
  return (
    <article className="rounded-lg border bg-card p-4 shadow-sm">
      <span className="text-xs font-bold text-accent-foreground capitalize">
        {project.properties.status}
      </span>
      <h2 className="mt-2 text-lg font-semibold">{project.properties.name}</h2>
      <p className="mt-2 text-muted-foreground">
        {project.properties.description ?? "No description."}
      </p>
    </article>
  )
}

export default function ProjectsPage() {
  const projectsQuery = useObjectsQuery(activeProjects)
  const projects = projectsQuery.data?.objects ?? []

  if (projectsQuery.isLoading) return <p>Loading projects...</p>
  if (projectsQuery.isError) return <p>Projects failed to load.</p>

  return (
    <main className="mx-auto grid max-w-3xl gap-3 p-6">
      {projects.map((project) => (
        <ProjectCard key={project.primaryId} project={project} />
      ))}
    </main>
  )
}
```

Hooks, the query builder, filtering, faceting, telemetry, and actions are covered
in [querying data](querying-data.md).

### Navigation

A plain same-origin `<a href="/...">` is intercepted and routed client-side when
its `href` matches a known route, so you get SPA navigation without React Router's
`<Link>`:

```tsx
<a href={`/review/${encodeURIComponent(intervention.id)}`}>Open review</a>
```

Links to `/api`, `/auth`, `/ws`, `/docs`, cross-origin URLs, `download` links, and
modified clicks (new tab, etc.) fall through to native navigation.

## Layout and metadata

`app/layout.tsx` is optional. Its `default` export wraps every route, and its
named `metadata` export sets the document title, description, and favicon.

```tsx
import type { AppMetadata } from "@sixb/app"
import type { PropsWithChildren } from "react"

export const metadata = {
  title: "Acme Operations",
  description: "Customers, projects, and invoices for Acme operations.",
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
the Tailwind at-rules and the `@sixb/ui` import and runs the Tailwind pipeline for
you. Override the CSS variables after the import to re-theme the components:

```css
@import "@sixb/ui/globals.css";
@source "./**/*.{ts,tsx}";

:root {
  --background: #f5f6f2;
  --foreground: #172018;
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

During development, `bun sixb dev` starts the app alongside the API whenever `app/`
has routes. Edits to `.ts`, `.tsx`, and `.css` files rebuild automatically.

```bash
bun sixb dev
```

For production, build the project first, then serve the compiled app. `sixb app`
errors if no built app exists yet:

```bash
bun run build
bun sixb app
```

## Next

- [Querying data](querying-data.md) — fetch objects, telemetry, facets, and
  actions from pages with the typed `@sixb/client/hooks` and `@sixb/client/query`.
- [Typed client](../client/overview.md) — the generated client the hooks build on,
  for non-app callers.
- [Authentication](../auth/authentication.md) — how the app shell establishes the
  auth session that pages run inside.

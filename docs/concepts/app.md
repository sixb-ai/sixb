# App

An app is the interface for your Sixb operating layer. It turns your objects, workflows,
actions, and live data into the screens people use to get work done.

Put it in `app/`.

```txt
app/
  page.tsx                  -> /
  projects/page.tsx         -> /projects
  review/[id]/page.tsx      -> /review/:id
  layout.tsx                -> root wrapper and metadata
  globals.css               -> app styles
  public/logo.svg           -> /logo.svg
```

Only `page.tsx` and `page.ts` create routes. Files or folders starting with `_` are ignored.

## Page

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

Use `@sixb/client/hooks` for API calls, actions, and live events. Sixb sets up React
Router, TanStack Query, auth cookies, and CSRF handling for the app shell.

## Layout

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

## Styles

Use `app/globals.css` for app-wide styles. Plain CSS works as-is.

You can use `@sixb/ui` for shared components and theme tokens:

```css
@import "@sixb/ui/globals.css";
@source "./**/*.{ts,tsx}";

:root {
  --primary: #1f7a5a;
  --primary-foreground: #ffffff;
  --ring: #1f7a5a;
}
```

Override CSS variables after the import to theme the components, or bring your own UI.
When using Tailwind features, install the CLI:

```bash
bun add tailwindcss @tailwindcss/cli
```

## Run

```bash
bun sixb dev
```

If `app/` has routes, dev starts it with the Sixb API. For production:

```bash
bun run build
bun sixb app
```

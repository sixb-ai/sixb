# @pario/ui

Shared UI foundations for Pario apps.

This package contains the design tokens, global CSS, React primitives, and small composed
components used by the built-in Pario server UI. It is intentionally boring: consistent
surface colors, hairline borders, accessible Radix behavior, lucide icons, and a compact
visual language that works for dense operational tools.

## What Lives Here

- **Global styles** in `src/styles/globals.css`
  - Tailwind CSS v4 setup
  - light and dark CSS variables
  - Pario typography, radius, border, scrollbar, and chart tokens
- **shadcn/Radix primitives** in `src/components/ui`
  - buttons, inputs, dialogs, dropdowns, tables, tabs, sidebar, tooltips, and more
- **Pario components** in `src/components`
  - collection headers, card grids, empty states, theme switching, and small charts
- **Hooks and utilities** in `src/hooks` and `src/lib`
  - `ThemeProvider`, `useTheme`, `useIsMobile`, and `cn`

## Usage

Import the global stylesheet once at the app boundary:

```css
@import "@pario/ui/globals.css";
```

Wrap the app with the theme provider if it should support light, dark, and system theme
selection:

```tsx
import type { ReactNode } from "react"
import { ThemeProvider } from "@pario/ui/hooks"

export function AppRoot({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>
}
```

Use components from the package-level component barrel:

```tsx
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@pario/ui/components"

export function DatasetCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>erp.customers</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        <Badge variant="secondary">synced</Badge>
        <Button size="sm">Open</Button>
      </CardContent>
    </Card>
  )
}
```

For low-level imports, use the explicit subpaths:

```tsx
import { Button } from "@pario/ui/components/ui/button"
import { cn } from "@pario/ui/lib/utils"
```

## Design Notes

The package is tuned for product surfaces, not marketing pages. Prefer dense, scannable
layouts; quiet color; restrained borders; and clear interaction states. Cards should frame
real repeated items or tools, not every page section.

Most visual decisions should come from the tokens in `globals.css`. If a component needs a
new color, radius, or semantic state, add the token first and then consume it through
Tailwind classes.

## Development

Run the component preview from the repo root:

```bash
bun run ui:dev
```

Or run the package directly:

```bash
bun --filter @pario/ui dev
```

The preview server listens on `http://localhost:3010`.

Typecheck the package:

```bash
bun --filter @pario/ui typecheck
```

## Adding Components

This package follows the local shadcn configuration in `components.json`.

From the repo root:

```bash
bun run ui:add button
```

After adding a primitive:

1. Export it from `src/components/index.ts`.
2. Make sure it uses `@pario/ui/lib/utils` for `cn`.
3. Keep styling aligned with the existing tokens and compact sizing.
4. Add it to the preview app when seeing it in context would help future changes.
5. Run `bun --filter @pario/ui typecheck`.

## Public Exports

```ts
import { Button, Card, EmptyState, MiniSparkline, ThemeSwitcher } from "@pario/ui/components"
import { ThemeProvider, useTheme, useIsMobile } from "@pario/ui/hooks"
import { cn } from "@pario/ui/lib"
```

The package is currently private to the workspace, so treat it as an internal foundation for
Pario-maintained apps and packages.

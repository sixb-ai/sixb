# @sixb/ui

Shared UI foundations for Sixb apps.

This package contains the design tokens, global CSS, React primitives, and small composed
components used by the built-in Sixb server UI. It is intentionally boring: consistent
surface colors, hairline borders, accessible Radix behavior, lucide icons, and a compact
visual language that works for dense operational tools.

## What Lives Here

- **Global styles** in `src/styles/globals.css`
  - Tailwind CSS v4 setup
  - light and dark CSS variables
  - Sixb typography, radius, border, scrollbar, and chart tokens
- **shadcn/Radix primitives** in `src/components/ui`
  - buttons, inputs, dialogs, dropdowns, tables, tabs, sidebar, tooltips, and more
- **Sixb components** in `src/components`
  - collection headers, card grids, empty states, theme switching, and small charts
- **Hooks and utilities** in `src/hooks` and `src/lib`
  - `ThemeProvider`, `useTheme`, `useIsMobile`, and `cn`

## Usage

Import the global stylesheet once at the app boundary:

```css
@import "@sixb/ui/globals.css";
```

Wrap the app with the theme provider if it should support light, dark, and system theme
selection:

```tsx
import type { ReactNode } from "react"
import { ThemeProvider } from "@sixb/ui/hooks"

export function AppRoot({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>
}
```

Use components from the package-level component barrel:

```tsx
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@sixb/ui/components"

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
import { Button } from "@sixb/ui/components/ui/button"
import { cn } from "@sixb/ui/lib/utils"
```

## Theming

Every color, font, radius, and shadow in this package resolves through CSS variables, and
Tailwind utilities consume them via the `@theme inline` block in `globals.css`
(`--color-primary: var(--primary)` makes `bg-primary` themeable, and so on). An app
re-themes the entire component set by overriding the variables in its own stylesheet after
the import — no Tailwind config, no component changes:

```css
@import "@sixb/ui/globals.css";
@source "./**/*.{ts,tsx}";

:root {
  --background: #f5f6f2;
  --primary: #1f7a5a;
  --primary-foreground: #ffffff;
  --ring: #1f7a5a;
}
```

Light values belong on `:root`; if the app supports dark mode, put the dark values on
`.dark` (the package toggles that class via `ThemeProvider`). `examples/acme-corp` is a
complete working override.

The token contract:

| Group | Tokens | Used for |
| --- | --- | --- |
| Page | `--background`, `--foreground` | body background and default text |
| Surfaces | `--card`, `--popover` (+ `-foreground`) | cards, menus, dialogs, inputs |
| Brand | `--primary`, `--secondary`, `--accent`, `--muted` (+ `-foreground`) | buttons, badges, hovers, secondary text |
| Status | `--destructive` (+ `-foreground`), `--success`, `--warning`, `--info` | errors, confirmations, alerts |
| Chrome | `--border`, `--input`, `--ring` | hairlines, field borders, focus rings |
| Charts | `--chart-1` … `--chart-5` | data-viz series colors |
| Sidebar | `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring` (+ `-foreground` pairs) | the sidebar component family |
| Type & shape | `--font-sans`, `--font-serif`, `--font-mono`, `--radius` | typography and corner rounding |
| Elevation | `--shadow-2xs` … `--shadow-2xl` | shadows (hairline-only by default) |

Pairs matter: anything that sets a background token should keep its `-foreground` partner
readable (e.g. a dark `--primary` needs a light `--primary-foreground`). When only a few
tokens are overridden, the rest keep the package defaults, so partial themes are fine.

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
bun --filter @sixb/ui dev
```

The preview server listens on `http://localhost:3010`.

Typecheck the package:

```bash
bun --filter @sixb/ui typecheck
```

## Adding Components

This package follows the local shadcn configuration in `components.json`.

From the repo root:

```bash
bun run ui:add button
```

After adding a primitive:

1. Export it from `src/components/index.ts`.
2. Make sure it uses `@sixb/ui/lib/utils` for `cn`.
3. Keep styling aligned with the existing tokens and compact sizing.
4. Add it to the preview app when seeing it in context would help future changes.
5. Run `bun --filter @sixb/ui typecheck`.

## Public Exports

```ts
import { Button, Card, EmptyState, MiniSparkline, ThemeSwitcher } from "@sixb/ui/components"
import { ThemeProvider, useTheme, useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib"
```

The package is currently private to the workspace, so treat it as an internal foundation for
Sixb-maintained apps and packages.

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
  - buttons, inputs, charts, dialogs, dropdowns, tables, tabs, sidebar, tooltips, and more
- **Agent/chat primitives** in `src/components/ui`
  - message scrollers, bubbles, markers, attachments, and streaming status utilities
- **Sixb components** in `src/components`
  - collection headers, card grids, empty states, theme switching, and small charts
  - address entry in `src/components/address`
- **Hooks and utilities** in `src/hooks` and `src/lib`
  - `ThemeProvider`, `useTheme`, `useIsMobile`, `useDebouncedValue`, and `cn`
- **Address lookup** in `src/lib/address`
  - the provider contract, the Photon provider, and address formatters
- **Speech dictation** in `src/lib/speech` and `src/components/speech`
  - the recognizer contract, the Web Speech recognizer, and microphone components

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

## Agent Chat Primitives

The package includes shadcn's newer chat-oriented primitives, adapted to Sixb's tokens and
exported from the normal component barrel:

| Component | Purpose |
| --- | --- |
| `MessageScroller*` | Accessible auto-scroll container for chat/thread views |
| `Bubble`, `BubbleContent`, `BubbleGroup`, `BubbleReactions` | User and assistant message bubbles |
| `Marker`, `MarkerIcon`, `MarkerContent` | Status rows, run checkpoints, separators, and tool activity |
| `Attachment*` | File, dataset, and generated-artifact previews |

Typical thread composition:

```tsx
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Bubble,
  BubbleContent,
  BubbleGroup,
  Marker,
  MarkerContent,
  MarkerIcon,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Spinner,
} from "@sixb/ui/components"

export function AgentThread() {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="h-full rounded-lg border border-border bg-background">
        <MessageScrollerViewport>
          <MessageScrollerContent className="p-4">
            <MessageScrollerItem messageId="request" scrollAnchor>
              <BubbleGroup className="items-end">
                <Bubble align="end">
                  <BubbleContent>Summarize the failed invoice rows.</BubbleContent>
                </Bubble>
              </BubbleGroup>
            </MessageScrollerItem>

            <MessageScrollerItem messageId="status" scrollAnchor>
              <Marker role="status">
                <MarkerIcon>
                  <Spinner />
                </MarkerIcon>
                <MarkerContent className="shimmer text-muted-foreground">
                  Generating response...
                </MarkerContent>
              </Marker>
            </MessageScrollerItem>

            <MessageScrollerItem messageId="attachment" scrollAnchor>
              <Attachment state="done">
                <AttachmentMedia />
                <AttachmentContent>
                  <AttachmentTitle>invoice-review.csv</AttachmentTitle>
                  <AttachmentDescription>18 KB</AttachmentDescription>
                </AttachmentContent>
              </Attachment>
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
```

`MessageScroller` uses `@shadcn/react/message-scroller` for the scroll state machine.
Keep chat-specific behavior in app code; `@sixb/ui` should stay visual and compositional.

## CSS Utilities

`globals.css` includes a small set of shared utilities used by chat and dense app
surfaces:

- `scroll-fade`, `scroll-fade-x`, `scroll-fade-y`, edge utilities like
  `scroll-fade-b`, and size utilities like `scroll-fade-24`
- `shimmer`, `shimmer-once`, `shimmer-reverse`, `shimmer-none`
- `shimmer-color-*`, `shimmer-duration-*`, `shimmer-spread-*`, `shimmer-angle-*`
- `scrollbar-thin`, `scrollbar-none`, `no-scrollbar`, and `scrollbar-gutter-stable`

The shimmer defaults match shadcn's utility behavior: `2s` duration,
`calc(3ch + 40px)` spread, `20deg` angle, current-color-derived highlight, RTL-aware
direction, and reduced-motion fallback. Sixb exposes those defaults as CSS variables so
apps can theme them after importing the stylesheet:

```css
@import "@sixb/ui/globals.css";

:root {
  --shimmer-duration: 1800ms;
  --shimmer-angle: 24deg;
  --shimmer-spread: 4.5rem;
  --shimmer-highlight: color-mix(in oklch, currentColor 32%, transparent);
}
```

## Address Lookup

Most Sixb apps need address entry, so the lookup lives here in three layers. Apps normally
touch only the components.

| Layer | Import | Purpose |
| --- | --- | --- |
| Components | `@sixb/ui/components` | `AddressAutocomplete` (one text value), `AddressFields` (structured draft) |
| Hooks | `@sixb/ui/hooks` | `useAddressLookup`, `AddressLookupProvider`, `useAddressProvider` |
| Providers | `@sixb/ui/lib/address` | `AddressProvider` contract, `createPhotonProvider`, formatters |

It works with no configuration — lookups fall back to a shared
[Photon](https://photon.komoot.io) provider, which is free and needs no API key:

> **Where the data goes.** The default sends what you type to `photon.komoot.io`, debounced and
> from the third character on. Self-host Photon or supply your own `AddressProvider` before typing
> confidential addresses into it.

```tsx
import { AddressFields } from "@sixb/ui/components"
import { type AddressDraft, EMPTY_ADDRESS_DRAFT } from "@sixb/ui/lib/address"
import { useState } from "react"

export function BillingAddressForm() {
  const [address, setAddress] = useState<AddressDraft>(EMPTY_ADDRESS_DRAFT)
  return <AddressFields value={address} onChange={setAddress} />
}
```

When the app stores a single formatted string instead of components, use the autocomplete
directly:

```tsx
<AddressAutocomplete
  value={site.address}
  onValueChange={(next) => setSite({ ...site, address: next })}
  onSelect={(suggestion) => setSite({ ...site, county: suggestion.county })}
  countries={["US"]}
/>
```

Configure the provider once at the app boundary — for example to point at a self-hosted
Photon instance, since the public one is best-effort with no SLA:

```tsx
import { AddressLookupProvider } from "@sixb/ui/hooks"
import { createPhotonProvider } from "@sixb/ui/lib/address"

const addresses = createPhotonProvider({
  endpoint: "https://photon.internal.example",
  countries: ["US"],
  proximity: { latitude: 40.7128, longitude: -74.006 },
})

export function AppRoot({ children }: { children: React.ReactNode }) {
  return <AddressLookupProvider provider={addresses}>{children}</AddressLookupProvider>
}
```

### Suggestions

`AddressSuggestion` is a superset of what the providers return, so no app has to give up a
field it stores. `region` keeps the provider's spelling (`"New York"`) while `regionCode`
carries the short form (`"NY"`); `raw` is the untouched provider payload for app-specific
enrichment. `formatAddress`, `formatAddressLine`, and `addressDraftFromSuggestion` project a
suggestion onto whatever shape the app persists.

### Adding a Provider

Implement `AddressProvider`. Only `id` and `search` are required; the optional members exist
so richer backends drop in without touching call sites:

- `retrieve` — for providers whose search returns predictions rather than addresses. Google
  Places and Mapbox both need a second details request to get components and coordinates;
  mark those results `partial` and `useAddressLookup`'s `select` will resolve them on choice.
- `createSession` — for providers that bill per lookup session. The hook mints one token for
  a run of keystrokes and discards it after the details call.
- `reverse` — coordinates to an address, for "use my location" and map-pin flows.

Providers must stay free of React imports so they can also run server-side.

Data licenses that require credit expose an `attribution` string, which the components
render under the suggestion list. Photon serves OpenStreetMap data, so leave that in place
unless the replacement provider's terms differ.

## Speech Dictation

Microphone-to-text for fields that are faster to speak than to type, layered the same
way as address lookup.

| Layer | Import | Purpose |
| --- | --- | --- |
| Components | `@sixb/ui/components` | `DictationTextarea`, `DictationButton` |
| Hooks | `@sixb/ui/hooks` | `useDictation`, `useSpeechRecognition`, `SpeechRecognitionProvider` |
| Recognizers | `@sixb/ui/lib/speech` | `SpeechRecognizer` contract, `createWebSpeechRecognizer` |

The default recognizer is the browser's own Web Speech API — no key and no setup:

> **Where the data goes.** "In the browser" is not "on the device": Chrome implements
> `webkitSpeechRecognition` by streaming the audio to Google. Supply your own `SpeechRecognizer`
> for confidential dictation.

```tsx
import { DictationTextarea } from "@sixb/ui/components"
import { useState } from "react"

export function ScopeOfWorkField() {
  const [scope, setScope] = useState("")
  return (
    <DictationTextarea
      label="Scope of work"
      onChange={setScope}
      placeholder="Describe the work, or press the microphone and say it."
      value={scope}
    />
  )
}
```

Dictation appends to whatever the field already holds, and the field goes read-only while
listening so typed and spoken text cannot interleave.

### Owning the hook

Pass `dictation` when the app needs the state outside the component — most often to stop two
microphones from running at once:

```tsx
const scope = useDictation({ value: scopeText, onChange: setScopeText })
const notes = useDictation({ value: notesText, onChange: setNotesText })

<DictationTextarea
  busyReason={notes.isActive ? "Stop the other dictation first" : undefined}
  dictation={scope}
  label="Scope of work"
  onChange={setScopeText}
  value={scopeText}
/>
```

For anything that is not a text field — voice commands, a transcript panel, an agent composer
— use `useSpeechRecognition` directly and read `transcript` and `interimTranscript` yourself.
`DictationButton` renders the microphone toggle for either hook.

### Browser support

The Web Speech API works in Chrome, Edge, and Safari but **not Firefox**, so `supported` is
part of the contract: it is `null` until probed on the client, then `true` or `false`.
`DictationButton` disables itself and `DictationTextarea` shows a "type instead" message when
it is `false` — dictation is always an accelerator, never the only way to enter text.

Two behaviors worth knowing:

- Chrome stops listening after a short silence even with `continuous`, so the hook restarts
  the session automatically (`autoRestart`, on by default) and accumulates the transcript
  across restarts. It gives up after a few silent restarts rather than reconnecting forever.
- Chrome streams microphone audio to Google's servers for recognition. If that is
  unacceptable for a project, supply a different recognizer.

### Adding a Recognizer

Implement `SpeechRecognizer` — `id`, `isSupported()`, and `start(options, handlers)` returning
a session with `stop()` and `abort()`. The contract is event-driven, so a
record-then-transcribe backend (MediaRecorder plus a server call) fits by emitting one final
result when the recording stops and never emitting interim ones. Configure it once at the app
boundary:

```tsx
import { SpeechRecognitionProvider } from "@sixb/ui/hooks"

<SpeechRecognitionProvider recognizer={whisperRecognizer}>{children}</SpeechRecognitionProvider>
```

Recognizers must stay free of React imports.

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
`.dark` (the package toggles that class via `ThemeProvider`). `examples/northline` is a
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
| Motion utilities | `--shimmer-duration`, `--shimmer-spread`, `--shimmer-angle`, `--shimmer-highlight` | shimmer defaults for streaming text |

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

If that port is already occupied, set `PORT`:

```bash
PORT=3011 bun --filter @sixb/ui dev
```A

Build the static preview bundle:

```bash
bun --filter @sixb/ui build:preview
```

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
3. Use `radix-ui` and `lucide-react` imports in the same style as nearby files.
4. Keep styling aligned with the existing tokens and compact sizing.
5. Add it to the preview app when seeing it in context would help future changes.
6. Run `bun --filter @sixb/ui typecheck`.

Some shadcn v4 utilities and newer chat primitives are distributed through the upstream
registry/CSS package before the CLI has stable aliases for every configured style. When
that happens, prefer copying the upstream registry component source, adapting imports to
`@sixb/ui`, and documenting any vendored CSS utility in this README.

## Public Exports

```ts
import {
  AddressAutocomplete,
  AddressFields,
  Attachment,
  Bubble,
  Button,
  Card,
  DictationButton,
  DictationTextarea,
  EmptyState,
  Marker,
  MessageScroller,
  MiniSparkline,
  ThemeSwitcher,
} from "@sixb/ui/components"
import {
  AddressLookupProvider,
  SpeechRecognitionProvider,
  ThemeProvider,
  useAddressLookup,
  useDebouncedValue,
  useDictation,
  useIsMobile,
  useSpeechRecognition,
  useTheme,
} from "@sixb/ui/hooks"
import { type AddressProvider, createPhotonProvider, formatAddress } from "@sixb/ui/lib/address"
import { createWebSpeechRecognizer, type SpeechRecognizer } from "@sixb/ui/lib/speech"
import { cn } from "@sixb/ui/lib/utils"
```

Treat this package as the maintained shared UI foundation for Sixb apps and packages. Keep
public exports intentional, documented, and covered by the preview when they affect visual
or interaction behavior.

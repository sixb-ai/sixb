# On a Phone

Every Sixb app behaves like an installed native app on a phone, with nothing to set up: the
keyboard slides over a page that stays still, dialogs rise as sheets that pull down to close,
screens push and pop, and pulling down refreshes. With `AppShell` and nav data, a phone also gets a
native shell: a top bar, a tab bar and a More sheet. Wider screens are unchanged.

People install the app from Safari with **Share › Add to Home Screen**.

## What every app gets

| Behaviour | What happens |
| --- | --- |
| Keyboard | The page never scrolls behind the keyboard. What sits at the bottom, such as a composer or a sheet, rides up on it, and a focused field scrolls clear inside its own pane |
| Sheets | Dialogs and drawers float as iOS sheets above the home indicator and the keyboard, and pull down to close |
| Screens | A pushed screen slides in over the one it leaves; Back reverses it. Moving between sections swaps in place, as tabs do |
| Scroll | A new screen starts at the top; Back returns to where the screen was left |
| Refresh | Pulling down at the top of a page refetches what it shows |
| Back swipe | iOS's own, from the screen's edge, once there is somewhere to go back to |
| Controls | Fields are 16px so iOS never zooms, controls take a 44pt touch area, toasts drop in as banners |

Where a screen sits comes from its address: `/quotes` is a top-level screen, `/quotes/q-1` is
pushed on it, and Back from a screen opened directly goes up to `/quotes`. Call `useBack()` for a
back button of your own.

## Opening, offline and coming back

A production build gives the installed app the rest of a native app's life cycle:

| Moment | What happens |
| --- | --- |
| Opening | iOS shows a launch image of the app's background with its icon in the middle, and the app takes over from an identical loading screen. Both follow the app's light or dark theme |
| Offline | The app opens from the device. Its pages and files are kept by a service worker; its data still comes from the API, so with no connection it says it is offline and opens once the connection is back |
| Coming back | Back after 30 seconds or more, the app refreshes what is on screen. Opened again within 30 minutes after iOS closed it, it reopens on the screen it was left on |

The icon is the app's `favicon` ([metadata](./customization.md#metadata)). Safari draws the launch
image for the device in hand when the app is added to the Home Screen, so an existing install must
be added again to get one.

The service worker is `/sixb-service-worker.js`. Each deploy replaces it and what it keeps, so the
next launch runs the new version. Pages go to the network first and open from the device only when
the network fails or takes longer than three seconds; the API, sign-in and shared links always go
to the network. The development server has no service worker.

## The phone shell

`AppShell` builds it from your `nav`. Mark the places the tab bar holds with `tab`; the rest are in
the More sheet with the account, Artifacts and the Console and Settings. Without `tab`, the first
four places with an icon are the tabs.

File: `app/layout.tsx`

```tsx
import { AppShell, type NavEntry } from "@sixb/app"
import { ClipboardList, Gauge, Network, Sun, UsersRound } from "lucide-react"
import type { PropsWithChildren } from "react"

const nav: NavEntry[] = [
  { label: "Home", href: "/", icon: Sun, tab: true },
  { label: "Service cases", href: "/service-cases", icon: ClipboardList, tab: true },
  { label: "Equipment", href: "/equipment", icon: Gauge, tab: true },
  { group: "Business", items: [
    { label: "Customers", href: "/customers", icon: Network },
    { label: "Technicians", href: "/technicians", icon: UsersRound },
  ] },
]

export default function RootLayout({ children }: PropsWithChildren) {
  return <AppShell nav={nav}>{children}</AppShell>
}
```

The top bar floats over the page as glass, with Search and the agent at its end, and takes the
page's first `<h1>` as its title once the heading scrolls away. A page adds its own controls with
`PhoneBarActions`; they render only while the phone's bar shows.

```tsx
<PhoneBarActions>
  <button type="button" className="phone-bar-action" aria-label="Edit" onClick={edit}>
    <Pencil />
  </button>
</PhoneBarActions>
```

### A shell of your own

The parts are exported for a layout that builds its own sidebar: `PhoneTopBar`, `PhoneTabBar`,
`PhoneMoreSheet` (with `PhoneMoreGroup` and `PhoneMoreRow` for rows of your own) and
`PhoneBarActions`. Render `PhoneMoreSheet` in place of the sidebar on a phone; it opens with the
sidebar, so anything that opens the sidebar opens it. Wrap the page in an element with the
`phone-shell` class, and mark its scroll container `data-app-scroll`.

## The status bar

The installed app draws under the status bar, as a native app does, so a sheet's backdrop dims the
status bar in step with the page. Sixb's shells and screens leave room for it: the phone shell's
bars, the sidebar, which runs up under it as an iPad app's does, the page beside the sidebar,
sheets from the side, and the artifact and agent pages.

A layout of your own leaves the room too. Pad what reaches the top edge by `--safe-top`, which is
zero in a browser. Or start the app below the status bar, where iOS paints the
status bar itself and snaps it to a backdrop's colour out of step with the fade:

```tsx
export const metadata = { title: "My app", statusBar: "below" } satisfies AppMetadata
```

iOS reads the setting when the app is added to the Home Screen, so an existing install must be
removed and added again to pick up a change.

## Opting out and in

| Attribute | On |
| --- | --- |
| `data-fullscreen` | A dialog that fills the screen instead of rising as a sheet, such as a search (`<CommandDialog fullscreen>`) |
| `data-focus-on-tap` | A field that focuses itself: the keyboard waits for a tap on it |
| `data-keyboard-overlay` | A panel that rests on the keyboard without being a dialog |
| `data-no-pull-refresh` | An element that owns vertical drags |

`--keyboard-inset` and `html[data-keyboard]` mark the keyboard while it is up, and `--app-height`
is the height to lay a full-screen view out in.

## Testing

Desktop browsers cannot reproduce the iOS keyboard, safe areas or the installed app. Use an iPhone,
or the iOS Simulator with the app added to the Home Screen. The simulator's synthetic touches never
trigger iOS's back swipe, so check that on a device. The launch image, offline opening and the
service worker need a production build: `sixb build`, then `sixb app`.

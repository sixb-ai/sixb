# Customization

Customize your app's environment, metadata, icons, sign-in screen, and shared-link screen with these
optional files and exports.

## Public environment variables

Prefix variables your browser code needs with `SIXB_PUBLIC_`:

File: `.env`

```dotenv
SIXB_PUBLIC_GOOGLE_MAPS_API_KEY=your-browser-key
```

Read them through `publicEnv`:

```ts
import { publicEnv } from "@sixb/app"

const key = publicEnv.SIXB_PUBLIC_GOOGLE_MAPS_API_KEY
```

Values are strings, or `undefined` when missing. `publicEnv` is empty outside the browser. Restart
the app server after changing values; no rebuild is required.

Public values are visible to users. Keep backend credentials and secrets out of `SIXB_PUBLIC_`
variables.

## Metadata

Export `metadata` from the root `app/layout.tsx` to set the document title, description, and theme.
All fields are optional.

File: `app/layout.tsx`

```tsx
import type { AppMetadata } from "@sixb/app"
import type { PropsWithChildren } from "react"

export const metadata = {
  title: "My app",
  description: "An app built with Sixb.",
  favicon: "/logo.svg",
  themeColor: "#171717",
  backgroundColor: "#ffffff",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return <>{children}</>
}
```

Place `logo.svg` in `app/public/`. The title also names the installed app; `themeColor` sets the
browser theme and `backgroundColor` sets the launch background. The installed app draws under an
iPhone's status bar; `statusBar: "below"` starts it below ([On a Phone](./mobile.md#the-status-bar)).

Only the root layout supplies metadata. It is loaded during app generation, so do not access
`window` or `document` at module scope.

Your app's document language follows the project's
[`locale`](../runtime/overview.md#language-and-time-zone), so browsers and screen readers handle
your content in the right language. The HTML is built without the project, so it starts as
`<html lang="en">` and Sixb sets the project's locale as soon as the app's first API call returns.
A custom sign-in page is served with it. Shared-link pages cannot read project settings, so they
declare the reader's browser language.

Text that Sixb writes itself, such as the assistant's buttons and statuses, dialog close labels, or
the not-found, access, and shared-link screens, is translated into English and French. It follows
the user's browser languages and falls back to the project's `locale`. Your own pages, welcome
content, and labels are shown as you wrote them.

## App icons

Sixb generates a web app manifest at `/app.webmanifest`. Add these files under `app/public/` to
provide browser and home-screen icons:

| File | Size and purpose |
| --- | --- |
| `favicon.svg` | Browser favicon, used when no `metadata.favicon` is set |
| `icon-192.png` | 192 × 192 install icon |
| `icon-512.png` | 512 × 512 install icon |
| `icon-maskable-512.png` | 512 × 512 adaptive icon, with artwork inside the central 80% |
| `apple-touch-icon.png` | 180 × 180 opaque iOS home-screen icon |

The [desktop app](desktop.md) uses `icon-maskable-512.png`, or `icon-512.png` without one.

Installed apps open in standalone mode. Protect important content from device notches and home
indicators with safe-area padding on your app shell:

```css
.app-shell {
  padding-top: max(1rem, env(safe-area-inset-top));
  padding-right: max(1rem, env(safe-area-inset-right));
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
  padding-left: max(1rem, env(safe-area-inset-left));
}
```

Sixb does not add an offline cache or service worker. The generated manifest is managed by Sixb;
you cannot replace it with a file in `app/public/`.

## Custom sign-in

Add `app/auth.tsx` to customize the magic-link sign-in screen. Sixb provides the current state and
actions for requesting a link, confirming sign-in, and starting again.

File: `app/auth.tsx`

```tsx
import type { AuthExperienceProps } from "@sixb/app"
import { useState } from "react"

export default function SignIn({ state, actions }: AuthExperienceProps) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")

  if (state.kind === "checkEmail") return <p>Check your email for a sign-in link.</p>

  if (state.kind === "confirm") {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          actions.confirmSignIn({ displayName: name })
        }}
      >
        {state.firstSignIn ? (
          <label>
            Your name
            <input
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : null}
        <button type="submit">Confirm sign-in</button>
      </form>
    )
  }

  if (state.kind === "invalidLink" || state.kind === "error") {
    return (
      <>
        <p role="alert">Unable to sign in. Request a new link.</p>
        <button type="button" onClick={actions.restartSignIn}>Try again</button>
      </>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        actions.requestMagicLink(email)
      }}
    >
      <label>
        Email
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button type="submit">Send sign-in link</button>
    </form>
  )
}
```

When the link creates the person's account, the confirm state has `firstSignIn: true`, so the
page asks for their name and passes it to `actions.confirmSignIn({ displayName })`. Sixb ignores a
name that is not valid, or one given for an account that already exists.

The sign-in screen uses `app/globals.css` and your app metadata, but is not wrapped in
`app/layout.tsx`. Sixb handles the credentials and session. See
[Authentication](../auth/authentication.md) for setup.

## Shared-link unavailable screen

A [shared link](../auth/shared-access.md) that is invalid, expired, or revoked shows a generic
screen, translated into English and French. Add `app/shared-unavailable.tsx` to show your own, with
your logo and your words:

File: `app/shared-unavailable.tsx`

```tsx
import type { SharedUnavailableProps } from "@sixb/app"

export default function SharedUnavailable({ locale, title }: SharedUnavailableProps) {
  return (
    <main className="unavailable">
      <img src="/logo.svg" alt="Acme" width={48} height={48} />
      <h1>{title}</h1>
      <p>
        {locale === "fr"
          ? "Demandez un nouveau lien à votre contact chez Acme."
          : "Ask your Acme contact for a new link."}
      </p>
    </main>
  )
}
```

The screen receives the reader's `locale` (`"en"` or `"fr"`, from their browser), and Sixb's own
`title` and `description` in that language. It uses `app/globals.css` and files from `app/public/`,
but is not wrapped in `app/layout.tsx`.

It renders without a session: the link opened nothing, so the screen has no data client, router, or
project settings, and an API request it makes is not authenticated. Sixb shows it only when the link
could not be opened. Its own generic screen stays for a temporary failure that the reader can retry,
for a page that fails once the link is open, and in place of yours if yours fails to load or throws.

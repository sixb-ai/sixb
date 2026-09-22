# Customization

Customize your app's environment, metadata, icons, and sign-in screen with these optional files
and exports.

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
browser theme and `backgroundColor` sets the launch background.

Only the root layout supplies metadata. It is loaded during app generation, so do not access
`window` or `document` at module scope.

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
import type { AuthExperienceProps } from "@sixb/app/auth"
import { useState } from "react"

export default function SignIn({ state, actions }: AuthExperienceProps) {
  const [email, setEmail] = useState("")

  if (state.kind === "checkEmail") return <p>Check your email for a sign-in link.</p>

  if (state.kind === "confirm") {
    return <button type="button" onClick={actions.confirmSignIn}>Confirm sign-in</button>
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

The sign-in screen uses `app/globals.css` and your app metadata, but is not wrapped in
`app/layout.tsx`. Sixb handles the credentials and session. See
[Authentication](../auth/authentication.md) for setup.

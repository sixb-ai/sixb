# `@sixb/desktop`

Ships a Sixb project's app as a desktop app, built with [Electron](https://www.electronjs.org).
Install it in a project, and the `sixb` CLI does the rest:

```bash
bun add -d @sixb/desktop
bun sixb dev --desktop      # the dev server, and the app in a desktop window
bun sixb desktop build      # the deployed app, packaged for this machine
```

See [Desktop App](https://docs.sixb.ai/apps/desktop) for what the desktop app takes from the app,
signing, and distribution. The rest of this file is how it works.

## How it works

The CLI does not depend on this package, because it brings Electron. It loads the project's copy
and calls its two exports, `openDesktopApp` and `buildDesktopApp`, with the app's URL and the API's
origin. Both generate the same Electron app first:

```
<app>/app.webmanifest ─▶ name, icon        (src/identity.ts)
        │
        ▼
.sixb/desktop/app/        rewritten on every call (src/generate.ts)
  main.js                 the main process, compiled from src/shell/main.ts
  preload.js              what the page can reach, compiled from src/shell/preload.ts
  shell.json              name, app URL, API origin
  index.html              the page shown while the app loads
  icon.png
        │
        ├─ openDesktopApp   electron .sixb/desktop/app
        └─ buildDesktopApp  @electron/packager ─▶ .sixb/desktop/dist/
```

The window loads the app from where it is served; `app/` is not compiled into the binary. The
page runs sandboxed, with no Node, and reaches the shell only through what `src/shell/bridge.ts`
exposes, which says how to add to it. The window stays on the app and API origins
(`src/shell/window.ts`): any other link opens in the user's browser.

### macOS builds

- **Icon.** `src/mac-icon.ts` redraws the icon on Apple's grid, a rounded square of 824 pixels with
  continuous corners in a canvas of 1024, over a soft shadow. Both were measured against Apple's
  Notes icon. An icon drawn to its edges otherwise stands larger than every icon beside it. It runs
  AppKit through `osascript`, and `sips` and `iconutil` turn the result into `.icns`.
- **Signature.** Packaging breaks the ad-hoc signature Electron ships with, and macOS calls a
  downloaded app with a broken signature damaged, with no way to open it. An unsigned build is
  re-signed ad hoc, so users can allow it. With `APPLE_API_KEY`, `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER`, the packager signs with the keychain's Developer ID certificate and notarizes
  instead.
- **Packager.** `@electron/packager` fails under Bun whenever it verifies a download, so
  `src/packager.mjs` runs it under Electron's own binary as Node.

### Signing in

A window like this cannot finish a sign-in on its own: a magic link opens in the user's browser,
not in the window, and identity providers refuse embedded browsers. So the shell sends the window
to `GET /auth/sign-in/device` instead of the sign-in page, and opens the approval page in the
system browser:

```
window                         API                          system browser
  │  app redirects to /auth/sign-in                              │
  │  shell loads /auth/sign-in/device ─▶ creates an authorization│
  │◀─ "Continue in your browser", cookie holds its secret        │
  │  shell opens /auth/device?user_code=… ──────────────────────▶│ signs in if needed,
  │                                      ◀── Authorize ──────────│ approves
  │  page reloads ─▶ approved: session cookie, back to the app   │
```

The session is an ordinary browser session, kept in the window's persistent cookie store, so later
launches open straight into the app. `src/shell/navigation.ts` holds those two decisions as a pure
function; `src/shell/main.ts` wires them to the window.

### Title bar

On macOS the window has no title bar: the app draws to the top edge and the window controls float
over it. Two things a title bar did then come from the shell (`src/shell/window.ts`):

- A 36px strip across the top is the handle the window is dragged by. Buttons, links and form
  controls under it still take their clicks; the space between them moves the window.
- `<html data-sixb-desktop="inset">` and `--sixb-desktop-controls-height` let an app make room for
  the controls. The sidebar of the default `AppShell` is moved down for it already.

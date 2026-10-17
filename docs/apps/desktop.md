# Desktop App

Ship your app as a desktop app: its own window, Dock or taskbar icon, and sign-in, around the same
app people open in the browser. Sixb builds it with [Electron](https://www.electronjs.org) from what
the app already declares, so there is nothing new to configure.

The desktop app opens your deployed app; it does not contain it. Every deploy reaches desktop users
as it reaches the browser, and you rebuild the desktop app only to change its name or icon.

## Add it

```bash
bun add -d @sixb/desktop
```

The package brings Electron, so only projects that ship a desktop app download it.

## Develop in a window

```bash
bun sixb dev --desktop
```

The window opens once the dev server is ready and stays open while you work: the app reloads
itself as you edit. Stopping `sixb dev` closes it.

## Build it

```bash
bun sixb desktop build
```

The build opens your app where it is deployed: the domains in `sixb.deploy.ts`, or the
`SIXB_APP_PUBLIC_ORIGIN` and `SIXB_API_PUBLIC_ORIGIN` variables (or the `--app-public-origin` and
`--api-public-origin` flags). The app must be running there, because the build reads the app's name
and icon from it.

It packages the app for the platform and architecture you build on, into `.sixb/desktop/dist/`: on
macOS a `.zip` of the app to hand out, elsewhere the app's folder.

To try a build against `sixb dev`, point it at the local app and API:

```bash
bun sixb desktop build --app-public-origin http://localhost:3000 --api-public-origin http://localhost:3001
```

## Name and icon

The desktop app takes its identity from your app's [metadata and icons](customization.md#metadata),
the same ones a browser installs the app from:

| Desktop app | Comes from                                                                |
| ----------- | ------------------------------------------------------------------------- |
| Name        | `metadata.title` in `app/layout.tsx`                                      |
| Icon        | `app/public/icon-maskable-512.png`, or else `app/public/icon-512.png`      |
| Version     | `version` in the project's `package.json`                                 |
| App id      | The app's domain, reversed: `orders.acme.com` becomes `com.acme.orders`   |

On macOS the icon is cut to the rounded square every Mac app icon uses, with the same margin and
shadow, so it sits at the size of the icons beside it. A maskable icon, with its background drawn to
the edges and its artwork inside the central 80%, is made for this.

Each deployment has its own domain, so a build of your staging app installs beside the production
one.

## Signing in

A desktop window cannot finish a sign-in itself: sign-in links open in the user's browser, and
identity providers refuse embedded browsers. So when the app asks the user to sign in, the window
shows **Continue in your browser** and opens an approval page there. The user approves, signing in
first if they need to, and the window continues signed in. It stays signed in across launches, until
the session ends.

This works with every sign-in method, because the sign-in itself happens in the browser.

## Distribute it

Host the `.zip` anywhere people can download it.

Unsigned, a downloaded Mac app opens only once the user allows it: they open it, then click **Open
Anyway** in System Settings → Privacy & Security. Macs managed by an IT department may not allow
this. On Windows, users choose **More info**, then **Run anyway**.

To sign and notarize the macOS app, so that it opens like any other download, join the Apple
Developer Program, put a Developer ID Application certificate in your keychain, and build with an
App Store Connect API key:

```bash
APPLE_API_KEY=~/keys/AuthKey_ABC123.p8 APPLE_API_KEY_ID=ABC123 APPLE_API_ISSUER=<issuer-id> \
  bun sixb desktop build
```

To install a build on your own Mac, copy it into Applications:

```bash
ditto ".sixb/desktop/dist/Acme Orders-darwin-arm64/Acme Orders.app" "/Applications/Acme Orders.app"
```

## The window

The window stays on your app and API. A link to any other site opens in the user's browser.

On macOS the window has no title bar: your app draws to the top edge, with the window controls over
it and a strip across the top to drag the window by. The default `AppShell` sidebar makes room for
the controls. Another layout can read `html[data-sixb-desktop]` and the
`--sixb-desktop-controls-height` variable. A clickable element in the strip other than a link,
button or form control needs `-webkit-app-region: no-drag`.

## Limitations

- `sixb desktop build` is tested on macOS. On Windows and Linux it packages the app's folder,
  unsigned and without an icon.
- There is no installer and no automatic update of the desktop app itself. A new build is
  downloaded again; deploys reach users without one.
- Under `sixb dev --desktop`, macOS names the app Electron in the menu bar and app switcher. Built
  apps carry their own name.

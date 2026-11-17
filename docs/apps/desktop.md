# Desktop App

Ship your app as a desktop app: its own window, Dock or taskbar icon, and sign-in, around the same
app people open in the browser. Sixb builds it with [Electron](https://www.electronjs.org) from what
the app already declares, so there is nothing new to configure.

The desktop app opens your deployed app; it does not contain it. Every deploy reaches desktop users
as it reaches the browser. You release the desktop app again to change its name or icon, or to pick
up a new version of `@sixb/desktop`.

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

It packages the app for the system you build on. On macOS that's one app for Apple silicon and
Intel, in a disk image at `.sixb/desktop/release/darwin/install.dmg`; elsewhere it's the app's
folder in `.sixb/desktop/dist/`.

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

Release the desktop app to your deployment, and people download it from your app:

```bash
bun sixb desktop release
```

It builds the app for the system you run it on, signs and notarizes it, and publishes it to the
deployment in `sixb.deploy.ts`. Releases are made for macOS. Then:

- The user menu shows **Download for Mac** to people on a Mac. They get a disk image named after
  your app, drag the app to Applications, open it, and approve its sign-in in their browser.
- Installed apps update themselves. A new release downloads in the background, and takes over the
  next time the app starts.

A release takes its version from `version` in the project's `package.json`. To release again,
raise it. When the deployment already serves that version, `release` says so and builds nothing;
an older version is refused. `sixb desktop status` shows what the deployment serves:

```text
            Released   package.json
macOS       1.1.0      1.2.0
```

### Signing

A release is always signed and notarized, so it opens like any other download. You need a
membership in the [Apple Developer Program](https://developer.apple.com/programs/), a **Developer
ID Application** certificate exported with its private key as a `.p12`, and an App Store Connect
API key with the Developer role. Set them where you release, in `.env` or the
[project's source](../deployment/environment-variables.md):

| Variable | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | The `.p12`, base64-encoded: `base64 -i certificate.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12`'s password |
| `APPLE_API_KEY` | The API key's `.p8` file, or its contents |
| `APPLE_API_KEY_ID` | The API key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown with your API keys in App Store Connect |

On a Mac that has the certificate in its keychain, leave out `APPLE_CERTIFICATE`. macOS shows the
certificate's name as the app's developer; the app's name and icon stay your app's.

`sixb desktop build` signs with the same variables when they are set. Without them it builds an
unsigned app to try on your own Mac: downloaded, macOS blocks it until the person clicks **Open
Anyway** in System Settings → Privacy & Security.

### Release from CI

With the variables set where you run it, [`sixb deploy ci`](../deployment/github-actions.md#the-desktop-app)
adds a Mac job to the deploy workflow that releases the desktop app after each deploy that raises
the version.

### Where releases are served

Your app serves them from its own domain, under `/__sixb/desktop/`, from the folder
`SIXB_DESKTOP_DIR` names. A deployment made with `sixb deploy` sets this up. When you run the app
server yourself, set `SIXB_DESKTOP_DIR` for it, and copy what `sixb desktop build` writes to
`.sixb/desktop/release/` into that folder.

## The window

The window stays on your app and API. A link to any other site opens in the user's browser.

On macOS the window has no title bar: your app draws to the top edge, with the window controls over
it and a strip across the top to drag the window by. The default `AppShell` sidebar makes room for
the controls. Another layout can read `html[data-sixb-desktop]` and the
`--sixb-desktop-controls-height` variable. A clickable element in the strip other than a link,
button or form control needs `-webkit-app-region: no-drag`.

## Run the agent on this computer

In the desktop app, a new conversation runs on the person's computer by default, with nothing to install
or configure. A line under the composer picks the folder or **Cloud**, and the first message asks for a
folder. While the app is closed, messages wait for it.

The agent works only in folders the person chose on that computer, for that project. Once one is allowed,
whoever is signed in as them can send it messages from the web, and the agent's commands run there without
asking.

The first folder signs the computer in with one approval in the browser, or uses a `sixb login` for that
project, and conversations run as that account. Sign it out in **Settings**: signing out of the window
doesn't end it.

On Windows, which has no local sandbox yet, conversations run in the cloud. On Linux, the computer
needs `bwrap`, or its turns fail.

## Check for the desktop app in your code

`useDesktop` tells your app where it is running, from the first render:

```tsx
import { useDesktop } from "@sixb/client/hooks"

function SearchHint() {
  const desktop = useDesktop()
  return <kbd>{desktop?.platform === "darwin" ? "⌘K" : "Ctrl K"}</kbd>
}
```

It returns `null` in a browser, and in a desktop app built before this hook existed, so treat `null`
as "use the browser's behavior". Every deploy reaches installed apps without a rebuild, which means
your code can run inside a desktop app older than itself.

Use it to decide what to show, not what to allow: a page can set the value it reads. Enforce
permissions on your API, as you do for the browser.

`desktop.computer` is missing from a desktop app older than your code. A page can't allow a folder on its
own: `pickFolder` returns what the person chose, and `allowFolder(folder)` asks them first.

```ts
const about = await desktop?.computer?.about() // { id, name }, or null where it can't run the agent; rejects if it can, but couldn't start
const folder = await desktop?.computer?.pickFolder() // the system's dialog; null if they cancel
```

## Limitations

- Releases are made for macOS. On Windows and Linux, `sixb desktop build` packages the app's
  folder, unsigned and without an icon.
- Under `sixb dev --desktop`, macOS names the app Electron in the menu bar and app switcher. Built
  apps carry their own name.

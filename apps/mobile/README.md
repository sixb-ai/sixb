# Sixb mobile (proof of concept)

An Expo app that connects to a running Sixb instance and chats with its agent, with a searchable
history of your conversations.

## Run it

1. Start an instance with an agent. Northline is the example that has one:

   ```bash
   AI_GATEWAY_API_KEY=… bun --filter @sixb/example-northline dev
   ```

2. Start the app in the iOS simulator (Expo Go installs itself on first run):

   ```bash
   cd apps/mobile && bun run ios
   ```

3. Enter `localhost:3002` as the workspace address. Use `localhost`, not `127.0.0.1`: the API
   accepts WebSocket upgrades only from its public origin, which in development is
   `http://localhost:3002`.

On a phone, run Expo Go on the same network. Find your computer's address on that network
(`ipconfig getifaddr en0` on a Mac), then start the instance from `examples/northline` so it
listens on the network and names that address as its origin:

```bash
bun run dev --api-host 0.0.0.0 --api-public-origin http://<your-computer's-address>:3002
```

Then enter `<your-computer's-address>:3002` in the app.

## How it works

- **Connecting.** The app calls `GET /api/auth/session` to confirm the address is a Sixb API and to
  learn whether it needs sign-in. An instance without sign-in (Northline in development) opens
  straight away. Otherwise the app runs the same device sign-in as `sixb login`. It opens the
  instance's approval page in an in-app browser sheet, polls until you approve, then closes the
  sheet. The session's tokens live in the keychain and refresh on their own.
- **Scanning a sign-in code.** In a signed-in browser, choose **Sign in on another device** from
  the account menu (Atlas, or the auth example's custom app). Scan the QR code with **Scan
  sign-in code**, the connect screen's main button. The code carries the API address too, so
  there's nothing to type. Opening its `sixb://connect` link from the iPhone Camera app works in a
  development build; in Expo Go, use the in-app scanner. In development the code names the API's
  public origin, so a phone needs the instance started with `--api-public-origin` (see above).
- **Chat.** Asking from Today turns that screen into the conversation in place. Today's content
  fades out and the new messages animate in; back returns to a fresh Today. History (the clock on
  Today) lists every conversation, grouped by date and searchable by title; one opened from there
  gets its own screen, with the same transcript and composer. The first message creates the
  thread, posts the message, and follows the run on `/ws/agents`. `liveRunReducer` from
  `@sixb/client`, which Atlas uses too, folds the stream into text and tool parts until the saved
  message replaces them. The client opens its sockets through React Native's `WebSocket`, which
  takes the session's headers as a third argument (`webSocket` in `src/lib/workspace.ts`).
- **Appearance.** The app follows the system's light or dark mode as it changes. Each screen
  builds its styles from the current palette in `src/lib/theme.ts`; the connect and scanner
  screens stay dark in both. Floating controls (the composer, header buttons, search and
  address fields) are glass: iOS 26's Liquid Glass where available, a frosted blur elsewhere
  (`src/components/Glass.tsx`).
- **Workspace packages.** Metro reads `@sixb/*` from source through the `bun` export condition
  (`metro.config.js`), as Atlas does, so the app needs no package build.

## Checks

The repo's `bun run typecheck` and `bun run test` cover the app. To run only its checks, from the
repo root:

```bash
bun run build:types                      # TypeScript reads the packages' emitted declarations
bun --filter @sixb/mobile typecheck
bun test apps/mobile/tests
```

The tests cover the logic that needs no device: workspace addresses, history grouping and search,
upload names, chat titles and message parts. That logic lives in modules that import nothing from
React Native or Expo (`src/lib/workspace-address.ts`, `history.ts`, `format.ts`, and
`agent/{files,titles,types}.ts`), which is what lets `bun test` load them. Keep it that way when
adding to them.

## Icon and splash

`assets/` holds the app icon, the Android icon's foreground and the splash image for each
appearance. All are the brand mark from `apps/docs/app/icon.svg`. The icon is the mark, small, on
white. The splash is the mark alone on the app's own background (`#F4F4F2`, or `#0B0B0C` in dark
mode), which is also what the app shows while it reads the saved workspace, so opening it is one
unbroken surface.

The splash appears in a development or release build. Expo Go draws its own loading screen
instead: a white page with the icon and the app's name.

// The desktop shell's main process. `writeDesktopApp` compiles this file into the generated
// Electron app; nothing imports it.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, type Event, nativeTheme, session, shell } from "electron"
import { createNavigationState, isWebUrl, nextNavigationStep, type ShellConfig } from "./navigation"
import { HIDDEN_TITLE_BAR_CSS, isAppUrl, mayNavigate, WINDOW_BACKGROUND } from "./window"

// Chromium's code for a load that was replaced by another one, which is not a failure.
const ERR_ABORTED = -3

// Not `__dirname`: the bundler replaces it with this source file's directory at compile time,
// which is not where the compiled app lives.
const appDir = app.getAppPath()
const config = JSON.parse(readFileSync(join(appDir, "shell.json"), "utf-8")) as ShellConfig
const loadingPage = join(appDir, "index.html")
const icon = existsSync(join(appDir, "icon.png")) ? join(appDir, "icon.png") : undefined
// Only macOS draws window controls over the page; elsewhere the title bar stays.
const inset = process.platform === "darwin"
const state = createNavigationState()

app.setName(config.name)

function createWindow(): void {
  const win = new BrowserWindow({
    title: config.name,
    width: 1280,
    height: 832,
    titleBarStyle: inset ? "hiddenInset" : "default",
    icon,
    // Opens once the loading page has painted, over a background of that page's color.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors
      ? WINDOW_BACKGROUND.dark
      : WINDOW_BACKGROUND.light,
    webPreferences: {
      // The window shows a remote page: it gets no Node, and a world apart from the preload's.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: inset ? join(appDir, "preload.js") : undefined,
    },
  })
  const contents = win.webContents
  win.once("ready-to-show", () => win.show())

  // A load that fails or is replaced also rejects; `did-fail-load` below is what answers it.
  const load = (url: string) => void win.loadURL(url).catch(() => {})

  function onNavigation(url: string, event?: Event): void {
    const step = nextNavigationStep(config, state, url)
    if (step?.kind === "load") {
      event?.preventDefault()
      load(step.url)
      return
    }
    if (step?.kind === "open-external") void shell.openExternal(step.url)
    if (event && !mayNavigate(config, url)) {
      event.preventDefault()
      if (isWebUrl(url)) void shell.openExternal(url)
    }
  }

  contents.on("will-navigate", (event, url) => onNavigation(url, event))
  contents.on("will-redirect", (event, url) => onNavigation(url, event))
  contents.on("did-navigate", (_event, url) => onNavigation(url))

  // Links that ask for a new window belong in the user's browser, not in a second shell window.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  if (inset) {
    contents.on("dom-ready", () => void contents.insertCSS(HIDDEN_TITLE_BAR_CSS))
  }

  // The loading page stays on screen until the app's first response replaces it. If the app
  // cannot be reached, it comes back saying so.
  contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) {
      void win.loadFile(loadingPage, { hash: "unreachable" })
    }
  })
  void win.loadFile(loadingPage).then(() => load(config.appUrl))
}

void app.whenReady().then(() => {
  // A packaged app carries its icon in its bundle. Run from source, it would show Electron's.
  if (icon && !app.isPackaged) app.dock?.setIcon(icon)

  // Judged by the frame that asks, which may be another site's embedded in the app.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback, details) => {
      callback(isAppUrl(config, details.requestingUrl))
    }
  )

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

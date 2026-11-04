// The desktop shell's main process. `writeDesktopApp` compiles this file into the generated
// Electron app; nothing imports it.
import { existsSync, readFileSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { hostname } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  app,
  BrowserWindow,
  dialog,
  type Event,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeTheme,
  session,
  shell,
} from "electron"
import { COMPUTER_CHANNELS } from "./bridge"
import { createNavigationState, isWebUrl, nextNavigationStep, type ShellConfig } from "./navigation"
import { DesktopRunner, RUNNER_BINARY, runnerEnvironment, startRunnerProcess } from "./runner"
import {
  HIDDEN_TITLE_BAR_CSS,
  hasHiddenTitleBar,
  isApiPage,
  isAppUrl,
  mayNavigate,
  pageWebPreferences,
  WINDOW_BACKGROUND,
} from "./window"

// Chromium's code for a load that was replaced by another one, which is not a failure.
const ERR_ABORTED = -3

// Not `__dirname`: the bundler replaces it with this source file's directory at compile time,
// which is not where the compiled app lives.
const appDir = app.getAppPath()
const config = JSON.parse(readFileSync(join(appDir, "shell.json"), "utf-8")) as ShellConfig
const loadingPage = join(appDir, "index.html")
const icon = existsSync(join(appDir, "icon.png")) ? join(appDir, "icon.png") : undefined
const inset = hasHiddenTitleBar(process.platform)
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
    webPreferences: pageWebPreferences(join(appDir, "preload.js")),
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

/** Beside the app's archive once packaged, and beside the generated app before that. */
const runnerDir = app.isPackaged
  ? join(process.resourcesPath, "runner")
  : join(appDir, "..", "runner")
const runnerProgram = join(runnerDir, RUNNER_BINARY)
let runnerEnv: NodeJS.ProcessEnv = process.env
const runner = existsSync(runnerProgram)
  ? new DesktopRunner({
      start: () =>
        startRunnerProcess(
          [runnerProgram, config.apiOrigin, `${config.name} on ${hostname()}`],
          runnerEnv
        ),
      // The runner holds the sign-in, and only says where to approve it: on the API, as the window's.
      onSignIn: (url) => {
        if (isApiPage(config, url)) void shell.openExternal(url)
      },
      onProblem: (message) => console.error(`[SixbDesktop] ${message}`),
    })
  : null

/** Answer the page's `computer` methods, asking whoever calls for the app's own origin first. */
function answerComputer(
  channel: string,
  answer: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppUrl(config, event.senderFrame?.url ?? "")) {
      throw new Error("[SixbDesktop] Only the app may ask for this.")
    }
    return answer(event, ...args)
  })
}

/** What a page named as a folder: it gets here unchecked, so nothing is taken on its word. */
async function namedFolder(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !isAbsolute(value)) return null
  const folder = await realpath(value).catch(() => null)
  if (!folder) return null
  return (await stat(folder)).isDirectory() ? folder : null
}

function installComputerAccess(running: DesktopRunner): void {
  answerComputer(COMPUTER_CHANNELS.about, () => running.about())
  answerComputer(COMPUTER_CHANNELS.folders, () => running.folders())
  answerComputer(COMPUTER_CHANNELS.pickFolder, async (event) => {
    const options = {
      title: "Choose a folder",
      message:
        "Choose where the agent works. Messages you send from here or the web run in this folder, " +
        "as you, and its commands run without asking.",
      buttonLabel: "Work Here",
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const { canceled, filePaths } = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const folder = canceled ? null : await namedFolder(filePaths[0])
    if (folder) running.allow(folder)
    return folder
  })
  answerComputer(COMPUTER_CHANNELS.allowFolder, async (event, value) => {
    const folder = await namedFolder(value)
    if (!folder) return false
    const options = {
      type: "question" as const,
      message: `Let the agent work in ${folder}?`,
      detail:
        "Messages you send from here or the web, in any conversation in this folder, run on this " +
        "computer, as you. The agent's commands run there without asking.",
      buttons: ["Allow", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const { response } = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options)
    if (response !== 0) return false
    running.allow(folder)
    return true
  })
  answerComputer(COMPUTER_CHANNELS.forgetFolder, async (_event, value) => {
    if (typeof value === "string") running.forget(value)
  })
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

  if (runner) {
    installComputerAccess(runner)
    void runnerEnvironment(runnerDir, process.env).then((env) => {
      runnerEnv = env
      runner.start()
    })
  } else {
    answerComputer(COMPUTER_CHANNELS.about, () => null)
    answerComputer(COMPUTER_CHANNELS.folders, () => [])
  }

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Waits for the runner, so that a turn running here records its end before the app is gone.
let runnerStopped = false
app.on("before-quit", (event) => {
  if (!runner || runnerStopped) return
  event.preventDefault()
  void runner.stop().finally(() => {
    runnerStopped = true
    app.quit()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

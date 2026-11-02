// Runs in every page the window shows, before the page's own scripts, in a world of its own. Electron
// sandboxes it: of what it imports, only `electron` may remain once compiled.
import { contextBridge } from "electron"
import { DESKTOP_BRIDGE_NAME, desktopBridge } from "./bridge"
import { CONTROLS_HEIGHT_PX, hasHiddenTitleBar } from "./window"

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_NAME, desktopBridge(process.platform))

if (hasHiddenTitleBar(process.platform)) installHiddenTitleBar()

/**
 * Marks `<html>` the moment the element exists, so an app can read the mark on its first render,
 * and adds the drag handle once there is a body to hold it.
 */
function installHiddenTitleBar(): void {
  const mark = () => {
    const root = document.documentElement
    if (!root) return false
    root.dataset.sixbDesktop = "inset"
    root.style.setProperty("--sixb-desktop-controls-height", `${CONTROLS_HEIGHT_PX}px`)
    return true
  }
  if (!mark()) {
    const observer = new MutationObserver(() => {
      if (mark()) observer.disconnect()
    })
    observer.observe(document, { childList: true })
  }

  const addHandle = () => {
    if (!document.body || document.getElementById("sixb-desktop-drag")) return
    const handle = document.createElement("div")
    handle.id = "sixb-desktop-drag"
    handle.setAttribute("aria-hidden", "true")
    // First in the body, not last: the draggable area is built in document order, so a control
    // is only cut out of it if it comes after the handle.
    document.body.prepend(handle)
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addHandle, { once: true })
  } else {
    addHandle()
  }
}

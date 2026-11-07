import { isInstalledApp, LAUNCH_ICON_SIZE } from "./launch"

/**
 * iOS shows a Home Screen app's launch image, read from `apple-touch-startup-image` links when the
 * app is added, and a blank screen without one. It takes no part of the manifest, and wants one
 * image per screen size and orientation, exactly sized. In Safari on an iPhone or iPad this draws
 * the two for the screen in hand, so whatever device adds the app has its own: the app's background
 * with its icon in the middle, matching the loading shell it hands over to. They follow the app's
 * theme until the app is added. Nothing runs once installed, elsewhere, or without canvas.
 */
export function watchStartupImages(): () => void {
  if (!isIOS() || isInstalledApp()) return () => undefined

  let drawn = 0
  const draw = async () => {
    const run = ++drawn
    const links = await startupImageLinks().catch(() => [])
    if (run !== drawn || links.length === 0) return
    for (const link of document.head.querySelectorAll("link[data-sixb-startup-image]")) {
      link.remove()
    }
    document.head.append(...links)
  }

  // After the app's first screen, out of its way; again whenever the theme changes.
  const timer = window.setTimeout(() => void draw(), 1000)
  const observer = new MutationObserver(() => void draw())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => {
    window.clearTimeout(timer)
    observer.disconnect()
  }
}

/** The `media` that matches this screen in one orientation, as iOS reads it. */
export function startupImageMedia(
  screen: { readonly width: number; readonly height: number; readonly scale: number },
  orientation: "portrait" | "landscape"
): string {
  const width = Math.min(screen.width, screen.height)
  const height = Math.max(screen.width, screen.height)
  return `screen and (device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${screen.scale}) and (orientation: ${orientation})`
}

async function startupImageLinks(): Promise<HTMLLinkElement[]> {
  const device = {
    width: window.screen.width,
    height: window.screen.height,
    scale: devicePixelRatio,
  }
  const background = appBackground()
  const icon = await loadIcon()

  return (["portrait", "landscape"] as const).map((orientation) => {
    const short = Math.min(device.width, device.height) * device.scale
    const long = Math.max(device.width, device.height) * device.scale
    const [width, height] = orientation === "portrait" ? [short, long] : [long, short]

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("No canvas")
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
    if (icon) {
      // Contained in the launch icon's square, as the loading shell's `object-fit: contain`.
      const box = LAUNCH_ICON_SIZE * device.scale
      const ratio = icon.naturalWidth / icon.naturalHeight || 1
      const [w, h] = ratio >= 1 ? [box, box / ratio] : [box * ratio, box]
      context.drawImage(icon, (width - w) / 2, (height - h) / 2, w, h)
    }

    const link = document.createElement("link")
    link.rel = "apple-touch-startup-image"
    link.media = startupImageMedia(device, orientation)
    link.href = canvas.toDataURL("image/png")
    link.dataset.sixbStartupImage = ""
    return link
  })
}

/** The loading shell's background: the app's `--background` in the theme on screen. */
function appBackground(): string {
  const probe = document.createElement("div")
  probe.style.cssText = "position:absolute;width:0;height:0;background:var(--background,#fff)"
  document.body.append(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  return color
}

/** The app's icon, as the loading shell shows it, or null without one. */
async function loadIcon(): Promise<HTMLImageElement | null> {
  const href = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href
  if (!href) return null
  const image = new Image()
  image.src = href
  try {
    await image.decode()
    return image
  } catch {
    return null
  }
}

function isIOS(): boolean {
  return (
    /iP(?:hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  )
}

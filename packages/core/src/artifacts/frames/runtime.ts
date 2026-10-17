/**
 * The runtime the frame injects into a deck before anything else in its `<head>`. It is served as
 * this function's own source, `(${frameRuntime})()`, so it imports nothing and names nothing
 * outside itself: the protocol string and the keys repeat what `protocol.ts` declares, and a test
 * holds the two together.
 *
 * It lays the deck out: every `section.slide` is a 1280×720 slide, shown one at a time scaled to
 * fit, or all at once in a grid. The URL's fragment can open it at a slide, and with `sixb-fill`
 * show that slide alone filling the frame, as a thumbnail or an embed does. It applies the theme the app sends, answers the app's requests,
 * and tells the app about keys, picks in the overview, and links to other artifacts.
 */
export function frameRuntime(): void {
  const PROTOCOL = "sixb-frame/1"
  const WIDTH = 1280
  const HEIGHT = 720
  const KEYS = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
    "Escape",
  ]
  const root = document.documentElement
  const start = new URLSearchParams(window.location.hash.slice(1))
  root.classList.add("sixb-deck")
  root.dataset.mode = start.has("sixb-fill") ? "fill" : "slide"
  let current = Number(start.get("sixb-slide")) || 1

  const slides = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>("section.slide"))
  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ protocol: PROTOCOL, ...message }, "*")

  /** The scale that fits a slide in the window, and the one that fits a column of the grid. */
  const fit = () => {
    const columns = window.innerWidth < 720 ? 2 : window.innerWidth < 1100 ? 3 : 4
    const gap = 16
    // A slide keeps a margin around it, so its edge reads against the stage; filled or presented,
    // it has none.
    const margin =
      root.dataset.mode === "fill" || root.dataset.mode === "present"
        ? 0
        : Math.min(32, window.innerWidth * 0.04)
    root.style.setProperty(
      "--sixb-scale",
      String(
        Math.min(
          (window.innerWidth - margin * 2) / WIDTH,
          (window.innerHeight - margin * 2) / HEIGHT
        )
      )
    )
    root.style.setProperty("--sixb-columns", String(columns))
    root.style.setProperty(
      "--sixb-overview-scale",
      String((window.innerWidth - gap * (columns + 1)) / columns / WIDTH)
    )
  }

  const show = (slide: number) => {
    const all = slides()
    current = Math.min(Math.max(1, Math.round(slide) || 1), Math.max(1, all.length))
    all.forEach((element, index) => {
      element.toggleAttribute("data-current", index + 1 === current)
    })
    if (root.dataset.mode === "overview") {
      all[current - 1]?.scrollIntoView({ block: "nearest" })
    }
  }

  const handle = (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "theme": {
        // In the theme's layer, not inline: the deck's own CSS, unlayered, still wins.
        const tokens = (params.tokens ?? {}) as Record<string, string>
        const declarations = Object.entries(tokens)
          .filter(
            ([name, value]) =>
              /^--[a-z0-9-]+$/.test(name) && typeof value === "string" && !/[;{}<]/.test(value)
          )
          .map(([name, value]) => `${name}: ${value};`)
        // The stage is the app's, in the app's colors, whatever a deck makes of its own tokens.
        for (const [stage, token] of [
          ["--sixb-stage", "--muted"],
          ["--sixb-stage-border", "--border"],
          ["--sixb-stage-foreground", "--foreground"],
        ]) {
          const value = declarations.find((declaration) => declaration.startsWith(`${token}:`))
          if (value) declarations.push(`${stage}${value.slice(token.length)}`)
        }
        let style = document.getElementById("sixb-theme")
        if (!style) {
          style = document.createElement("style")
          style.id = "sixb-theme"
          document.head.append(style)
        }
        style.textContent = `@layer sixb-theme { :root { ${declarations.join(" ")} color-scheme: ${params.dark === true ? "dark" : "light"}; } }`
        root.classList.toggle("dark", params.dark === true)
        return
      }
      case "goto":
        show(Number(params.slide))
        return
      case "mode":
        if (root.dataset.mode === "fill") return
        root.dataset.mode =
          params.mode === "overview" || params.mode === "present" ? params.mode : "slide"
        fit()
        show(current)
        return
      default:
        throw new Error(`Unknown method '${method}'.`)
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const data = event.data as Record<string, unknown> | null
    if (!data || data.protocol !== PROTOCOL || typeof data.id !== "number") return
    try {
      handle(String(data.method), (data.params ?? {}) as Record<string, unknown>)
      post({ id: data.id })
    } catch (error) {
      post({ id: data.id, error: error instanceof Error ? error.message : String(error) })
    }
  })

  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (target?.closest("input, textarea, select, [contenteditable]")) return
    if (!KEYS.includes(event.key)) return
    event.preventDefault()
    post({ event: "key", params: { key: event.key } })
  })

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null
    const link = target?.closest<HTMLAnchorElement>("a[href]")
    if (link) {
      const href = link.getAttribute("href") ?? ""
      if (/^artifact:/i.test(href.trim())) {
        event.preventDefault()
        post({ event: "open", params: { address: href.trim() } })
      } else if (!href.startsWith("#")) {
        // Outside the frame: a link opens in its own tab.
        link.target = "_blank"
        link.rel = "noopener noreferrer"
      }
      return
    }
    if (root.dataset.mode !== "overview") return
    const slide = target?.closest<HTMLElement>("section.slide")
    if (!slide) return
    post({ event: "select", params: { slide: slides().indexOf(slide) + 1 } })
  })

  window.addEventListener("resize", fit)
  const ready = () => {
    slides().forEach((element, index) => {
      element.dataset.number = String(index + 1)
    })
    fit()
    show(current)
    post({ event: "ready", params: { slides: slides().length } })
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready)
  else ready()
}

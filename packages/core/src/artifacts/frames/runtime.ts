/**
 * The runtime the frame injects before anything else in an entry's `<head>`. It is served as this
 * function's own source, `(${frameRuntime})()`, so it imports nothing and names nothing outside
 * itself: the protocol string and the keys repeat what `protocol.ts` declares, and a test holds
 * the two together. Its tag names the layout, `data-sixb-layout`.
 *
 * In every layout it applies the theme the app sends, then fires `sixb:theme` on the window for
 * what draws its own colors; answers the app's requests; and tells the app about links to other
 * artifacts and where its `<sixb-embed>` boxes are, for the app to draw them over the frame. A
 * deck it also lays out: every `section.slide` is a 1280×720 slide, shown one at a time scaled to
 * fit, or all at once in a grid. The URL's fragment can open it at a slide, and with `sixb-fill`
 * show that slide alone filling the frame, as a thumbnail or an embed does; it tells the app about
 * keys and picks in the overview. A page scrolls as it is: it reports the embeds near its view as
 * it scrolls, and its height as it changes.
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
  const deck = document.currentScript?.getAttribute("data-sixb-layout") !== "page"
  const start = new URLSearchParams(window.location.hash.slice(1))
  if (deck) {
    root.classList.add("sixb-deck")
    root.dataset.mode = start.has("sixb-fill") ? "fill" : "slide"
  }
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

  /**
   * The embeds to draw over the frame, once an animation frame, when they move: the shown slide's
   * in a deck; in a page, those within a screen of its view, so a long page mounts what is near.
   */
  let reported = ""
  let reporting = false
  const reportEmbeds = () => {
    if (reporting || root.dataset.mode === "fill") return
    reporting = true
    requestAnimationFrame(() => {
      reporting = false
      const scale = deck ? Number(root.style.getPropertyValue("--sixb-scale")) || 1 : 1
      const scope = deck
        ? root.dataset.mode === "overview"
          ? undefined
          : slides()[current - 1]
        : document
      const near = (rect: DOMRect) =>
        deck || (rect.bottom > -window.innerHeight && rect.top < window.innerHeight * 2)
      const embeds = Array.from(scope?.querySelectorAll("sixb-embed[src]") ?? []).flatMap(
        (element) => {
          const rect = element.getBoundingClientRect()
          return near(rect)
            ? [
                {
                  address: (element.getAttribute("src") ?? "").trim(),
                  rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                  scale,
                },
              ]
            : []
        }
      )
      const next = JSON.stringify(embeds)
      if (next === reported) return
      reported = next
      post({ event: "embeds", params: { embeds } })
    })
  }

  /**
   * A page's height as laid out, for a document that shows it to size its frame: its body's, not
   * the document's, which is never less than the frame and so would never let the frame shrink.
   */
  let height = -1
  const reportSize = () => {
    const body = document.body
    if (deck || !body) return
    const style = getComputedStyle(body)
    const next = Math.ceil(
      Math.max(body.scrollHeight, body.getBoundingClientRect().height) +
        (Number.parseFloat(style.marginTop) || 0) +
        (Number.parseFloat(style.marginBottom) || 0)
    )
    if (next === height) return
    height = next
    post({ event: "size", params: { height } })
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
    reportEmbeds()
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
        // What draws on a canvas, as a chart library does, reads its colors once: it redraws on
        // this, which comes after the page has loaded.
        window.dispatchEvent(
          new CustomEvent("sixb:theme", { detail: { dark: params.dark === true } })
        )
        return
      }
      case "goto":
        if (!deck) throw new Error("Only a deck has slides.")
        show(Number(params.slide))
        return
      case "scroll":
        if (deck) throw new Error("Only a page scrolls.")
        window.scrollBy({ left: Number(params.x) || 0, top: Number(params.y) || 0 })
        return
      case "mode":
        if (!deck) throw new Error("Only a deck has modes.")
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
    // Requests only: at the top level, as in the layout check, the frame's own answers come back
    // to it, and answering an answer would trade error messages with itself for good.
    if (!data || data.protocol !== PROTOCOL || typeof data.id !== "number") return
    if (typeof data.method !== "string") return
    try {
      handle(String(data.method), (data.params ?? {}) as Record<string, unknown>)
      post({ id: data.id })
    } catch (error) {
      post({ id: data.id, error: error instanceof Error ? error.message : String(error) })
    }
  })

  // A deck's keys move it wherever focus is; a page's keys are its own.
  window.addEventListener("keydown", (event) => {
    if (!deck || event.metaKey || event.ctrlKey || event.altKey) return
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
    if (!deck || root.dataset.mode !== "overview") return
    const slide = target?.closest<HTMLElement>("section.slide")
    if (!slide) return
    post({ event: "select", params: { slide: slides().indexOf(slide) + 1 } })
  })

  window.addEventListener("resize", () => {
    if (deck) fit()
    reportEmbeds()
  })
  const ready = () => {
    if (!deck) {
      post({ event: "ready", params: {} })
      window.addEventListener("scroll", reportEmbeds, { passive: true })
      // What changes the page's height moves its embeds too: content, fonts, and images.
      const resized = new ResizeObserver(() => {
        reportSize()
        reportEmbeds()
      })
      resized.observe(document.documentElement)
      if (document.body) resized.observe(document.body)
      window.addEventListener("load", () => {
        reportSize()
        reportEmbeds()
      })
      reportSize()
      reportEmbeds()
      return
    }
    slides().forEach((element, index) => {
      element.dataset.number = String(index + 1)
    })
    fit()
    show(current)
    post({ event: "ready", params: { slides: slides().length } })
    // Fonts and images that arrive later move what is laid out after them.
    const resized = new ResizeObserver(reportEmbeds)
    for (const element of Array.from(document.querySelectorAll("section.slide > *, sixb-embed"))) {
      resized.observe(element)
    }
    window.addEventListener("load", reportEmbeds)
    document.fonts?.ready.then(reportEmbeds)
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready)
  else ready()
}

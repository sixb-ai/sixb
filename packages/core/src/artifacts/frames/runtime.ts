/**
 * The runtime the frame injects before anything else in an entry's `<head>`. It is served as this
 * function's own source, `(${frameRuntime})()`, so it imports nothing and names nothing outside
 * itself: the protocol string and the keys repeat what `protocol.ts` declares, and a test holds
 * the two together. Its tag names the layout, `data-sixb-layout`.
 *
 * In every layout it applies the theme the app sends, then fires `sixb:theme` on the window for
 * what draws its own colors; answers the app's requests; and tells the app about the links the
 * reader follows, to other artifacts or to web pages, for the app to open them, and where its
 * `<sixb-embed>` boxes are, for the app to draw them over the frame. A deck it also lays out:
 * every `section.slide` is a 1280×720 slide, shown one at a time scaled to fit, or all at once in
 * a grid. The URL's fragment can open it at a slide, and with `sixb-fill` show that slide alone
 * filling the frame, as a thumbnail or an embed does; it tells the app about keys and picks in the
 * overview. A page scrolls as it is: it reports the embeds near its view as it scrolls, and its
 * height as it changes.
 *
 * It gives every layout `window.sixb.state`, where a page keeps JSON values for its reader: each
 * call is a message the app answers, and the app keeps the values. Opened on its own, with no app
 * around it, as the layout check opens a page, the values live in memory until it closes.
 *
 * And `window.sixb.query(name)`, which reads one of the version's queries as the reader: the app
 * runs it and answers with the query route's JSON. Opened on its own, it reads
 * `__sixb/queries/<name>.json` beside the runtime instead, where the layout check serves what the
 * query returned for the Agent's requester.
 *
 * When the objects a query reads change, the app reads it again and tells the frame, which fires
 * `sixb:query` on the window with `detail.name`, for the page to call `sixb.query(name)` again.
 * Opened on its own, nothing tells it: the rows the check served are all there is.
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
  /** What a page may keep, as `ARTIFACT_STATE_LIMITS` says: refused here before it is sent. */
  const MAX_KEY_LENGTH = 128
  const MAX_VALUE_BYTES = 65536
  /** A query's name, as `isArtifactQueryName` says: refused here before it is sent. */
  const QUERY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
  const root = document.documentElement
  // Only set while the runtime itself runs, so kept for what reads it later.
  const script = document.currentScript as HTMLScriptElement | null
  const deck = script?.getAttribute("data-sixb-layout") !== "page"
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

  /** A link's address resolved against the page, when it is a web page's: `http:` or `https:`. */
  const webAddress = (href: string): string | null => {
    try {
      const url = new URL(href, document.baseURI)
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
    } catch {
      return null
    }
  }

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

  /** Each element's own id, for the app to keep what it draws there as others come and go. */
  const ids = new WeakMap<Element, number>()
  let lastId = 0
  const idOf = (element: Element): number => {
    const known = ids.get(element)
    if (known !== undefined) return known

    lastId += 1
    ids.set(element, lastId)
    return lastId
  }

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
          const id = idOf(element)
          const rect = element.getBoundingClientRect()
          return near(rect)
            ? [
                {
                  id,
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
      case "reload":
        // After the answer is posted, so the app hears it before the page goes.
        setTimeout(() => window.location.reload())
        return
      case "query.changed": {
        // The page reads the new rows itself: what it drew from the old ones is its own.
        const name = String(params.name)
        if (!QUERY_NAME.test(name)) throw new Error(`Unknown query '${name}'.`)

        window.dispatchEvent(new CustomEvent("sixb:query", { detail: { name } }))
        return
      }
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

  /**
   * `sixb.state` and `sixb.query`, promise-based: each call posted numbered, and settled by the
   * app's result with that number.
   */
  const calls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  let called = 0
  const alone = window.parent === window
  const memory = new Map<string, string>()
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (alone) {
      const key = String(params.key)
      const kept = memory.get(key)
      switch (method) {
        case "state.get":
          return Promise.resolve(kept === undefined ? undefined : JSON.parse(kept))
        case "state.set":
          memory.set(key, JSON.stringify(params.value))
          return Promise.resolve(undefined)
        case "state.delete":
          return Promise.resolve(memory.delete(key))
        default:
          return Promise.resolve([...memory.keys()].sort())
      }
    }
    called += 1
    const id = called
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject })
      post({ call: id, method, params })
    })
  }
  // Not `.` or `..`: the app puts the key in a URL's path, where those name another route.
  const checkKey = (key: unknown): string => {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > MAX_KEY_LENGTH ||
      key === "." ||
      key === ".."
    ) {
      throw new TypeError(`sixb.state: a key is text of 1 to ${MAX_KEY_LENGTH} characters.`)
    }
    return key
  }
  const state = {
    get: (key: string) => Promise.resolve().then(() => call("state.get", { key: checkKey(key) })),
    set: (key: string, value: unknown) =>
      Promise.resolve().then(() => {
        const json = JSON.stringify(value)
        if (json === undefined) {
          throw new TypeError(
            "sixb.state: a value is JSON: text, a number, true or false, null, a list, or an object."
          )
        }
        if (new TextEncoder().encode(json).byteLength > MAX_VALUE_BYTES) {
          throw new RangeError(
            `sixb.state: a value is at most ${MAX_VALUE_BYTES / 1024} KB as JSON.`
          )
        }
        // As JSON keeps it, so the page reads back what it would after a reload.
        return call("state.set", { key: checkKey(key), value: JSON.parse(json) }).then(() => {})
      }),
    delete: (key: string) =>
      Promise.resolve().then(() => call("state.delete", { key: checkKey(key) })),
    keys: () => call("state.keys", {}),
  }

  /**
   * A query's result as the check serves it beside the runtime, `__sixb/queries/<name>.json`:
   * resolved from the runtime's own address, so a canvas's board in its folder finds it too.
   */
  const readQueryFile = async (name: string): Promise<unknown> => {
    const base = script?.src || new URL("__sixb/runtime.js", window.location.href).href
    const response = await fetch(new URL(`queries/${name}.json`, base))
    if (response.ok) return response.json()

    if (response.status === 404) {
      throw new Error(`[Sixb] No query '${name}' in this page's version.`)
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    throw new Error(
      typeof body?.error === "string" ? body.error : `[Sixb] Query '${name}' could not be read.`
    )
  }
  const query = (name: string): Promise<unknown> =>
    Promise.resolve().then(() => {
      if (typeof name !== "string" || !QUERY_NAME.test(name)) {
        throw new TypeError(
          "sixb.query: a query's name is that of its file, queries/<name>.json: lowercase letters, digits and hyphens."
        )
      }
      return alone ? readQueryFile(name) : call("query.run", { name })
    })

  Object.defineProperty(window, "sixb", {
    value: Object.freeze({ state: Object.freeze(state), query }),
    enumerable: true,
  })

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const data = event.data as Record<string, unknown> | null
    // The app's answer to a call.
    if (data && data.protocol === PROTOCOL && typeof data.result === "number") {
      const pending = calls.get(data.result)
      calls.delete(data.result)
      if (typeof data.error === "string") pending?.reject(new Error(data.error))
      else pending?.resolve(data.value)
      return
    }
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
      // A link within the page moves through it, and one the page's own script handled is its.
      if (href.startsWith("#") || event.defaultPrevented) return

      // Anything else would leave the frame, which can open no window and navigates nowhere but
      // the frames' origin: the app opens it, an artifact where the reader is and a web page in a
      // new tab.
      event.preventDefault()
      if (/^artifact:/i.test(href.trim())) {
        post({ event: "open", params: { address: href.trim() } })
        return
      }

      const url = webAddress(href)
      if (url) post({ event: "link", params: { url } })
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

/**
 * The runtime the frame injects before anything else in an entry's `<head>`. It is served as this
 * function's own source, `(${frameRuntime})()`, so it imports nothing and names nothing outside
 * itself: the protocol string and the keys repeat what `protocol.ts` declares, and a test holds
 * the two together. Its tag names the layout, `data-sixb-layout`.
 *
 * In every layout it applies the theme the app sends, then fires `sixb:theme` on the window for
 * what draws its own colors; answers the app's requests; and tells the app about the links the
 * reader follows, to other artifacts or to web pages, for the app to open them, the words of the
 * buttons they press, and where its `<sixb-embed>` boxes are, for the app to draw them over the
 * frame. A deck it also lays out: every `section.slide` is a 1280×720 slide, shown one at a time
 * scaled to fit, or all at once in a grid. The URL's fragment can open it at a slide, and with
 * `sixb-fill` show that slide alone filling the frame, as a thumbnail or an embed does; it tells
 * the app about keys and picks in the overview. A page scrolls as it is: it reports the embeds
 * near its view as it scrolls, and its height as it changes.
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
 *
 * A canvas's board served for editing has each static element marked with its address
 * (`data-sixb-at`), its kind (`data-sixb-edit`) and a text's words hashed (`data-sixb-text`), as
 * `annotateBoard` writes them. While the app has editing on, a click picks an element instead of
 * following it, the frame reports what the reader points at and picks, and a text element takes
 * the reader's typing, each change posted as its words. What a script built, or a text whose words
 * a script rewrote, is reported as scripted and takes nothing. What others change arrives as
 * patches, element by element; the one the reader is typing in takes its own once they leave it,
 * so their caret stays. What editing reports goes through the port the app hands over with its
 * first `edit` request, taken before the page's scripts run: they cannot post on it. Once it holds
 * that port, the frame also sends the reader's pinches, ⌘-wheel turns and ⌘ +, − and 0 through
 * it, for the app to zoom the opened board instead of the browser zooming everything.
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
  /** The longest words a press reports, an arrow's label's, as `ARTIFACT_LIMITS` says. */
  const MAX_LABEL_LENGTH = 120
  /** What `annotateBoard` marks a board's elements with. */
  const AT = "data-sixb-at"
  const KIND = "data-sixb-edit"
  const WORDS = "data-sixb-text"
  const MAX_EDIT_LABEL = 80
  /** A comment's bubble, its tip where the pin goes, as the canvas draws it. */
  const COMMENT_CURSOR =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M3 21V11a8 8 0 1 1 8 8H3z' fill='%23111' stroke='white' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E\") 3 21, crosshair"
  /**
   * How picking shows: editing, a dashed line around what the pointer is over and a solid one
   * around what is picked, under a bubble pointer when commenting. One blue whatever the
   * page or the theme, as a design tool's selection is, so it shows on light and dark alike.
   */
  const EDITING_CSS = [
    "[data-sixb-editing] [data-sixb-hover] { outline: 1px dashed #0a84ff; outline-offset: 2px; }",
    "[data-sixb-editing] [data-sixb-picked] { outline: 2px solid #0a84ff; outline-offset: 2px; }",
    "[data-sixb-editing] [contenteditable] { cursor: text; }",
    `[data-sixb-commenting], [data-sixb-commenting] * { cursor: ${COMMENT_CURSOR} !important; }`,
    "[data-sixb-commenting] [data-sixb-hover] { outline: 2px dashed #0a84ff; outline-offset: 3px; }",
    "[data-sixb-commenting] [data-sixb-picked] { outline: 2px solid #0a84ff; outline-offset: 3px; }",
  ].join(" ")
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

  // ── Editing a board ─────────────────────────────────────────────────

  // What editing reports goes to the app through the port its first `edit` request hands over,
  // never through the window, where the page's own scripts post too. The port, and the way to
  // post on it, are taken before any of the page's scripts run, which cannot reach either.
  const portPost = typeof MessagePort === "function" ? MessagePort.prototype.postMessage : undefined
  const apply = Reflect.apply
  let editPort: MessagePort | null = null
  const postEdit = (message: Record<string, unknown>) => {
    if (editPort && portPost) apply(portPost, editPort, [{ protocol: PROTOCOL, ...message }])
  }

  let editing = false
  /** Whether a text the reader picks takes their typing: not while they pick what to comment on. */
  let typable = true
  let pointed: Element | null = null
  let picked: Element | null = null
  let typing: HTMLElement | null = null
  /** What others changed in the element the reader is typing in, for when they leave it. */
  let held: Record<string, unknown> | null = null
  /** The words the reader's typing starts from: as they began, then as last posted. */
  let typedFrom = ""

  /** FNV-1a over the words' UTF-16 code units, as `boardTextHash` hashes them. */
  const wordsHash = (text: string): string => {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16)
  }

  /** A text's words as they read: a line break between two words parts them. */
  const spokenWords = (element: Element): string => {
    const copy = element.cloneNode(true)
    if (!(copy instanceof Element)) return element.textContent ?? ""
    for (const lineBreak of Array.from(copy.querySelectorAll("br"))) lineBreak.replaceWith(" ")
    for (const code of Array.from(copy.querySelectorAll("script, style, template"))) code.remove()
    return copy.textContent ?? ""
  }

  /**
   * What is drawn as picked or pointed at: the element, or, picking what to comment on, what a
   * script built too, which a comment can be about though it cannot be edited.
   */
  const commentable = (element: Element | null, node: EventTarget | null): Element | null =>
    element ??
    (!typable && node instanceof Element && node !== root && node !== document.body ? node : null)

  /** The element the reader means by `node`, as the app is told of it. */
  const editTarget = (node: EventTarget | null) => {
    const start = node instanceof Element ? node : null
    const element = start?.closest(`[${AT}]`) ?? null
    const box = (start ?? element)?.getBoundingClientRect()
    const rect = {
      x: box?.left ?? 0,
      y: box?.top ?? 0,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
    }
    const kind = element?.getAttribute(KIND) ?? ""
    // The page itself is no part of it to quote.
    const shown =
      start && start !== root && start !== document.body
        ? spokenWords(start).replace(/\s+/g, " ").trim()
        : ""
    const scripted = {
      address: null,
      kind: "scripted",
      within: element?.getAttribute(AT) ?? null,
      ...(shown ? { label: shown.slice(0, MAX_EDIT_LABEL) } : {}),
      rect,
    }
    if (!element) return { element: null, target: scripted }

    // What is inside a text, or drawn whole, is part of it; anything else inside a box that has
    // no address of its own is a script's.
    if (element !== start && kind !== "text" && kind !== "whole") {
      return { element: null, target: scripted }
    }
    const words = element.textContent ?? ""
    if (kind === "text" && wordsHash(words) !== element.getAttribute(WORDS)) {
      return { element: null, target: { ...scripted, within: element.getAttribute(AT) } }
    }

    const own = element.getBoundingClientRect()
    const label = (kind === "image" ? (element.getAttribute("alt") ?? "") : spokenWords(element))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_EDIT_LABEL)
    return {
      element,
      target: {
        address: element.getAttribute(AT),
        kind,
        label,
        rect: { x: own.left, y: own.top, width: own.width, height: own.height },
      },
    }
  }

  const mark = (attribute: string, previous: Element | null, next: Element | null) => {
    previous?.removeAttribute(attribute)
    next?.setAttribute(attribute, "")
    return next
  }

  const stopTyping = () => {
    const element = typing
    if (!element) return
    typing = null
    element.removeAttribute("contenteditable")
    const patch = held
    held = null
    if (patch) applyPatch(element, patch)
  }

  /** Makes an element what a patch says it holds now: its attributes, then what is inside it. */
  const applyPatch = (element: Element, patch: Record<string, unknown>) => {
    const attributes = patch.attributes
    if (attributes && typeof attributes === "object") {
      const next = attributes as Record<string, unknown>
      for (const name of element.getAttributeNames()) {
        if (!(name in next) && !name.startsWith("data-sixb-")) element.removeAttribute(name)
      }
      for (const [name, value] of Object.entries(next)) {
        if (typeof value === "string" && /^[a-z_:][a-z0-9_.:-]*$/i.test(name)) {
          element.setAttribute(name, value)
        }
      }
    }
    if (typeof patch.html === "string") element.innerHTML = patch.html
  }

  const startEditing = (on: boolean, typingAllowed: boolean) => {
    editing = on
    typable = typingAllowed
    if (!typable) stopTyping()
    root.toggleAttribute("data-sixb-editing", on)
    // Picking what to comment on: the pointer is a comment's bubble, and what it would comment on
    // is outlined.
    root.toggleAttribute("data-sixb-commenting", on && !typable)
    if (on && !document.getElementById("sixb-editing")) {
      const style = document.createElement("style")
      style.id = "sixb-editing"
      style.textContent = EDITING_CSS
      document.head.append(style)
    }
    if (!on) {
      stopTyping()
      pointed = mark("data-sixb-hover", pointed, null)
      picked = mark("data-sixb-picked", picked, null)
    }
  }

  // Before anything of the page's own: editing, a click picks, and nothing follows it.
  window.addEventListener(
    "click",
    (event) => {
      // Only the reader's own clicks: the page's scripts can click too.
      if (!editing || !event.isTrusted) return
      if (typing?.contains(event.target as Node | null)) return
      event.preventDefault()
      event.stopPropagation()
      stopTyping()

      const { element, target } = editTarget(event.target)
      picked = mark("data-sixb-picked", picked, commentable(element, event.target))
      // Where the reader clicked, for a comment's pin.
      const at = { x: event.clientX, y: event.clientY }
      postEdit({ event: "edit.select", params: { target, at } })
      if (typable && element instanceof HTMLElement && target.kind === "text") {
        typing = element
        typedFrom = element.textContent ?? ""
        element.setAttribute("contenteditable", "plaintext-only")
        element.focus()
      }
    },
    true
  )
  document.addEventListener("mouseover", (event) => {
    if (!editing || !event.isTrusted) return
    const { element, target } = editTarget(event.target)
    const shown = commentable(element, event.target)
    if (shown === pointed && shown !== null) return
    pointed = mark("data-sixb-hover", pointed, shown)
    postEdit({ event: "edit.hover", params: { target } })
  })
  // The pointer gone from the page, nothing is under it: it left for nothing of the page.
  document.addEventListener("mouseout", (event) => {
    if (!editing || !event.isTrusted || event.relatedTarget !== null || pointed === null) return
    pointed = mark("data-sixb-hover", pointed, null)
    postEdit({ event: "edit.hover", params: { target: null } })
  })
  document.addEventListener("input", (event) => {
    if (!editing || !event.isTrusted || !typing || !typing.contains(event.target as Node | null)) {
      return
    }
    const text = typing.textContent ?? ""
    // Its words are the reader's now: still theirs to type in.
    typing.setAttribute(WORDS, wordsHash(text))
    postEdit({
      event: "edit.text",
      params: { address: typing.getAttribute(AT), base: typedFrom, text },
    })
    typedFrom = text
  })
  window.addEventListener(
    "keydown",
    (event) => {
      if (!typing || !event.isTrusted) return
      // A text element's words are one block: a new line would be new markup.
      if (event.key === "Enter") event.preventDefault()
      if (event.key === "Escape") typing.blur()
      event.stopPropagation()
    },
    true
  )
  document.addEventListener("focusout", (event) => {
    if (typing && event.target === typing) stopTyping()
  })

  // ── Zooming an opened board ─────────────────────────────────────────

  // A canvas's opened board is zoomed by the app around it, never by the browser: once the app has
  // handed the port over, a pinch, the wheel with ⌘ or Ctrl, and ⌘ or Ctrl with +, − or 0 go to
  // the app through it, the reader's own alone. Without a port, as a document's or a deck's frame
  // is, they stay the browser's.
  const mac = /Mac|iPhone|iPad/.test(window.navigator?.platform ?? "")
  const zoom = (params: Record<string, unknown>) => postEdit({ event: "zoom", params })
  const zooming = (event: Event) => editPort !== null && event.isTrusted

  window.addEventListener(
    "wheel",
    (event) => {
      if (!zooming(event) || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()

      // As the canvas zooms by the wheel: a trackpad's pinch is the wheel with Ctrl, in small steps.
      const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002
      const factor = 2 ** (-event.deltaY * unit * (event.ctrlKey && mac ? 10 : 1))
      zoom({ factor, at: { x: event.clientX, y: event.clientY } })
    },
    { passive: false }
  )

  // Two fingers pinch on a touch screen, measured on the screen: the frame grows as the zoom
  // follows them, so in its own pixels they would seem to close. Safari also tells of a pinch as a
  // gesture of its own, which is only stopped here; on a Mac's trackpad, where no finger touches
  // the page, the gesture is it.
  let spread = 0
  const spreadOf = (touches: TouchList) => {
    const [one, two] = [touches[0], touches[1]]
    return one && two ? Math.hypot(one.screenX - two.screenX, one.screenY - two.screenY) : 0
  }
  window.addEventListener(
    "touchstart",
    (event) => {
      spread = zooming(event) && event.touches.length === 2 ? spreadOf(event.touches) : 0
    },
    { passive: true }
  )
  window.addEventListener(
    "touchmove",
    (event) => {
      if (!zooming(event) || event.touches.length !== 2 || spread === 0) return
      event.preventDefault()

      const [one, two] = [event.touches[0], event.touches[1]]
      const next = spreadOf(event.touches)
      if (!one || !two || next === 0) return
      zoom({
        factor: next / spread,
        at: { x: (one.clientX + two.clientX) / 2, y: (one.clientY + two.clientY) / 2 },
      })
      spread = next
    },
    { passive: false }
  )
  window.addEventListener("touchend", (event) => {
    if (event.touches.length < 2) spread = 0
  })

  let gestured = 1
  const onGesture = (event: Event) => {
    if (!zooming(event)) return
    event.preventDefault()

    const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number }
    const scale = gesture.scale ?? 1
    if (event.type === "gesturestart" || spread > 0 || scale <= 0) {
      gestured = scale > 0 ? scale : 1
      return
    }
    zoom({ factor: scale / gestured, at: { x: gesture.clientX ?? 0, y: gesture.clientY ?? 0 } })
    gestured = scale
  }
  window.addEventListener("gesturestart", onGesture, { passive: false })
  window.addEventListener("gesturechange", onGesture, { passive: false })

  // Before the page's own keys, and while the reader types in a text.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!zooming(event) || !(event.metaKey || event.ctrlKey) || event.altKey) return
      const step =
        event.key === "=" || event.key === "+"
          ? "in"
          : event.key === "-"
            ? "out"
            : event.key === "0"
              ? "actual"
              : null
      if (!step) return

      event.preventDefault()
      zoom({ step })
    },
    true
  )

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
      case "edit":
        startEditing(params.on === true, params.typing !== false)
        return
      case "edit.patch": {
        const patches = Array.isArray(params.patches) ? params.patches : []
        for (const patch of patches as Record<string, unknown>[]) {
          const address = typeof patch?.address === "string" ? patch.address : null
          const element = address
            ? document.querySelector(`[${AT}="${CSS.escape(address)}"]`)
            : null
          if (!element) continue
          if (element === typing) held = { ...(held ?? {}), ...patch }
          else applyPatch(element, patch)
        }
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

  // First of all the page's listeners, and the only one to hear the app's requests: a request
  // stops here, so the page's scripts never see the port an `edit` request hands over.
  window.addEventListener(
    "message",
    (event) => {
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
      event.stopImmediatePropagation()
      const port = event.ports?.[0]
      if (data.method === "edit" && port) editPort = port
      try {
        handle(String(data.method), (data.params ?? {}) as Record<string, unknown>)
        post({ id: data.id })
      } catch (error) {
        post({ id: data.id, error: error instanceof Error ? error.message : String(error) })
      }
    },
    true
  )

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

    // A button, or a link within the page, by its words: on a canvas, an opened board follows the
    // arrow they label.
    const pressed = target?.closest<HTMLElement>('button, [role="button"], a[href^="#"]')
    const words = (pressed?.innerText ?? pressed?.textContent ?? "").replace(/\s+/g, " ").trim()
    if (words && words.length <= MAX_LABEL_LENGTH) post({ event: "press", params: { text: words } })

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

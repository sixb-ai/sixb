import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { Window } from "happy-dom"
import {
  ActivityDeliveryError,
  ActivityTracker,
  type ActivityTrackerOptions,
  INTERACTION_NAME_MAX_LENGTH,
  INTERACTION_NAME_PATTERN,
  startSixbActivityCapture,
  stopSixbActivityCapture,
  trackSixbEvent,
} from "../src/activity-tracker"
import { client } from "../src/generated/client.gen"

type Batch = Parameters<ActivityTrackerOptions["send"]>[0]

interface Registration {
  readonly listener: EventListenerOrEventListenerObject | null
  readonly capture: boolean
  readonly passive: boolean
}

/**
 * A document whose visibility and input the test drives, trusted or synthetic. It keeps one
 * listener per input type, and removes it only with the same capture flag, as a browser does.
 */
class ActivityDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible"
  readonly listeners = new Map<string, Registration>()

  visibility(value: DocumentVisibilityState) {
    this.visibilityState = value
    this.dispatchEvent(new Event("visibilitychange"))
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ) {
    super.addEventListener(type, listener, options)
    if (type === "pointerdown" || type === "click") {
      const flags = typeof options === "object" ? options : { capture: options }
      this.listeners.set(type, {
        listener,
        capture: flags.capture === true,
        passive: typeof options === "object" && options.passive === true,
      })
    }
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ) {
    super.removeEventListener(type, listener, options)
    const capture = typeof options === "object" ? options.capture === true : options === true
    const registered = this.listeners.get(type)
    if (registered?.listener === listener && registered.capture === capture) {
      this.listeners.delete(type)
    }
  }

  input(trusted: boolean) {
    this.deliver("pointerdown", new Event("pointerdown"), trusted)
  }

  /** A click on `target`, with the composed path a browser gives the document's listener. */
  click(target: unknown, trusted = true) {
    const path = composedPath(target)
    const event = new Proxy(new Event("click"), {
      get: (event, key) =>
        key === "target"
          ? target
          : key === "composedPath"
            ? () => path
            : Reflect.get(event, key, event),
    })
    this.deliver("click", event, trusted)
  }

  /** `isTrusted` cannot be set on a constructed event, so the listener gets a proxy. */
  private deliver(type: string, original: Event, trusted: boolean) {
    const listener = this.listeners.get(type)?.listener
    const event = new Proxy(original, {
      get: (target, key) => (key === "isTrusted" ? trusted : Reflect.get(target, key, target)),
    })

    if (typeof listener === "function") {
      listener.call(this, event)
    } else {
      listener?.handleEvent(event)
    }
  }
}

/** The target, then its ancestors, crossing from a shadow root to its host. */
function composedPath(target: unknown): unknown[] {
  const path: unknown[] = []
  let node = target

  while (typeof node === "object" && node !== null) {
    path.push(node)
    node = Reflect.get(node, "parentNode") ?? Reflect.get(node, "host")
  }
  return path
}

const windows: Window[] = []

/** A happy-dom document holding `html`, closed after the test. */
function page(html: string) {
  const window = new Window()
  windows.push(window)
  window.document.body.innerHTML = html
  return window.document
}

const trackers: ActivityTracker[] = []

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(async () => {
  for (const tracker of trackers.splice(0)) {
    tracker.dispose()
  }
  jest.useRealTimers()
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()))
})

async function setup(overrides: Partial<ActivityTrackerOptions> = {}) {
  const document = new ActivityDocument()
  const sent: Batch[] = []
  const warnings: string[] = []
  let now = 1_000_000

  const tracker = new ActivityTracker({
    document,
    now: () => now,
    load: async () => ({ enabled: true, idleTimeoutMs: 60_000 }),
    send: async (events) => {
      sent.push(events)
    },
    warn: (message) => warnings.push(message),
    ...overrides,
  })
  trackers.push(tracker)
  await Promise.resolve()

  const advance = (ms: number) => {
    now += ms
  }
  return { tracker, document, sent, warnings, advance }
}

function attributionOf(event: Batch[number] | undefined) {
  return event && "attribution" in event ? event.attribution : undefined
}

function ofType(sent: readonly Batch[], type: Batch[number]["type"]) {
  return sent.flat().filter((event) => event.type === type)
}

describe("activity browser delivery", () => {
  test("disabled settings and hidden pages collect nothing", async () => {
    const disabled = await setup({ load: async () => ({ enabled: false, idleTimeoutMs: 60_000 }) })
    disabled.tracker.page("/")
    await disabled.tracker.flush()
    expect(disabled.sent).toEqual([])

    const { tracker, document, sent } = await setup()
    document.visibility("hidden")
    tracker.page("/invoices/:id")
    await tracker.flush()
    expect(sent).toEqual([])

    document.visibility("visible")
    await tracker.flush()
    expect(sent.flat().map((event) => event.route)).toEqual(["/invoices/:id"])
  })

  test("a page that is not recorded sends nothing, not even activity", async () => {
    const { tracker, document, sent, advance } = await setup()
    tracker.page(null)
    advance(60_000)
    document.input(true)
    document.visibility("hidden")
    document.visibility("visible")
    await tracker.flush()

    expect(sent).toEqual([])
  })

  // Guard proof: remove the isTrusted check from onInput; the synthetic input is sent.
  test("idle tabs and synthetic events do not prolong visits; real foreground input does", async () => {
    const { tracker, document, sent, advance } = await setup()
    tracker.page("/")
    await tracker.flush()

    advance(60_000)
    jest.advanceTimersByTime(60_000)
    document.input(false)
    document.visibility("hidden")
    await tracker.flush()
    expect(sent.flat()).toHaveLength(1)

    document.visibility("visible")
    await tracker.flush()
    advance(60_000)
    document.input(true)
    await tracker.flush()
    expect(sent.flat().at(-1)?.type).toBe("visit.activity")

    advance(1_000)
    document.input(true)
    document.visibility("hidden")
    await tracker.flush()
    expect(sent.flat().at(-1)?.type).toBe("visit.activity")
  })

  test("retries keep their ids, stop after three failures, and concurrent flushes share one", async () => {
    const attempts: Batch[] = []
    const { tracker, warnings } = await setup({
      send: async (events) => {
        attempts.push(events)
        throw Error("offline")
      },
    })
    tracker.page("/invoices/:id")

    const first = tracker.flush()
    expect(tracker.flush()).toBe(first)
    await first
    await tracker.flush()
    await tracker.flush()
    await tracker.flush()

    expect(attempts).toHaveLength(3)
    expect(attempts[1]).toEqual(attempts[0])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain("invoices")
  })

  test("the queue, its batches and the age of events stay bounded", async () => {
    const { tracker, sent, warnings, advance } = await setup()
    for (let index = 0; index < 105; index++) {
      tracker.page("/")
    }
    for (let index = 0; index < 6; index++) {
      await tracker.flush()
    }
    expect(sent.map((batch) => batch.length)).toEqual([20, 20, 20, 20, 20])
    expect(warnings).toHaveLength(5)

    tracker.page("/expired")
    advance(60_001)
    await tracker.flush()
    expect(sent.flat()).toHaveLength(100)
  })

  test("disposing aborts pending delivery and cannot revive a previous authority", async () => {
    let resolveLoad: (value: { enabled: boolean; idleTimeoutMs: number }) => void = () => {}
    let signal: AbortSignal | undefined
    const { tracker, sent } = await setup({
      load: (value) => {
        signal = value
        return new Promise((resolve) => {
          resolveLoad = resolve
        })
      },
    })

    tracker.page("/old-user")
    tracker.dispose()
    resolveLoad({ enabled: true, idleTimeoutMs: 60_000 })
    await Promise.resolve()
    await tracker.flush()

    expect(signal?.aborted).toBe(true)
    expect(sent).toEqual([])
  })
})

// Guard proof: raise REQUEST_TIMEOUT_MS to 60 seconds; the request is not aborted in time.
test("a stalled request is aborted and retried with the same event id", async () => {
  const attempts: Batch[] = []
  let requestSignal: AbortSignal | undefined
  const { tracker } = await setup({
    send: async (events, signal) => {
      attempts.push(events)
      requestSignal = signal
      if (attempts.length === 1) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Error("timeout")), { once: true })
        })
      }
    },
  })

  tracker.page("/")
  const pending = tracker.flush()
  jest.advanceTimersByTime(10_000)
  expect(requestSignal?.aborted).toBe(true)

  await pending
  await tracker.flush()
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
})

// Guard proof: send page.view from onVisibility and onInput; the page-view count grows.
test("returning to a viewed tab and resuming input add activity, not page views", async () => {
  const { tracker, document, sent, advance } = await setup()
  tracker.page("/invoices/:id")
  await tracker.flush()

  for (let index = 0; index < 3; index++) {
    document.visibility("hidden")
    await tracker.flush()
    document.visibility("visible")
    await tracker.flush()
  }
  expect(ofType(sent, "page.view")).toHaveLength(1)
  expect(ofType(sent, "visit.activity")).toHaveLength(3)

  advance(60_000)
  document.input(true)
  await tracker.flush()
  expect(ofType(sent, "page.view")).toHaveLength(1)
  expect(ofType(sent, "visit.activity")).toHaveLength(4)
})

// Guard proof: always send visit.activity from onVisibility; the deferred page view disappears.
test("a navigation while hidden counts its visible destination once", async () => {
  const { tracker, document, sent } = await setup()
  tracker.page("/")
  await tracker.flush()

  document.visibility("hidden")
  tracker.page("/loading")
  tracker.page("/reports")
  await tracker.flush()
  expect(sent.flat()).toHaveLength(1)

  document.visibility("visible")
  await tracker.flush()
  document.visibility("hidden")
  await tracker.flush()
  document.visibility("visible")
  await tracker.flush()

  expect(ofType(sent, "page.view").map((event) => event.route)).toEqual(["/", "/reports"])
  expect(sent.flat().at(-1)?.type).toBe("visit.activity")
})

test("the arrival travels once, a retry keeps it, and later inactivity starts direct", async () => {
  const attempts: Batch[] = []
  const { tracker, advance, document } = await setup({
    attribution: { source: "newsletter", medium: "email" },
    send: async (events) => {
      attempts.push(events)
      if (attempts.length === 1) {
        throw new Error("offline")
      }
    },
  })

  tracker.page("/")
  await tracker.flush()
  await tracker.flush()
  expect(attempts[1]).toEqual(attempts[0])
  expect(attributionOf(attempts[0]?.[0])).toEqual({ source: "newsletter", medium: "email" })

  tracker.page("/next")
  await tracker.flush()
  expect(attributionOf(attempts.at(-1)?.[0])).toEqual({})

  advance(60_000)
  document.input(true)
  await tracker.flush()
  expect(attributionOf(attempts.at(-1)?.[0])).toEqual({})
})

// Guard proof: drop the 4xx branch in sendBatch; the refused batch is sent three times.
test("a refused batch is dropped at once, without retries", async () => {
  const attempts: Batch[] = []
  const { tracker, warnings } = await setup({
    send: async (events) => {
      attempts.push(events)
      throw new ActivityDeliveryError(403)
    },
  })

  tracker.page("/")
  await tracker.flush()
  await tracker.flush()

  expect(attempts).toHaveLength(1)
  expect(warnings).toHaveLength(1)
})

// Guard proof: drop the 429 branch in sendBatch; the batch is retried before Retry-After.
test("a throttled batch waits for Retry-After, at most as long as events are kept", async () => {
  const attempts: Batch[] = []
  const { tracker, advance, warnings } = await setup({
    send: async (events) => {
      attempts.push(events)
      if (attempts.length === 1) {
        throw new ActivityDeliveryError(429, 5_000)
      }
      if (attempts.length === 2) {
        throw new ActivityDeliveryError(429, 3_600_000)
      }
    },
  })

  tracker.page("/")
  await tracker.flush()
  advance(4_999)
  await tracker.flush()
  expect(attempts).toHaveLength(1)

  advance(1)
  await tracker.flush()
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])

  // An hour's wait is cut to the minute events are kept; by then this one has expired.
  advance(60_000)
  await tracker.flush()
  expect(attempts).toHaveLength(2)
  expect(warnings).toHaveLength(1)
})

describe("tracked interactions", () => {
  // Guard proof: remove the isTrusted check from onClick; the synthetic click is sent.
  test("a real click inside a marked element records its name, and nothing else", async () => {
    const { tracker, document, sent, warnings, advance } = await setup()
    const dom = page(`
      <button data-sixb-track="invoices.export"><svg><path></path></svg> Export</button>
      <table><tr data-sixb-track="invoices.row.open"><td>INV-42 · Acme</td></tr></table>
      <button data-sixb-track="Export">Misnamed</button>
      <button>Plain</button>
      <span id="host" data-sixb-track="invoices.shadow"></span>
    `)
    const [exportButton, misnamed, plain] = dom.querySelectorAll("button")
    const shadow = dom.querySelector("#host")?.attachShadow({ mode: "open" })
    if (shadow) shadow.innerHTML = "<button>Inside</button>"

    tracker.page("/invoices")
    document.click(dom.querySelector("path"))
    document.click(dom.querySelector("td"))
    document.click(exportButton, false)
    document.click(plain)
    document.click(misnamed)
    document.click(misnamed)
    document.click(shadow?.querySelector("button"))
    document.click(null)

    // The same name within a second is one interaction; a second later, another.
    document.click(exportButton)
    document.click(exportButton)
    advance(1_000)
    document.click(exportButton)
    await tracker.flush()

    expect(names(sent)).toEqual([
      "invoices.export",
      "invoices.row.open",
      "invoices.shadow",
      "invoices.export",
      "invoices.export",
    ])

    // The element's text never travels; a misnamed one warns once.
    expect(JSON.stringify(sent)).not.toContain("Acme")
    expect(warnings).toEqual([expect.stringContaining('"Export" is not an interaction name')])
  })

  // Guard proof: drop the forwardsClick check in onClick; the labels' own clicks record.
  test("a label and the click it forwards to its control record once", async () => {
    const { tracker, document, sent } = await setup()
    const dom = page(`
      <div data-sixb-track="invoices.paid.toggle">
        <button role="checkbox" id="paid"></button><label for="paid"><b>Paid</b></label>
      </div>
      <label data-sixb-track="invoices.terms"><input type="checkbox" /> <span>Terms</span></label>
      <label data-sixb-track="invoices.note" for="note">Note</label>
      <input id="note" />
    `)
    tracker.page("/invoices")

    // A label's own click records nothing: the one the browser forwards to its control does.
    document.click(dom.querySelector("b"))
    document.click(dom.querySelector("span"))
    await tracker.flush()
    expect(names(sent)).toEqual([])

    document.click(dom.querySelector("#paid"))
    document.click(dom.querySelector("input[type=checkbox]"))

    // A control outside the marked label: its forwarded click finds no marked element.
    document.click(dom.querySelector("label[for=note]"))
    document.click(dom.querySelector("#note"))
    await tracker.flush()

    expect(names(sent)).toEqual(["invoices.paid.toggle", "invoices.terms", "invoices.note"])
  })

  // Guard proof: drop the isDisabled check in onClick; the disabled controls record.
  test("a click inside a disabled part of a marked element records nothing", async () => {
    const { tracker, document, sent } = await setup()
    const dom = page(`
      <button data-sixb-track="invoices.archive" disabled><span>Archive</span></button>
      <div data-sixb-track="invoices.menu">
        <div role="menuitem" aria-disabled="true"><span>Delete</span></div>
        <fieldset disabled><button id="inner">Inner</button></fieldset>
      </div>
    `)
    tracker.page("/invoices")

    document.click(dom.querySelector("button span"))
    document.click(dom.querySelector("[role=menuitem] span"))
    document.click(dom.querySelector("#inner"))
    await tracker.flush()

    expect(names(sent)).toEqual([])
  })

  // Guard proof: remove the click listener with `{}` in dispose; it stays registered.
  test("the click listener is one capture listener on the document, removed on dispose", async () => {
    const { tracker, document } = await setup()

    expect(document.listeners.get("click")).toMatchObject({ capture: true, passive: true })

    tracker.dispose()
    expect(document.listeners.has("click")).toBe(false)
  })

  // Guard proof: refresh lastInputAt in interaction(); the call after a minute is recorded.
  test("code's interactions need the person's own input, and never keep the visit alive", async () => {
    const { tracker, document, sent, warnings, advance } = await setup()
    tracker.page("/invoices")

    advance(30_000)
    tracker.interaction("invoices.filter.applied")
    tracker.interaction("invoices.filter.applied")
    tracker.interaction("Invoices Filter")

    // A minute after the last input, a call is background code, not the person.
    advance(30_000)
    tracker.interaction("invoices.search")

    // A marked click is input: code may report again.
    const dom = page(`<button data-sixb-track="invoices.export">Export</button>`)
    document.click(dom.querySelector("button"))
    tracker.interaction("invoices.search")
    await tracker.flush()

    expect(names(sent)).toEqual(["invoices.filter.applied", "invoices.export", "invoices.search"])
    expect(ofType(sent, "ui.interaction").every((event) => !("attribution" in event))).toBe(true)
    expect(warnings).toEqual([expect.stringContaining('"Invoices Filter" is not')])
  })

  test("nothing is recorded while off, before the settings, hidden or unrecorded", async () => {
    const disabled = await setup({ load: async () => ({ enabled: false, idleTimeoutMs: 60_000 }) })
    disabled.tracker.page("/")
    disabled.tracker.interaction("home.open")
    disabled.document.click(page(`<b data-sixb-track="home.open"></b>`).querySelector("b"))
    await disabled.tracker.flush()
    expect(disabled.sent).toEqual([])

    let resolveLoad: (value: { enabled: boolean; idleTimeoutMs: number }) => void = () => {}
    const { tracker, document, sent } = await setup({
      load: () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
    })
    tracker.page("/")
    tracker.interaction("home.early")
    resolveLoad({ enabled: true, idleTimeoutMs: 60_000 })
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
    await tracker.flush()
    expect(sent.flat().map((event) => event.type)).toEqual(["page.view"])

    document.visibility("hidden")
    tracker.interaction("home.hidden")
    document.visibility("visible")
    tracker.page(null)
    tracker.interaction("settings.open")
    await tracker.flush()
    await tracker.flush()

    expect(sent.flat().map((event) => event.type)).toEqual(["page.view", "visit.activity"])
  })

  // Guard proof: drop the MAX_REPORTED_NAMES check in invalidName; every name warns.
  test("invalid names warn by a short prefix, twenty at most", async () => {
    const { tracker, warnings } = await setup()
    tracker.page("/")

    tracker.interaction(`invoices.${"x".repeat(60)}secret`)
    for (let index = 0; index < 25; index++) {
      tracker.interaction(`Invalid ${index}`)
    }

    expect(warnings).toHaveLength(21)
    expect(warnings[0]).toContain(`"invoices.${"x".repeat(31)}…"`)
    expect(warnings.join("\n")).not.toContain("secret")
    expect(warnings.at(-1)).toBe(
      "[SixbClient] More interaction names are invalid; they are not reported."
    )
  })

  test("the name rule is the one the API validates", async () => {
    const openapi = await Bun.file(new URL("../openapi.json", import.meta.url)).json()
    const events =
      openapi.paths["/api/activity/events"].post.requestBody.content["application/json"].schema
        .properties.events.items.anyOf
    const name = events.find(
      (event: { properties: { type: { enum: string[] } } }) =>
        event.properties.type.enum[0] === "ui.interaction"
    ).properties.name

    expect(name.pattern).toBe(INTERACTION_NAME_PATTERN.source)
    expect(name.maxLength).toBe(INTERACTION_NAME_MAX_LENGTH)
  })

  test("trackSixbEvent reaches the active tracker, and does nothing without one", () => {
    const interaction = jest.spyOn(ActivityTracker.prototype, "interaction")
    client.setConfig({
      baseUrl: "http://api.test",
      fetch: Object.assign(async () => Response.json({ enabled: false, idleTimeoutMs: 60_000 }), {
        preconnect: fetch.preconnect,
      }),
    })

    try {
      trackSixbEvent("invoices.export")
      expect(interaction).not.toHaveBeenCalled()

      startSixbActivityCapture()
      trackSixbEvent("invoices.export")
      expect(interaction).toHaveBeenCalledWith("invoices.export")
    } finally {
      stopSixbActivityCapture()
      interaction.mockRestore()
      client.setConfig({ baseUrl: undefined, fetch: undefined })
    }
  })
})

function names(sent: readonly Batch[]): string[] {
  return sent.flat().flatMap((event) => (event.type === "ui.interaction" ? [event.name] : []))
}

import { afterEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { documentData } from "../src/artifacts/frames/document-data"
import { frameRuntime } from "../src/artifacts/frames/runtime"

// A designed document's fields in the frame, run in a DOM: opened on its own, as the layout check
// opens it, the runtime reads the holder and the queries its fields name from beside it.

const DOCUMENT = `<!doctype html><html lang="en"><head></head><body>
<h1 data-sixb-field="client.name">Client</h1>
<p>Fee <span data-sixb-field="amount" data-format="money" data-currency="USD">$0</span></p>
<ul><li data-sixb-each="query:past"><span data-sixb-field="title">Phase</span></li></ul>
</body></html>`

const windows: Window[] = []
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close()
})

const rows = (...titles: string[]) => ({
  kind: "objects",
  objects: titles.map((title, index) => ({ primaryId: `p${index}`, properties: { title } })),
  total: titles.length,
})

/** The document opened alone at `url`, answering the queries the check serves beside it. */
function frame(url: string, answers: Record<string, unknown>) {
  const window = new Window({ url })
  windows.push(window)
  window.document.write(DOCUMENT)
  const document = window.document
  const script = document.createElement("script")
  script.setAttribute("data-sixb-layout", "document")

  const overrides: Record<string, unknown> = {}
  const proxy = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property) {
        if (typeof property === "string" && property in overrides) return overrides[property]
        const value = Reflect.get(object, property, object)
        return typeof value === "function" ? value.bind(object) : value
      },
    })
  const frameWindow = proxy(window)
  // Alone: no app around it.
  overrides.parent = frameWindow
  const frameDocument = new Proxy(document, {
    get(object, property) {
      if (property === "currentScript") return script
      // What happy-dom leaves out, which the runtime waits on before it marks page breaks.
      if (property === "images") return object.querySelectorAll("img")
      const value = Reflect.get(object, property, object)
      return typeof value === "function" ? value.bind(object) : value
    },
  })
  const fetched: string[] = []
  const fetch = async (address: URL) => {
    const name = address.pathname.match(/^\/__sixb\/queries\/(.+)\.json$/)?.[1] ?? ""
    fetched.push(name)
    return name in answers ? Response.json(answers[name]) : new Response(null, { status: 404 })
  }

  new Function(
    "window",
    "document",
    "requestAnimationFrame",
    "ResizeObserver",
    "getComputedStyle",
    "CustomEvent",
    "Element",
    "HTMLElement",
    "Node",
    "CSS",
    "fetch",
    `(${frameRuntime.toString()})(${documentData.toString()})`
  )(
    frameWindow,
    frameDocument,
    (callback: () => void) => window.setTimeout(callback),
    window.ResizeObserver,
    window.getComputedStyle.bind(window),
    window.CustomEvent,
    window.Element,
    window.HTMLElement,
    window.Node,
    window.CSS,
    fetch
  )

  const texts = (selector: string) =>
    Array.from(document.querySelectorAll(selector), (element) => element.textContent)
  return { window, document, texts, fetched }
}

/** Lets the reads the runtime started arrive, and what they set off: turns, never time. */
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe("a designed document's fields in the frame", () => {
  // Reproduce by dropping showData from the runtime's ready: the fields keep their written text.
  // Dropping its sixb:query listener: the rows read first stay.
  test("show what the holder and the queries hold, and again when a query changes", async () => {
    const answers: Record<string, unknown> = {
      holder: {
        kind: "objects",
        objects: [
          {
            primaryId: "c1",
            properties: { amount: 4200 },
            links: { client: { primaryId: "o1", properties: { name: "Harbor Co" } } },
          },
        ],
        total: 1,
      },
      past: rows("Phase A", "Phase B"),
    }
    const { window, texts, fetched } = frame("https://frame.test/document.html", answers)
    await settle()

    expect(texts("h1")).toEqual(["Harbor Co"])
    expect(texts("p span")).toEqual(["$4,200"])
    expect(texts("li")).toEqual(["Phase A", "Phase B"])
    expect(fetched.sort()).toEqual(["holder", "past"])

    answers.past = rows("Phase C")
    window.dispatchEvent(new window.CustomEvent("sixb:query", { detail: { name: "past" } }))
    await settle()
    expect(texts("li")).toEqual(["Phase C"])
    expect(texts("h1")).toEqual(["Harbor Co"])
  })

  test("keep their written text where nothing is read, and while it is served for editing", async () => {
    // Reproduce by filling in an editing frame: the fields would show values the editor's
    // addresses and words do not hold.
    const missing = frame("https://frame.test/document.html", { past: rows("Phase A") })
    await settle()
    expect(missing.texts("h1")).toEqual(["Client"])
    expect(missing.texts("li")).toEqual(["Phase A"])

    const editing = frame("https://frame.test/document.html?sixb-edit", { past: rows("Phase A") })
    await settle()
    expect(editing.texts("li")).toEqual(["Phase"])
    expect(editing.fetched).toEqual([])
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, jest, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { Composer, type ComposerProps } from "../src/agent/components/composer"
import { ContextChips } from "../src/agent/components/context-chips"
import { useComposerInsertion } from "../src/agent/composer-insertion"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

// Radix picks its layout effect when it loads, a no-op without a `document`, and its popovers then
// never mount: it is given React's own for this file, as agent-context-meter.test.tsx does.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))
afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

const originalConfig = client.getConfig()

beforeAll(() => client.setConfig({ baseUrl: "https://api.sixb.test" }))

afterEach(() => {
  jest.useRealTimers()
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

const digest = `sha256:${"a".repeat(64)}`
const uploaded = {
  blobId: `sha256-${"a".repeat(64)}`,
  digest,
  sizeBytes: 4,
  fileName: "image.png",
  mediaType: "image/png",
}

/** Plays `POST /api/files`, recording each upload. */
function serveUploads() {
  const uploads: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    uploads.push(`${request.method} ${new URL(request.url).pathname}`)
    return Response.json(uploaded, { status: 201 })
  }
  client.setConfig({ fetch: Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }) })
  return uploads
}

function renderComposer(props: Partial<ComposerProps> = {}) {
  const onSend = mock<ComposerProps["onSend"]>(() => {})
  const queryClient = new QueryClient()
  const composer = (next: Partial<ComposerProps>) => (
    <QueryClientProvider client={queryClient}>
      <Composer onSend={onSend} {...props} {...next} />
    </QueryClientProvider>
  )
  const view = render(composer({}))
  const input = () => view.getByLabelText("Message") as HTMLTextAreaElement
  const send = () => view.getByLabelText("Send message") as HTMLButtonElement
  return {
    ...view,
    onSend,
    input,
    send,
    rerender: (next: Partial<ComposerProps>) => view.rerender(composer(next)),
  }
}

/** What a paste carries: its files, and the text its app copied beside them. */
function clipboard(files: readonly File[], text = "") {
  return {
    files,
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    types: [...(text ? ["text/plain"] : []), ...(files.length > 0 ? ["Files"] : [])],
    getData: (type: string) => (type === "text/plain" ? text : ""),
  }
}

const screenshot = () =>
  new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" })

describe("Composer attachments", () => {
  // Removal proof: drop onPaste from the input; nothing uploads.
  test("a pasted screenshot uploads, and sends without text", async () => {
    const uploads = serveUploads()
    const view = renderComposer()
    expect(view.send().disabled).toBe(true)

    const notPrevented = fireEvent.paste(view.input(), { clipboardData: clipboard([screenshot()]) })

    expect(notPrevented).toBe(false)
    expect(await view.findByLabelText("Remove image.png")).toBeDefined()
    expect(uploads).toEqual(["POST /api/files"])
    // Removal proof: require text again in canSend; the button stays disabled.
    await waitFor(() => expect(view.send().disabled).toBe(false))

    fireEvent.click(view.send())
    expect(view.onSend).toHaveBeenCalledWith("", [uploaded], [])
  })

  // Removal proof: drop the text/plain check in handlePaste; the cells upload as a picture.
  test("pasted text stays text, even when its app copies a picture of it too", () => {
    const uploads = serveUploads()
    const view = renderComposer()

    const cells = clipboard([screenshot()], "Q3\t1200")
    expect(fireEvent.paste(view.input(), { clipboardData: cells })).toBe(true)
    expect(fireEvent.paste(view.input(), { clipboardData: clipboard([], "Hello") })).toBe(true)

    // An upload shows its chip at once, before it reaches the API.
    expect(view.queryByLabelText("Remove image.png")).toBeNull()
    expect(uploads).toEqual([])
  })

  test("a file a browser lists only as an item uploads too", async () => {
    const uploads = serveUploads()
    const view = renderComposer()
    const data = { ...clipboard([screenshot()]), files: [] }

    expect(fireEvent.paste(view.input(), { clipboardData: data })).toBe(false)

    expect(await view.findByLabelText("Remove image.png")).toBeDefined()
    expect(uploads).toEqual(["POST /api/files"])
  })

  test("a paste while a message is being sent attaches nothing", () => {
    const uploads = serveUploads()
    const view = renderComposer({ pending: true })

    fireEvent.paste(view.input(), { clipboardData: clipboard([screenshot()]) })

    // An upload shows its chip at once, before it reaches the API.
    expect(view.queryByLabelText("Remove image.png")).toBeNull()
    expect(uploads).toEqual([])
  })

  test("while an answer runs, the next message is written, then sent once it ends", () => {
    const view = renderComposer({ running: true, onStop: () => {} })
    // One availability policy decides initial and return focus: a running answer is not in it.
    expect(document.activeElement).toBe(view.input())

    fireEvent.change(view.input(), { target: { value: "And Globex?" } })
    fireEvent.keyDown(view.input(), { key: "Enter" })

    expect(view.input().value).toBe("And Globex?")
    expect(view.onSend).not.toHaveBeenCalled()

    view.rerender({ running: false })
    // A click focuses the button it lands on.
    view.send().focus()
    fireEvent.click(view.send())
    expect(view.onSend).toHaveBeenCalledWith("And Globex?", [], [])
    // Removal proof: drop the focus call from submit; the focus stays on the button clicked.
    expect(document.activeElement).toBe(view.input())
  })
})

const comments = {
  kind: "app-state" as const,
  id: "artifact-comments:art_1",
  label: "2 comments · Summer sale",
  description: "Comments the person chose.",
  value: {
    artifactId: "art_1",
    title: "Summer sale",
    comments: [
      {
        id: "cmt_1",
        quote: "[landing · body>main:0>h1:0 · revision 3 · comment cmt_1] Warmer title",
        author: "Ava Martin",
        body: "Warmer title",
        replies: [],
      },
      {
        id: "cmt_2",
        quote: "[landing · revision 3 · comment cmt_2] Bigger button",
        author: null,
        body: "Bigger button",
        replies: ["Agreed"],
      },
    ],
  },
}

// Guard proof: set the handed words in place of the input's (`setValue(text)`); what the reader
// wrote is lost. Drop the context branch of the insertion effect; no chip shows, and the comments
// never reach the Agent.
test("comments handed to the input join it as a chip, its words the reader's, and nothing is sent", async () => {
  const view = renderComposer()
  view.rerender({
    insertion: { text: "Please address these comments.", context: comments, nonce: 1 },
  })
  await waitFor(() => expect(view.input().value).toBe("Please address these comments."))
  expect(view.getByRole("button", { name: "Show 2 comments · Summer sale" })).toBeTruthy()
  // The reader reads the comments' words, never where the Agent finds them.
  expect(view.container.textContent).not.toContain("body>")

  // What the reader wrote stays; the same comments handed again make one chip.
  fireEvent.focusIn(view.input())
  fireEvent.input(view.input(), { target: { value: "Keep it short" } })
  fireEvent.keyUp(view.input(), { key: "t" })
  view.rerender({
    insertion: { text: "Please address these comments.", context: comments, nonce: 2 },
  })
  await waitFor(() => expect(view.input().value).toBe("Keep it short"))
  expect(view.getAllByRole("button", { name: "Show 2 comments · Summer sale" })).toHaveLength(1)
  expect(view.onSend).not.toHaveBeenCalled()

  // Sent, they go as the message's context.
  await act(async () => {
    fireEvent.keyDown(view.input(), { key: "Enter" })
  })
  expect(view.onSend).toHaveBeenCalledWith(
    "Keep it short",
    [],
    [{ context: comments, origin: "explicit" }]
  )
})

// Guard proof: render the chip's label without CommentsPreview; a tap shows nothing of what the
// reader sends.
test("a comments chip shows the comments' words on a tap", async () => {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ContextChips entries={[{ context: comments, origin: "explicit" }]} />
    </QueryClientProvider>
  )
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Show 2 comments · Summer sale" }))
  })
  const preview = await waitFor(() => {
    const found = document.querySelector("[data-comments-preview]")
    if (!found) throw new Error("Expected the comments' preview.")
    return found
  })
  expect(preview.textContent).toContain("Ava MartinWarmer title")
  expect(preview.textContent).toContain("SomeoneBigger button1 reply")
  expect(preview.textContent).not.toContain("cmt_")

  // The popover's focus scope dispatches its last event on a timer, while this file's window is
  // still the one installed.
  jest.useFakeTimers()
  view.unmount()
  await act(async () => {
    jest.runAllTimers()
  })
})

// Guard proof: keep the insertion once the composer took it (`inserted` changing nothing); the
// composer drawn again, as the first message replaces the welcome, adds the words a second time.
test("words handed to the input join it once, however often the composer is drawn again", async () => {
  let insert: (draft: { readonly text: string }) => void = () => {}
  function Conversation({ drawing }: { readonly drawing: number }) {
    const insertion = useComposerInsertion()
    insert = insertion.insert
    return (
      <Composer
        key={drawing}
        onSend={() => {}}
        {...(insertion.insertion ? { insertion: insertion.insertion } : {})}
        onInserted={insertion.inserted}
      />
    )
  }
  const queryClient = new QueryClient()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Conversation drawing={1} />
    </QueryClientProvider>
  )
  const input = () => view.getByLabelText("Message") as HTMLTextAreaElement

  await act(async () => insert({ text: "Please address these comments." }))
  await waitFor(() => expect(input().value).toBe("Please address these comments."))
  const first = input()

  // Drawn again, the new composer's effects have run once its input is in the page: an insertion
  // still held would have joined it by then.
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <Conversation drawing={2} />
    </QueryClientProvider>
  )
  await waitFor(() => expect(input()).not.toBe(first))
  expect(input().value).toBe("")
})

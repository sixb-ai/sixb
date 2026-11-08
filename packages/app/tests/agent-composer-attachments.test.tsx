import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { Composer, type ComposerProps } from "../src/agent/components/composer"
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
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const originalConfig = client.getConfig()

beforeAll(() => client.setConfig({ baseUrl: "https://api.sixb.test" }))

afterEach(() => {
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

// Guard proof: set the inserted words in place of the input's (`setValue(insertion.text)`); what
// the reader had written is lost.
test("words handed to the input join what the reader is writing, and are not sent", async () => {
  const view = renderComposer()
  fireEvent.focusIn(view.input())
  fireEvent.input(view.input(), { target: { value: "Also:" } })
  fireEvent.keyUp(view.input(), { key: ":" })

  view.rerender({ insertion: { text: "- [home · revision 3] Warmer colors", nonce: 1 } })
  await waitFor(() =>
    expect(view.input().value).toBe("Also:\n\n- [home · revision 3] Warmer colors")
  )
  expect(view.onSend).not.toHaveBeenCalled()

  // More words, handed later, join after them.
  view.rerender({ insertion: { text: "Done.", nonce: 2 } })
  await waitFor(() => expect(view.input().value).toEndWith("Warmer colors\n\nDone."))
})

// Guard proof: keep the insertion once the composer took it (`inserted` changing nothing); the
// composer drawn again, as the first message replaces the welcome, adds the words a second time.
test("words handed to the input join it once, however often the composer is drawn again", async () => {
  let insert: (text: string) => void = () => {}
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

  await act(async () => insert("- [home · revision 3] Warmer colors"))
  await waitFor(() => expect(input().value).toBe("- [home · revision 3] Warmer colors"))

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <Conversation drawing={2} />
    </QueryClientProvider>
  )
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20))
  })
  expect(input().value).toBe("")
})

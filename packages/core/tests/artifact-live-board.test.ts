import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
import {
  annotateBoard,
  applyBoardEdit,
  applyBoardEditToText,
  boardElement,
  boardElements,
  boardFilePath,
  boardFramePatches,
  boardTextHash,
  patchText,
  setBoardImage,
  setBoardStyle,
  setBoardText,
} from "../src/artifacts/live"

const BOARD = `<!doctype html>
<html>
<head><style>h1 { color: red }</style><script>window.x = 1</script></head>
<body>
  <main class="screen">
    <h1>Welcome</h1>
    <p>Pick a <b>region</b> near you.</p>
    <p></p>
    <img src="hero.png" alt="Fields at dawn">
    <div id="chart"></div>
    <svg viewBox="0 0 10 10"><circle r="4"></circle></svg>
    <ul><li>One</li><li>Two &amp; three</li></ul>
  </main>
  <script>document.getElementById("chart").textContent = "42"</script>
</body>
</html>
`

const edited = (
  source: string,
  edit: readonly { index: number; remove: number; insert: string }[]
) => applyBoardEdit(source, edit)

describe("a board's elements", () => {
  test("are addressed by their path in the source, each with what an editor can do with it", () => {
    expect(boardElements(BOARD).map(({ address, kind, label }) => [address, kind, label])).toEqual([
      ["body", "box", "Welcome Pick a region near you. One Two & three"],
      ["body>main:0", "box", "Welcome Pick a region near you. One Two & three"],
      ["body>main:0>h1:0", "text", "Welcome"],
      ["body>main:0>p:0", "text", "Pick a region near you."],
      ["body>main:0>p:1", "text", ""],
      ["body>main:0>img:0", "image", "Fields at dawn"],
      ["body>main:0>div:0", "box", ""],
      ["body>main:0>svg:0", "whole", ""],
      ["body>main:0>ul:0", "box", "One Two & three"],
      ["body>main:0>ul:0>li:0", "text", "One"],
      ["body>main:0>ul:0>li:1", "text", "Two & three"],
    ])

    // The words inside a block of text are part of it, and what scripts hold is no element.
    expect(boardElement(BOARD, "body>main:0>p:0>b:0")).toBeNull()
    expect(boardElement(BOARD, "body>script:0")).toBeNull()

    const heading = boardElement(BOARD, "body>main:0>h1:0")
    expect(heading && BOARD.slice(heading.start, heading.end)).toBe("<h1>Welcome</h1>")
  })

  test("are addressed the same in a board with no body tag, and nowhere in its head", () => {
    // An implied body is no element of the source: its children are.
    expect(boardElements("<h1>Hi</h1><p>There</p>").map(({ address }) => address)).toEqual([
      "body>h1:0",
      "body>p:0",
    ])
  })

  test("are marked in the source served for editing, and nothing else changes", () => {
    const annotated = annotateBoard(BOARD)
    expect(annotated).toContain(
      `<h1 data-sixb-at="body>main:0>h1:0" data-sixb-edit="text" data-sixb-text="${boardTextHash("Welcome")}">Welcome</h1>`
    )
    expect(annotated).toContain(
      '<img src="hero.png" alt="Fields at dawn" data-sixb-at="body>main:0>img:0" data-sixb-edit="image">'
    )
    expect(annotated).toContain(
      '<svg viewBox="0 0 10 10" data-sixb-at="body>main:0>svg:0" data-sixb-edit="whole"><circle r="4">'
    )
    expect(annotated.replace(/ data-sixb-[a-z]+="[^"]*"/g, "")).toBe(BOARD)
    expect(annotateBoard('<img src="a.png"/>')).toBe(
      '<img src="a.png" data-sixb-at="body>img:0" data-sixb-edit="image"/>'
    )
  })
})

describe("an edit to a board", () => {
  // Guard proof: in setBoardText, put the words into the text after the change's start
  // (`from < end`); typed at the end of the bold word, they leave it.
  test("replaces only the words that changed, and keeps the inline tags around the rest", () => {
    const at = "body>main:0>p:0"

    // Typed at the end of the bold word: bold too.
    const typed = setBoardText(BOARD, at, "Pick a regions near you.")
    expect(typed).toEqual([{ index: BOARD.indexOf("</b>"), remove: 0, insert: "s" }])

    // Deleted across the bold word's end: both texts lose their part.
    const across = edited(BOARD, setBoardText(BOARD, at, "Pick a regi you."))
    expect(across).toContain("<p>Pick a <b>regi</b> you.</p>")

    // At the start, into the first text.
    expect(edited(BOARD, setBoardText(BOARD, at, "So, pick a region near you."))).toContain(
      "<p>So, pick a <b>region</b> near you.</p>"
    )

    // Unchanged words change nothing, and what is typed is text, not markup.
    expect(setBoardText(BOARD, at, "Pick a region near you.")).toEqual([])
    expect(edited(BOARD, setBoardText(BOARD, at, "Pick a region near <you>."))).toContain(
      "near &lt;you&gt;.</p>"
    )
  })

  test("keeps the entities and line breaks of what it does not change", () => {
    const at = "body>main:0>ul:0>li:1"
    expect(edited(BOARD, setBoardText(BOARD, at, "Two & four"))).toContain(
      "<li>Two &amp; four</li>"
    )
    expect(edited(BOARD, setBoardText(BOARD, at, "Two & three!"))).toContain(
      "<li>Two &amp; three!</li>"
    )

    const crlf = "<p>One\r\nTwo&nbsp;three</p>"
    expect(edited(crlf, setBoardText(crlf, "body>p:0", "One\nTwo four"))).toBe(
      "<p>One\r\nTwo&nbsp;four</p>"
    )

    // An entity this does not read one by one: the text is written again whole.
    const named = "<p>Caf&eacute; open</p>"
    expect(edited(named, setBoardText(named, "body>p:0", "Café closed"))).toBe("<p>Café closed</p>")
  })

  test("types into an empty block of text, and refuses what is not one", () => {
    expect(edited(BOARD, setBoardText(BOARD, "body>main:0>p:1", "New"))).toContain("<p>New</p>")
    expect(() => setBoardText(BOARD, "body>main:0>div:0", "x")).toThrow("a box of elements")
    expect(() => setBoardText(BOARD, "body>main:0>h2:0", "x")).toThrow("or a script builds it")
  })

  test("replaces an image's picture and description", () => {
    const at = "body>main:0>img:0"
    expect(
      edited(BOARD, setBoardImage(BOARD, at, { src: "photos/new.png", alt: 'A "new" day' }))
    ).toContain('<img src="photos/new.png" alt="A &quot;new&quot; day">')
    const bare = '<img src="a.png">'
    expect(edited(bare, setBoardImage(bare, "body>img:0", { alt: "A" }))).toBe(
      '<img src="a.png" alt="A">'
    )
    expect(() => setBoardImage(BOARD, at, { src: " javascript:alert(1)" })).toThrow(
      "is not a picture"
    )
    expect(() => setBoardImage(BOARD, "body>main:0>h1:0", { alt: "x" })).toThrow("is text")
  })

  test("sets style properties in the inline style, keeping the rest of it", () => {
    const styled = '<p style="margin: 0; color: red">Hi</p>'
    expect(
      edited(styled, setBoardStyle(styled, "body>p:0", { color: "#336699", "font-size": "18px" }))
    ).toBe('<p style="margin: 0; color: #336699; font-size: 18px">Hi</p>')
    expect(edited(styled, setBoardStyle(styled, "body>p:0", { color: null }))).toBe(
      '<p style="margin: 0">Hi</p>'
    )
    expect(
      edited(BOARD, setBoardStyle(BOARD, "body>main:0>svg:0", { "border-radius": "8px" }))
    ).toContain('<svg viewBox="0 0 10 10" style="border-radius: 8px">')

    expect(() =>
      setBoardStyle(styled, "body>p:0", { position: "fixed" } as Record<string, string>)
    ).toThrow("not a style")
    for (const value of ["red; position: fixed", "url(x.png)", "red}", "@import"]) {
      expect(() => setBoardStyle(styled, "body>p:0", { background: value })).toThrow(
        "is not a value"
      )
    }
  })
})

describe("edits made at once to a board in the live document", () => {
  const pair = () => {
    const left = new Y.Doc()
    const right = new Y.Doc()
    left.getText("board").insert(0, BOARD)
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    return { left, right, text: (doc: Y.Doc) => doc.getText("board") }
  }
  const exchange = (left: Y.Doc, right: Y.Doc) => {
    const fromLeft = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right))
    const fromRight = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left))
    Y.applyUpdate(right, fromLeft)
    Y.applyUpdate(left, fromRight)
  }

  test("to different elements, by two editors, converge to both", () => {
    const { left, right, text } = pair()
    const edit = (doc: Y.Doc, make: (source: string) => ReturnType<typeof setBoardText>) =>
      applyBoardEditToText(text(doc), make(text(doc).toString()))

    edit(left, (source) => setBoardText(source, "body>main:0>h1:0", "Welcome back"))
    edit(left, (source) => setBoardStyle(source, "body>main:0>p:0", { color: "navy" }))
    edit(right, (source) => setBoardImage(source, "body>main:0>img:0", { alt: "Fields at dusk" }))
    edit(right, (source) => setBoardText(source, "body>main:0>ul:0>li:0", "First"))
    exchange(left, right)

    const result = text(left).toString()
    expect(text(right).toString()).toBe(result)
    expect(result).toContain("<h1>Welcome back</h1>")
    expect(result).toContain('<p style="color: navy">Pick a <b>region</b> near you.</p>')
    expect(result).toContain('alt="Fields at dusk"')
    expect(result).toContain("<li>First</li>")
    expect(boardElements(result).map(({ address }) => address)).toEqual(
      boardElements(BOARD).map(({ address }) => address)
    )
  })

  test("an Agent's rewrite merged as a diff, while an editor types in the same board", () => {
    const { left, right, text } = pair()

    // The editor types in the heading; the Agent rewrites the list and adds a paragraph.
    applyBoardEditToText(
      text(left),
      setBoardText(text(left).toString(), "body>main:0>h1:0", "Welcome, Marie")
    )
    patchText(
      text(right),
      BOARD.replace("<li>One</li>", "<li>Uno</li>").replace("</ul>", "</ul>\n    <p>Need help?</p>")
    )
    exchange(left, right)

    const result = text(left).toString()
    expect(text(right).toString()).toBe(result)
    expect(result).toContain("<h1>Welcome, Marie</h1>")
    expect(result).toContain("<li>Uno</li>")
    expect(result).toContain("<p>Need help?</p>")
  })
})

describe("a frame showing a board for editing", () => {
  test("changes in place what changed in an element, and loads again when elements did", () => {
    const named = applyBoardEdit(BOARD, setBoardText(BOARD, "body>main:0>h1:0", "Hello"))
    const after = applyBoardEdit(named, setBoardStyle(named, "body>main:0>p:0", { color: "navy" }))

    expect(boardFramePatches(BOARD, after)).toEqual([
      {
        address: "body>main:0>h1:0",
        attributes: {
          "data-sixb-at": "body>main:0>h1:0",
          "data-sixb-edit": "text",
          "data-sixb-text": boardTextHash("Hello"),
        },
        html: "Hello",
      },
      {
        address: "body>main:0>p:0",
        attributes: {
          style: "color: navy",
          "data-sixb-at": "body>main:0>p:0",
          "data-sixb-edit": "text",
          "data-sixb-text": boardTextHash("Pick a region near you."),
        },
      },
    ])
    expect(boardFramePatches(BOARD, BOARD)).toEqual([])
    expect(boardFramePatches(BOARD, BOARD.replace("</ul>", "</ul><p>New</p>"))).toBeNull()
    // A box's own words, between its children.
    expect(
      boardFramePatches(BOARD, BOARD.replace('<main class="screen">', '<main class="screen">Note'))
    ).toBeNull()
  })

  test("names an image's file from the board's folder", () => {
    expect(boardFilePath("boards/welcome.html", "boards/images/hero.png")).toBe("images/hero.png")
    expect(boardFilePath("boards/welcome.html", "images/hero one.png")).toBe(
      "../images/hero%20one.png"
    )
  })
})

import { describe, expect, test } from "bun:test"
import { htmlToMarkdown } from "../src/tools/web-fetch/html-markdown"

const PAGE_URL = "https://example.com/docs/guide/page.html"

function convert(html: string, contentType = "text/html; charset=utf-8") {
  return htmlToMarkdown({ bytes: new TextEncoder().encode(html), contentType, url: PAGE_URL })
}

describe("htmlToMarkdown", () => {
  test("writes tables as GFM tables", () => {
    const { markdown } = convert(`
      <table>
        <thead><tr><th>Plan</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Free</td><td>$0</td></tr>
          <tr><td>Team</td><td>$20</td></tr>
        </tbody>
      </table>
    `)

    expect(markdown).toBe(
      ["| Plan | Price |", "| ---- | ----- |", "| Free | $0    |", "| Team | $20   |"].join("\n")
    )
  })

  test("keeps nested lists nested", () => {
    const { markdown } = convert(`
      <ul>
        <li>Fruit
          <ol><li>Apple</li><li>Pear</li></ol>
        </li>
        <li>Vegetables</li>
      </ul>
    `)

    expect(markdown).toBe(["- Fruit", "", "  1. Apple", "  2. Pear", "", "- Vegetables"].join("\n"))
  })

  test("resolves links and images against the final URL", () => {
    const { markdown } = convert(`
      <p>
        <a href="../api">API</a>, <a href="/pricing">pricing</a>, <a href="#setup">setup</a>,
        <a href="mailto:team@example.com">mail</a>
        <img src="img/diagram.png" alt="Diagram">
      </p>
    `)

    expect(markdown).toContain("[API](https://example.com/docs/api)")
    expect(markdown).toContain("[pricing](https://example.com/pricing)")
    expect(markdown).toContain("[setup](https://example.com/docs/guide/page.html#setup)")
    expect(markdown).toContain("[mail](mailto:team@example.com)")
    expect(markdown).toContain("![Diagram](https://example.com/docs/guide/img/diagram.png)")
  })

  test("resolves against a <base href> when the page declares one", () => {
    const { markdown } = convert(`
      <head><base href="/v2/"></head>
      <body><a href="intro">Intro</a></body>
    `)

    expect(markdown).toBe("[Intro](https://example.com/v2/intro)")
  })

  test("keeps the text of a javascript: link and drops the link", () => {
    const { markdown } = convert(`<p>Click <a href="javascript:alert(1)">here</a> now.</p>`)

    expect(markdown).toBe("Click here now.")
  })

  test("drops images that are not on the web", () => {
    const { markdown } = convert(`<p>A<img src="data:image/png;base64,AAAA" alt="inline">B</p>`)

    expect(markdown).toBe("AB")
  })

  test("strips scripts, styles, page chrome and hidden elements", () => {
    const { markdown } = convert(`
      <head><style>body { color: red }</style><script>track()</script></head>
      <body>
        <header>Logo</header>
        <nav><a href="/">Home</a></nav>
        <p>Content<script>inline()</script></p>
        <noscript>Enable JavaScript</noscript>
        <div hidden>Hidden</div>
        <span aria-hidden="true">Decoration</span>
        <form><input name="q"><button>Search</button></form>
        <aside>Related</aside>
        <svg><text>Chart</text></svg>
        <iframe src="/ad"></iframe>
        <template><p>Template</p></template>
        <footer>Copyright</footer>
      </body>
    `)

    expect(markdown).toBe("Content")
  })

  test("keeps only the page's single main", () => {
    const { markdown } = convert(`
      <div>Cookie banner</div>
      <main><h1>Guide</h1><article>One</article><article>Two</article></main>
      <div>Newsletter</div>
    `)

    expect(markdown).toBe(["# Guide", "", "One", "", "Two"].join("\n"))
  })

  test("keeps only the single article when there is no main", () => {
    const { markdown } = convert(`
      <div>Sidebar</div>
      <article><h1>Post</h1><p>Body</p></article>
    `)

    expect(markdown).toBe(["# Post", "", "Body"].join("\n"))
  })

  test("keeps the whole page when articles are several", () => {
    const { markdown } = convert(`<p>Feed</p><article>One</article><article>Two</article>`)

    expect(markdown).toBe(["Feed", "", "One", "", "Two"].join("\n"))
  })

  test("decodes with the charset of the content type", () => {
    // "café crème" in ISO-8859-1: é is 0xe9, è is 0xe8.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("<p>caf"),
      0xe9,
      ...new TextEncoder().encode(" cr"),
      0xe8,
      ...new TextEncoder().encode("me</p>"),
    ])

    const fromHeader = htmlToMarkdown({
      bytes,
      contentType: "text/html; charset=ISO-8859-1",
      url: PAGE_URL,
    })
    expect(fromHeader.markdown).toBe("café crème")

    const fromMeta = htmlToMarkdown({
      bytes: new Uint8Array([...new TextEncoder().encode('<meta charset="latin1">'), ...bytes]),
      contentType: "text/html",
      url: PAGE_URL,
    })
    expect(fromMeta.markdown).toBe("café crème")
  })

  test("decodes an unknown charset as UTF-8", () => {
    const { markdown } = convert("<p>café</p>", "text/html; charset=x-made-up")

    expect(markdown).toBe("café")
  })

  test("prefers og:title over <title>", () => {
    const head = `<title>  Docs |
      Example </title>`

    expect(convert(`${head}<meta property="og:title" content=" Getting started ">`).title).toBe(
      "Getting started"
    )
    expect(convert(head).title).toBe("Docs | Example")
  })

  test("returns nothing for an empty or garbage body", () => {
    expect(convert("")).toEqual({ title: "", markdown: "" })

    const garbage = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7919) % 256)
    const result = htmlToMarkdown({ bytes: garbage, contentType: "", url: "not a url" })
    expect(typeof result.markdown).toBe("string")
  })

  test("writes code blocks as fenced code, blank lines included", () => {
    const { markdown } = convert(`
      <p>Install:</p>
      <pre><code class="language-ts">const a = 1


const b = 2</code></pre>
      <p>Then <code>run()</code>.</p>
    `)

    expect(markdown).toBe(
      [
        "Install:",
        "",
        "```ts",
        "const a = 1",
        "",
        "",
        "const b = 2",
        "```",
        "",
        "Then `run()`.",
      ].join("\n")
    )
  })

  test("collapses runs of blank lines", () => {
    const { markdown } = convert("<p>One</p><p> </p><br><br><p></p><p>Two</p>")

    expect(markdown).toBe("One\n\nTwo")
  })

  test("cuts the page where it nests deeper than a browser would", () => {
    // Without the depth bound in `parseBounded`, this throws "Maximum call stack size exceeded"
    // from the syntax-tree utilities. Reproduce by returning `parse(html)` there directly.
    const deep = `<p>Before</p>${"<div>".repeat(20_000)}Deep`

    const { markdown, truncated } = convert(deep)

    expect(markdown).toBe("Before")
    expect(truncated).toBe(true)
  })

  test("cuts a page that places too many elements, however few its bytes", () => {
    // parse5 rebuilds the misnested `<b>` around every paragraph: 300 KB place ~160k elements,
    // seconds of conversion. Without the element budget in `parseBounded`, every paragraph is
    // kept and `truncated` is absent. Reproduce by raising MAX_ELEMENTS to Infinity.
    const paragraphs = Array.from({ length: 20_000 }, (_, index) => `<a><b><p>p${index}</a>`)

    const { markdown, truncated } = convert(paragraphs.join(""))

    expect(truncated).toBe(true)
    expect(markdown).toContain("p0")
    expect(markdown).not.toContain("p19999")
  })

  test("keeps a page within the element budget whole", () => {
    const paragraphs = Array.from({ length: 5_000 }, (_, index) => `<p>p${index}</p>`)

    const { markdown, truncated } = convert(paragraphs.join(""))

    expect(truncated).toBeUndefined()
    expect(markdown.endsWith("p4999")).toBe(true)
  })

  test("writes struck text and task lists as GFM", () => {
    // Without the GFM extensions, `toMarkdown` throws "Cannot handle unknown node `delete`" on
    // any page with <del>, <s> or <strike>. Reproduce with `gfmTableToMarkdown()` alone.
    const { markdown } = convert(`
      <p><del>old</del> <s>gone</s> <strike>struck</strike> new</p>
      <ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>
    `)

    expect(markdown).toBe("~~old~~ ~~gone~~ ~~struck~~ new\n\n- [x] done\n- [ ] todo")
  })

  // Regression proof: drop `unwrapEmptyInline` in writeMarkdown; the first page then starts with
  // `~~~~~~~~`, a code fence that swallows the rest of the page.
  test("drops struck text, emphasis and links that show nothing", () => {
    expect(convert("<p><del></del><s> </s></p><p>After</p>").markdown).toBe("After")

    const { markdown } = convert(
      `<p>a <em></em><strong> </strong><a href="/x"> </a><code> </code>b <a href="/y"><img src="y.png" alt=""></a></p>`
    )
    expect(markdown).toBe("a b [![](https://example.com/docs/guide/y.png)](https://example.com/y)")
  })

  test("keeps every row of a table too large to convert in one piece", () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => `<tr><td>row ${index}</td></tr>`)

    const { markdown } = convert(`<table><tr><th>Name</th></tr>${rows.join("")}</table>`)

    const lines = markdown.split("\n").map((line) => line.replace(/ +/g, " "))
    const cells = lines.filter((line) => line.startsWith("| row "))

    expect(cells).toHaveLength(3_000)
    expect(cells[0]).toBe("| row 0 |")
    expect(cells.at(-1)).toBe("| row 2999 |")
  })
})

// Copying writes the selection as HTML, marked with where it was cut open (`data-pm-slice`, as
// ProseMirror-based editors read it), and as text. Pasting reads HTML by the schema's parse rules,
// fitting what it reads where the caret is, or reads plain text a line to a paragraph. Both follow
// ProseMirror's clipboard (MIT), so a paste reads as it did.

import { type DOMSpec, renderSpec } from "./dom"
import {
  type Attrs,
  type ContentMatch,
  Fragment,
  Mark,
  type MarkType,
  type Node,
  type NodeType,
  type ParseRule,
  type ResolvedPos,
  type Schema,
  Slice,
  TextNode,
} from "./model"

// ── Writing ─────────────────────────────────────────────────────────────

/** A fragment drawn as its schema draws it, without node views: what the clipboard holds. */
export function serializeFragment(
  document: Document,
  fragment: Fragment,
  target: DocumentFragment | HTMLElement = document.createDocumentFragment()
): DocumentFragment | HTMLElement {
  let top: globalThis.Node = target
  const active: [Mark, globalThis.Node][] = []
  fragment.forEach((node) => {
    if (active.length || node.marks.length) {
      let keep = 0
      let rendered = 0
      while (keep < active.length && rendered < node.marks.length) {
        const next = node.marks[rendered] as Mark
        if (!next.type.spec.toDOM) {
          rendered += 1
          continue
        }
        if (!next.eq((active[keep] as [Mark, globalThis.Node])[0])) break
        keep += 1
        rendered += 1
      }
      while (keep < active.length) top = (active.pop() as [Mark, globalThis.Node])[1]
      while (rendered < node.marks.length) {
        const mark = node.marks[rendered] as Mark
        rendered += 1
        const spec = mark.type.spec.toDOM?.(mark)
        if (!spec) continue
        const made = renderSpec(document, spec)
        active.push([mark, top])
        top.appendChild(made.dom)
        top = made.contentDOM ?? made.dom
      }
    }
    top.appendChild(serializeNode(document, node))
  })
  return target
}

export function serializeNode(document: Document, node: Node): globalThis.Node {
  if (node.isText) return document.createTextNode(node.text ?? "")
  const spec: DOMSpec = node.type.spec.toDOM?.(node) ?? ["div", 0]
  const { dom, contentDOM } = renderSpec(document, spec)
  if (contentDOM) serializeFragment(document, node.content, contentDOM)
  return dom
}

const WRAP_MAP: Readonly<Record<string, readonly string[]>> = {
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  caption: ["table"],
  colgroup: ["table"],
  col: ["table", "colgroup"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"],
}

/** A slice as clipboard HTML and text. */
export function serializeSlice(
  view: { readonly document: Document },
  slice: Slice,
  textSerializer?: (slice: Slice) => string
): { html: string; text: string } {
  const context: unknown[] = []
  let { content, openStart, openEnd } = slice
  while (
    openStart > 1 &&
    openEnd > 1 &&
    content.childCount === 1 &&
    (content.firstChild as Node).childCount === 1
  ) {
    openStart -= 1
    openEnd -= 1
    const node = content.firstChild as Node
    context.push(
      node.type.name,
      Object.keys(node.attrs).length && !sameAsDefault(node) ? node.attrs : null
    )
    content = node.content
  }
  const document = view.document.implementation.createHTMLDocument("title")
  const wrap = document.createElement("div")
  wrap.appendChild(serializeFragment(document, content, document.createDocumentFragment()))
  let firstChild = wrap.firstChild
  let wrappers = 0
  for (
    let needs =
      firstChild?.nodeType === 1 ? WRAP_MAP[firstChild.nodeName.toLowerCase()] : undefined;
    firstChild && needs;
  ) {
    for (let index = needs.length - 1; index >= 0; index -= 1) {
      const wrapper = document.createElement(needs[index] as string)
      while (wrap.firstChild) wrapper.appendChild(wrap.firstChild)
      wrap.appendChild(wrapper)
      wrappers += 1
    }
    firstChild = wrap.firstChild
    needs = firstChild?.nodeType === 1 ? WRAP_MAP[firstChild.nodeName.toLowerCase()] : undefined
  }
  if (firstChild && firstChild.nodeType === 1) {
    ;(firstChild as HTMLElement).setAttribute(
      "data-pm-slice",
      `${openStart} ${openEnd}${wrappers ? ` -${wrappers}` : ""} ${JSON.stringify(context)}`
    )
  }
  const text = textSerializer?.(slice) || slice.content.textBetween(0, slice.content.size, "\n\n")
  return { html: wrap.innerHTML, text }
}

function sameAsDefault(node: Node): boolean {
  const defaults = node.type.defaultAttrs
  return Object.keys(node.attrs).every((key) => node.attrs[key] === defaults[key])
}

// ── Reading ─────────────────────────────────────────────────────────────

/** What is pasted or dropped, as a slice fitted to stand at `$context`; null for nothing. */
export function parseSlice(
  view: { readonly document: Document; readonly state: { readonly schema: Schema } },
  html: string | null,
  text: string | null,
  plainText: boolean,
  $context: ResolvedPos
): Slice | null {
  const schema = view.state.schema
  const inCode = !!$context.parent.type.spec.code
  if (!html && !text) return null
  const asText = !!text && (plainText || inCode || !html)
  let dom: HTMLElement
  if (asText) {
    const value = text as string
    if (inCode)
      return new Slice(Fragment.from(schema.textNode(value.replace(/\r\n?/g, "\n"))), 0, 0)
    const marks = $context.marks()
    dom = view.document.createElement("div")
    for (const block of value.split(/(?:\r\n?|\n)+/)) {
      const paragraph = dom.appendChild(view.document.createElement("p"))
      if (block) paragraph.appendChild(serializeNode(view.document, schema.textNode(block, marks)))
    }
  } else {
    dom = readHTML(view.document, html as string)
    for (const node of Array.from(dom.querySelectorAll("span:not([class]):not([style])"))) {
      if (node.childNodes.length === 1 && node.textContent === "\u00a0" && node.parentNode) {
        node.parentNode.replaceChild(dom.ownerDocument.createTextNode(" "), node)
      }
    }
  }
  const contextNode = dom.querySelector("[data-pm-slice]")
  const sliceData =
    contextNode &&
    /^(\d+) (\d+)(?: -(\d+))? (.*)/.exec(contextNode.getAttribute("data-pm-slice") ?? "")
  if (sliceData?.[3]) {
    for (let index = Number(sliceData[3]); index > 0; index -= 1) {
      let child = dom.firstChild
      while (child && child.nodeType !== 1) child = child.nextSibling
      if (!child) break
      dom = child as HTMLElement
    }
  }
  const parser = parserFor(schema)
  let slice = parser.parseSlice(dom, {
    preserveWhitespace: !!(asText || sliceData),
    context: $context,
    ruleFromNode: (element) => {
      if (
        element.nodeName === "BR" &&
        !element.nextSibling &&
        element.parentNode &&
        !/^(a|abbr|acronym|b|bd[io]|big|br|button|cite|code|data(list)?|del|dfn|em|i|img|ins|kbd|label|map|mark|meter|output|q|ruby|s|samp|small|span|strong|su[bp]|time|u|tt|var)$/i.test(
          element.parentNode.nodeName
        )
      ) {
        return { ignore: true }
      }
      return null
    },
  })
  if (sliceData) {
    slice = addContext(
      closeSlice(slice, Number(sliceData[1]), Number(sliceData[2])),
      sliceData[4] as string
    )
  } else {
    slice = Slice.maxOpen(normalizeSiblings(slice.content, $context), true)
    if (slice.openStart || slice.openEnd) {
      let openStart = 0
      let openEnd = 0
      for (
        let node = slice.content.firstChild;
        openStart < slice.openStart && node && !node.type.spec.isolating;
        openStart += 1, node = node.firstChild
      ) {
        // Opened only to its first isolating node.
      }
      for (
        let node = slice.content.lastChild;
        openEnd < slice.openEnd && node && !node.type.spec.isolating;
        openEnd += 1, node = node.lastChild
      ) {
        // And at its end, the same.
      }
      slice = closeSlice(slice, openStart, openEnd)
    }
  }
  return slice
}

function readHTML(document: Document, source: string): HTMLElement {
  let html = source
  const metas = /^(\s*<meta [^>]*>)*/.exec(html)
  if (metas) html = html.slice(metas[0].length)
  const detached = document.implementation.createHTMLDocument("title")
  let element = detached.body
  const firstTag = /<([a-z][^>\s]+)/i.exec(html)
  const wrap = firstTag ? WRAP_MAP[(firstTag[1] as string).toLowerCase()] : undefined
  if (wrap)
    html =
      wrap.map((name) => `<${name}>`).join("") +
      html +
      [...wrap]
        .reverse()
        .map((name) => `</${name}>`)
        .join("")
  element.innerHTML = html
  if (wrap)
    for (const name of wrap)
      element = (element.querySelector(name) as HTMLElement | null) ?? element
  return element
}

function normalizeSiblings(fragment: Fragment, $context: ResolvedPos): Fragment {
  if (fragment.childCount < 2) return fragment
  for (let depth = $context.depth; depth >= 0; depth -= 1) {
    const parent = $context.node(depth)
    let match = parent.contentMatchAt($context.index(depth))
    let lastWrap: readonly NodeType[] = []
    let result: Node[] | null = []
    fragment.forEach((node) => {
      if (!result) return
      const wrap = match.findWrapping(node.type)
      if (!wrap) {
        result = null
        return
      }
      const inLast =
        result.length && lastWrap.length
          ? addToSibling(wrap, lastWrap, node, result[result.length - 1] as Node, 0)
          : undefined
      if (inLast) {
        result[result.length - 1] = inLast
      } else {
        if (result.length)
          result[result.length - 1] = closeRight(result[result.length - 1] as Node, lastWrap.length)
        const wrapped = withWrappers(node, wrap)
        result.push(wrapped)
        match = match.matchType(wrapped.type) as ContentMatch
        lastWrap = wrap
      }
    })
    if (result) return Fragment.from(result)
  }
  return fragment
}

function withWrappers(node: Node, wrap: readonly NodeType[], from = 0): Node {
  let wrapped = node
  for (let index = wrap.length - 1; index >= from; index -= 1)
    wrapped = (wrap[index] as NodeType).create(null, Fragment.from(wrapped))
  return wrapped
}

function addToSibling(
  wrap: readonly NodeType[],
  lastWrap: readonly NodeType[],
  node: Node,
  sibling: Node,
  depth: number
): Node | undefined {
  if (depth < wrap.length && depth < lastWrap.length && wrap[depth] === lastWrap[depth]) {
    const inner = addToSibling(wrap, lastWrap, node, sibling.lastChild as Node, depth + 1)
    if (inner) return sibling.copy(sibling.content.replaceChild(sibling.childCount - 1, inner))
    const match = sibling.contentMatchAt(sibling.childCount)
    if (match.matchType(depth === wrap.length - 1 ? node.type : (wrap[depth + 1] as NodeType))) {
      return sibling.copy(
        sibling.content.append(Fragment.from(withWrappers(node, wrap, depth + 1)))
      )
    }
  }
  return undefined
}

function closeRight(node: Node, depth: number): Node {
  if (depth === 0) return node
  const fragment = node.content.replaceChild(
    node.childCount - 1,
    closeRight(node.lastChild as Node, depth - 1)
  )
  const fill = node.contentMatchAt(node.childCount).fillBefore(Fragment.empty, true) as Fragment
  return node.copy(fragment.append(fill))
}

function closeRange(
  fragment: Fragment,
  side: number,
  from: number,
  to: number,
  depth: number,
  openEnd: number
): Fragment {
  const node = (side < 0 ? fragment.firstChild : fragment.lastChild) as Node
  let inner = node.content
  const end = fragment.childCount > 1 ? 0 : openEnd
  if (depth < to - 1) inner = closeRange(inner, side, from, to, depth + 1, end)
  if (depth >= from) {
    inner =
      side < 0
        ? (node.contentMatchAt(0).fillBefore(inner, end <= depth) as Fragment).append(inner)
        : inner.append(
            node.contentMatchAt(node.childCount).fillBefore(Fragment.empty, true) as Fragment
          )
  }
  return fragment.replaceChild(side < 0 ? 0 : fragment.childCount - 1, node.copy(inner))
}

function closeSlice(slice: Slice, openStart: number, openEnd: number): Slice {
  let result = slice
  if (openStart < result.openStart)
    result = new Slice(
      closeRange(result.content, -1, openStart, result.openStart, 0, result.openEnd),
      openStart,
      result.openEnd
    )
  if (openEnd < result.openEnd)
    result = new Slice(
      closeRange(result.content, 1, openEnd, result.openEnd, 0, 0),
      result.openStart,
      openEnd
    )
  return result
}

function addContext(slice: Slice, context: string): Slice {
  if (!slice.size) return slice
  const schema = (slice.content.firstChild as Node).type.schema
  let array: unknown[]
  try {
    array = JSON.parse(context)
  } catch {
    return slice
  }
  let { content, openStart, openEnd } = slice
  for (let index = array.length - 2; index >= 0; index -= 2) {
    const type = schema.nodes[array[index] as string]
    if (!type) break
    try {
      content = Fragment.from(type.create(array[index + 1] as Attrs | null, content))
    } catch {
      break
    }
    openStart += 1
    openEnd += 1
  }
  return new Slice(content, openStart, openEnd)
}

// ── The parser ──────────────────────────────────────────────────────────

interface Rule extends ParseRule {
  readonly node?: string
  readonly mark?: string
}

interface ParseOptions {
  readonly preserveWhitespace?: boolean | "full"
  readonly context?: ResolvedPos
  readonly ruleFromNode?: (element: HTMLElement) => ParseRule | null
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "canvas",
  "dd",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "noscript",
  "ol",
  "output",
  "p",
  "pre",
  "section",
  "table",
  "tfoot",
  "ul",
])
const IGNORE_TAGS = new Set(["head", "noscript", "object", "script", "style", "title"])
const LIST_TAGS = new Set(["ol", "ul"])

const PRESERVE = 1
const PRESERVE_FULL = 2
const OPEN_LEFT = 4

const parsers = new WeakMap<Schema, Parser>()

export function parserFor(schema: Schema): Parser {
  let parser = parsers.get(schema)
  if (!parser) {
    parser = new Parser(schema)
    parsers.set(schema, parser)
  }
  return parser
}

/** Reads DOM as a schema's nodes and marks, by their parse rules. */
export class Parser {
  readonly tags: Rule[] = []
  readonly styles: Rule[] = []
  readonly matchedStyles: string[] = []
  readonly normalizeLists: boolean

  constructor(readonly schema: Schema) {
    const rules: Rule[] = []
    const insert = (rule: Rule) => {
      const priority = rule.priority ?? 50
      let index = 0
      for (; index < rules.length; index += 1) if ((rules[index]?.priority ?? 50) < priority) break
      rules.splice(index, 0, rule)
    }
    for (const [name, type] of Object.entries(schema.marks)) {
      for (const rule of type.spec.parseDOM ?? [])
        insert({ ...rule, ...(rule.ignore || rule.clearMark ? {} : { mark: name }) })
    }
    for (const [name, type] of Object.entries(schema.nodes)) {
      for (const rule of type.spec.parseDOM ?? [])
        insert({ ...rule, ...(rule.ignore ? {} : { node: name }) })
    }
    for (const rule of rules) {
      if (rule.tag) this.tags.push(rule)
      else if (rule.style) {
        const prop = /[^=]*/.exec(rule.style)?.[0] as string
        if (!this.matchedStyles.includes(prop)) this.matchedStyles.push(prop)
        this.styles.push(rule)
      }
    }
    this.normalizeLists = !this.tags.some((rule) => {
      if (!/^(ul|ol)\b/.test(rule.tag ?? "") || !rule.node) return false
      const node = schema.nodes[rule.node] as NodeType
      return !!node.contentMatch.matchType(node)
    })
  }

  parseSlice(dom: globalThis.Node, options: ParseOptions = {}): Slice {
    const context = new ParseContext(this, options)
    context.addAll(dom, Mark.none)
    return Slice.maxOpen(context.finish() as Fragment)
  }

  matchTag(dom: HTMLElement, after?: Rule): { rule: Rule; attrs: Attrs | null } | null {
    for (
      let index = after ? this.tags.indexOf(after) + 1 : 0;
      index < this.tags.length;
      index += 1
    ) {
      const rule = this.tags[index] as Rule
      if (!dom.matches(rule.tag as string)) continue
      let attrs: Attrs | null = null
      if (rule.getAttrs) {
        const result = rule.getAttrs(dom)
        if (result === false) continue
        attrs = result ?? null
      }
      return { rule, attrs }
    }
    return null
  }

  matchStyle(
    prop: string,
    value: string,
    after?: Rule
  ): { rule: Rule; attrs: Attrs | null } | null {
    for (
      let index = after ? this.styles.indexOf(after) + 1 : 0;
      index < this.styles.length;
      index += 1
    ) {
      const rule = this.styles[index] as Rule
      const style = rule.style as string
      if (
        style.indexOf(prop) !== 0 ||
        (style.length > prop.length &&
          (style.charCodeAt(prop.length) !== 61 || style.slice(prop.length + 1) !== value))
      )
        continue
      let attrs: Attrs | null = null
      if (rule.getAttrs) {
        const result = rule.getAttrs(value)
        if (result === false) continue
        attrs = result ?? null
      }
      return { rule, attrs }
    }
    return null
  }
}

class NodeContext {
  match: ContentMatch | null
  content: Node[] = []

  constructor(
    readonly type: NodeType | null,
    readonly attrs: Attrs | null,
    readonly marks: readonly Mark[],
    readonly solid: boolean,
    match: ContentMatch | null,
    public options: number
  ) {
    this.match = match ?? (options & OPEN_LEFT ? null : (type?.contentMatch ?? null))
  }

  findWrapping(node: Node): readonly NodeType[] | null {
    if (!this.match) {
      if (!this.type) return []
      const fill = this.type.contentMatch.fillBefore(Fragment.from(node))
      if (fill) {
        this.match = this.type.contentMatch.matchFragment(fill)
      } else {
        const start = this.type.contentMatch
        const wrap = start.findWrapping(node.type)
        if (!wrap) return null
        this.match = start
        return wrap
      }
    }
    return this.match?.findWrapping(node.type) ?? null
  }

  finish(openEnd: boolean): Node | Fragment {
    if (!(this.options & PRESERVE)) {
      const last = this.content[this.content.length - 1]
      const match = last?.isText ? /[ \t\r\n\u000c]+$/.exec(last.text ?? "") : null
      if (last && match) {
        if ((last.text ?? "").length === match[0].length) this.content.pop()
        else
          this.content[this.content.length - 1] = (last as TextNode).withText(
            (last.text ?? "").slice(0, (last.text ?? "").length - match[0].length)
          )
      }
    }
    let content = Fragment.from(this.content)
    if (!openEnd && this.match)
      content = content.append(this.match.fillBefore(Fragment.empty, true) ?? Fragment.empty)
    return this.type ? this.type.create(this.attrs, content, this.marks) : content
  }

  inlineContext(node: globalThis.Node): boolean {
    if (this.type) return this.type.inlineContent
    if (this.content.length) return (this.content[0] as Node).isInline
    return !!node.parentNode && !BLOCK_TAGS.has(node.parentNode.nodeName.toLowerCase())
  }
}

function wsOptionsFor(
  type: NodeType | null,
  preserveWhitespace: boolean | "full" | undefined,
  base: number
): number {
  if (preserveWhitespace !== undefined)
    return (preserveWhitespace ? PRESERVE : 0) | (preserveWhitespace === "full" ? PRESERVE_FULL : 0)
  return type?.spec.code ? PRESERVE | PRESERVE_FULL : base & ~OPEN_LEFT
}

function markMayApply(markType: MarkType, nodeType: NodeType): boolean {
  for (const parent of Object.values(nodeType.schema.nodes)) {
    if (!parent.allowsMarkType(markType)) continue
    const seen: ContentMatch[] = []
    const scan = (match: ContentMatch): boolean => {
      seen.push(match)
      for (let index = 0; index < match.edgeCount; index += 1) {
        const { type, next } = match.edge(index)
        if (type === nodeType) return true
        if (!seen.includes(next) && scan(next)) return true
      }
      return false
    }
    if (scan(parent.contentMatch)) return true
  }
  return false
}

class ParseContext {
  open = 0
  needsBlock = false
  nodes: NodeContext[]
  localPreserve = false

  constructor(
    readonly parser: Parser,
    readonly options: ParseOptions
  ) {
    const topOptions = wsOptionsFor(null, options.preserveWhitespace, 0) | OPEN_LEFT
    this.nodes = [new NodeContext(null, null, Mark.none, true, null, topOptions)]
  }

  get top(): NodeContext {
    return this.nodes[this.open] as NodeContext
  }

  addDOM(dom: globalThis.Node, marks: readonly Mark[]): void {
    if (dom.nodeType === 3) this.addText(dom as Text, marks)
    else if (dom.nodeType === 1) this.addElement(dom as HTMLElement, marks)
  }

  addText(dom: Text, marks: readonly Mark[]): void {
    let value = dom.nodeValue ?? ""
    const top = this.top
    const preserve =
      top.options & PRESERVE_FULL ? "full" : this.localPreserve || (top.options & PRESERVE) > 0
    const schema = this.parser.schema
    if (preserve === "full" || top.inlineContext(dom) || /[^ \t\r\n\u000c]/.test(value)) {
      if (!preserve) {
        value = value.replace(/[ \t\r\n\u000c]+/g, " ")
        if (/^[ \t\r\n\u000c]/.test(value) && this.open === this.nodes.length - 1) {
          const before = top.content[top.content.length - 1]
          const domBefore = dom.previousSibling
          if (
            !before ||
            domBefore?.nodeName === "BR" ||
            (before.isText && /[ \t\r\n\u000c]$/.test(before.text ?? ""))
          )
            value = value.slice(1)
        }
      } else if (preserve === "full") {
        value = value.replace(/\r\n?/g, "\n")
      } else if (
        schema.nodes.hardBreak &&
        /[\r\n]/.test(value) &&
        this.top.findWrapping((schema.nodes.hardBreak as NodeType).create())
      ) {
        const lines = value.split(/\r?\n|\r/)
        lines.forEach((line, index) => {
          if (index) this.insertNode((schema.nodes.hardBreak as NodeType).create(), marks, true)
          if (line) this.insertNode(schema.textNode(line), marks, !/\S/.test(line))
        })
        value = ""
      } else {
        value = value.replace(/\r?\n|\r/g, " ")
      }
      if (value) this.insertNode(schema.textNode(value), marks, !/\S/.test(value))
    }
  }

  addElement(dom: HTMLElement, marks: readonly Mark[], matchAfter?: Rule): void {
    const outer = this.localPreserve
    let top = this.top
    if (dom.tagName === "PRE" || /pre/.test(dom.style?.whiteSpace ?? "")) this.localPreserve = true
    const name = dom.nodeName.toLowerCase()
    if (LIST_TAGS.has(name) && this.parser.normalizeLists) normalizeList(dom)
    const fromNode = this.options.ruleFromNode?.(dom)
    const matched = fromNode
      ? { rule: fromNode as Rule, attrs: null }
      : this.parser.matchTag(dom, matchAfter)
    const rule = matched?.rule
    if (rule ? rule.ignore : IGNORE_TAGS.has(name)) {
      if (dom.nodeName === "BR" && (!this.top.type || !this.top.type.inlineContent))
        this.findPlace(this.parser.schema.textNode("-"), marks, true)
    } else if (!rule || rule.skip) {
      let sync = false
      const oldNeedsBlock = this.needsBlock
      if (BLOCK_TAGS.has(name)) {
        if (top.content.length && (top.content[0] as Node).isInline && this.open) {
          this.open -= 1
          top = this.top
        }
        sync = true
        if (!top.type) this.needsBlock = true
      } else if (!dom.firstChild) {
        this.leafFallback(dom, marks)
        this.localPreserve = outer
        return
      }
      const inner = rule?.skip ? marks : this.readStyles(dom, marks)
      if (inner) this.addAll(dom, inner)
      if (sync) this.sync(top)
      this.needsBlock = oldNeedsBlock
    } else {
      const inner = this.readStyles(dom, marks)
      if (inner) this.addByRule(dom, rule, matched?.attrs ?? null, inner)
    }
    this.localPreserve = outer
  }

  leafFallback(dom: globalThis.Node, marks: readonly Mark[]): void {
    if (dom.nodeName === "BR" && this.top.type?.inlineContent)
      this.addText((dom.ownerDocument as Document).createTextNode("\n"), marks)
  }

  readStyles(dom: HTMLElement, marks: readonly Mark[]): readonly Mark[] | null {
    let result = marks
    const styles = dom.style
    if (styles?.length) {
      for (const name of this.parser.matchedStyles) {
        const value = styles.getPropertyValue(name)
        if (!value) continue
        const found = this.parser.matchStyle(name, value)
        if (!found) continue
        if (found.rule.ignore) return null
        if (found.rule.clearMark) result = result.filter((mark) => !found.rule.clearMark?.(mark))
        else
          result = result.concat(
            (this.parser.schema.marks[found.rule.mark as string] as MarkType).create(found.attrs)
          )
      }
    }
    return result
  }

  addByRule(dom: HTMLElement, rule: Rule, attrs: Attrs | null, marks: readonly Mark[]): void {
    let sync = false
    let nodeType: NodeType | undefined
    let inner = marks
    if (rule.node) {
      nodeType = this.parser.schema.nodes[rule.node] as NodeType
      if (!nodeType.isLeaf) {
        const entered = this.enter(nodeType, attrs, marks, rule.preserveWhitespace)
        if (entered) {
          sync = true
          inner = entered
        }
      } else if (!this.insertNode(nodeType.create(attrs), marks, dom.nodeName === "BR")) {
        this.leafFallback(dom, marks)
      }
    } else {
      inner = marks.concat(
        (this.parser.schema.marks[rule.mark as string] as MarkType).create(attrs)
      )
    }
    const startIn = this.top
    if (!nodeType?.isLeaf) {
      let content: HTMLElement = dom
      if (typeof rule.contentElement === "string")
        content = (dom.querySelector(rule.contentElement) as HTMLElement | null) ?? dom
      else if (typeof rule.contentElement === "function") content = rule.contentElement(dom)
      this.addAll(content, inner)
    }
    if (sync && this.sync(startIn)) this.open -= 1
  }

  addAll(parent: globalThis.Node, marks: readonly Mark[]): void {
    for (let dom = parent.firstChild; dom; dom = dom.nextSibling) this.addDOM(dom, marks)
  }

  findPlace(node: Node, marks: readonly Mark[], cautious: boolean): readonly Mark[] | null {
    let route: readonly NodeType[] | null = null
    let sync: NodeContext | undefined
    for (let depth = this.open, penalty = 0; depth >= 0; depth -= 1) {
      const context = this.nodes[depth] as NodeContext
      const found = context.findWrapping(node)
      if (found && (!route || route.length > found.length + penalty)) {
        route = found
        sync = context
        if (!found.length) break
      }
      if (context.solid) {
        if (cautious) break
        penalty += 2
      }
    }
    if (!route || !sync) return null
    this.sync(sync)
    let result = marks
    for (const type of route) result = this.enterInner(type, null, result, false)
    return result
  }

  insertNode(node: Node, marks: readonly Mark[], cautious: boolean): boolean {
    let current = marks
    if (node.isInline && this.needsBlock && !this.top.type) {
      const block = this.textblockFromContext()
      if (block) current = this.enterInner(block, null, current)
    }
    const inner = this.findPlace(node, current, cautious)
    if (!inner) return false
    this.closeExtra()
    const top = this.top
    if (top.match) top.match = top.match.matchType(node.type)
    let nodeMarks: readonly Mark[] = Mark.none
    for (const mark of inner.concat(node.marks)) {
      if (top.type ? top.type.allowsMarkType(mark.type) : markMayApply(mark.type, node.type))
        nodeMarks = mark.addToSet(nodeMarks)
    }
    top.content.push(node.mark(nodeMarks))
    return true
  }

  enter(
    type: NodeType,
    attrs: Attrs | null,
    marks: readonly Mark[],
    preserve?: boolean | "full"
  ): readonly Mark[] | null {
    const inner = this.findPlace(type.create(attrs), marks, false)
    return inner ? this.enterInner(type, attrs, marks, true, preserve) : null
  }

  enterInner(
    type: NodeType,
    attrs: Attrs | null,
    marks: readonly Mark[],
    solid = false,
    preserve?: boolean | "full"
  ): readonly Mark[] {
    this.closeExtra()
    const top = this.top
    top.match = top.match?.matchType(type) ?? null
    let options = wsOptionsFor(type, preserve, top.options)
    if (top.options & OPEN_LEFT && top.content.length === 0) options |= OPEN_LEFT
    let applied: readonly Mark[] = Mark.none
    const rest = marks.filter((mark) => {
      if (top.type ? top.type.allowsMarkType(mark.type) : markMayApply(mark.type, type)) {
        applied = mark.addToSet(applied)
        return false
      }
      return true
    })
    this.nodes.push(new NodeContext(type, attrs, applied, solid, null, options))
    this.open += 1
    return rest
  }

  closeExtra(openEnd = false): void {
    let index = this.nodes.length - 1
    if (index > this.open) {
      for (; index > this.open; index -= 1)
        (this.nodes[index - 1] as NodeContext).content.push(
          (this.nodes[index] as NodeContext).finish(openEnd) as Node
        )
      this.nodes.length = this.open + 1
    }
  }

  finish(): Node | Fragment {
    this.open = 0
    this.closeExtra(true)
    return (this.nodes[0] as NodeContext).finish(true)
  }

  sync(to: NodeContext): boolean {
    for (let index = this.open; index >= 0; index -= 1) {
      if (this.nodes[index] === to) {
        this.open = index
        return true
      }
      if (this.localPreserve) (this.nodes[index] as NodeContext).options |= PRESERVE
    }
    return false
  }

  textblockFromContext(): NodeType | undefined {
    const $context = this.options.context
    if ($context) {
      for (let depth = $context.depth; depth >= 0; depth -= 1) {
        const deflt = $context.node(depth).contentMatchAt($context.indexAfter(depth)).defaultType
        if (deflt?.isTextblock) return deflt
      }
    }
    return Object.values(this.parser.schema.nodes).find((type) => type.isTextblock)
  }
}

function normalizeList(dom: globalThis.Node): void {
  for (
    let child = dom.firstChild, previous: ChildNode | null = null;
    child;
    child = child.nextSibling
  ) {
    const name = child.nodeType === 1 ? child.nodeName.toLowerCase() : null
    if (name && LIST_TAGS.has(name) && previous) {
      previous.appendChild(child)
      child = previous
    } else if (name === "li") {
      previous = child
    } else if (name) {
      previous = null
    }
  }
}

export { TextNode }

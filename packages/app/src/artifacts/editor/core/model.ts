// The editor's document model: an immutable tree of nodes, each a type, attributes, marks and
// content, addressed by positions. A position counts the characters of text, one for each leaf
// node, and one for each side of every other node, so `doc.resolve(pos)` finds the node a position
// is in and where. The model, its positions and its `replace` follow ProseMirror's design (MIT),
// whose documents the live Yjs encoding of a document was made for: what the editor does to a
// document does what that design does to it.

// ── Schema ──────────────────────────────────────────────────────────────

import type { DOMSpec } from "./dom"

export type Attrs = Readonly<Record<string, unknown>>

/** How an element pasted or dropped is read: as a node or mark of a type, by its tag or style. */
export interface ParseRule {
  /** A CSS selector the element must match. */
  readonly tag?: string
  /** A style property, `font-weight`, or a property and value, `font-weight=400`. */
  readonly style?: string
  /** Rules are tried by priority, highest first. Defaults to 50. */
  readonly priority?: number
  /** The node's attributes, or false when the rule does not apply to this element. */
  readonly getAttrs?: (value: HTMLElement | string) => Attrs | false | null | undefined
  /** Where the node's content is in the element, when not the element itself. */
  readonly contentElement?: string | ((element: HTMLElement) => HTMLElement)
  /** Whitespace is kept as it is written: in code. */
  readonly preserveWhitespace?: boolean | "full"
  /** The element and what it holds are not read. */
  readonly ignore?: boolean
  /** The element is not read, but what it holds is. */
  readonly skip?: boolean
  /** For a style rule: marks this style takes off what is inside it. */
  readonly clearMark?: (mark: Mark) => boolean
}

export interface NodeSpec {
  /** What the node holds, as a content expression: `block+`, `inline*`, `paragraph block*`. */
  readonly content?: string
  readonly group?: string
  readonly inline?: boolean
  /** Edited as one unit, though it may hold content of its own. */
  readonly atom?: boolean
  /** Whether a click picks it whole. Defaults to true. */
  readonly selectable?: boolean
  readonly draggable?: boolean
  /** It holds code: Enter is a new line, marks do not apply. */
  readonly code?: boolean
  /** It keeps its kind when its content is replaced, and paste does not open it. */
  readonly defining?: boolean
  /** Its edges are walls: deleting and joining stop at them. */
  readonly isolating?: boolean
  /** The marks its content allows: `_` all of them, `""` none, else their names. */
  readonly marks?: string
  /** Its attributes and their defaults. */
  readonly attrs?: Readonly<Record<string, unknown>>
  /** What the node reads as in plain text, for a leaf. */
  readonly leafText?: (node: Node) => string
  readonly tableRole?: "table" | "row" | "cell" | "header_cell"
  /** How the node is drawn. */
  readonly toDOM?: (node: Node) => DOMSpec
  /** How pasted HTML is read as this node. */
  readonly parseDOM?: readonly ParseRule[]
}

export interface MarkSpec {
  readonly attrs?: Readonly<Record<string, unknown>>
  /** Whether typing at its end extends it. Defaults to true. */
  readonly inclusive?: boolean
  /** The marks it cannot stand beside: `_` all of them. Defaults to its own kind. */
  readonly excludes?: string
  readonly code?: boolean
  /** How the mark is drawn around what it marks. */
  readonly toDOM?: (mark: Mark) => DOMSpec
  /** How pasted HTML is read as this mark. */
  readonly parseDOM?: readonly ParseRule[]
}

export class Schema {
  readonly nodes: Readonly<Record<string, NodeType>>
  readonly marks: Readonly<Record<string, MarkType>>
  readonly topNodeType: NodeType
  readonly text: NodeType

  constructor(spec: {
    readonly nodes: readonly (readonly [string, NodeSpec])[]
    readonly marks: readonly (readonly [string, MarkSpec])[]
    readonly topNode?: string
  }) {
    const nodes: Record<string, NodeType> = {}
    for (const [name, nodeSpec] of spec.nodes) nodes[name] = new NodeType(name, this, nodeSpec)
    const marks: Record<string, MarkType> = {}
    spec.marks.forEach(([name, markSpec], rank) => {
      marks[name] = new MarkType(name, rank, this, markSpec)
    })
    this.nodes = nodes
    this.marks = marks
    const expressions = new Map<string, ContentMatch>()
    for (const type of Object.values(nodes)) {
      const expression = type.spec.content ?? ""
      let match = expressions.get(expression)
      if (!match) {
        match = ContentMatch.parse(expression, nodes)
        expressions.set(expression, match)
      }
      type.contentMatch = match
      type.inlineContent = match.inlineContent
    }
    for (const type of Object.values(nodes)) {
      const allowed = type.spec.marks
      type.markSet =
        allowed === "_"
          ? null
          : allowed
            ? marksNamed(this, allowed.split(" "))
            : allowed === "" || !type.inlineContent
              ? []
              : null
    }
    for (const type of Object.values(marks)) {
      const excludes = type.spec.excludes
      type.excluded =
        excludes === undefined
          ? [type]
          : excludes === ""
            ? []
            : marksNamed(this, excludes.split(" "))
    }
    const top = nodes[spec.topNode ?? "doc"]
    const text = nodes.text
    if (!top || !text) throw new Error("[SixbEditor] A schema needs a doc and a text node.")
    this.topNodeType = top
    this.text = text
  }

  node(
    name: string,
    attrs?: Attrs | null,
    content?: FragmentSource,
    marks?: readonly Mark[]
  ): Node {
    return this.nodeType(name).create(attrs, content, marks)
  }

  nodeType(name: string): NodeType {
    const type = this.nodes[name]
    if (!type) throw new Error(`[SixbEditor] No node type '${name}'.`)
    return type
  }

  textNode(text: string, marks?: readonly Mark[]): Node {
    if (!text) throw new Error("[SixbEditor] Text nodes cannot be empty.")
    return new TextNode(this.text, {}, text, Mark.setFrom(marks))
  }

  mark(name: string, attrs?: Attrs | null): Mark {
    const type = this.marks[name]
    if (!type) throw new Error(`[SixbEditor] No mark type '${name}'.`)
    return type.create(attrs)
  }

  nodeFromJSON(json: NodeJSON): Node {
    const marks = (json.marks ?? []).map((mark) => this.mark(mark.type, mark.attrs))
    if (json.type === "text") return this.textNode(json.text ?? "", marks)
    const content = Fragment.fromArray(
      (json.content ?? []).map((child) => this.nodeFromJSON(child))
    )
    return this.nodeType(json.type).create(json.attrs, content, marks)
  }
}

function marksNamed(schema: Schema, names: readonly string[]): MarkType[] {
  const found: MarkType[] = []
  for (const name of names) {
    if (name === "_") return Object.values(schema.marks)
    const type = schema.marks[name]
    if (type) found.push(type)
  }
  return found
}

export class NodeType {
  readonly groups: readonly string[]
  readonly defaultAttrs: Attrs
  readonly isBlock: boolean
  readonly isText: boolean
  contentMatch: ContentMatch = ContentMatch.empty
  inlineContent = false
  /** The marks its content may carry; null for all. */
  markSet: readonly MarkType[] | null = null

  constructor(
    readonly name: string,
    readonly schema: Schema,
    readonly spec: NodeSpec
  ) {
    this.groups = spec.group ? spec.group.split(" ") : []
    this.defaultAttrs = { ...spec.attrs }
    this.isBlock = !(spec.inline || name === "text")
    this.isText = name === "text"
  }

  get isInline(): boolean {
    return !this.isBlock
  }
  get isTextblock(): boolean {
    return this.isBlock && this.inlineContent
  }
  get isLeaf(): boolean {
    return this.contentMatch === ContentMatch.empty
  }
  get isAtom(): boolean {
    return this.isLeaf || !!this.spec.atom
  }

  isInGroup(group: string): boolean {
    return this.groups.includes(group)
  }

  computeAttrs(attrs?: Attrs | null): Attrs {
    if (!attrs) return this.defaultAttrs
    const computed: Record<string, unknown> = {}
    for (const name of Object.keys(this.defaultAttrs)) {
      computed[name] = name in attrs ? attrs[name] : this.defaultAttrs[name]
    }
    return computed
  }

  create(attrs?: Attrs | null, content?: FragmentSource, marks?: readonly Mark[]): Node {
    if (this.isText) throw new Error("[SixbEditor] Text nodes are made with schema.textNode.")
    return new Node(this, this.computeAttrs(attrs), Fragment.from(content), Mark.setFrom(marks))
  }

  /** A node of this type holding `content`, with what it must hold before and after added. */
  createAndFill(
    attrs?: Attrs | null,
    content?: FragmentSource,
    marks?: readonly Mark[]
  ): Node | null {
    let fragment = Fragment.from(content)
    if (fragment.size) {
      const before = this.contentMatch.fillBefore(fragment)
      if (!before) return null
      fragment = before.append(fragment)
    }
    const matched = this.contentMatch.matchFragment(fragment)
    const after = matched?.fillBefore(Fragment.empty, true)
    if (!after) return null
    return new Node(this, this.computeAttrs(attrs), fragment.append(after), Mark.setFrom(marks))
  }

  validContent(content: Fragment): boolean {
    const result = this.contentMatch.matchFragment(content)
    if (!result?.validEnd) return false
    for (let index = 0; index < content.childCount; index += 1) {
      if (!this.allowsMarks(content.child(index).marks)) return false
    }
    return true
  }

  compatibleContent(other: NodeType): boolean {
    return this === other || this.contentMatch.compatible(other.contentMatch)
  }

  allowsMarkType(type: MarkType): boolean {
    return this.markSet === null || this.markSet.includes(type)
  }

  allowsMarks(marks: readonly Mark[]): boolean {
    return this.markSet === null || marks.every((mark) => this.allowsMarkType(mark.type))
  }

  allowedMarks(marks: readonly Mark[]): readonly Mark[] {
    if (this.markSet === null) return marks
    const kept = marks.filter((mark) => this.allowsMarkType(mark.type))
    return kept.length === marks.length ? marks : kept
  }
}

export class MarkType {
  excluded: readonly MarkType[] = []
  private readonly instance: Mark | null

  constructor(
    readonly name: string,
    readonly rank: number,
    readonly schema: Schema,
    readonly spec: MarkSpec
  ) {
    this.instance = spec.attrs && Object.keys(spec.attrs).length > 0 ? null : new Mark(this, {})
  }

  create(attrs?: Attrs | null): Mark {
    if (!attrs && this.instance) return this.instance
    const computed: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(this.spec.attrs ?? {})) {
      computed[name] = attrs && name in attrs ? attrs[name] : value
    }
    return new Mark(this, computed)
  }

  isInSet(set: readonly Mark[]): Mark | undefined {
    return set.find((mark) => mark.type === this)
  }

  removeFromSet(set: readonly Mark[]): readonly Mark[] {
    const kept = set.filter((mark) => mark.type !== this)
    return kept.length === set.length ? set : kept
  }

  excludes(other: MarkType): boolean {
    return this.excluded.includes(other)
  }
}

// ── Marks ───────────────────────────────────────────────────────────────

export class Mark {
  static readonly none: readonly Mark[] = []

  constructor(
    readonly type: MarkType,
    readonly attrs: Attrs
  ) {}

  /** The set with this mark in it, in rank order, without the marks it excludes. */
  addToSet(set: readonly Mark[]): readonly Mark[] {
    let copy: Mark[] | undefined
    let placed = false
    for (let index = 0; index < set.length; index += 1) {
      const other = set[index] as Mark
      if (this.eq(other)) return set
      if (this.type.excludes(other.type)) {
        copy ??= set.slice(0, index)
      } else if (other.type.excludes(this.type)) {
        return set
      } else {
        if (!placed && other.type.rank > this.type.rank) {
          copy ??= set.slice(0, index)
          copy.push(this)
          placed = true
        }
        copy?.push(other)
      }
    }
    copy ??= set.slice()
    if (!placed) copy.push(this)
    return copy
  }

  removeFromSet(set: readonly Mark[]): readonly Mark[] {
    const index = set.findIndex((mark) => this.eq(mark))
    return index < 0 ? set : [...set.slice(0, index), ...set.slice(index + 1)]
  }

  isInSet(set: readonly Mark[]): boolean {
    return set.some((mark) => this.eq(mark))
  }

  eq(other: Mark): boolean {
    return this === other || (this.type === other.type && sameAttrs(this.attrs, other.attrs))
  }

  toJSON(): MarkJSON {
    return Object.keys(this.attrs).length > 0
      ? { type: this.type.name, attrs: this.attrs }
      : { type: this.type.name }
  }

  static sameSet(left: readonly Mark[], right: readonly Mark[]): boolean {
    if (left === right) return true
    if (left.length !== right.length) return false
    return left.every((mark, index) => mark.eq(right[index] as Mark))
  }

  static setFrom(marks?: readonly Mark[] | null): readonly Mark[] {
    if (!marks || marks.length === 0) return Mark.none
    if (marks.length === 1) return marks
    return [...marks].sort((left, right) => left.type.rank - right.type.rank)
  }
}

export function sameAttrs(left: Attrs, right: Attrs): boolean {
  if (left === right) return true
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => sameValue(left[key], right[key]))
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  return sameAttrs(left as Attrs, right as Attrs)
}

// ── Fragments ───────────────────────────────────────────────────────────

export type FragmentSource = Fragment | Node | readonly Node[] | null | undefined

/** A node's content: its children, and how many positions they take. */
export class Fragment {
  static readonly empty = new Fragment([], 0)
  readonly size: number

  constructor(
    readonly content: readonly Node[],
    size?: number
  ) {
    this.size = size ?? content.reduce((sum, node) => sum + node.nodeSize, 0)
  }

  static from(source: FragmentSource): Fragment {
    if (!source) return Fragment.empty
    if (source instanceof Fragment) return source
    if (Array.isArray(source)) return Fragment.fromArray(source)
    return new Fragment([source as Node], (source as Node).nodeSize)
  }

  /** Nodes as a fragment, adjacent text with the same marks joined. */
  static fromArray(nodes: readonly Node[]): Fragment {
    if (nodes.length === 0) return Fragment.empty
    let joined: Node[] | undefined
    let size = 0
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index] as Node
      size += node.nodeSize
      const previous = joined ? joined[joined.length - 1] : nodes[index - 1]
      if (index > 0 && node.isText && previous?.isText && previous.sameMarkup(node)) {
        joined ??= nodes.slice(0, index)
        joined[joined.length - 1] = (previous as TextNode).withText(
          (previous.text ?? "") + node.text
        )
      } else {
        joined?.push(node)
      }
    }
    return new Fragment(joined ?? nodes, size)
  }

  get childCount(): number {
    return this.content.length
  }
  get firstChild(): Node | null {
    return this.content[0] ?? null
  }
  get lastChild(): Node | null {
    return this.content[this.content.length - 1] ?? null
  }

  child(index: number): Node {
    const found = this.content[index]
    if (!found) throw new RangeError(`[SixbEditor] Index ${index} out of range for ${this}`)
    return found
  }

  maybeChild(index: number): Node | null {
    return this.content[index] ?? null
  }

  forEach(each: (node: Node, offset: number, index: number) => void): void {
    for (let index = 0, offset = 0; index < this.content.length; index += 1) {
      const child = this.content[index] as Node
      each(child, offset, index)
      offset += child.nodeSize
    }
  }

  /** Calls `each` for every node between two positions, children after their parent. */
  nodesBetween(
    from: number,
    to: number,
    each: (node: Node, pos: number, parent: Node | null, index: number) => unknown,
    nodeStart = 0,
    parent: Node | null = null
  ): void {
    for (let index = 0, pos = 0; pos < to; index += 1) {
      const child = this.content[index]
      if (!child) break
      const end = pos + child.nodeSize
      if (
        end > from &&
        each(child, nodeStart + pos, parent, index) !== false &&
        child.content.size
      ) {
        const start = pos + 1
        child.content.nodesBetween(
          Math.max(0, from - start),
          Math.min(child.content.size, to - start),
          each,
          nodeStart + start,
          child
        )
      }
      pos = end
    }
  }

  descendants(
    each: (node: Node, pos: number, parent: Node | null, index: number) => unknown
  ): void {
    this.nodesBetween(0, this.size, each)
  }

  textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string {
    let text = ""
    let first = true
    this.nodesBetween(from, to, (node, pos) => {
      const nodeText = node.isText
        ? (node.text ?? "").slice(Math.max(from, pos) - pos, to - pos)
        : !node.isLeaf
          ? ""
          : (leafText ?? node.type.spec.leafText?.(node) ?? "")
      if (node.isBlock && ((node.isLeaf && nodeText) || node.isTextblock) && blockSeparator) {
        if (first) first = false
        else text += blockSeparator
      }
      text += nodeText
    })
    return text
  }

  append(other: Fragment): Fragment {
    if (!other.size) return this
    if (!this.size) return other
    const last = this.lastChild as Node
    const first = other.firstChild as Node
    const content = this.content.slice()
    let index = 0
    if (last.isText && last.sameMarkup(first)) {
      content[content.length - 1] = (last as TextNode).withText((last.text ?? "") + first.text)
      index = 1
    }
    for (; index < other.content.length; index += 1) content.push(other.content[index] as Node)
    return new Fragment(content, this.size + other.size)
  }

  cut(from: number, to = this.size): Fragment {
    if (from === 0 && to === this.size) return this
    const result: Node[] = []
    let size = 0
    if (to > from) {
      for (let index = 0, pos = 0; pos < to; index += 1) {
        let child = this.content[index] as Node
        const end = pos + child.nodeSize
        if (end > from) {
          if (pos < from || end > to) {
            child = child.isText
              ? child.cut(Math.max(0, from - pos), Math.min((child.text ?? "").length, to - pos))
              : child.cut(Math.max(0, from - pos - 1), Math.min(child.content.size, to - pos - 1))
          }
          result.push(child)
          size += child.nodeSize
        }
        pos = end
      }
    }
    return new Fragment(result, size)
  }

  cutByIndex(from: number, to: number): Fragment {
    if (from === to) return Fragment.empty
    if (from === 0 && to === this.content.length) return this
    return new Fragment(this.content.slice(from, to))
  }

  replaceChild(index: number, node: Node): Fragment {
    const current = this.content[index] as Node
    if (current === node) return this
    const copy = this.content.slice()
    copy[index] = node
    return new Fragment(copy, this.size + node.nodeSize - current.nodeSize)
  }

  addToStart(node: Node): Fragment {
    return new Fragment([node, ...this.content], this.size + node.nodeSize)
  }

  addToEnd(node: Node): Fragment {
    return new Fragment([...this.content, node], this.size + node.nodeSize)
  }

  eq(other: Fragment): boolean {
    if (this === other) return true
    if (this.content.length !== other.content.length) return false
    return this.content.every((node, index) => node.eq(other.content[index] as Node))
  }

  /** The child a position falls in or before, and where it starts. */
  findIndex(pos: number, round = -1): { index: number; offset: number } {
    if (pos === 0) return { index: 0, offset: 0 }
    if (pos === this.size) return { index: this.content.length, offset: pos }
    if (pos > this.size || pos < 0)
      throw new RangeError(`[SixbEditor] Position ${pos} outside of ${this}`)
    for (let index = 0, offset = 0; ; index += 1) {
      const end = offset + (this.content[index] as Node).nodeSize
      if (end >= pos) {
        if (end === pos || round > 0) return { index: index + 1, offset: end }
        return { index, offset }
      }
      offset = end
    }
  }

  toJSON(): NodeJSON[] {
    return this.content.map((node) => node.toJSON())
  }

  toString(): string {
    return `<${this.content.map((node) => node.toString()).join(", ")}>`
  }
}

// ── Nodes ───────────────────────────────────────────────────────────────

/** A node as JSON: the block format core's live documents are read into and written from. */
export interface NodeJSON {
  readonly type: string
  readonly attrs?: Attrs
  readonly content?: readonly NodeJSON[]
  readonly text?: string
  readonly marks?: readonly MarkJSON[]
}

export interface MarkJSON {
  readonly type: string
  readonly attrs?: Attrs
}

export class Node {
  constructor(
    readonly type: NodeType,
    readonly attrs: Attrs,
    readonly content: Fragment,
    readonly marks: readonly Mark[]
  ) {}

  get text(): string | undefined {
    return undefined
  }
  get nodeSize(): number {
    return this.isLeaf ? 1 : 2 + this.content.size
  }
  get childCount(): number {
    return this.content.childCount
  }
  get firstChild(): Node | null {
    return this.content.firstChild
  }
  get lastChild(): Node | null {
    return this.content.lastChild
  }
  get isBlock(): boolean {
    return this.type.isBlock
  }
  get isTextblock(): boolean {
    return this.type.isTextblock
  }
  get inlineContent(): boolean {
    return this.type.inlineContent
  }
  get isInline(): boolean {
    return this.type.isInline
  }
  get isText(): boolean {
    return this.type.isText
  }
  get isLeaf(): boolean {
    return this.type.isLeaf
  }
  get isAtom(): boolean {
    return this.type.isAtom
  }
  get textContent(): string {
    return this.isLeaf
      ? (this.type.spec.leafText?.(this) ?? "")
      : this.textBetween(0, this.content.size, "")
  }

  child(index: number): Node {
    return this.content.child(index)
  }
  maybeChild(index: number): Node | null {
    return this.content.maybeChild(index)
  }
  forEach(each: (node: Node, offset: number, index: number) => void): void {
    this.content.forEach(each)
  }
  nodesBetween(
    from: number,
    to: number,
    each: (node: Node, pos: number, parent: Node | null, index: number) => unknown
  ): void {
    this.content.nodesBetween(from, to, each, 0, this)
  }
  descendants(
    each: (node: Node, pos: number, parent: Node | null, index: number) => unknown
  ): void {
    this.content.nodesBetween(0, this.content.size, each, 0, this)
  }
  textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string {
    return this.content.textBetween(from, to, blockSeparator, leafText)
  }

  eq(other: Node): boolean {
    return this === other || (this.sameMarkup(other) && this.content.eq(other.content))
  }
  sameMarkup(other: Node): boolean {
    return this.hasMarkup(other.type, other.attrs, other.marks)
  }
  hasMarkup(type: NodeType, attrs?: Attrs | null, marks?: readonly Mark[]): boolean {
    return (
      this.type === type &&
      sameAttrs(this.attrs, attrs ?? type.defaultAttrs) &&
      Mark.sameSet(this.marks, marks ?? Mark.none)
    )
  }

  copy(content: Fragment = this.content): Node {
    return content === this.content ? this : new Node(this.type, this.attrs, content, this.marks)
  }
  mark(marks: readonly Mark[]): Node {
    return marks === this.marks ? this : new Node(this.type, this.attrs, this.content, marks)
  }
  cut(from: number, to = this.content.size): Node {
    if (from === 0 && to === this.content.size) return this
    return this.copy(this.content.cut(from, to))
  }

  /** What lies between two positions, with how deep it is open at either side. */
  slice(from: number, to = this.content.size, includeParents = false): Slice {
    if (from === to) return Slice.empty
    const $from = this.resolve(from)
    const $to = this.resolve(to)
    const depth = includeParents ? 0 : $from.sharedDepth(to)
    const start = $from.start(depth)
    const content = $from.node(depth).content.cut($from.pos - start, $to.pos - start)
    return new Slice(content, $from.depth - depth, $to.depth - depth)
  }

  replace(from: number, to: number, slice: Slice): Node {
    return replace(this.resolve(from), this.resolve(to), slice)
  }

  nodeAt(pos: number): Node | null {
    let node: Node | null = this
    let at = pos
    for (;;) {
      const { index, offset }: { index: number; offset: number } = node.content.findIndex(at)
      node = node.maybeChild(index)
      if (!node) return null
      if (offset === at || node.isText) return node
      at -= offset + 1
    }
  }

  childAfter(pos: number): { node: Node | null; index: number; offset: number } {
    const { index, offset } = this.content.findIndex(pos)
    return { node: this.content.maybeChild(index), index, offset }
  }

  childBefore(pos: number): { node: Node | null; index: number; offset: number } {
    if (pos === 0) return { node: null, index: 0, offset: 0 }
    const { index, offset } = this.content.findIndex(pos)
    if (offset < pos) return { node: this.content.child(index), index, offset }
    const node = this.content.child(index - 1)
    return { node, index: index - 1, offset: offset - node.nodeSize }
  }

  resolve(pos: number): ResolvedPos {
    return ResolvedPos.resolveCached(this, pos)
  }

  rangeHasMark(from: number, to: number, type: MarkType | Mark): boolean {
    let found = false
    if (to > from) {
      this.nodesBetween(from, to, (node) => {
        if (type instanceof Mark ? type.isInSet(node.marks) : type.isInSet(node.marks)) found = true
        return !found
      })
    }
    return found
  }

  contentMatchAt(index: number): ContentMatch {
    const match = this.type.contentMatch.matchFragment(this.content, 0, index)
    if (!match)
      throw new Error(`[SixbEditor] ${this.type.name} holds content its schema does not allow.`)
    return match
  }

  canReplace(
    from: number,
    to: number,
    replacement = Fragment.empty,
    start = 0,
    end = replacement.childCount
  ): boolean {
    const one = this.contentMatchAt(from).matchFragment(replacement, start, end)
    const two = one?.matchFragment(this.content, to)
    if (!two?.validEnd) return false
    for (let index = start; index < end; index += 1) {
      if (!this.type.allowsMarks(replacement.child(index).marks)) return false
    }
    return true
  }

  canReplaceWith(from: number, to: number, type: NodeType, marks?: readonly Mark[]): boolean {
    if (marks && !this.type.allowsMarks(marks)) return false
    const start = this.contentMatchAt(from).matchType(type)
    const end = start?.matchFragment(this.content, to)
    return end ? end.validEnd : false
  }

  canAppend(other: Node): boolean {
    if (other.content.size) return this.canReplace(this.childCount, this.childCount, other.content)
    return this.type.compatibleContent(other.type)
  }

  toJSON(): NodeJSON {
    const json: { -readonly [Key in keyof NodeJSON]: NodeJSON[Key] } = { type: this.type.name }
    if (Object.keys(this.attrs).length > 0) json.attrs = this.attrs
    if (this.content.size) json.content = this.content.toJSON()
    if (this.marks.length) json.marks = this.marks.map((mark) => mark.toJSON())
    return json
  }

  toString(): string {
    const content = this.content.size
      ? `(${this.content.content.map((node) => node.toString()).join(", ")})`
      : ""
    return `${this.type.name}${content}`
  }
}

export class TextNode extends Node {
  constructor(
    type: NodeType,
    attrs: Attrs,
    private readonly value: string,
    marks: readonly Mark[]
  ) {
    super(type, attrs, Fragment.empty, marks)
  }

  override get text(): string {
    return this.value
  }
  override get nodeSize(): number {
    return this.value.length
  }
  override get textContent(): string {
    return this.value
  }
  override textBetween(from: number, to: number): string {
    return this.value.slice(from, to)
  }
  override mark(marks: readonly Mark[]): Node {
    return marks === this.marks ? this : new TextNode(this.type, this.attrs, this.value, marks)
  }
  withText(text: string): TextNode {
    return text === this.value ? this : new TextNode(this.type, this.attrs, text, this.marks)
  }
  override cut(from = 0, to = this.value.length): Node {
    if (from === 0 && to === this.value.length) return this
    return this.withText(this.value.slice(from, to))
  }
  override eq(other: Node): boolean {
    return this.sameMarkup(other) && this.value === other.text
  }
  override toJSON(): NodeJSON {
    const json: NodeJSON = { type: "text", text: this.value }
    return this.marks.length ? { ...json, marks: this.marks.map((mark) => mark.toJSON()) } : json
  }
  override toString(): string {
    return JSON.stringify(this.value)
  }
}

// ── Positions ───────────────────────────────────────────────────────────

/** A position resolved in a document: the nodes it is in, at every depth, and where. */
export class ResolvedPos {
  readonly depth: number

  constructor(
    readonly pos: number,
    /** For each depth, the node, the index in it, and the position its content starts at. */
    private readonly path: readonly (Node | number)[],
    readonly parentOffset: number
  ) {
    this.depth = path.length / 3 - 1
  }

  private resolveDepth(depth?: number | null): number {
    if (depth === undefined || depth === null) return this.depth
    return depth < 0 ? this.depth + depth : depth
  }

  get parent(): Node {
    return this.node(this.depth)
  }
  get doc(): Node {
    return this.node(0)
  }
  node(depth?: number | null): Node {
    return this.path[this.resolveDepth(depth) * 3] as Node
  }
  index(depth?: number | null): number {
    return this.path[this.resolveDepth(depth) * 3 + 1] as number
  }
  indexAfter(depth?: number | null): number {
    const resolved = this.resolveDepth(depth)
    return this.index(resolved) + (resolved === this.depth && !this.textOffset ? 0 : 1)
  }
  start(depth?: number | null): number {
    const resolved = this.resolveDepth(depth)
    return resolved === 0 ? 0 : (this.path[resolved * 3 - 1] as number) + 1
  }
  end(depth?: number | null): number {
    const resolved = this.resolveDepth(depth)
    return this.start(resolved) + this.node(resolved).content.size
  }
  before(depth?: number | null): number {
    const resolved = this.resolveDepth(depth)
    if (!resolved)
      throw new RangeError("[SixbEditor] There is no position before the top level node.")
    return resolved === this.depth + 1 ? this.pos : (this.path[resolved * 3 - 1] as number)
  }
  after(depth?: number | null): number {
    const resolved = this.resolveDepth(depth)
    if (!resolved)
      throw new RangeError("[SixbEditor] There is no position after the top level node.")
    return resolved === this.depth + 1
      ? this.pos
      : (this.path[resolved * 3 - 1] as number) + (this.path[resolved * 3] as Node).nodeSize
  }
  get textOffset(): number {
    return this.pos - (this.path[this.path.length - 1] as number)
  }
  get nodeAfter(): Node | null {
    const parent = this.parent
    const index = this.index(this.depth)
    if (index === parent.childCount) return null
    const offset = this.textOffset
    const child = parent.child(index)
    return offset ? child.cut(offset) : child
  }
  get nodeBefore(): Node | null {
    const index = this.index(this.depth)
    const offset = this.textOffset
    if (offset) return this.parent.child(index).cut(0, offset)
    return index === 0 ? null : this.parent.child(index - 1)
  }

  posAtIndex(index: number, depth?: number): number {
    const resolved = this.resolveDepth(depth)
    const node = this.path[resolved * 3] as Node
    let pos = resolved === 0 ? 0 : (this.path[resolved * 3 - 1] as number) + 1
    for (let at = 0; at < index; at += 1) pos += node.child(at).nodeSize
    return pos
  }

  /** The marks text typed here would take. */
  marks(): readonly Mark[] {
    const parent = this.parent
    const index = this.index()
    if (parent.content.size === 0) return Mark.none
    if (this.textOffset) return parent.child(index).marks
    let main = parent.maybeChild(index - 1)
    let other = parent.maybeChild(index)
    if (!main) [main, other] = [other, main]
    let marks = (main as Node).marks
    for (let at = 0; at < marks.length; at += 1) {
      const mark = marks[at] as Mark
      if (mark.type.spec.inclusive === false && (!other || !mark.isInSet(other.marks))) {
        marks = mark.removeFromSet(marks)
        at -= 1
      }
    }
    return marks
  }

  /** The marks that run on from here to `$end`, for a deletion that joins them. */
  marksAcross($end: ResolvedPos): readonly Mark[] | null {
    const after = this.parent.maybeChild(this.index())
    if (!after?.isInline) return null
    let marks = after.marks
    const next = $end.parent.maybeChild($end.index())
    for (let at = 0; at < marks.length; at += 1) {
      const mark = marks[at] as Mark
      if (mark.type.spec.inclusive === false && (!next || !mark.isInSet(next.marks))) {
        marks = mark.removeFromSet(marks)
        at -= 1
      }
    }
    return marks
  }

  sharedDepth(pos: number): number {
    for (let depth = this.depth; depth > 0; depth -= 1) {
      if (this.start(depth) <= pos && this.end(depth) >= pos) return depth
    }
    return 0
  }

  blockRange(other: ResolvedPos = this, pred?: (node: Node) => boolean): NodeRange | null {
    if (other.pos < this.pos) return other.blockRange(this, pred)
    for (
      let depth = this.depth - (this.parent.inlineContent || this.pos === other.pos ? 1 : 0);
      depth >= 0;
      depth -= 1
    ) {
      if (other.pos <= this.end(depth) && (!pred || pred(this.node(depth))))
        return new NodeRange(this, other, depth)
    }
    return null
  }

  sameParent(other: ResolvedPos): boolean {
    return this.pos - this.parentOffset === other.pos - other.parentOffset
  }

  max(other: ResolvedPos): ResolvedPos {
    return other.pos > this.pos ? other : this
  }
  min(other: ResolvedPos): ResolvedPos {
    return other.pos < this.pos ? other : this
  }

  static resolve(doc: Node, pos: number): ResolvedPos {
    if (!(pos >= 0 && pos <= doc.content.size))
      throw new RangeError(`[SixbEditor] Position ${pos} out of range`)
    const path: (Node | number)[] = []
    let start = 0
    let parentOffset = pos
    for (let node = doc; ; ) {
      const { index, offset } = node.content.findIndex(parentOffset)
      const rest = parentOffset - offset
      path.push(node, index, start + offset)
      if (!rest) break
      node = node.child(index)
      if (node.isText) break
      parentOffset = rest - 1
      start += offset + 1
    }
    return new ResolvedPos(pos, path, parentOffset)
  }

  static resolveCached(doc: Node, pos: number): ResolvedPos {
    let cache = resolveCache.get(doc)
    if (!cache) {
      cache = []
      resolveCache.set(doc, cache)
    }
    for (const cached of cache) if (cached.pos === pos) return cached
    const resolved = ResolvedPos.resolve(doc, pos)
    cache.push(resolved)
    if (cache.length > 12) cache.shift()
    return resolved
  }
}

const resolveCache = new WeakMap<Node, ResolvedPos[]>()

/** A run of sibling blocks: what wrapping and lifting act on. */
export class NodeRange {
  constructor(
    readonly $from: ResolvedPos,
    readonly $to: ResolvedPos,
    readonly depth: number
  ) {}
  get start(): number {
    return this.$from.before(this.depth + 1)
  }
  get end(): number {
    return this.$to.after(this.depth + 1)
  }
  get parent(): Node {
    return this.$from.node(this.depth)
  }
  get startIndex(): number {
    return this.$from.index(this.depth)
  }
  get endIndex(): number {
    return this.$to.indexAfter(this.depth)
  }
}

// ── Slices and replacing ────────────────────────────────────────────────

/** A piece of a document, its content open `openStart` and `openEnd` deep at its sides. */
export class Slice {
  static readonly empty = new Slice(Fragment.empty, 0, 0)

  constructor(
    readonly content: Fragment,
    readonly openStart: number,
    readonly openEnd: number
  ) {}

  get size(): number {
    return this.content.size - this.openStart - this.openEnd
  }

  eq(other: Slice): boolean {
    return (
      this.content.eq(other.content) &&
      this.openStart === other.openStart &&
      this.openEnd === other.openEnd
    )
  }

  insertAt(pos: number, fragment: Fragment): Slice | null {
    const content = insertInto(this.content, pos + this.openStart, fragment)
    return content && new Slice(content, this.openStart, this.openEnd)
  }

  removeBetween(from: number, to: number): Slice {
    return new Slice(
      removeRange(this.content, from + this.openStart, to + this.openStart),
      this.openStart,
      this.openEnd
    )
  }

  /** A fragment open as deep as it goes at both sides. */
  static maxOpen(fragment: Fragment, openIsolating = true): Slice {
    let openStart = 0
    let openEnd = 0
    for (
      let node = fragment.firstChild;
      node && !node.isLeaf && (openIsolating || !node.type.spec.isolating);
      node = node.firstChild
    ) {
      openStart += 1
    }
    for (
      let node = fragment.lastChild;
      node && !node.isLeaf && (openIsolating || !node.type.spec.isolating);
      node = node.lastChild
    ) {
      openEnd += 1
    }
    return new Slice(fragment, openStart, openEnd)
  }
}

function removeRange(content: Fragment, from: number, to: number): Fragment {
  const { index, offset } = content.findIndex(from)
  const child = content.maybeChild(index)
  const { index: indexTo, offset: offsetTo } = content.findIndex(to)
  if (offset === from || child?.isText) {
    if (offsetTo !== to && !content.child(indexTo).isText)
      throw new RangeError("[SixbEditor] Removing a non-flat range")
    return content.cut(0, from).append(content.cut(to))
  }
  if (index !== indexTo || !child) throw new RangeError("[SixbEditor] Removing a non-flat range")
  return content.replaceChild(
    index,
    child.copy(removeRange(child.content, from - offset - 1, to - offset - 1))
  )
}

function insertInto(
  content: Fragment,
  dist: number,
  insert: Fragment,
  parent?: Node
): Fragment | null {
  const { index, offset } = content.findIndex(dist)
  const child = content.maybeChild(index)
  if (offset === dist || child?.isText) {
    if (parent && !parent.canReplace(index, index, insert)) return null
    return content.cut(0, dist).append(insert).append(content.cut(dist))
  }
  if (!child) return null
  const inner = insertInto(child.content, dist - offset - 1, insert, child)
  return inner && content.replaceChild(index, child.copy(inner))
}

export class ReplaceError extends Error {}

/** The document with what lies between `$from` and `$to` replaced by `slice`, which must fit. */
export function replace($from: ResolvedPos, $to: ResolvedPos, slice: Slice): Node {
  if (slice.openStart > $from.depth)
    throw new ReplaceError("Inserted content deeper than insertion position")
  if ($from.depth - slice.openStart !== $to.depth - slice.openEnd)
    throw new ReplaceError("Inconsistent open depths")
  return replaceOuter($from, $to, slice, 0)
}

function replaceOuter($from: ResolvedPos, $to: ResolvedPos, slice: Slice, depth: number): Node {
  const index = $from.index(depth)
  const node = $from.node(depth)
  if (index === $to.index(depth) && depth < $from.depth - slice.openStart) {
    const inner = replaceOuter($from, $to, slice, depth + 1)
    return node.copy(node.content.replaceChild(index, inner))
  }
  if (!slice.content.size) return close(node, replaceTwoWay($from, $to, depth))
  if (!slice.openStart && !slice.openEnd && $from.depth === depth && $to.depth === depth) {
    const parent = $from.parent
    const content = parent.content
    return close(
      parent,
      content.cut(0, $from.parentOffset).append(slice.content).append(content.cut($to.parentOffset))
    )
  }
  const { start, end } = prepareSliceForReplace(slice, $from)
  return close(node, replaceThreeWay($from, start, end, $to, depth))
}

function checkJoin(main: Node, sub: Node): void {
  if (!sub.type.compatibleContent(main.type))
    throw new ReplaceError(`Cannot join ${sub.type.name} onto ${main.type.name}`)
}

function joinable($before: ResolvedPos, $after: ResolvedPos, depth: number): Node {
  const node = $before.node(depth)
  checkJoin(node, $after.node(depth))
  return node
}

function addNode(child: Node, target: Node[]): void {
  const last = target.length - 1
  if (last >= 0 && child.isText && child.sameMarkup(target[last] as Node)) {
    target[last] = (child as TextNode).withText((target[last] as Node).text + (child.text ?? ""))
  } else {
    target.push(child)
  }
}

function addRange(
  $start: ResolvedPos | null,
  $end: ResolvedPos | null,
  depth: number,
  target: Node[]
): void {
  const node = (($end ?? $start) as ResolvedPos).node(depth)
  let startIndex = 0
  const endIndex = $end ? $end.index(depth) : node.childCount
  if ($start) {
    startIndex = $start.index(depth)
    if ($start.depth > depth) {
      startIndex += 1
    } else if ($start.textOffset) {
      addNode($start.nodeAfter as Node, target)
      startIndex += 1
    }
  }
  for (let index = startIndex; index < endIndex; index += 1) addNode(node.child(index), target)
  if ($end && $end.depth === depth && $end.textOffset) addNode($end.nodeBefore as Node, target)
}

function close(node: Node, content: Fragment): Node {
  if (!node.type.validContent(content))
    throw new ReplaceError(`Invalid content for node ${node.type.name}`)
  return node.copy(content)
}

function replaceThreeWay(
  $from: ResolvedPos,
  $start: ResolvedPos,
  $end: ResolvedPos,
  $to: ResolvedPos,
  depth: number
): Fragment {
  const openStart = $from.depth > depth && joinable($from, $start, depth + 1)
  const openEnd = $to.depth > depth && joinable($end, $to, depth + 1)
  const content: Node[] = []
  addRange(null, $from, depth, content)
  if (openStart && openEnd && $start.index(depth) === $end.index(depth)) {
    checkJoin(openStart, openEnd)
    addNode(close(openStart, replaceThreeWay($from, $start, $end, $to, depth + 1)), content)
  } else {
    if (openStart) addNode(close(openStart, replaceTwoWay($from, $start, depth + 1)), content)
    addRange($start, $end, depth, content)
    if (openEnd) addNode(close(openEnd, replaceTwoWay($end, $to, depth + 1)), content)
  }
  addRange($to, null, depth, content)
  return new Fragment(content)
}

function replaceTwoWay($from: ResolvedPos, $to: ResolvedPos, depth: number): Fragment {
  const content: Node[] = []
  addRange(null, $from, depth, content)
  if ($from.depth > depth) {
    const type = joinable($from, $to, depth + 1)
    addNode(close(type, replaceTwoWay($from, $to, depth + 1)), content)
  }
  addRange($to, null, depth, content)
  return new Fragment(content)
}

function prepareSliceForReplace(
  slice: Slice,
  $along: ResolvedPos
): { start: ResolvedPos; end: ResolvedPos } {
  const extra = $along.depth - slice.openStart
  const parent = $along.node(extra)
  let node = parent.copy(slice.content)
  for (let depth = extra - 1; depth >= 0; depth -= 1)
    node = $along.node(depth).copy(Fragment.from(node))
  return {
    start: ResolvedPos.resolve(node, slice.openStart + extra),
    end: ResolvedPos.resolve(node, node.content.size - slice.openEnd - extra),
  }
}

// ── Content expressions ─────────────────────────────────────────────────

interface MatchEdge {
  readonly type: NodeType
  readonly next: ContentMatch
}

/** A state of a content expression, compiled to an automaton: what may come next. */
export class ContentMatch {
  static readonly empty = new ContentMatch(true)
  readonly next: MatchEdge[] = []
  private readonly wrapCache = new Map<NodeType, readonly NodeType[] | null>()

  constructor(readonly validEnd: boolean) {}

  static parse(expression: string, types: Readonly<Record<string, NodeType>>): ContentMatch {
    const stream = new TokenStream(expression, types)
    if (stream.next === undefined) return ContentMatch.empty
    const parsed = parseChoice(stream)
    if (stream.next !== undefined) stream.fail("Unexpected trailing text")
    return toDfa(toNfa(parsed))
  }

  matchType(type: NodeType): ContentMatch | null {
    for (const edge of this.next) if (edge.type === type) return edge.next
    return null
  }

  matchFragment(fragment: Fragment, start = 0, end = fragment.childCount): ContentMatch | null {
    let current: ContentMatch | null = this
    for (let index = start; current && index < end; index += 1)
      current = current.matchType(fragment.child(index).type)
    return current
  }

  get inlineContent(): boolean {
    return this.next.length !== 0 && (this.next[0] as MatchEdge).type.isInline
  }

  /** The first type that may come here and can be made empty. */
  get defaultType(): NodeType | null {
    for (const { type } of this.next) if (!type.isText) return type
    return null
  }

  compatible(other: ContentMatch): boolean {
    return this.next.some((mine) => other.next.some((theirs) => mine.type === theirs.type))
  }

  /** The nodes to add before `after` for it to match here, ending validly when `toEnd`. */
  fillBefore(after: Fragment, toEnd = false, startIndex = 0): Fragment | null {
    const seen: ContentMatch[] = [this]
    const search = (match: ContentMatch, types: readonly NodeType[]): Fragment | null => {
      const finished = match.matchFragment(after, startIndex)
      if (finished && (!toEnd || finished.validEnd)) {
        return Fragment.from(types.map((type) => type.createAndFill() as Node))
      }
      for (const { type, next } of match.next) {
        if (!type.isText && !seen.includes(next)) {
          seen.push(next)
          const found = search(next, [...types, type])
          if (found) return found
        }
      }
      return null
    }
    return search(this, [])
  }

  /** The types to wrap a `target` in for it to stand here, outermost first. */
  findWrapping(target: NodeType): readonly NodeType[] | null {
    if (this.wrapCache.has(target)) return this.wrapCache.get(target) ?? null
    const computed = this.computeWrapping(target)
    this.wrapCache.set(target, computed)
    return computed
  }

  private computeWrapping(target: NodeType): readonly NodeType[] | null {
    interface Active {
      readonly match: ContentMatch
      readonly type: NodeType | null
      readonly via: Active | null
    }
    const seen = new Set<string>()
    const active: Active[] = [{ match: this, type: null, via: null }]
    while (active.length) {
      const current = active.shift() as Active
      if (current.match.matchType(target)) {
        const result: NodeType[] = []
        for (let each: Active | null = current; each?.type; each = each.via) result.push(each.type)
        return result.reverse()
      }
      for (const { type, next } of current.match.next) {
        if (!type.isLeaf && !seen.has(type.name) && (!current.type || next.validEnd)) {
          active.push({ match: type.contentMatch, type, via: current })
          seen.add(type.name)
        }
      }
    }
    return null
  }

  get edgeCount(): number {
    return this.next.length
  }

  edge(index: number): MatchEdge {
    const edge = this.next[index]
    if (!edge) throw new RangeError(`[SixbEditor] No edge ${index}`)
    return edge
  }
}

class TokenStream {
  readonly tokens: string[]
  pos = 0

  constructor(
    readonly expression: string,
    readonly types: Readonly<Record<string, NodeType>>
  ) {
    this.tokens = expression.split(/\s*(?=\b|\W|$)/).filter((token) => token !== "")
  }

  get next(): string | undefined {
    return this.tokens[this.pos]
  }

  eat(token: string): boolean {
    if (this.next !== token) return false
    this.pos += 1
    return true
  }

  fail(message: string): never {
    throw new SyntaxError(`[SixbEditor] ${message} (in content expression '${this.expression}')`)
  }
}

type Expr =
  | { readonly kind: "choice" | "seq"; readonly exprs: readonly Expr[] }
  | { readonly kind: "plus" | "star" | "opt"; readonly expr: Expr }
  | { readonly kind: "name"; readonly type: NodeType }

function parseChoice(stream: TokenStream): Expr {
  const exprs: Expr[] = []
  do exprs.push(parseSequence(stream))
  while (stream.eat("|"))
  return exprs.length === 1 ? (exprs[0] as Expr) : { kind: "choice", exprs }
}

function parseSequence(stream: TokenStream): Expr {
  const exprs: Expr[] = []
  do exprs.push(parseSubscript(stream))
  while (stream.next && stream.next !== ")" && stream.next !== "|")
  return exprs.length === 1 ? (exprs[0] as Expr) : { kind: "seq", exprs }
}

function parseSubscript(stream: TokenStream): Expr {
  let expr = parseAtom(stream)
  for (;;) {
    if (stream.eat("+")) expr = { kind: "plus", expr }
    else if (stream.eat("*")) expr = { kind: "star", expr }
    else if (stream.eat("?")) expr = { kind: "opt", expr }
    else return expr
  }
}

function parseAtom(stream: TokenStream): Expr {
  if (stream.eat("(")) {
    const expr = parseChoice(stream)
    if (!stream.eat(")")) stream.fail("Missing closing paren")
    return expr
  }
  const name = stream.next
  if (!name || /\W/.test(name)) stream.fail(`Unexpected token '${name}'`)
  const named = stream.types[name]
  const types = named ? [named] : Object.values(stream.types).filter((type) => type.isInGroup(name))
  if (types.length === 0) stream.fail(`No node type or group '${name}'`)
  stream.pos += 1
  const exprs = types.map((type): Expr => ({ kind: "name", type }))
  return exprs.length === 1 ? (exprs[0] as Expr) : { kind: "choice", exprs }
}

interface Edge {
  term: NodeType | undefined
  to: number | undefined
}

function toNfa(expr: Expr): Edge[][] {
  const nfa: Edge[][] = [[]]
  const node = () => nfa.push([]) - 1
  const edge = (from: number, to?: number, term?: NodeType) => {
    const made: Edge = { term, to }
    ;(nfa[from] as Edge[]).push(made)
    return made
  }
  const connect = (edges: readonly Edge[], to: number) => {
    for (const each of edges) each.to = to
  }
  const compile = (current: Expr, from: number): Edge[] => {
    switch (current.kind) {
      case "choice":
        return current.exprs.flatMap((each) => compile(each, from))
      case "seq": {
        let start = from
        for (let index = 0; ; index += 1) {
          const next = compile(current.exprs[index] as Expr, start)
          if (index === current.exprs.length - 1) return next
          start = node()
          connect(next, start)
        }
      }
      case "star": {
        const loop = node()
        edge(from, loop)
        connect(compile(current.expr, loop), loop)
        return [edge(loop)]
      }
      case "plus": {
        const loop = node()
        connect(compile(current.expr, from), loop)
        connect(compile(current.expr, loop), loop)
        return [edge(loop)]
      }
      case "opt":
        return [edge(from), ...compile(current.expr, from)]
      case "name":
        return [edge(from, undefined, current.type)]
    }
  }
  connect(compile(expr, 0), node())
  return nfa
}

function nullFrom(nfa: readonly Edge[][], start: number): number[] {
  const result: number[] = []
  const scan = (at: number): void => {
    const edges = nfa[at] as Edge[]
    if (edges.length === 1 && !(edges[0] as Edge).term) {
      scan((edges[0] as Edge).to as number)
      return
    }
    result.push(at)
    for (const { term, to } of edges)
      if (!term && !result.includes(to as number)) scan(to as number)
  }
  scan(start)
  return result.sort((left, right) => right - left)
}

function toDfa(nfa: readonly Edge[][]): ContentMatch {
  const labeled = new Map<string, ContentMatch>()
  const explore = (states: readonly number[]): ContentMatch => {
    const out: [NodeType, number[]][] = []
    for (const at of states) {
      for (const { term, to } of nfa[at] as Edge[]) {
        if (!term) continue
        let set = out.find(([type]) => type === term)?.[1]
        for (const next of nullFrom(nfa, to as number)) {
          if (!set) {
            set = []
            out.push([term, set])
          }
          if (!set.includes(next)) set.push(next)
        }
      }
    }
    const state = new ContentMatch(states.includes(nfa.length - 1))
    labeled.set(states.join(","), state)
    for (const [type, set] of out) {
      const sorted = set.sort((left, right) => right - left)
      state.next.push({ type, next: labeled.get(sorted.join(",")) ?? explore(sorted) })
    }
    return state
  }
  return explore(nullFrom(nfa, 0))
}

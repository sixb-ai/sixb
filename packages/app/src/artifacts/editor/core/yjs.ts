// The editor's document, held in a live `Y.XmlFragment`, which is the document itself: a node is
// a `Y.XmlElement` named by its type, its attributes those of the node; a run of text is a
// `Y.XmlText` whose formatting attributes are its marks, each named by its type with its
// attributes as value. Core's `artifacts/live/blocks.ts` and `page.ts` read and write the same
// encoding on the server.
//
// Reading builds the editor's document from the fragment once, then again only along the path of
// what changed: each element keeps the node read from it until a change reaches it. Writing turns
// the fragment into the next document by y-prosemirror's reconciliation (MIT), step for step:
// elements left as they are where their nodes are, texts patched in place, the rest deleted and
// created again. Which Yjs types survive a change decides where others' carets and an undo land,
// so this is not a place for a cleverer diff.

import { simpleDiff } from "lib0/diff"
import * as Y from "yjs"
import { type Attrs, Fragment, type Mark, type Node, type Schema } from "./model"

type YChild = Y.XmlElement | Y.XmlText
type YParent = Y.XmlFragment | Y.XmlElement
type YType = YParent | Y.XmlText

export class YBinding {
  /**
   * The node each element was read as or written from, and the text nodes each text was written
   * from: y-prosemirror's mapping, which a change passes over where it still holds.
   */
  private readonly mapping = new WeakMap<object, Node | readonly Node[]>()

  constructor(
    readonly fragment: Y.XmlFragment,
    readonly schema: Schema
  ) {
    for (const type of Object.values(schema.marks)) {
      // y-prosemirror names a mark that may repeat by a hash of its attributes; none here may.
      if (!type.excludes(type))
        throw new Error(
          `[SixbEditor] Mark "${type.name}" may repeat, which the live document cannot hold.`
        )
    }
  }

  get doc(): Y.Doc {
    const doc = this.fragment.doc
    if (!doc) throw new Error("[SixbEditor] The live document's fragment is not in a Y.Doc.")
    return doc
  }

  // ── Reading ─────────────────────────────────────────────────────────

  /** The document the fragment holds. */
  document(): Node {
    const cached = this.mapping.get(this.fragment)
    if (cached && !Array.isArray(cached)) return cached as Node
    const doc = this.schema.topNodeType.create(null, this.children(this.fragment))
    this.mapping.set(this.fragment, doc)
    return doc
  }

  /** Forgets what was read from the types a change reached, and from what holds them. */
  forget(events: readonly { readonly target: object }[]): void {
    for (const event of events) {
      for (let type: YType | null = event.target as YType; type; type = parentOf(type)) {
        if (!this.mapping.delete(type) && type !== event.target) break
        if (type === this.fragment) break
      }
    }
    this.mapping.delete(this.fragment)
  }

  private children(parent: YParent): Fragment {
    const nodes: Node[] = []
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) nodes.push(...this.text(child))
      else if (child instanceof Y.XmlElement) {
        const node = this.element(child)
        if (node) nodes.push(node)
      }
    }
    return Fragment.fromArray(nodes)
  }

  private element(element: Y.XmlElement): Node | null {
    const cached = this.mapping.get(element)
    if (cached && !Array.isArray(cached)) return cached as Node
    const type = this.schema.nodes[element.nodeName]
    if (!type || type.isText) return null
    const node = type.create(element.getAttributes() as Attrs, this.children(element))
    this.mapping.set(element, node)
    return node
  }

  /** A text's runs as text nodes. A text this editor added just after another joins it first. */
  private text(text: Y.XmlText): readonly Node[] {
    mergeNext(text)
    const nodes: Node[] = []
    for (const op of text.toDelta() as {
      insert?: unknown
      attributes?: Record<string, unknown>
    }[]) {
      if (typeof op.insert !== "string" || op.insert === "") continue
      nodes.push(this.schema.textNode(op.insert, this.marksOf(op.attributes)))
    }
    return nodes
  }

  private marksOf(attributes: Record<string, unknown> | undefined): Mark[] {
    const marks: Mark[] = []
    for (const [name, value] of Object.entries(attributes ?? {})) {
      // A second mark of a type that allows several is named `type--hash`.
      const type = this.schema.marks[name.split("--")[0] as string]
      if (type) marks.push(type.create((value && typeof value === "object" ? value : {}) as Attrs))
    }
    return marks
  }

  // ── Writing ─────────────────────────────────────────────────────────

  /** Makes the fragment hold `next` instead of `previous`, which it holds now. */
  write(previous: Node, next: Node, origin: unknown): void {
    if (previous === next) return
    this.doc.transact(() => this.update(this.fragment, next), origin)
  }

  /** y-prosemirror's `updateYFragment`: makes `target` hold `node`. */
  private update(target: YParent, node: Node): void {
    if (target instanceof Y.XmlElement && target.nodeName !== node.type.name) {
      throw new Error(
        `[SixbEditor] A "${target.nodeName}" element cannot hold a "${node.type.name}" node.`
      )
    }
    this.mapping.set(target, node)
    if (target instanceof Y.XmlElement) updateAttributes(target, node.attrs)
    const contents = contentOf(node)
    const types = target.toArray() as YChild[]
    if (this.reconcileAnchored(target, contents, types)) return

    // Alike at either end passed over, leaving one on the left for what is left to change.
    const shortest = Math.min(contents.length, types.length)
    let left = 0
    let right = 0
    for (; left < shortest; left += 1) {
      const type = types[left] as YChild
      const content = contents[left] as Content
      if (sameMapped(this.mapping.get(type), content)) continue
      if (!equalTypeContent(type, content)) break
      this.mapping.set(type, content)
    }
    for (; right + left + 1 < shortest; right += 1) {
      const type = types[types.length - right - 1] as YChild
      const content = contents[contents.length - right - 1] as Content
      if (sameMapped(this.mapping.get(type), content)) continue
      if (!equalTypeContent(type, content)) break
      this.mapping.set(type, content)
    }

    // In between, a text is patched, an element of the same name updated (from whichever end
    // keeps more of its children), and anything else deleted and created again.
    while (types.length - left - right > 0 && contents.length - left - right > 0) {
      const leftType = types[left] as YChild
      const leftContent = contents[left] as Content
      const rightType = types[types.length - right - 1] as YChild
      const rightContent = contents[contents.length - right - 1] as Content
      if (leftType instanceof Y.XmlText && Array.isArray(leftContent)) {
        if (!equalText(leftType, leftContent)) this.updateText(leftType, leftContent)
        left += 1
        continue
      }
      let updateLeft = leftType instanceof Y.XmlElement && sameName(leftType, leftContent)
      let updateRight = rightType instanceof Y.XmlElement && sameName(rightType, rightContent)
      if (updateLeft && updateRight) {
        const fromLeft = this.equality(leftType as Y.XmlElement, leftContent as Node)
        const fromRight = this.equality(rightType as Y.XmlElement, rightContent as Node)
        if (fromLeft.mapped && !fromRight.mapped) updateRight = false
        else if (!fromLeft.mapped && fromRight.mapped) updateLeft = false
        else if (fromLeft.factor < fromRight.factor) updateLeft = false
        else updateRight = false
      }
      if (updateLeft) {
        this.update(leftType as Y.XmlElement, leftContent as Node)
        left += 1
        continue
      }
      if (updateRight) {
        this.update(rightType as Y.XmlElement, rightContent as Node)
        right += 1
        continue
      }
      this.mapping.delete(target.get(left))
      target.delete(left, 1)
      target.insert(left, [this.create(leftContent)])
      left += 1
    }

    const removed = types.length - left - right
    const only = types[0]
    if (types.length === 1 && contents.length === 0 && only instanceof Y.XmlText) {
      // A block's only text, emptied, stays, so what others type into it still lands.
      this.mapping.delete(only)
      only.delete(0, only.length)
    } else if (removed > 0) {
      for (const type of target.slice(left, left + removed)) this.mapping.delete(type)
      target.delete(left, removed)
    }
    if (left + right < contents.length) {
      const made: YChild[] = []
      for (let index = left; index < contents.length - right; index += 1)
        made.push(this.create(contents[index] as Content))
      target.insert(left, made)
    }
  }

  /**
   * Children still mapped to their nodes, in order, anchor the rest, which is reconciled between
   * them: y-prosemirror's `reconcileMappedChildren`, for when the anchors have moved.
   */
  private reconcileAnchored(
    target: YParent,
    contents: readonly Content[],
    types: readonly YChild[]
  ): boolean {
    const anchors = this.anchors(types, contents)
    if (anchors.length < 2 || !anchors.some((anchor) => anchor.typeIndex !== anchor.contentIndex))
      return false
    const kindsAgree = anchors.every(
      (anchor) => anchor.type instanceof Y.XmlText === Array.isArray(contents[anchor.contentIndex])
    )
    if (!kindsAgree) return false
    let typeIndex = 0
    let contentIndex = 0
    for (const anchor of anchors) {
      this.reconcileBetween(
        target,
        contents,
        types,
        typeIndex,
        anchor.typeIndex,
        contentIndex,
        anchor.contentIndex
      )
      this.updateMatching(anchor.type, contents[anchor.contentIndex] as Content)
      typeIndex = anchor.typeIndex + 1
      contentIndex = anchor.contentIndex + 1
    }
    this.reconcileBetween(
      target,
      contents,
      types,
      typeIndex,
      types.length,
      contentIndex,
      contents.length
    )
    return true
  }

  /** The longest run of children still mapped to their nodes in the same order. */
  private anchors(types: readonly YChild[], contents: readonly Content[]): Anchor[] {
    const indexOf = new Map<Content, number>()
    contents.forEach((content, index) => {
      if (!indexOf.has(content)) indexOf.set(content, index)
    })
    const candidates: Anchor[] = []
    types.forEach((type, typeIndex) => {
      const mapped = this.mapping.get(type)
      const contentIndex = mapped === undefined ? undefined : indexOf.get(mapped)
      if (contentIndex !== undefined && sameMapped(mapped, contents[contentIndex] as Content))
        candidates.push({ typeIndex, contentIndex, type })
    })
    if (candidates.length === 0) return []
    const previous: number[] = []
    const tails: number[] = []
    candidates.forEach((candidate, index) => {
      let low = 0
      let high = tails.length
      while (low < high) {
        const middle = (low + high) >> 1
        if ((candidates[tails[middle] as number] as Anchor).contentIndex < candidate.contentIndex)
          low = middle + 1
        else high = middle
      }
      previous[index] = low > 0 ? (tails[low - 1] as number) : -1
      tails[low] = index
    })
    const anchors: Anchor[] = []
    for (
      let index = tails[tails.length - 1] as number;
      index !== -1;
      index = previous[index] as number
    )
      anchors.push(candidates[index] as Anchor)
    return anchors.reverse()
  }

  /** Children between two anchors, paired off in order; past the shorter side, deleted or created. */
  private reconcileBetween(
    target: YParent,
    contents: readonly Content[],
    types: readonly YChild[],
    typeStart: number,
    typeEnd: number,
    contentStart: number,
    contentEnd: number
  ): void {
    const paired = Math.min(typeEnd - typeStart, contentEnd - contentStart)
    for (let index = 0; index < paired; index += 1) {
      const content = contents[contentStart + index] as Content
      if (this.updateMatching(types[typeStart + index] as YChild, content)) continue
      this.remove(target, contentStart + index, 1)
      target.insert(contentStart + index, [this.create(content)])
    }
    this.remove(target, contentStart + paired, typeEnd - typeStart - paired)
    const made: YChild[] = []
    for (let index = contentStart + paired; index < contentEnd; index += 1)
      made.push(this.create(contents[index] as Content))
    if (made.length) target.insert(contentStart + paired, made)
  }

  /** Updates a child to hold `content` if it is of its kind, as a text or an element of its name. */
  private updateMatching(type: YChild, content: Content): boolean {
    if (type instanceof Y.XmlText && Array.isArray(content)) {
      if (equalText(type, content)) this.mapping.set(type, content)
      else this.updateText(type, content)
      return true
    }
    if (type instanceof Y.XmlElement && sameName(type, content)) {
      if (equalTypeContent(type, content)) this.mapping.set(type, content)
      else this.update(type, content as Node)
      return true
    }
    return false
  }

  private remove(target: YParent, index: number, length: number): void {
    if (length <= 0) return
    for (const type of target.slice(index, index + length)) this.mapping.delete(type)
    target.delete(index, length)
  }

  /** How many children alike, from either end, an element keeps holding `node`. */
  private equality(type: Y.XmlElement, node: Node): { factor: number; mapped: boolean } {
    const types = type.toArray() as YChild[]
    const contents = contentOf(node)
    const shortest = Math.min(types.length, contents.length)
    let left = 0
    let right = 0
    let mapped = false
    for (; left < shortest; left += 1) {
      if (sameMapped(this.mapping.get(types[left] as YChild), contents[left] as Content))
        mapped = true
      else if (!equalTypeContent(types[left] as YChild, contents[left] as Content)) break
    }
    for (; left + right < shortest; right += 1) {
      const each = types[types.length - right - 1] as YChild
      const content = contents[contents.length - right - 1] as Content
      if (sameMapped(this.mapping.get(each), content)) mapped = true
      else if (!equalTypeContent(each, content)) break
    }
    return { factor: left + right, mapped }
  }

  /** Patches a text to read as `nodes`: the changed middle replaced, then every run formatted. */
  private updateText(text: Y.XmlText, nodes: readonly Node[]): void {
    this.mapping.set(text, nodes)
    let current = ""
    const unset: Record<string, null> = {}
    for (
      let item = (text as unknown as { _start: YItem | null })._start;
      item !== null;
      item = item.right
    ) {
      if (item.deleted) continue
      if (item.countable && item.content instanceof Y.ContentString) current += item.content.str
      else if (item.content instanceof Y.ContentFormat) unset[item.content.key] = null
    }
    const runs = nodes.map((node) => ({
      insert: node.text ?? "",
      attributes: { ...unset, ...marksToAttributes(node.marks) },
    }))
    const { index, remove, insert } = simpleDiff(current, runs.map((run) => run.insert).join(""))
    text.delete(index, remove)
    text.insert(index, insert)
    text.applyDelta(runs.map((run) => ({ retain: run.insert.length, attributes: run.attributes })))
  }

  /** A new type holding `content`: a text for text nodes, an element for a node. */
  private create(content: Content): YChild {
    if (Array.isArray(content)) {
      const text = new Y.XmlText()
      text.applyDelta(
        content.map((node) => ({
          insert: node.text ?? "",
          attributes: marksToAttributes(node.marks),
        }))
      )
      this.mapping.set(text, content)
      return text
    }
    const node = content as Node
    const element = new Y.XmlElement(node.type.name)
    for (const [name, value] of Object.entries(node.attrs)) {
      if (value !== null) element.setAttribute(name, value as string)
    }
    element.insert(
      0,
      contentOf(node).map((child) => this.create(child))
    )
    this.mapping.set(element, node)
    return element
  }

  // ── Positions ───────────────────────────────────────────────────────

  /**
   * A position as a Yjs relative position, which stays with the words around it whatever others
   * change: within a text, its character; between blocks, the block after it. As the editor
   * collaboration of y-prosemirror makes them, so carets read the same by either.
   */
  relative(pos: number): Y.RelativePosition {
    const fragment = this.fragment
    if (pos === 0) return Y.createRelativePositionFromTypeIndex(fragment, 0, -1)
    let left = pos
    let node: YType | null = fragment.firstChild as YChild | null
    while (node !== null && node !== fragment) {
      if (node instanceof Y.XmlText) {
        if (node.length >= left) return Y.createRelativePositionFromTypeIndex(node, left, -1)
        left -= node.length
        const sibling: YChild | null = node.nextSibling as YChild | null
        if (sibling) {
          node = sibling
        } else {
          do {
            node = parentOf(node)
            left -= 1
          } while (node !== fragment && node !== null && !(node as YChild).nextSibling)
          if (node !== null && node !== fragment)
            node = (node as YChild).nextSibling as YChild | null
        }
      } else {
        const element = node as Y.XmlElement
        const size = this.element(element)?.nodeSize ?? 0
        if (element.length > 0 && left < size) {
          node = element.firstChild as YChild
          left -= 1
        } else {
          if (left === 1 && element.length === 0 && size > 1)
            return Y.createRelativePositionFromTypeIndex(element, 0)
          left -= size
          const sibling: YChild | null = element.nextSibling as YChild | null
          if (sibling) {
            node = sibling
          } else {
            if (left === 0) {
              const parent = element.parent as YParent
              return Y.createRelativePositionFromTypeIndex(parent, parent.length)
            }
            do {
              node = parentOf(node)
              if (node === null) throw new Error("[SixbEditor] A position outside the document.")
              left -= 1
            } while (node !== fragment && !(node as YChild).nextSibling)
            if (node !== fragment) node = (node as YChild).nextSibling as YChild | null
          }
        }
      }
      if (node === null) throw new Error("[SixbEditor] A position outside the document.")
      if (left === 0 && !(node instanceof Y.XmlText) && node !== fragment) {
        const parent = node.parent as YParent
        return Y.createRelativePositionFromTypeIndex(
          parent,
          parent.toArray().indexOf(node as YChild)
        )
      }
    }
    return Y.createRelativePositionFromTypeIndex(fragment, fragment.length, -1)
  }

  /** Where a relative position is now; null when what it was in is gone. */
  absolute(relative: Y.RelativePosition): number | null {
    const decoded = Y.createAbsolutePositionFromRelativePosition(relative, this.doc)
    if (!decoded) return null
    let type = decoded.type as YType
    if (type !== this.fragment && !isWithin(type, this.fragment)) return null
    // A position in a text that was deleted resolves to its start, which is somewhere else.
    if (type instanceof Y.XmlText && relative.item !== null && isDeleted(type)) return null
    let pos = 0
    if (type instanceof Y.XmlText) {
      pos = decoded.index
    } else if (!isDeleted(type)) {
      pos = this.sizeBefore(type as YParent, decoded.index) + 1
    }
    while (type !== this.fragment) {
      const parent = parentOf(type)
      if (!parent) return null
      if (!isDeleted(parent)) {
        const index = parent.toArray().indexOf(type as YChild)
        if (index < 0) return null
        pos += this.sizeBefore(parent, index) + 1
      }
      type = parent
    }
    return pos - 1
  }

  private sizeBefore(parent: YParent, index: number): number {
    let size = 0
    const children = parent.toArray()
    for (let at = 0; at < index && at < children.length; at += 1) {
      const child = children[at]
      if (child instanceof Y.XmlText) size += child.length
      else if (child instanceof Y.XmlElement) size += this.element(child)?.nodeSize ?? 0
    }
    return size
  }
}

/** What a node holds as Yjs sees it: each inline or block node, and each run of text nodes. */
type Content = Node | readonly Node[]

interface Anchor {
  readonly typeIndex: number
  readonly contentIndex: number
  readonly type: YChild
}

/** The parts of a Yjs item the text patch reads, as Yjs keeps them. */
interface YItem {
  readonly right: YItem | null
  readonly deleted: boolean
  readonly countable: boolean
  readonly content: unknown
}

function contentOf(node: Node): Content[] {
  const contents: Content[] = []
  let run: Node[] | null = null
  node.forEach((child) => {
    if (child.isText) {
      if (!run) {
        run = []
        contents.push(run)
      }
      run.push(child)
    } else {
      run = null
      contents.push(child)
    }
  })
  return contents
}

function sameMapped(mapped: Content | undefined, content: Content): boolean {
  if (mapped === content) return true
  if (!Array.isArray(mapped) || !Array.isArray(content)) return false
  return mapped.length === content.length && mapped.every((node, index) => content[index] === node)
}

function sameName(element: Y.XmlElement, content: Content): boolean {
  return !Array.isArray(content) && element.nodeName === (content as Node).type.name
}

function equalTypeContent(type: YChild, content: Content): boolean {
  if (type instanceof Y.XmlElement && sameName(type, content)) {
    const contents = contentOf(content as Node)
    return (
      type.length === contents.length &&
      equalAttrs(type.getAttributes(), (content as Node).attrs) &&
      type
        .toArray()
        .every((child, index) => equalTypeContent(child as YChild, contents[index] as Content))
    )
  }
  return type instanceof Y.XmlText && Array.isArray(content) && equalText(type, content)
}

function equalText(text: Y.XmlText, nodes: readonly Node[]): boolean {
  const delta = text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]
  return (
    delta.length === nodes.length &&
    delta.every((op, index) => {
      const node = nodes[index] as Node
      const attributes = op.attributes ?? {}
      if (op.insert !== node.text || Object.keys(attributes).length !== node.marks.length)
        return false
      return Object.entries(attributes).every(([name, value]) => {
        const mark = node.marks.find((each) => each.type.name === name)
        return !!mark && equalAttrs(value as Record<string, unknown>, mark.attrs)
      })
    })
  )
}

/** Attributes alike, nulls aside, objects compared by their own attributes. */
function equalAttrs(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left).filter((key) => left[key] !== null)
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== null).length) return false
  return keys.every((key) => {
    const a = left[key]
    const b = right[key]
    return a === b || (isObject(a) && isObject(b) && equalAttrs(a, b))
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function marksToAttributes(marks: readonly Mark[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  for (const mark of marks) attributes[mark.type.name] = mark.attrs
  return attributes
}

function updateAttributes(element: Y.XmlElement, attrs: Attrs): void {
  const current = element.getAttributes() as Record<string, unknown>
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) element.removeAttribute(name)
    else if (current[name] !== value) element.setAttribute(name, value as string)
  }
  for (const name of Object.keys(current))
    if (attrs[name] === undefined) element.removeAttribute(name)
}

/**
 * Joins the text right after `text` into it when this editor made that one, as two people
 * typing into an empty block at once each add a text there. Only its maker joins it, so the
 * words are not doubled.
 */
function mergeNext(text: Y.XmlText): void {
  const item = (text as unknown as { _item: { right: { content: unknown } | null } | null })._item
  const content = item?.right?.content
  const next = content instanceof Y.ContentType ? content.type : null
  if (!(next instanceof Y.Text)) return
  const nextItem = (
    next as unknown as {
      _item: { deleted: boolean; id: Y.ID; delete(transaction: Y.Transaction): void } | null
    }
  )._item
  const doc = next.doc
  if (!nextItem || !doc || nextItem.deleted || nextItem.id.client !== doc.clientID) return
  text.applyDelta([{ retain: text.length }, ...next.toDelta()])
  doc.transact((transaction) => nextItem.delete(transaction))
}

function parentOf(type: YType): YParent | null {
  return (type.parent as YParent | null) ?? null
}

function isWithin(type: YType, root: Y.XmlFragment): boolean {
  for (let current = parentOf(type); current; current = parentOf(current))
    if (current === root) return true
  return false
}

/** Whether a Yjs type was deleted; Yjs keeps this on the type's item, which it exposes as `_item`. */
function isDeleted(type: YType): boolean {
  return (type as unknown as { _item: { deleted: boolean } | null })._item?.deleted === true
}

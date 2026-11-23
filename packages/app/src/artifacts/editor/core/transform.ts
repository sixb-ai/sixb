// Changes to a document as steps, each replacing a range with a slice, and the maps that carry
// positions across them. `Transform` builds a new document step by step; the editor turns its
// result into Yjs changes (./yjs.ts). Replacing a range with content that does not fit there as it
// is, a paste or a deletion across blocks, fits it the way ProseMirror's `replaceStep` does: the
// content is opened, wrapped and closed until it can stand where it goes.

import {
  type Attrs,
  type ContentMatch,
  Fragment,
  type Mark,
  MarkType,
  type Node,
  type NodeRange,
  type NodeType,
  ReplaceError,
  type ResolvedPos,
  Slice,
} from "./model"

// ── Maps ────────────────────────────────────────────────────────────────

const DELETED_BEFORE = 1
const DELETED_AFTER = 2
const DELETED_ACROSS = 4
const DELETED_SIDE = 8

/** Where a position went, and what around it was deleted. */
export class MapResult {
  constructor(
    readonly pos: number,
    private readonly deletion: number
  ) {}
  /** The position's side, given its association, was deleted. */
  get deleted(): boolean {
    return (this.deletion & DELETED_SIDE) > 0
  }
  get deletedBefore(): boolean {
    return (this.deletion & (DELETED_BEFORE | DELETED_ACROSS)) > 0
  }
  get deletedAfter(): boolean {
    return (this.deletion & (DELETED_AFTER | DELETED_ACROSS)) > 0
  }
  get deletedAcross(): boolean {
    return (this.deletion & DELETED_ACROSS) > 0
  }
  /** @internal */
  get flags(): number {
    return this.deletion
  }
}

export interface Mappable {
  map(pos: number, assoc?: number): number
  mapResult(pos: number, assoc?: number): MapResult
}

/** One step's map: ranges as triples of start, size before and size after. */
export class StepMap implements Mappable {
  static readonly empty = new StepMap([])

  constructor(readonly ranges: readonly number[]) {}

  map(pos: number, assoc = 1): number {
    return this.mapPos(pos, assoc).pos
  }

  mapResult(pos: number, assoc = 1): MapResult {
    return this.mapPos(pos, assoc)
  }

  private mapPos(pos: number, assoc: number): MapResult {
    let diff = 0
    for (let index = 0; index < this.ranges.length; index += 3) {
      const start = this.ranges[index] as number
      if (start > pos) break
      const oldSize = this.ranges[index + 1] as number
      const newSize = this.ranges[index + 2] as number
      const end = start + oldSize
      if (pos <= end) {
        const side = !oldSize ? assoc : pos === start ? -1 : pos === end ? 1 : assoc
        const result = start + diff + (side < 0 ? 0 : newSize)
        let deletion = pos === start ? DELETED_AFTER : pos === end ? DELETED_BEFORE : DELETED_ACROSS
        if (assoc < 0 ? pos !== start : pos !== end) deletion |= DELETED_SIDE
        return new MapResult(result, deletion)
      }
      diff += newSize - oldSize
    }
    return new MapResult(pos + diff, 0)
  }

  forEach(
    each: (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => void
  ): void {
    let diff = 0
    for (let index = 0; index < this.ranges.length; index += 3) {
      const start = this.ranges[index] as number
      const oldSize = this.ranges[index + 1] as number
      const newSize = this.ranges[index + 2] as number
      each(start, start + oldSize, start + diff, start + diff + newSize)
      diff += newSize - oldSize
    }
  }
}

/** The maps of several steps, applied in order. */
export class Mapping implements Mappable {
  constructor(readonly maps: StepMap[] = []) {}

  slice(from = 0, to = this.maps.length): Mapping {
    return new Mapping(this.maps.slice(from, to))
  }

  appendMap(map: StepMap): void {
    this.maps.push(map)
  }

  map(pos: number, assoc = 1): number {
    let mapped = pos
    for (const map of this.maps) mapped = map.map(mapped, assoc)
    return mapped
  }

  mapResult(pos: number, assoc = 1): MapResult {
    let mapped = pos
    let deletion = 0
    for (const map of this.maps) {
      const result = map.mapResult(mapped, assoc)
      deletion |= result.flags
      mapped = result.pos
    }
    return new MapResult(mapped, deletion)
  }
}

// ── Steps ───────────────────────────────────────────────────────────────

export class StepError extends Error {}

export interface Step {
  apply(doc: Node): Node
  getMap(): StepMap
  /** The step undoing this one, given the document it applied to. */
  invert(doc: Node): Step
}

/** Replaces `from`–`to` with a slice. A structure step may only cross node boundaries. */
export class ReplaceStep implements Step {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly slice: Slice,
    readonly structure = false
  ) {}

  apply(doc: Node): Node {
    if (this.structure && contentBetween(doc, this.from, this.to)) {
      throw new StepError("Structure replace would overwrite content")
    }
    return replaceIn(doc, this.from, this.to, this.slice)
  }

  getMap(): StepMap {
    return new StepMap([this.from, this.to - this.from, this.slice.size])
  }

  invert(doc: Node): Step {
    return new ReplaceStep(this.from, this.from + this.slice.size, doc.slice(this.from, this.to))
  }
}

/** Replaces `from`–`to` with a slice, keeping `gapFrom`–`gapTo` and putting it at `insert`. */
export class ReplaceAroundStep implements Step {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly gapFrom: number,
    readonly gapTo: number,
    readonly slice: Slice,
    readonly insert: number,
    readonly structure = false
  ) {}

  apply(doc: Node): Node {
    if (
      this.structure &&
      (contentBetween(doc, this.from, this.gapFrom) || contentBetween(doc, this.gapTo, this.to))
    ) {
      throw new StepError("Structure gap-replace would overwrite content")
    }
    const gap = doc.slice(this.gapFrom, this.gapTo)
    if (gap.openStart || gap.openEnd) throw new StepError("Gap is not a flat range")
    const inserted = this.slice.insertAt(this.insert, gap.content)
    if (!inserted) throw new StepError("Content does not fit in gap")
    return replaceIn(doc, this.from, this.to, inserted)
  }

  getMap(): StepMap {
    return new StepMap([
      this.from,
      this.gapFrom - this.from,
      this.insert,
      this.gapTo,
      this.to - this.gapTo,
      this.slice.size - this.insert,
    ])
  }

  invert(doc: Node): Step {
    const gap = this.gapTo - this.gapFrom
    return new ReplaceAroundStep(
      this.from,
      this.from + this.slice.size + gap,
      this.from + this.insert,
      this.from + this.insert + gap,
      doc.slice(this.from, this.to).removeBetween(this.gapFrom - this.from, this.gapTo - this.from),
      this.gapFrom - this.from,
      this.structure
    )
  }
}

/** Adds or removes a mark over the inline content between two positions. */
export class MarkStep implements Step {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly mark: Mark,
    readonly add: boolean
  ) {}

  apply(doc: Node): Node {
    const old = doc.slice(this.from, this.to)
    const $from = doc.resolve(this.from)
    const parent = $from.node($from.sharedDepth(this.to))
    const content = mapInline(
      old.content,
      (node, holder) => {
        if (!this.add) return node.mark(this.mark.removeFromSet(node.marks))
        if (!node.isAtom || !holder.type.allowsMarkType(this.mark.type)) return node
        return node.mark(this.mark.addToSet(node.marks))
      },
      parent
    )
    return replaceIn(doc, this.from, this.to, new Slice(content, old.openStart, old.openEnd))
  }

  getMap(): StepMap {
    return StepMap.empty
  }

  invert(): Step {
    return new MarkStep(this.from, this.to, this.mark, !this.add)
  }
}

/** Sets one attribute of the node at `pos`. */
export class AttrStep implements Step {
  constructor(
    readonly pos: number,
    readonly attr: string,
    readonly value: unknown
  ) {}

  apply(doc: Node): Node {
    const node = doc.nodeAt(this.pos)
    if (!node) throw new StepError("No node at attribute step's position")
    const updated = node.type.create({ ...node.attrs, [this.attr]: this.value }, null, node.marks)
    return replaceIn(
      doc,
      this.pos,
      this.pos + 1,
      new Slice(Fragment.from(updated), 0, node.isLeaf ? 0 : 1)
    )
  }

  getMap(): StepMap {
    return StepMap.empty
  }

  invert(doc: Node): Step {
    return new AttrStep(this.pos, this.attr, doc.nodeAt(this.pos)?.attrs[this.attr])
  }
}

function replaceIn(doc: Node, from: number, to: number, slice: Slice): Node {
  try {
    return doc.replace(from, to, slice)
  } catch (error) {
    if (error instanceof ReplaceError) throw new StepError(error.message)
    throw error
  }
}

function mapInline(
  fragment: Fragment,
  each: (node: Node, parent: Node) => Node,
  parent: Node
): Fragment {
  const mapped: Node[] = []
  fragment.forEach((child) => {
    let node = child
    if (node.content.size) node = node.copy(mapInline(node.content, each, node))
    if (node.isInline) node = each(node, parent)
    mapped.push(node)
  })
  return Fragment.fromArray(mapped)
}

function contentBetween(doc: Node, from: number, to: number): boolean {
  const $from = doc.resolve(from)
  let dist = to - from
  let depth = $from.depth
  while (dist > 0 && depth > 0 && $from.indexAfter(depth) === $from.node(depth).childCount) {
    depth -= 1
    dist -= 1
  }
  if (dist > 0) {
    let next = $from.node(depth).maybeChild($from.indexAfter(depth))
    while (dist > 0) {
      if (!next || next.isLeaf) return true
      next = next.firstChild
      dist -= 1
    }
  }
  return false
}

// ── Transforms ──────────────────────────────────────────────────────────

/** A document changed step by step. */
export class Transform {
  readonly steps: Step[] = []
  readonly docs: Node[] = []
  readonly mapping = new Mapping()
  doc: Node

  constructor(readonly before: Node) {
    this.doc = before
  }

  get docChanged(): boolean {
    return this.steps.length > 0
  }

  /** Applies `step`, or adds it with `doc`, the document it makes, when that is known already. */
  step(step: Step, doc = step.apply(this.doc)): this {
    this.docs.push(this.doc)
    this.steps.push(step)
    this.mapping.appendMap(step.getMap())
    this.doc = doc
    return this
  }

  /** Applies the step, or does nothing when it does not apply. */
  maybeStep(step: Step): boolean {
    try {
      this.step(step)
      return true
    } catch (error) {
      if (error instanceof StepError) return false
      throw error
    }
  }

  replace(from: number, to = from, slice = Slice.empty): this {
    const step = replaceStep(this.doc, from, to, slice)
    if (step) this.step(step)
    return this
  }

  replaceWith(from: number, to: number, content: Fragment | Node | readonly Node[]): this {
    return this.replace(from, to, new Slice(Fragment.from(content), 0, 0))
  }

  delete(from: number, to: number): this {
    return this.replace(from, to, Slice.empty)
  }

  insert(pos: number, content: Fragment | Node | readonly Node[]): this {
    return this.replaceWith(pos, pos, content)
  }

  replaceRange(from: number, to: number, slice: Slice): this {
    replaceRange(this, from, to, slice)
    return this
  }

  replaceRangeWith(from: number, to: number, node: Node): this {
    let start = from
    let end = to
    if (!node.isInline && from === to && this.doc.resolve(from).parent.content.size) {
      const point = insertPoint(this.doc, from, node.type)
      if (point !== null) start = end = point
    }
    return this.replaceRange(start, end, new Slice(Fragment.from(node), 0, 0))
  }

  deleteRange(from: number, to: number): this {
    deleteRange(this, from, to)
    return this
  }

  lift(range: NodeRange, target: number): this {
    const { $from, $to, depth } = range
    const gapStart = $from.before(depth + 1)
    const gapEnd = $to.after(depth + 1)
    let start = gapStart
    let end = gapEnd
    let before = Fragment.empty
    let openStart = 0
    for (let at = depth, splitting = false; at > target; at -= 1) {
      if (splitting || $from.index(at) > 0) {
        splitting = true
        before = Fragment.from($from.node(at).copy(before))
        openStart += 1
      } else {
        start -= 1
      }
    }
    let after = Fragment.empty
    let openEnd = 0
    for (let at = depth, splitting = false; at > target; at -= 1) {
      if (splitting || $to.after(at + 1) < $to.end(at)) {
        splitting = true
        after = Fragment.from($to.node(at).copy(after))
        openEnd += 1
      } else {
        end += 1
      }
    }
    return this.step(
      new ReplaceAroundStep(
        start,
        end,
        gapStart,
        gapEnd,
        new Slice(before.append(after), openStart, openEnd),
        before.size - openStart,
        true
      )
    )
  }

  wrap(
    range: NodeRange,
    wrappers: readonly { readonly type: NodeType; readonly attrs?: Attrs | null }[]
  ): this {
    let content = Fragment.empty
    for (let index = wrappers.length - 1; index >= 0; index -= 1) {
      const wrapper = wrappers[index] as { readonly type: NodeType; readonly attrs?: Attrs | null }
      if (content.size) {
        const match = wrapper.type.contentMatch.matchFragment(content)
        if (!match?.validEnd)
          throw new RangeError("[SixbEditor] A wrapper does not hold what is inside it.")
      }
      content = Fragment.from(wrapper.type.create(wrapper.attrs, content))
    }
    return this.step(
      new ReplaceAroundStep(
        range.start,
        range.end,
        range.start,
        range.end,
        new Slice(content, 0, 0),
        wrappers.length,
        true
      )
    )
  }

  setBlockType(from: number, to: number, type: NodeType, attrs: Attrs | null = null): this {
    if (!type.isTextblock) throw new RangeError("[SixbEditor] setBlockType takes a textblock type.")
    const mapFrom = this.steps.length
    this.doc.nodesBetween(from, to, (node, pos) => {
      if (
        node.isTextblock &&
        !node.hasMarkup(type, type.computeAttrs(attrs)) &&
        canChangeType(this.doc, this.mapping.slice(mapFrom).map(pos), type)
      ) {
        const convert = newlineConversion(type)
        if (convert === false) replaceLinebreaks(this, node, pos, mapFrom)
        clearIncompatible(
          this,
          this.mapping.slice(mapFrom).map(pos, 1),
          type,
          undefined,
          convert === null
        )
        const mapping = this.mapping.slice(mapFrom)
        const start = mapping.map(pos, 1)
        const end = mapping.map(pos + node.nodeSize, 1)
        this.step(
          new ReplaceAroundStep(
            start,
            end,
            start + 1,
            end - 1,
            new Slice(Fragment.from(type.create(attrs, null, node.marks)), 0, 0),
            1,
            true
          )
        )
        if (convert === true) replaceNewlines(this, node, pos, mapFrom)
        return false
      }
      return true
    })
    return this
  }

  setNodeMarkup(
    pos: number,
    type?: NodeType | null,
    attrs: Attrs | null = null,
    marks?: readonly Mark[]
  ): this {
    const node = this.doc.nodeAt(pos)
    if (!node) throw new RangeError("[SixbEditor] No node at the given position.")
    const nodeType = type ?? node.type
    const made = nodeType.create(attrs, null, marks ?? node.marks)
    if (node.isLeaf) return this.replaceWith(pos, pos + node.nodeSize, made)
    if (!nodeType.validContent(node.content))
      throw new RangeError(`[SixbEditor] Invalid content for ${nodeType.name}.`)
    return this.step(
      new ReplaceAroundStep(
        pos,
        pos + node.nodeSize,
        pos + 1,
        pos + node.nodeSize - 1,
        new Slice(Fragment.from(made), 0, 0),
        1,
        true
      )
    )
  }

  setNodeAttribute(pos: number, attr: string, value: unknown): this {
    return this.step(new AttrStep(pos, attr, value))
  }

  split(pos: number, depth = 1, typesAfter?: readonly (TypeAfter | null)[]): this {
    const $pos = this.doc.resolve(pos)
    let before = Fragment.empty
    let after = Fragment.empty
    for (
      let at = $pos.depth, end = $pos.depth - depth, index = depth - 1;
      at > end;
      at -= 1, index -= 1
    ) {
      before = Fragment.from($pos.node(at).copy(before))
      const typeAfter = typesAfter?.[index]
      after = Fragment.from(
        typeAfter ? typeAfter.type.create(typeAfter.attrs, after) : $pos.node(at).copy(after)
      )
    }
    return this.step(new ReplaceStep(pos, pos, new Slice(before.append(after), depth, depth), true))
  }

  join(pos: number, depth = 1): this {
    const $before = this.doc.resolve(pos - depth)
    const beforeType = $before.node().type
    const convert = beforeType.inlineContent ? newlineConversion(beforeType) : null
    const mapFrom = this.steps.length
    if (convert === false) {
      const $after = this.doc.resolve(pos + depth)
      replaceLinebreaks(this, $after.node(), $after.before(), mapFrom)
    }
    if (beforeType.inlineContent) {
      clearIncompatible(
        this,
        pos + depth - 1,
        beforeType,
        $before.node().contentMatchAt($before.index()),
        convert === null
      )
    }
    const mapping = this.mapping.slice(mapFrom)
    const start = mapping.map(pos - depth)
    this.step(new ReplaceStep(start, mapping.map(pos + depth, -1), Slice.empty, true))
    if (convert === true) {
      const $full = this.doc.resolve(start)
      replaceNewlines(this, $full.node(), $full.before(), this.steps.length)
    }
    return this
  }

  addMark(from: number, to: number, mark: Mark): this {
    const added: MarkStep[] = []
    this.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (!node.isInline) return true
      if (!mark.isInSet(node.marks) && parent?.type.allowsMarkType(mark.type)) {
        const start = Math.max(pos, from)
        const end = Math.min(pos + node.nodeSize, to)
        const last = added[added.length - 1]
        if (last && last.to === start && last.mark.eq(mark))
          added[added.length - 1] = new MarkStep(last.from, end, mark, true)
        else added.push(new MarkStep(start, end, mark, true))
      }
      return true
    })
    for (const step of added) this.step(step)
    return this
  }

  removeMark(from: number, to: number, mark?: Mark | MarkType | null): this {
    const matched: { style: Mark; from: number; to: number; step: number }[] = []
    let step = 0
    this.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isInline) return true
      step += 1
      let toRemove: readonly Mark[] | null = null
      if (mark instanceof MarkType) {
        const found: Mark[] = []
        let set = node.marks
        for (let each = mark.isInSet(set); each; each = mark.isInSet(set)) {
          found.push(each)
          set = each.removeFromSet(set)
        }
        toRemove = found
      } else if (mark) {
        if (mark.isInSet(node.marks)) toRemove = [mark]
      } else {
        toRemove = node.marks
      }
      if (toRemove?.length) {
        const end = Math.min(pos + node.nodeSize, to)
        for (const style of toRemove) {
          const found = matched.find((each) => each.step === step - 1 && style.eq(each.style))
          if (found) {
            found.to = end
            found.step = step
          } else {
            matched.push({ style, from: Math.max(pos, from), to: end, step })
          }
        }
      }
      return true
    })
    for (const each of matched) this.step(new MarkStep(each.from, each.to, each.style, false))
    return this
  }

  clearIncompatible(pos: number, parentType: NodeType, match?: ContentMatch): this {
    clearIncompatible(this, pos, parentType, match)
    return this
  }
}

export interface TypeAfter {
  readonly type: NodeType
  readonly attrs?: Attrs | null
}

// ── Structure ───────────────────────────────────────────────────────────

/**
 * Whether newlines become line breaks (true) or line breaks newlines (false) in a textblock of
 * `type`; null when neither: a code block keeps newlines, a paragraph takes line breaks.
 */
function newlineConversion(type: NodeType): boolean | null {
  const linebreak = linebreakType(type)
  if (!linebreak) return null
  const pre = !!type.spec.code
  const supportsLinebreak = !!type.contentMatch.matchType(linebreak)
  if (pre && !supportsLinebreak) return false
  if (!pre && supportsLinebreak) return true
  return null
}

function linebreakType(type: NodeType): NodeType | null {
  return type.schema.nodes.hardBreak ?? null
}

function replaceNewlines(tr: Transform, node: Node, pos: number, mapFrom: number): void {
  const linebreak = linebreakType(node.type)
  if (!linebreak) return
  node.forEach((child, offset) => {
    if (!child.isText) return
    for (const match of (child.text ?? "").matchAll(/\r?\n|\r/g)) {
      const start = tr.mapping.slice(mapFrom).map(pos + 1 + offset + match.index)
      tr.replaceWith(start, start + 1, linebreak.create())
    }
  })
}

function replaceLinebreaks(tr: Transform, node: Node, pos: number, mapFrom: number): void {
  const linebreak = linebreakType(node.type)
  node.forEach((child, offset) => {
    if (child.type !== linebreak) return
    const start = tr.mapping.slice(mapFrom).map(pos + 1 + offset)
    tr.replaceWith(start, start + 1, node.type.schema.textNode("\n"))
  })
}

function clearIncompatible(
  tr: Transform,
  pos: number,
  parentType: NodeType,
  start = parentType.contentMatch,
  clearNewlines = true
): void {
  const node = tr.doc.nodeAt(pos) as Node
  const replaced: Step[] = []
  let match = start
  let cur = pos + 1
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    const end = cur + child.nodeSize
    const allowed = match.matchType(child.type)
    if (!allowed) {
      replaced.push(new ReplaceStep(cur, end, Slice.empty))
    } else {
      match = allowed
      for (const mark of child.marks) {
        if (!parentType.allowsMarkType(mark.type)) tr.step(new MarkStep(cur, end, mark, false))
      }
      if (clearNewlines && child.isText && !parentType.spec.code) {
        let space: Slice | null = null
        for (const found of (child.text ?? "").matchAll(/\r?\n|\r/g)) {
          space ??= new Slice(
            Fragment.from(parentType.schema.textNode(" ", parentType.allowedMarks(child.marks))),
            0,
            0
          )
          replaced.push(
            new ReplaceStep(cur + found.index, cur + found.index + found[0].length, space)
          )
        }
      }
    }
    cur = end
  }
  if (!match.validEnd) {
    const fill = match.fillBefore(Fragment.empty, true)
    if (fill) tr.replace(cur, cur, new Slice(fill, 0, 0))
  }
  for (let index = replaced.length - 1; index >= 0; index -= 1) tr.step(replaced[index] as Step)
}

function canChangeType(doc: Node, pos: number, type: NodeType): boolean {
  const $pos = doc.resolve(pos)
  const index = $pos.index()
  return $pos.parent.canReplaceWith(index, index + 1, type)
}

function canCut(node: Node, start: number, end: number): boolean {
  return (
    (start === 0 || node.canReplace(start, node.childCount)) &&
    (end === node.childCount || node.canReplace(0, end))
  )
}

/** The depth a range of blocks can be lifted to, out of what holds it; null when none. */
export function liftTarget(range: NodeRange): number | null {
  const parent = range.parent
  const content = parent.content.cutByIndex(range.startIndex, range.endIndex)
  for (let depth = range.depth, contentBefore = 0, contentAfter = 0; ; depth -= 1) {
    const node = range.$from.node(depth)
    const index = range.$from.index(depth) + contentBefore
    const endIndex = range.$to.indexAfter(depth) - contentAfter
    if (depth < range.depth && node.canReplace(index, endIndex, content)) return depth
    if (depth === 0 || node.type.spec.isolating || !canCut(node, index, endIndex)) break
    if (index) contentBefore = 1
    if (endIndex < node.childCount) contentAfter = 1
  }
  return null
}

/** The wrappers a range of blocks needs to be wrapped in a node of `type`; null when it cannot. */
export function findWrapping(
  range: NodeRange,
  type: NodeType,
  attrs: Attrs | null = null,
  innerRange = range
): { type: NodeType; attrs: Attrs | null }[] | null {
  const around = findWrappingOutside(range, type)
  const inner = around && findWrappingInside(innerRange, type)
  if (!around || !inner) return null
  return [
    ...around.map((each) => ({ type: each, attrs: null })),
    { type, attrs },
    ...inner.map((each) => ({ type: each, attrs: null })),
  ]
}

function findWrappingOutside(range: NodeRange, type: NodeType): readonly NodeType[] | null {
  const { parent, startIndex, endIndex } = range
  const around = parent.contentMatchAt(startIndex).findWrapping(type)
  if (!around) return null
  const outer = around.length ? (around[0] as NodeType) : type
  return parent.canReplaceWith(startIndex, endIndex, outer) ? around : null
}

function findWrappingInside(range: NodeRange, type: NodeType): readonly NodeType[] | null {
  const { parent, startIndex, endIndex } = range
  const inner = parent.child(startIndex)
  const inside = type.contentMatch.findWrapping(inner.type)
  if (!inside) return null
  const lastType = inside.length ? (inside[inside.length - 1] as NodeType) : type
  let innerMatch: ContentMatch | null = lastType.contentMatch
  for (let index = startIndex; innerMatch && index < endIndex; index += 1) {
    innerMatch = innerMatch.matchType(parent.child(index).type)
  }
  return innerMatch?.validEnd ? inside : null
}

export function canSplit(
  doc: Node,
  pos: number,
  depth = 1,
  typesAfter?: readonly (TypeAfter | null)[]
): boolean {
  const $pos = doc.resolve(pos)
  const base = $pos.depth - depth
  const innerType = typesAfter?.[typesAfter.length - 1] ?? $pos.parent
  if (
    base < 0 ||
    $pos.parent.type.spec.isolating ||
    !$pos.parent.canReplace($pos.index(), $pos.parent.childCount) ||
    !innerType.type.validContent(
      $pos.parent.content.cutByIndex($pos.index(), $pos.parent.childCount)
    )
  ) {
    return false
  }
  for (let at = $pos.depth - 1, index = depth - 2; at > base; at -= 1, index -= 1) {
    const node = $pos.node(at)
    const nodeIndex = $pos.index(at)
    if (node.type.spec.isolating) return false
    let rest = node.content.cutByIndex(nodeIndex, node.childCount)
    const overrideChild = typesAfter?.[index + 1]
    if (overrideChild) rest = rest.replaceChild(0, overrideChild.type.create(overrideChild.attrs))
    const after = typesAfter?.[index] ?? node
    if (!node.canReplace(nodeIndex + 1, node.childCount) || !after.type.validContent(rest))
      return false
  }
  const index = $pos.indexAfter(base)
  const baseType = typesAfter?.[0]
  return $pos
    .node(base)
    .canReplaceWith(index, index, baseType ? baseType.type : $pos.node(base + 1).type)
}

export function canJoin(doc: Node, pos: number): boolean {
  const $pos = doc.resolve(pos)
  const index = $pos.index()
  return joinable($pos.nodeBefore, $pos.nodeAfter) && $pos.parent.canReplace(index, index + 1)
}

function joinable(before: Node | null, after: Node | null): boolean {
  if (!before || !after || before.isLeaf) return false
  let match: ContentMatch | null = before.contentMatchAt(before.childCount)
  const linebreak = linebreakType(before.type)
  for (let index = 0; index < after.childCount; index += 1) {
    const child = after.child(index)
    const type = child.type === linebreak ? before.type.schema.text : child.type
    match = match.matchType(type)
    if (!match) return false
    if (!before.type.allowsMarks(child.marks)) return false
  }
  return match.validEnd
}

/** The nearest position at or around `pos` where two blocks can be joined. */
export function joinPoint(doc: Node, pos: number, dir = -1): number | undefined {
  const $pos = doc.resolve(pos)
  let at = pos
  for (let depth = $pos.depth; ; depth -= 1) {
    let before: Node | null
    let after: Node | null
    let index = $pos.index(depth)
    if (depth === $pos.depth) {
      before = $pos.nodeBefore
      after = $pos.nodeAfter
    } else if (dir > 0) {
      before = $pos.node(depth + 1)
      index += 1
      after = $pos.node(depth).maybeChild(index)
    } else {
      before = $pos.node(depth).maybeChild(index - 1)
      after = $pos.node(depth + 1)
    }
    if (
      before &&
      !before.isTextblock &&
      joinable(before, after) &&
      $pos.node(depth).canReplace(index, index + 1)
    ) {
      return at
    }
    if (depth === 0) break
    at = dir < 0 ? $pos.before(depth) : $pos.after(depth)
  }
  return undefined
}

/** Where a node of `type` can be inserted at or around `pos`, at its parent's edge. */
export function insertPoint(doc: Node, pos: number, type: NodeType): number | null {
  const $pos = doc.resolve(pos)
  if ($pos.parent.canReplaceWith($pos.index(), $pos.index(), type)) return pos
  if ($pos.parentOffset === 0) {
    for (let depth = $pos.depth - 1; depth >= 0; depth -= 1) {
      const index = $pos.index(depth)
      if ($pos.node(depth).canReplaceWith(index, index, type)) return $pos.before(depth + 1)
      if (index > 0) return null
    }
  }
  if ($pos.parentOffset === $pos.parent.content.size) {
    for (let depth = $pos.depth - 1; depth >= 0; depth -= 1) {
      const index = $pos.indexAfter(depth)
      if ($pos.node(depth).canReplaceWith(index, index, type)) return $pos.after(depth + 1)
      if (index < $pos.node(depth).childCount) return null
    }
  }
  return null
}

/** Where a dropped slice can go at or around `pos`. */
export function dropPoint(doc: Node, pos: number, slice: Slice): number | null {
  const $pos = doc.resolve(pos)
  if (!slice.content.size) return pos
  let content = slice.content
  for (let index = 0; index < slice.openStart; index += 1)
    content = (content.firstChild as Node).content
  for (let pass = 1; pass <= (slice.openStart === 0 && slice.size ? 2 : 1); pass += 1) {
    for (let depth = $pos.depth; depth >= 0; depth -= 1) {
      const bias =
        depth === $pos.depth
          ? 0
          : $pos.pos <= ($pos.start(depth + 1) + $pos.end(depth + 1)) / 2
            ? -1
            : 1
      const insertPos = $pos.index(depth) + (bias > 0 ? 1 : 0)
      const parent = $pos.node(depth)
      let fits = false
      if (pass === 1) {
        fits = parent.canReplace(insertPos, insertPos, content)
      } else {
        const wrapping = parent
          .contentMatchAt(insertPos)
          .findWrapping((content.firstChild as Node).type)
        fits = !!wrapping && parent.canReplaceWith(insertPos, insertPos, wrapping[0] as NodeType)
      }
      if (fits)
        return bias === 0 ? $pos.pos : bias < 0 ? $pos.before(depth + 1) : $pos.after(depth + 1)
    }
  }
  return null
}

// ── Fitting a slice where it goes ───────────────────────────────────────

/** A step replacing `from`–`to` with `slice`, fitted to stand there; null when it is no change. */
export function replaceStep(doc: Node, from: number, to = from, slice = Slice.empty): Step | null {
  if (from === to && !slice.size) return null
  const $from = doc.resolve(from)
  const $to = doc.resolve(to)
  if (fitsTrivially($from, $to, slice)) return new ReplaceStep(from, to, slice)
  return new Fitter($from, $to, slice).fit()
}

function fitsTrivially($from: ResolvedPos, $to: ResolvedPos, slice: Slice): boolean {
  return (
    !slice.openStart &&
    !slice.openEnd &&
    $from.start() === $to.start() &&
    $from.parent.canReplace($from.index(), $to.index(), slice.content)
  )
}

interface Fittable {
  readonly sliceDepth: number
  readonly frontierDepth: number
  readonly parent: Node | null
  readonly inject?: Fragment | null
  readonly wrap?: readonly NodeType[]
}

interface FrontierEntry {
  readonly type: NodeType
  match: ContentMatch
}

class Fitter {
  private readonly frontier: FrontierEntry[] = []
  private placed: Fragment = Fragment.empty

  constructor(
    private readonly $from: ResolvedPos,
    private readonly $to: ResolvedPos,
    private unplaced: Slice
  ) {
    for (let depth = 0; depth <= $from.depth; depth += 1) {
      const node = $from.node(depth)
      this.frontier.push({ type: node.type, match: node.contentMatchAt($from.indexAfter(depth)) })
    }
    for (let depth = $from.depth; depth > 0; depth -= 1)
      this.placed = Fragment.from($from.node(depth).copy(this.placed))
  }

  private get depth(): number {
    return this.frontier.length - 1
  }

  fit(): Step | null {
    while (this.unplaced.size) {
      const fit = this.findFittable()
      if (fit) this.placeNodes(fit)
      else if (!this.openMore()) this.dropNode()
    }
    const moveInline = this.mustMoveInline()
    const placedSize = this.placed.size - this.depth - this.$from.depth
    const $from = this.$from
    const $to = this.close(moveInline < 0 ? this.$to : $from.doc.resolve(moveInline))
    if (!$to) return null
    let content = this.placed
    let openStart = $from.depth
    let openEnd = $to.depth
    while (openStart && openEnd && content.childCount === 1) {
      content = (content.firstChild as Node).content
      openStart -= 1
      openEnd -= 1
    }
    const slice = new Slice(content, openStart, openEnd)
    if (moveInline > -1)
      return new ReplaceAroundStep(
        $from.pos,
        moveInline,
        this.$to.pos,
        this.$to.end(),
        slice,
        placedSize
      )
    if (slice.size || $from.pos !== this.$to.pos) return new ReplaceStep($from.pos, $to.pos, slice)
    return null
  }

  private findFittable(): Fittable | undefined {
    let startDepth = this.unplaced.openStart
    for (
      let cur = this.unplaced.content, depth = 0, openEnd = this.unplaced.openEnd;
      depth < startDepth;
      depth += 1
    ) {
      const node = cur.firstChild as Node
      if (cur.childCount > 1) openEnd = 0
      if (node.type.spec.isolating && openEnd <= depth) {
        startDepth = depth
        break
      }
      cur = node.content
    }
    for (let pass = 1; pass <= 2; pass += 1) {
      for (
        let sliceDepth = pass === 1 ? startDepth : this.unplaced.openStart;
        sliceDepth >= 0;
        sliceDepth -= 1
      ) {
        let fragment: Fragment
        let parent: Node | null = null
        if (sliceDepth) {
          parent = contentAt(this.unplaced.content, sliceDepth - 1).firstChild
          fragment = (parent as Node).content
        } else {
          fragment = this.unplaced.content
        }
        const first = fragment.firstChild
        for (let frontierDepth = this.depth; frontierDepth >= 0; frontierDepth -= 1) {
          const { type, match } = this.frontier[frontierDepth] as FrontierEntry
          if (pass === 1) {
            // Fits as it is, or after nodes filled in before it.
            const matched = first
              ? !!match.matchType(first.type)
              : !!parent && type.compatibleContent(parent.type)
            const inject = first && !matched ? match.fillBefore(Fragment.from(first), false) : null
            if (matched || inject) return { sliceDepth, frontierDepth, parent, inject }
          }
          if (pass === 2 && first) {
            const wrap = match.findWrapping(first.type)
            if (wrap) return { sliceDepth, frontierDepth, parent, wrap }
          }
          if (parent && match.matchType(parent.type)) break
        }
      }
    }
    return undefined
  }

  private openMore(): boolean {
    const { content, openStart, openEnd } = this.unplaced
    if (maxOpen(content, -1) <= openStart) return false
    const end = this.unplaced.size > 1 && maxOpen(content, 1) > openEnd ? openEnd + 1 : openEnd
    this.unplaced = new Slice(content, openStart + 1, end)
    return true
  }

  private dropNode(): void {
    const { content, openStart, openEnd } = this.unplaced
    const inner = contentAt(content, openStart)
    if (inner.childCount <= 1 && openStart > 0) {
      const openAtEnd = content.size - openStart <= openStart + inner.size
      this.unplaced = new Slice(
        dropFromFragment(content, openStart - 1, 1),
        openStart - 1,
        openAtEnd ? openStart - 1 : openEnd
      )
    } else {
      this.unplaced = new Slice(dropFromFragment(content, openStart, 1), openStart, openEnd)
    }
  }

  private placeNodes({ sliceDepth, frontierDepth, parent, inject, wrap }: Fittable): void {
    while (this.depth > frontierDepth) this.closeFrontierNode()
    if (wrap) for (const type of wrap) this.openFrontierNode(type)
    const slice = this.unplaced
    const fragment = parent ? parent.content : slice.content
    const openStart = slice.openStart - sliceDepth
    let taken = 0
    const add: Node[] = []
    let { match } = this.frontier[frontierDepth] as FrontierEntry
    const { type } = this.frontier[frontierDepth] as FrontierEntry
    if (inject) {
      for (let index = 0; index < inject.childCount; index += 1) add.push(inject.child(index))
      match = match.matchFragment(inject) as ContentMatch
    }
    let openEndCount = fragment.size + sliceDepth - (slice.content.size - slice.openEnd)
    while (taken < fragment.childCount) {
      const next = fragment.child(taken)
      const matches = match.matchType(next.type)
      if (!matches) break
      taken += 1
      if (taken > 1 || openStart === 0 || next.content.size) {
        match = matches
        add.push(
          closeNodeStart(
            next.mark(type.allowedMarks(next.marks)),
            taken === 1 ? openStart : 0,
            taken === fragment.childCount ? openEndCount : -1
          )
        )
      }
    }
    const toEnd = taken === fragment.childCount
    if (!toEnd) openEndCount = -1
    this.placed = addToFragment(this.placed, frontierDepth, Fragment.from(add))
    ;(this.frontier[frontierDepth] as FrontierEntry).match = match
    if (
      toEnd &&
      openEndCount < 0 &&
      parent &&
      parent.type === (this.frontier[this.depth] as FrontierEntry).type &&
      this.frontier.length > 1
    ) {
      this.closeFrontierNode()
    }
    for (
      let index = 0, cur: Node | null = add[add.length - 1] ?? null;
      cur && index < openEndCount;
      index += 1
    ) {
      this.frontier.push({ type: cur.type, match: cur.contentMatchAt(cur.childCount) })
      cur = cur.lastChild
    }
    this.unplaced = !toEnd
      ? new Slice(dropFromFragment(slice.content, sliceDepth, taken), sliceDepth, slice.openEnd)
      : sliceDepth === 0
        ? Slice.empty
        : new Slice(
            dropFromFragment(slice.content, sliceDepth - 1, 1),
            sliceDepth - 1,
            openEndCount < 0 ? slice.openEnd : sliceDepth - 1
          )
  }

  private mustMoveInline(): number {
    if (!this.$to.parent.isTextblock) return -1
    const top = this.frontier[this.depth] as FrontierEntry
    if (
      !top.type.isTextblock ||
      !contentAfterFits(this.$to, this.$to.depth, top.type, top.match, false)
    )
      return -1
    if (this.$to.depth === this.depth) {
      const level = this.findCloseLevel(this.$to)
      if (level && level.depth === this.depth) return -1
    }
    let { depth } = this.$to
    let after = this.$to.after(depth)
    while (depth > 1 && after === this.$to.end(--depth)) after += 1
    return after
  }

  private findCloseLevel(
    $to: ResolvedPos
  ): { depth: number; fit: Fragment; move: ResolvedPos } | undefined {
    scan: for (let index = Math.min(this.depth, $to.depth); index >= 0; index -= 1) {
      const { match, type } = this.frontier[index] as FrontierEntry
      const dropInner =
        index < $to.depth && $to.end(index + 1) === $to.pos + ($to.depth - (index + 1))
      const fit = contentAfterFits($to, index, type, match, dropInner)
      if (!fit) continue
      for (let depth = index - 1; depth >= 0; depth -= 1) {
        const entry = this.frontier[depth] as FrontierEntry
        const matches = contentAfterFits($to, depth, entry.type, entry.match, true)
        if (!matches || matches.childCount) continue scan
      }
      return { depth: index, fit, move: dropInner ? $to.doc.resolve($to.after(index + 1)) : $to }
    }
    return undefined
  }

  private close($to: ResolvedPos): ResolvedPos | null {
    const close = this.findCloseLevel($to)
    if (!close) return null
    while (this.depth > close.depth) this.closeFrontierNode()
    if (close.fit.childCount) this.placed = addToFragment(this.placed, close.depth, close.fit)
    const moved = close.move
    for (let depth = close.depth + 1; depth <= moved.depth; depth += 1) {
      const node = moved.node(depth)
      const add = node.type.contentMatch.fillBefore(
        node.content,
        true,
        moved.index(depth)
      ) as Fragment
      this.openFrontierNode(node.type, node.attrs, add)
    }
    return moved
  }

  private openFrontierNode(type: NodeType, attrs: Attrs | null = null, content?: Fragment): void {
    const top = this.frontier[this.depth] as FrontierEntry
    top.match = top.match.matchType(type) as ContentMatch
    this.placed = addToFragment(this.placed, this.depth, Fragment.from(type.create(attrs, content)))
    this.frontier.push({ type, match: type.contentMatch })
  }

  private closeFrontierNode(): void {
    const open = this.frontier.pop() as FrontierEntry
    const add = open.match.fillBefore(Fragment.empty, true) as Fragment
    if (add.childCount) this.placed = addToFragment(this.placed, this.frontier.length, add)
  }
}

function dropFromFragment(fragment: Fragment, depth: number, count: number): Fragment {
  if (depth === 0) return fragment.cutByIndex(count, fragment.childCount)
  const first = fragment.firstChild as Node
  return fragment.replaceChild(0, first.copy(dropFromFragment(first.content, depth - 1, count)))
}

function addToFragment(fragment: Fragment, depth: number, content: Fragment): Fragment {
  if (depth === 0) return fragment.append(content)
  const last = fragment.lastChild as Node
  return fragment.replaceChild(
    fragment.childCount - 1,
    last.copy(addToFragment(last.content, depth - 1, content))
  )
}

function contentAt(fragment: Fragment, depth: number): Fragment {
  let content = fragment
  for (let index = 0; index < depth; index += 1) content = (content.firstChild as Node).content
  return content
}

function closeNodeStart(node: Node, openStart: number, openEnd: number): Node {
  if (openStart <= 0) return node
  let fragment = node.content
  if (openStart > 1) {
    fragment = fragment.replaceChild(
      0,
      closeNodeStart(
        fragment.firstChild as Node,
        openStart - 1,
        fragment.childCount === 1 ? openEnd - 1 : 0
      )
    )
  }
  fragment = (node.type.contentMatch.fillBefore(fragment) as Fragment).append(fragment)
  if (openEnd <= 0) {
    fragment = fragment.append(
      (node.type.contentMatch.matchFragment(fragment) as ContentMatch).fillBefore(
        Fragment.empty,
        true
      ) as Fragment
    )
  }
  return node.copy(fragment)
}

function contentAfterFits(
  $to: ResolvedPos,
  depth: number,
  type: NodeType,
  match: ContentMatch,
  open: boolean
): Fragment | null {
  const node = $to.node(depth)
  const index = open ? $to.indexAfter(depth) : $to.index(depth)
  if (index === node.childCount && !type.compatibleContent(node.type)) return null
  const fit = match.fillBefore(node.content, true, index)
  if (!fit) return null
  for (let at = index; at < node.childCount; at += 1) {
    if (!type.allowsMarks(node.content.child(at).marks)) return null
  }
  return fit
}

function maxOpen(fragment: Fragment, side: -1 | 1): number {
  let content = fragment
  for (let count = 0; ; count += 1) {
    const child = side < 0 ? content.firstChild : content.lastChild
    if (!child || child.isAtom) return count
    content = child.content
  }
}

function replaceRange(tr: Transform, from: number, to: number, slice: Slice): void {
  if (!slice.size) {
    tr.deleteRange(from, to)
    return
  }
  const $from = tr.doc.resolve(from)
  const $to = tr.doc.resolve(to)
  if (fitsTrivially($from, $to, slice)) {
    tr.step(new ReplaceStep(from, to, slice))
    return
  }
  const targetDepths = coveredDepths($from, $to)
  if (targetDepths[targetDepths.length - 1] === 0) targetDepths.pop()
  let preferredTarget = -($from.depth + 1)
  targetDepths.unshift(preferredTarget)
  for (let depth = $from.depth, pos = $from.pos - 1; depth > 0; depth -= 1, pos -= 1) {
    const spec = $from.node(depth).type.spec
    if (spec.defining || spec.isolating) break
    if (targetDepths.includes(depth)) preferredTarget = depth
    else if ($from.before(depth) === pos) targetDepths.splice(1, 0, -depth)
  }
  const preferredTargetIndex = targetDepths.indexOf(preferredTarget)
  const leftNodes: Node[] = []
  let preferredDepth = slice.openStart
  for (let content = slice.content, index = 0; ; index += 1) {
    const node = content.firstChild as Node
    leftNodes.push(node)
    if (index === slice.openStart) break
    content = node.content
  }
  for (let depth = preferredDepth - 1; depth >= 0; depth -= 1) {
    const leftNode = leftNodes[depth] as Node
    const defining = !!leftNode.type.spec.defining
    if (defining && !leftNode.sameMarkup($from.node(Math.abs(preferredTarget) - 1)))
      preferredDepth = depth
    else if (defining || !leftNode.type.isTextblock) break
  }
  for (let open = slice.openStart; open >= 0; open -= 1) {
    const openDepth = (open + preferredDepth + 1) % (slice.openStart + 1)
    const insert = leftNodes[openDepth]
    if (!insert) continue
    for (let index = 0; index < targetDepths.length; index += 1) {
      let targetDepth = targetDepths[(index + preferredTargetIndex) % targetDepths.length] as number
      let expand = true
      if (targetDepth < 0) {
        expand = false
        targetDepth = -targetDepth
      }
      const parent = $from.node(targetDepth - 1)
      const at = $from.index(targetDepth - 1)
      if (parent.canReplaceWith(at, at, insert.type, insert.marks)) {
        tr.replace(
          $from.before(targetDepth),
          expand ? $to.after(targetDepth) : to,
          new Slice(
            closeFragment(slice.content, 0, slice.openStart, openDepth),
            openDepth,
            slice.openEnd
          )
        )
        return
      }
    }
  }
  const startSteps = tr.steps.length
  let start = from
  let end = to
  for (let index = targetDepths.length - 1; index >= 0; index -= 1) {
    tr.replace(start, end, slice)
    if (tr.steps.length > startSteps) break
    const depth = targetDepths[index] as number
    if (depth < 0) continue
    start = $from.before(depth)
    end = $to.after(depth)
  }
}

function closeFragment(
  fragment: Fragment,
  depth: number,
  oldOpen: number,
  newOpen: number,
  parent?: Node
): Fragment {
  let content = fragment
  if (depth < oldOpen) {
    const first = content.firstChild as Node
    content = content.replaceChild(
      0,
      first.copy(closeFragment(first.content, depth + 1, oldOpen, newOpen, first))
    )
  }
  if (depth > newOpen && parent) {
    const match = parent.contentMatchAt(0)
    const start = (match.fillBefore(content) as Fragment).append(content)
    content = start.append(
      (match.matchFragment(start) as ContentMatch).fillBefore(Fragment.empty, true) as Fragment
    )
  }
  return content
}

function deleteRange(tr: Transform, from: number, to: number): void {
  let $from = tr.doc.resolve(from)
  let $to = tr.doc.resolve(to)
  let start = from
  let end = to
  if (
    $from.parent.isTextblock &&
    $to.parent.isTextblock &&
    $from.start() !== $to.start() &&
    $from.parentOffset === 0 &&
    $to.parentOffset === 0
  ) {
    const shared = $from.sharedDepth(to)
    let isolated = false
    for (let depth = $from.depth; depth > shared; depth -= 1)
      if ($from.node(depth).type.spec.isolating) isolated = true
    for (let depth = $to.depth; depth > shared; depth -= 1)
      if ($to.node(depth).type.spec.isolating) isolated = true
    if (!isolated) {
      for (let depth = $from.depth; depth > 0 && start === $from.start(depth); depth -= 1)
        start = $from.before(depth)
      for (let depth = $to.depth; depth > 0 && end === $to.start(depth); depth -= 1)
        end = $to.before(depth)
      $from = tr.doc.resolve(start)
      $to = tr.doc.resolve(end)
    }
  }
  const covered = coveredDepths($from, $to)
  for (let index = 0; index < covered.length; index += 1) {
    const depth = covered[index] as number
    const last = index === covered.length - 1
    if ((last && depth === 0) || $from.node(depth).type.contentMatch.validEnd) {
      tr.delete($from.start(depth), $to.end(depth))
      return
    }
    if (
      depth > 0 &&
      (last || $from.node(depth - 1).canReplace($from.index(depth - 1), $to.indexAfter(depth - 1)))
    ) {
      tr.delete($from.before(depth), $to.after(depth))
      return
    }
  }
  for (let depth = 1; depth <= $from.depth && depth <= $to.depth; depth += 1) {
    if (
      start - $from.start(depth) === $from.depth - depth &&
      end > $from.end(depth) &&
      $to.end(depth) - end !== $to.depth - depth &&
      $from.start(depth - 1) === $to.start(depth - 1) &&
      $from.node(depth - 1).canReplace($from.index(depth - 1), $to.index(depth - 1))
    ) {
      tr.delete($from.before(depth), end)
      return
    }
  }
  tr.delete(start, end)
}

function coveredDepths($from: ResolvedPos, $to: ResolvedPos): number[] {
  const result: number[] = []
  const minDepth = Math.min($from.depth, $to.depth)
  for (let depth = minDepth; depth >= 0; depth -= 1) {
    const start = $from.start(depth)
    if (
      start < $from.pos - ($from.depth - depth) ||
      $to.end(depth) > $to.pos + ($to.depth - depth) ||
      $from.node(depth).type.spec.isolating ||
      $to.node(depth).type.spec.isolating
    ) {
      break
    }
    if (
      start === $to.start(depth) ||
      (depth === $from.depth &&
        depth === $to.depth &&
        $from.parent.inlineContent &&
        $to.parent.inlineContent &&
        depth &&
        $to.start(depth - 1) === start - 1)
    ) {
      result.push(depth)
    }
  }
  return result
}

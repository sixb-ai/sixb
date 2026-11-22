// What styles a clip of a scene, and how that look goes with it to another scene: the rules that
// style the element itself, in the order the page reads them, each rewritten to reach it alone by
// its id, one id more specific than it was so they keep their cascade among themselves and outrank
// the scene they land in, within the `@media` they were in, and the keyframes they animate by,
// renamed when that scene already has others of the same name. A scene's own rules never change, so
// the clips it already shows keep their look. What cannot be told from the stylesheets alone, a
// rule through a wrapper or the clip's place among its siblings, is not carried but said. Strings
// in, strings out: `edit.ts` reads and writes the files. Browser-safe, as `composition.ts`.

/** A rule or an at-rule of a stylesheet: what comes before its braces, and what they hold. */
export interface CssBlock {
  readonly prelude: string
  readonly body: string
}

/** An element, as a selector reads it. */
export interface LookElement {
  readonly tag: string
  readonly id?: string
  readonly classes: readonly string[]
  readonly attributes: ReadonlyMap<string, string>
}

/**
 * A stylesheet that reaches a scene, given in the order the page reads them: the sheets
 * `index.html` links, then its file's own `<style>`, then the look carried for the clip there.
 * `byId` keeps only the rules that name the element by its id, as a scene the clip is not from
 * styles it; `carried` is a look written by {@link writtenLook}, already one id more specific.
 */
export interface LookSheet {
  readonly blocks: readonly CssBlock[]
  readonly byId?: boolean
  readonly carried?: boolean
}

/** A rule of an element's look, as {@link writtenLook} writes it for another scene. */
export interface LookRule {
  /** Whether it was scoped to its scene, as it will be to the next. */
  readonly scoped: boolean
  /** Its tag, if it names one, and the rest of what it names the element by, its id aside. */
  readonly tag: string
  readonly rest: string
  /** What it styles inside the element, through it, as written: ` .hot`, ` > span`. */
  readonly tail: string
  /** How many times it names the element's id, which the rewritten rule names it as often. */
  readonly ids: number
  readonly body: string
  /** The `@media`, `@supports`, `@container` or `@layer` it was in, outermost first. */
  readonly within: readonly string[]
}

/**
 * An element's look: each rule that styles it itself, in cascade order, the keyframes they
 * animate by, and whether some rule may style it there that cannot be carried.
 */
export interface Look {
  readonly rules: readonly LookRule[]
  readonly keyframes: ReadonlyMap<string, string>
  readonly uncertain: boolean
}

/** The keyframes a scene reads by name: its own and its linked sheets', and the looks carried in. */
export interface SceneKeyframes {
  readonly own: ReadonlyMap<string, string>
  readonly carried: ReadonlyMap<string, readonly string[]>
}

/**
 * The top-level rules and at-rules of a stylesheet, comments aside: `@media` and its kind are
 * blocks of their own, which no rule of theirs is taken from.
 */
export function cssBlocks(css: string): CssBlock[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const blocks: CssBlock[] = []
  let at = 0
  while (at < text.length) {
    const open = text.indexOf("{", at)
    if (open < 0) break

    // What a statement before it ends, as `@import …;`, is not its prelude.
    const prelude = (text.slice(at, open).split(";").at(-1) ?? "").trim()
    let depth = 0
    let quote = ""
    let close = open
    for (; close < text.length; close += 1) {
      const char = text[close]
      if (quote) {
        if (char === "\\") close += 1
        else if (char === quote) quote = ""
      } else if (char === '"' || char === "'") quote = char
      else if (char === "{") depth += 1
      else if (char === "}" && --depth === 0) break
    }
    blocks.push({ prelude, body: text.slice(open + 1, close) })
    at = close + 1
  }
  return blocks
}

/** The keyframes a stylesheet defines, by name. */
export function keyframesOf(blocks: readonly CssBlock[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const block of blocks) {
    const name = KEYFRAMES.exec(block.prelude)?.[1]
    if (name && !found.has(name)) found.set(name, block.body)
  }
  return found
}

/**
 * The look an element has in `scene`: each rule of the sheets that reach it there whose selector
 * styles the element itself, by its tag, id, classes, attributes and states, `:is()` and `:not()`
 * read for it, within the scene or within no composition, in the order the page reads them, and
 * each inside the `@media` and its kind it was in. A rule that reaches it through a wrapper, or by
 * its place among its siblings, is not carried, and makes the look uncertain.
 */
export function lookOf(element: LookElement, scene: string, sheets: readonly LookSheet[]): Look {
  const rules: LookRule[] = []
  const keyframes = new Map<string, string>()
  const defined = new Map<string, string>()
  let uncertain = false
  for (const sheet of sheets) {
    for (const [name, body] of keyframesOf(sheet.blocks)) {
      if (!defined.has(name)) defined.set(name, body)
    }
  }

  const visit = (blocks: readonly CssBlock[], sheet: LookSheet, within: readonly string[]) => {
    for (const block of blocks) {
      if (GROUPING.test(block.prelude)) {
        visit(cssBlocks(block.body), sheet, [...within, block.prelude])
        continue
      }
      if (block.prelude.startsWith("@")) continue

      for (const selector of selectorsOf(block.prelude)) {
        const styled = stylesItself(selector, element, scene, sheet)
        if (styled === "uncertain") uncertain = true
        if (styled === undefined || styled === "uncertain") continue

        const rule = { ...styled, body: block.body, within }
        const same = (other: LookRule) =>
          cssKey(JSON.stringify(other)) === cssKey(JSON.stringify(rule))
        if (!rules.some(same)) rules.push(rule)
        for (const [name, frames] of defined) {
          if (animatesBy(block.body, name)) keyframes.set(name, frames)
        }
      }
    }
  }
  for (const sheet of sheets) visit(sheet.blocks, sheet, [])
  return { rules, keyframes, uncertain }
}

/**
 * A look written for an element landing in `scene` by its id: each rule as it was, naming the
 * element by its id once more, `[data-composition-id="<scene>"] p#<id>.caption`, so the rules keep
 * their cascade among themselves and outrank the scene's own; in the `@media` it was in; and the
 * keyframes it animates by. A name the scene reads already, with the same frames, is used as it
 * is; with others, the look's keyframes take a name of their own, so neither changes the other.
 */
export function writtenLook(look: Look, scene: string, id: string, seen: SceneKeyframes): string[] {
  const renamed = new Map<string, string>()
  const frames: string[] = []
  for (const [name, body] of look.keyframes) {
    const same = (other: string | undefined) =>
      other !== undefined && cssKey(other) === cssKey(body)
    const free = (candidate: string) => {
      const own = seen.own.get(candidate)
      const carried = seen.carried.get(candidate) ?? []
      return (own === undefined || same(own)) && carried.every((each) => same(each))
    }

    let chosen = name
    for (let n = 2; !free(chosen); n += 1) chosen = `${name}-${n}`
    if (chosen !== name) renamed.set(name, chosen)
    if (!same(seen.own.get(chosen))) frames.push(cssRule(`@keyframes ${chosen}`, body))
  }

  const rules = look.rules.map((rule) => {
    let body = rule.body
    for (const [from, to] of renamed) body = renameAnimation(body, from, to)
    const scope = rule.scoped ? `[data-composition-id="${scene}"] ` : ""
    const selector = `${scope}${rule.tag}${`#${id}`.repeat(rule.ids)}${rule.rest}${rule.tail}`
    return rule.within.reduceRight(
      (inner, prelude) => wrapped(prelude, inner),
      cssRule(selector, body)
    )
  })
  return [...rules, ...frames]
}

/** A rule inside an at-rule: on one line when the rule is, else indented under it. */
function wrapped(prelude: string, inner: string): string {
  if (!inner.includes("\n")) return `${prelude} { ${inner} }`
  return [`${prelude} {`, ...inner.split("\n").map((line) => `  ${line}`), "}"].join("\n")
}

/** Whether a scene's script names an element as a selector does: by its id or a class. */
export function scriptNames(scripts: string, element: LookElement): boolean {
  if (scripts.trim() === "") return false
  const byId =
    element.id !== undefined &&
    (inSelector(scripts, `#${element.id}`) ||
      new RegExp(`getElementById\\(\\s*["'\`]${escapeRegExp(element.id)}["'\`]`).test(scripts))
  return byId || element.classes.some((name) => inSelector(scripts, `.${name}`))
}

/**
 * Whether a scene's script reaches an element by what it is rather than by its id: one of its
 * classes, or its tag within the scene, `${scene} video`, as the Agent's timelines write it.
 */
export function scriptReaches(scripts: string, element: LookElement): boolean {
  if (scripts.trim() === "") return false
  const byTag = new RegExp(`[\\]}]\\s+${escapeRegExp(element.tag)}(?=["'\`\\s,.:\\[>)])`, "i")
  return byTag.test(scripts) || element.classes.some((name) => inSelector(scripts, `.${name}`))
}

/** A rule as a scene's file writes it: on one line when its body is, else one line each. */
export function cssRule(prelude: string, body: string): string {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length <= 1) return `${prelude} { ${lines[0] ?? ""} }`
  return [`${prelude} {`, ...lines.map((line) => `  ${line}`), "}"].join("\n")
}

const KEYFRAMES = /^@(?:-webkit-)?keyframes\s+([\w-]+)/i

/** Each composition a selector names by `[data-composition-id=…]`. */
const SCOPE = /^\[\s*data-composition-id\s*=\s*(["']?)([^"'\]\s]+)\1\s*\]$/

/** The at-rules whose rules apply under a condition, which a carried rule stays inside. */
const GROUPING = /^@(?:media|supports|container|layer)\b/i

/** States a clip may be in, which a rule keeps as it reaches it elsewhere. */
const STATES = new Set([
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "visited",
  "link",
  "any-link",
  "checked",
  "disabled",
  "enabled",
])

/**
 * How a selector styles an element in `scene`: its own compound, rewritten as {@link LookRule}
 * holds it, when every compound before it is the scene and the last names the element by what it
 * is; `"uncertain"` when it may style it in ways the stylesheet alone cannot tell, through a
 * wrapper or by its place among its siblings; undefined when it does not.
 */
function stylesItself(
  selector: string,
  element: LookElement,
  scene: string,
  sheet: LookSheet
): Omit<LookRule, "body" | "within"> | "uncertain" | undefined {
  const compounds = compoundsOf(selector)
  if (compounds.length === 0) return undefined

  // The scene it is scoped to, then the compound that would be the clip, then what it holds.
  let first = 0
  while (first < compounds.length - 1 && SCOPE.exec(compounds[first]?.compound ?? "")) first += 1
  const scopes = compounds.slice(0, first).map((each) => SCOPE.exec(each.compound)?.[2])
  if (scopes.some((each) => each !== scene)) return undefined
  const anchor = compounds[first]
  const after = compounds.slice(first + 1)
  if (!anchor) return undefined

  const parts = subjectParts(anchor.compound)
  const matched = parts ? matchCompound(parts, element) : "uncertain"
  if (matched === false || !parts) {
    // Not the clip: it may be one further on, through a wrapper the stylesheet cannot see.
    const last = compounds.at(-1)
    const lastParts = last && after.length > 0 ? subjectParts(last.compound) : undefined
    if (!parts) return "uncertain"
    return lastParts && matchCompound(lastParts, element) !== false ? "uncertain" : undefined
  }
  if (matched === "uncertain") return "uncertain"
  // What a rule styles beside the clip, its siblings, stays with the scene.
  if (after.some((each) => each.combinator !== " " && each.combinator !== ">")) return "uncertain"

  let names = false
  let ids = 0
  let tag = ""
  let rest = ""
  for (const part of parts) {
    if (part.startsWith("#")) {
      ids += 1
      names = true
    } else if (part.startsWith(".")) {
      if (sheet.byId) return undefined
      names = true
      rest += part
    } else if (/^[a-zA-Z]/.test(part)) {
      if (sheet.byId) return undefined
      names = true
      tag = part
    } else if (part !== "*") {
      // `:is()` and `:where()`, read for the element above, name it by what they hold.
      if (/^:(?:is|where)\(/i.test(part)) names = true
      rest += part
    }
  }
  if (!names) return undefined
  if (sheet.byId && ids === 0) return undefined

  // What it holds, styled through it, as written: `.caption .hot`, `.caption > span`.
  const tail = after
    .map((each) => `${each.combinator === " " ? " " : ` ${each.combinator} `}${each.compound}`)
    .join("")

  // One id more specific than it was, unless it is a carried look's, which is already.
  return { scoped: first > 0, tag, rest, tail, ids: sheet.carried ? ids : ids + 1 }
}

/** A compound's simple selectors, in order; undefined when it holds what is not one. */
function subjectParts(compound: string): string[] | undefined {
  const parts =
    compound.match(
      /::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?|\[[^\]]*\]|[#.](?:[\w-]|\\.)+|\*|[a-zA-Z][\w-]*/g
    ) ?? []
  return parts.join("") === compound ? parts : undefined
}

/**
 * Whether a compound's simple selectors match an element: `"uncertain"` when one of them depends
 * on what the element's attributes do not say, its place among its siblings or what it holds.
 */
function matchCompound(parts: readonly string[], element: LookElement): boolean | "uncertain" {
  let uncertain = false
  for (const part of parts) {
    if (part.startsWith("::")) continue
    if (part.startsWith(":")) {
      const name = /^:([\w-]+)/.exec(part)?.[1]?.toLowerCase() ?? ""
      const args = /\((.*)\)$/.exec(part)?.[1]
      if (STATES.has(name)) continue
      if ((name === "is" || name === "where" || name === "not") && args !== undefined) {
        const each = selectorsOf(args).map((arg) => {
          const inner = compoundsOf(arg).length === 1 ? subjectParts(arg.trim()) : undefined
          return inner ? matchCompound(inner, element) : "uncertain"
        })
        const any = each.includes(true)
        if (name === "not" ? any : !any && !each.includes("uncertain")) return false
        if (each.includes("uncertain") && !(name !== "not" && any)) uncertain = true
        continue
      }
      uncertain = true
    } else if (part.startsWith("#")) {
      if (unescaped(part.slice(1)) !== element.id) return false
    } else if (part.startsWith(".")) {
      if (!element.classes.includes(unescaped(part.slice(1)))) return false
    } else if (part.startsWith("[")) {
      const attribute = /^\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(["']?)([^"'\]]*)\3\s*)?\]$/.exec(part)
      const name = attribute?.[1]?.toLowerCase()
      if (!attribute || !name) {
        uncertain = true
        continue
      }
      const value = element.attributes.get(name)
      if (name === "data-composition-id" || value === undefined) return false
      if (attribute[2] && !attributeMatches(value, attribute[2], attribute[4] ?? "")) return false
    } else if (part !== "*" && part.toLowerCase() !== element.tag) {
      return false
    }
  }
  return uncertain ? "uncertain" : true
}

/** A selector's compounds, split at its combinators outside brackets and parentheses. */
function compoundsOf(
  selector: string
): { readonly combinator: string; readonly compound: string }[] {
  const compounds: { combinator: string; compound: string }[] = []
  let depth = 0
  let current = ""
  let combinator = ""
  const text = selector.trim()
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? ""
    if (char === "\\") {
      current += text.slice(at, at + 2)
      at += 1
      continue
    }
    if (char === "[" || char === "(") depth += 1
    if (char === "]" || char === ")") depth -= 1
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current)
        compounds.push({
          combinator: compounds.length === 0 ? "" : combinator || " ",
          compound: current,
        })
      if (current) combinator = ""
      current = ""
      if (char !== " " && !/\s/.test(char)) combinator = char
      continue
    }
    current += char
  }
  if (current)
    compounds.push({
      combinator: compounds.length === 0 ? "" : combinator || " ",
      compound: current,
    })
  return compounds
}

/** A selector list's selectors, split at its commas outside brackets, parentheses and quotes. */
function selectorsOf(prelude: string): string[] {
  const selectors: string[] = []
  let depth = 0
  let quote = ""
  let start = 0
  for (let at = 0; at < prelude.length; at += 1) {
    const char = prelude[at]
    if (quote) {
      if (char === quote) quote = ""
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth -= 1
    else if (char === "," && depth === 0) {
      selectors.push(prelude.slice(start, at).trim())
      start = at + 1
    }
  }
  selectors.push(prelude.slice(start).trim())
  return selectors.filter(Boolean)
}

/** Whether an attribute's value matches an attribute selector's `op` and `wanted`. */
function attributeMatches(value: string, op: string, wanted: string): boolean {
  switch (op) {
    case "~=":
      return value.split(/\s+/).includes(wanted)
    case "^=":
      return wanted !== "" && value.startsWith(wanted)
    case "$=":
      return wanted !== "" && value.endsWith(wanted)
    case "*=":
      return wanted !== "" && value.includes(wanted)
    case "|=":
      return value === wanted || value.startsWith(`${wanted}-`)
    default:
      return value === wanted
  }
}

/** An identifier as a selector escapes it, read: `md\\:big` is the class `md:big`. */
function unescaped(identifier: string): string {
  return identifier.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, escaped: string) =>
    /^[0-9a-fA-F]/.test(escaped) && escaped.trim().length > 1
      ? String.fromCodePoint(Number.parseInt(escaped.trim(), 16))
      : escaped.trim() || escaped
  )
}

/** Whether a rule's declarations animate by the keyframes `name`. */
function animatesBy(body: string, name: string): boolean {
  return new RegExp(
    `animation(?:-name)?\\s*:[^;}]*(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`
  ).test(body)
}

/** A rule's declarations, animating by `to` where they animated by `from`. */
function renameAnimation(body: string, from: string, to: string): string {
  return body.replace(/(animation(?:-name)?\s*:)([^;}]*)/g, (_, property, value: string) => {
    const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(from)}(?![\\w-])`, "g")
    return `${property}${value.replace(pattern, to)}`
  })
}

/** A token a script writes where a selector does, never as a property, as `demo.from(…)`. */
function inSelector(scripts: string, token: string): boolean {
  return new RegExp(`(?<![\\w$)\\]])${escapeRegExp(token)}(?![\\w-])`).test(scripts)
}

/** A rule's text, its spaces aside, to tell two alike. */
export function cssKey(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .replace(/;$/, "")
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// What styles a clip of a scene, and how that look goes with it to another scene: the rules that
// style the element itself, rewritten to reach it alone, by its id, in the scene it lands in, and
// the keyframes they animate by, renamed when that scene already has others of the same name. A
// scene's own rules never change, so the clips it already shows keep their look. Strings in,
// strings out: `edit.ts` reads and writes the files. Browser-safe, as `composition.ts`.

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
 * A stylesheet that reaches a scene: its file's own `<style>`, or a sheet `index.html` links, of
 * which only the rules scoped to the scene are its own; `byId` keeps the rules that name the
 * element by its id, as a scene the clip is not from styles it.
 */
export interface LookSheet {
  readonly blocks: readonly CssBlock[]
  readonly scopedOnly: boolean
  readonly byId?: boolean
}

/** An element's look: each rule that styles it itself, and the keyframes they animate by. */
export interface Look {
  /** Its pseudo-element, `::before`, or none, and its declarations. */
  readonly rules: readonly { readonly pseudo: string; readonly body: string }[]
  readonly keyframes: ReadonlyMap<string, string>
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
 * styles the element itself, by its tag, id, classes and attributes, within the scene or within no
 * composition. A rule that reaches it through a wrapper, its place among its siblings or a state
 * such as `:hover` stays with the scene, as the wrapper does.
 */
export function lookOf(element: LookElement, scene: string, sheets: readonly LookSheet[]): Look {
  const rules: { pseudo: string; body: string }[] = []
  const keyframes = new Map<string, string>()
  const defined = new Map<string, string>()
  for (const sheet of sheets) {
    for (const [name, body] of keyframesOf(sheet.blocks))
      if (!defined.has(name)) defined.set(name, body)
  }

  for (const sheet of sheets) {
    for (const block of sheet.blocks) {
      if (block.prelude.startsWith("@")) continue

      for (const selector of selectorsOf(block.prelude)) {
        const styled = stylesItself(selector, element, scene, sheet)
        if (styled === undefined) continue
        if (
          rules.some((rule) => rule.pseudo === styled && cssKey(rule.body) === cssKey(block.body))
        )
          continue
        rules.push({ pseudo: styled, body: block.body })

        for (const [name, frames] of defined) {
          if (animatesBy(block.body, name)) keyframes.set(name, frames)
        }
      }
    }
  }
  return { rules, keyframes }
}

/**
 * A look written for an element landing in `scene` by its id: each rule reaching it alone there,
 * `[data-composition-id="<scene>"] #<id>`, which no rule of the scene's own outranks, and the
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

  const target = `[data-composition-id="${scene}"] #${id}`
  const rules = look.rules.map((rule) => {
    let body = rule.body
    for (const [from, to] of renamed) body = renameAnimation(body, from, to)
    return cssRule(`${target}${rule.pseudo}`, body)
  })
  return [...rules, ...frames]
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

/**
 * The pseudo-element a selector styles an element by, `""` for none, when it styles the element
 * itself in `scene`: every compound before its last one, if any, is the scene; the last names the
 * element by what it is, and no state, place or relation. Undefined for any other selector.
 */
function stylesItself(
  selector: string,
  element: LookElement,
  scene: string,
  sheet: LookSheet
): string | undefined {
  const compounds = compoundsOf(selector)
  const subject = compounds.at(-1)
  if (!subject) return undefined

  const scopes = compounds.slice(0, -1)
  if (scopes.some((scope) => SCOPE.exec(scope)?.[2] !== scene)) return undefined
  if (sheet.scopedOnly && scopes.length === 0) return undefined

  const parts =
    subject.match(/::?[\w-]+(?:\([^)]*\))?|\[[^\]]*\]|[#.][\w-]+|\*|[a-zA-Z][\w-]*/g) ?? []
  if (parts.join("") !== subject) return undefined

  let pseudo = ""
  let names = false
  for (const part of parts) {
    if (part.startsWith("::")) pseudo = part
    else if (part.startsWith(":")) return undefined
    else if (part.startsWith("#")) {
      if (part.slice(1) !== element.id) return undefined
      names = true
    } else if (part.startsWith(".")) {
      if (!element.classes.includes(part.slice(1))) return undefined
      if (sheet.byId) return undefined
      names = true
    } else if (part.startsWith("[")) {
      const attribute = /^\[\s*([\w-]+)\s*(?:=\s*(["']?)([^"'\]]*)\2\s*)?\]$/.exec(part)
      const name = attribute?.[1]?.toLowerCase()
      if (!name || name === "data-composition-id" || !element.attributes.has(name)) return undefined
      if (attribute?.[3] !== undefined && element.attributes.get(name) !== attribute[3])
        return undefined
    } else if (part !== "*") {
      if (part.toLowerCase() !== element.tag || sheet.byId) return undefined
      names = true
    }
  }
  return names ? pseudo : undefined
}

/** A selector's compounds, split at its combinators outside brackets and parentheses. */
function compoundsOf(selector: string): string[] {
  const compounds: string[] = []
  let depth = 0
  let current = ""
  for (const char of selector.trim()) {
    if (char === "[" || char === "(") depth += 1
    if (char === "]" || char === ")") depth -= 1
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current) compounds.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current) compounds.push(current)
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

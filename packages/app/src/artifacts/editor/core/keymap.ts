// Keys as the editor binds them: `Mod-b`, `Shift-Enter`, `Alt-Shift-ArrowUp`, where Mod is ⌘ on a
// Mac and Ctrl elsewhere. A keymap is a list of bindings tried in order; the first that handles a
// key takes it.

import type { EditorView } from "./view"

export type KeyHandler = (view: EditorView, event: KeyboardEvent) => boolean
export type Keymap = Readonly<Record<string, KeyHandler>>

const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

/** Key names by key code, for when a modifier changes what `event.key` says. */
const BASE: Record<number, string> = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  27: "Escape",
  32: " ",
  33: "PageUp",
  34: "PageDown",
  35: "End",
  36: "Home",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  46: "Delete",
  59: ";",
  186: ";",
  187: "=",
  188: ",",
  189: "-",
  190: ".",
  191: "/",
  192: "`",
  219: "[",
  220: "\\",
  221: "]",
  222: "'",
}
for (let code = 0; code < 10; code += 1) BASE[48 + code] = String(code)
for (let code = 65; code <= 90; code += 1) BASE[code] = String.fromCharCode(code + 32)

/** The name of the key an event is for, with its modifiers: `Shift-Meta-b`. */
export function keyName(event: KeyboardEvent): string {
  // Chrome on a Mac names keys pressed with ⌘⇧ by what they would be without shift.
  const broken = mac && event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
  let name = (!broken && event.key) || BASE[event.keyCode] || event.key || "Unidentified"
  if (broken && name.length === 1) name = name.toUpperCase()
  return modifiers(name, event)
}

function modifiers(name: string, event: KeyboardEvent, shift = true): string {
  let result = name
  if (event.altKey) result = `Alt-${result}`
  if (event.ctrlKey) result = `Ctrl-${result}`
  if (event.metaKey) result = `Meta-${result}`
  if (shift && event.shiftKey) result = `Shift-${result}`
  return result
}

/** A binding's name in the form `keyName` gives: modifiers in one order, Mod resolved. */
export function normalizeKey(name: string): string {
  const parts = name.split(/-(?!$)/)
  let result = parts[parts.length - 1] as string
  if (result === "Space") result = " "
  let alt = false
  let ctrl = false
  let shift = false
  let meta = false
  for (const part of parts.slice(0, -1)) {
    if (/^(cmd|meta|m)$/i.test(part)) meta = true
    else if (/^a(lt)?$/i.test(part)) alt = true
    else if (/^(c|ctrl|control)$/i.test(part)) ctrl = true
    else if (/^s(hift)?$/i.test(part)) shift = true
    else if (/^mod$/i.test(part)) {
      if (mac) meta = true
      else ctrl = true
    } else throw new Error(`[SixbEditor] Unrecognized modifier name: ${part}`)
  }
  if (alt) result = `Alt-${result}`
  if (ctrl) result = `Ctrl-${result}`
  if (meta) result = `Meta-${result}`
  if (shift) result = `Shift-${result}`
  return result
}

/** A handler trying each keymap in order, as keys are pressed. */
export function keydownHandler(keymaps: readonly Keymap[]): KeyHandler {
  const normalized = keymaps.map((map) => {
    const result = new Map<string, KeyHandler>()
    for (const [name, handler] of Object.entries(map)) result.set(normalizeKey(name), handler)
    return result
  })
  return (view, event) => {
    const name = keyName(event)
    const bare = name.split("-").pop() as string
    for (const map of normalized) {
      const direct = map.get(name)
      if (direct?.(view, event)) return true
      if (bare.length === 1 && bare !== " ") {
        if (event.shiftKey) {
          const noShift = map.get(modifiers(bare, event, false))
          if (noShift?.(view, event)) return true
        }
        const base = BASE[event.keyCode]
        if ((event.altKey || event.metaKey || event.ctrlKey) && base && base !== bare) {
          const fromCode = map.get(modifiers(base, event))
          if (fromCode?.(view, event)) return true
        }
      }
    }
    return false
  }
}

export const isMac = mac

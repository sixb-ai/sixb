import type { KeyboardEvent } from "react"

/**
 * Arrow keys in a radio group made of buttons: the group is one tab stop (its checked radio, whose
 * `tabIndex` is 0), and the arrows move between its radios. With `select`, moving also chooses, as
 * a native radio group does; without it, as in a menu that closes on a choice, Enter or Space
 * chooses the radio in focus.
 */
export function moveRadioFocus(
  event: KeyboardEvent<HTMLElement>,
  options: { readonly select?: boolean } = {}
): void {
  const step =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0
  if (step === 0) return

  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")]
  if (radios.length === 0) return
  event.preventDefault()

  const current = radios.indexOf(document.activeElement as HTMLElement)
  const next = radios[(current + step + radios.length) % radios.length]
  next?.focus()
  if (options.select) next?.click()
}

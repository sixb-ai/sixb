const CTRL_C = "\u0003"
const CTRL_D = "\u0004"
const BACKSPACE = "\u007f"
const PASTE_START = "\u001b[200~"
const PASTE_END = "\u001b[201~"
/** Keys such as the arrows, which are not part of a value. */
const ESCAPE_SEQUENCE = /^\u001b\[[0-9;]*[A-Za-z~]/
/** A long value still shows that something arrived, without filling the screen. */
const MOST_DOTS = 40

export interface HiddenInput {
  readonly value: string
  /** The start of a paste that hasn't finished arriving. */
  readonly pending: string
  /** `refused`: lines arrived that this terminal didn't mark as one paste. */
  readonly outcome?: "done" | "cancelled" | "refused"
}

/**
 * Applies what the terminal sent. A terminal that supports it marks a paste, so a multi-line value
 * stays whole. Without the marks, a newline with more behind it is refused: keeping only the first
 * line would store a broken value, and "Set" would still print.
 */
export function readHiddenKeys(input: HiddenInput, text: string): HiddenInput {
  let { value } = input
  let rest = input.pending + text

  while (rest.length > 0) {
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END)
      if (end === -1) return { value, pending: rest }
      value += rest.slice(PASTE_START.length, end).replace(/\r\n?/g, "\n").replace(/\n$/, "")
      rest = rest.slice(end + PASTE_END.length)
      continue
    }

    const sequence = ESCAPE_SEQUENCE.exec(rest)
    if (sequence) {
      rest = rest.slice(sequence[0].length)
      continue
    }

    const character = String.fromCodePoint(rest.codePointAt(0) ?? 0)
    rest = rest.slice(character.length)

    if (character === CTRL_C) return { value, pending: "", outcome: "cancelled" }
    if (character === CTRL_D) return { value, pending: "", outcome: "done" }
    if (character === "\r" || character === "\n") {
      const outcome = rest.trim() === "" ? "done" : "refused"
      return { value, pending: "", outcome }
    }
    if (character === BACKSPACE) value = [...value].slice(0, -1).join("")
    else if (character >= " ") value += character
  }
  return { value, pending: "" }
}

/**
 * Reads a value from a terminal without showing it. It never joins the scrollback or the shell's
 * history.
 */
export function promptHidden(label: string): Promise<string> {
  const { stdin, stderr } = process

  return new Promise((resolve, reject) => {
    let input: HiddenInput = { value: "", pending: "" }
    let dots = 0

    const onData = (chunk: Buffer) => {
      input = readHiddenKeys(input, chunk.toString("utf8"))

      const shown = Math.min([...input.value].length, MOST_DOTS)
      stderr.write(shown > dots ? "•".repeat(shown - dots) : "\b \b".repeat(dots - shown))
      dots = shown

      if (input.outcome === undefined) return
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      stderr.write("\u001b[?2004l\n")

      if (input.outcome === "done") resolve(input.value)
      else if (input.outcome === "refused") {
        reject(new Error("[SixbEnv] A value with several lines has to come from standard input."))
      } else {
        void import("../ui/live/prompt").then(({ PromptCancelledError }) =>
          reject(new PromptCancelledError())
        )
      }
    }

    stderr.write(`${label} \u001b[?2004h`)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
  })
}

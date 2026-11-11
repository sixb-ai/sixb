/**
 * The bot was here.
 *
 * A receipt an agent prints after it has touched this repository: a box, a few lines of context,
 * and a seal computed from the subject line. Nothing imports it and nothing depends on it, which
 * is the point: this is a pull request whose only job is to prove that pull requests can be
 * opened, done with a straight face.
 *
 *   bun scripts/bot-handshake.ts "opened a pull request" branch=test vibe=composed
 *
 * Read the seal off the receipt, recompute it with `seal(subject)`, and the bot is accountable
 * for what it claims. That is not cryptography. It is a handshake.
 */

export type HandshakeField = readonly [label: string, value: string]

const TITLE = "THE BOT WAS HERE"
const SUBTITLE = "a receipt, not a recommendation"
const FOOTER = "Verified by no one. Trusted by both of us."
const PAD = "  "
const RULE = "─"

const encoder = new TextEncoder()

/** FNV-1a over UTF-8 bytes: small, stable, and short enough to fit on a receipt. */
export function seal(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of encoder.encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * Draw the receipt. `null` in the layout means "draw a horizontal rule here", so the width of the
 * box is decided once, after every line is known.
 */
export function handshake(subject: string, fields: readonly HandshakeField[] = []): string {
  const rows: HandshakeField[] = [["subject", subject], ...fields]
  const labelWidth = rows.reduce((width, [label]) => Math.max(width, label.length), 0)
  const format = (label: string, value: string) =>
    `${PAD}${label.padEnd(labelWidth)}${PAD}${value}`

  const layout: (string | null)[] = [
    "",
    `${PAD}${TITLE}`,
    `${PAD}${SUBTITLE}`,
    "",
    null,
    ...rows.map(([label, value]) => format(label, value)),
    format("seal", seal(subject)),
    null,
    `${PAD}${FOOTER}`,
    "",
  ]

  // Every line keeps a trailing gap, so the text never touches its own frame.
  const width = layout.reduce((widest, line) => Math.max(widest, line?.length ?? 0), 0) + PAD.length
  const rule = `├${RULE.repeat(width)}┤`
  const body = layout.map((line) => (line === null ? rule : `│${line.padEnd(width)}│`))

  return [`┌${RULE.repeat(width)}┐`, ...body, `└${RULE.repeat(width)}┘`].join("\n")
}

if (import.meta.main) {
  const [subject = "was here", ...pairs] = Bun.argv.slice(2)
  const fields = pairs.map((pair): HandshakeField => {
    const separator = pair.indexOf("=")
    if (separator < 1) {
      throw new Error(`[Sixb] expected label=value, got "${pair}"`)
    }
    return [pair.slice(0, separator), pair.slice(separator + 1)]
  })

  console.log(handshake(subject, fields))
}

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
const MODULUS = 2 ** 32
const SEAL_LENGTH = 8

const encoder = new TextEncoder()

/** djb2 over the subject's UTF-8 bytes: small, stable, and short enough to fit on a receipt. */
export function seal(text: string): string {
  let hash = 5381
  for (const byte of encoder.encode(text)) {
    hash = (hash * 33 + byte) % MODULUS
  }
  return hash.toString(16).padStart(SEAL_LENGTH, "0")
}

function row(label: string, value: string, labelWidth: number): string {
  return `${PAD}${label.padEnd(labelWidth)}${PAD}${value}`
}

/**
 * Draw the receipt. `null` in the layout means "draw a horizontal rule here", so the width of the
 * box is decided once, after every line is known.
 */
export function handshake(subject: string, fields: readonly HandshakeField[] = []): string {
  const rows: HandshakeField[] = [["subject", subject], ...fields]
  const labelWidth = rows.reduce((width, [label]) => Math.max(width, label.length), 0)

  const layout: (string | null)[] = [
    "",
    `${PAD}${TITLE}`,
    `${PAD}${SUBTITLE}`,
    "",
    null,
    ...rows.map(([label, value]) => row(label, value, labelWidth)),
    row("seal", seal(subject), labelWidth),
    null,
    `${PAD}${FOOTER}`,
    "",
  ]

  // Every line keeps a trailing gap, so the text never touches its own frame.
  const contentWidth = layout.reduce((widest, line) => Math.max(widest, line?.length ?? 0), 0)
  const width = contentWidth + PAD.length
  const rule = `├${RULE.repeat(width)}┤`

  function draw(line: string | null): string {
    if (line === null) {
      return rule
    }
    return `│${line.padEnd(width)}│`
  }

  const body = layout.map(draw)
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

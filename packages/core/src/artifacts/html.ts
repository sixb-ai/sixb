const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(0xa0),
}

/**
 * Text or an attribute as the browser reads it. HTMLRewriter hands both over as written in the
 * HTML, entities included, so `artifact:…#Q3%20&amp;%20Q4` must read `&` before it is resolved.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()] ?? match
    const codePoint =
      entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1))
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match
  })
}

/** Quotes a value as one POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** A shell command that writes `content` to `path`, whatever bytes it holds. */
export function writeFileCommand(path: string, content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64")
  return `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`
}

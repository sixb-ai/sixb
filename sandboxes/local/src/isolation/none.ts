/**
 * Build the argv for the none isolation backend: passthrough, no wrapper.
 */
export function buildNoneArgv(input: {
  readonly command: string
  readonly args: readonly string[]
}): readonly string[] {
  return [input.command, ...input.args]
}

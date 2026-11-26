// Commands typed in the composer: `/model`, `/new`. A message that names one runs it instead of
// reaching the agent.

/** A command typed in the composer, as `/model`. */
export interface SlashCommand {
  readonly name: string
  readonly description: string
  run(): void
}

/** The commands a composer's text starts to name: all of them for a lone `/`. */
export function slashMatches(
  commands: readonly SlashCommand[],
  text: string
): readonly SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return []
  const typed = text.slice(1).toLowerCase()
  return commands.filter((command) => command.name.startsWith(typed))
}

/**
 * The command a message runs when it is sent: the one chosen in the menu its text opens, the first
 * when none was. Undefined for anything else, which is sent to the agent.
 */
export function pickSlash(
  commands: readonly SlashCommand[],
  text: string,
  chosen = 0
): SlashCommand | undefined {
  const matches = slashMatches(commands, text.trim())
  return matches[Math.min(chosen, matches.length - 1)]
}

import { cn } from "@sixb/ui/lib/utils"
import { AGENT_APPROVAL_MODES, type AgentApprovalMode } from "../approvals"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import { hasTiers } from "../model-selection"
import type { LanguageModel } from "../types"
import { ComposerKey } from "./composer-add-menu"
import {
  COMPOSER_MENU_ROW_CLASS_NAME,
  COMPOSER_MENU_ROW_SELECTED_CLASS_NAME,
} from "./composer-menu"

/** A slash command: typed as the whole message, `/name`, and run with Enter. */
export interface ComposerCommand {
  /** What follows the slash, lowercase and without spaces: `opus` for `/opus`. */
  readonly name: string
  /** What it does, as the list shows it. */
  readonly label: string
  readonly run: () => void
}

/** The command being typed, without its slash; `null` unless the message is one slash word. */
export function commandQuery(value: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(value)
  return match ? (match[1] ?? "").toLowerCase() : null
}

/** The commands a query names or describes, those whose name starts with it first. */
export function matchCommands(
  commands: readonly ComposerCommand[],
  query: string
): readonly ComposerCommand[] {
  const named = commands.filter((command) => command.name.startsWith(query))
  const rest = commands.filter(
    (command) =>
      !named.includes(command) &&
      (command.name.includes(query) || command.label.toLowerCase().includes(query))
  )
  return [...named, ...rest]
}

/** The permission modes by the word a command uses for each. */
const MODE_COMMANDS: Readonly<Record<AgentApprovalMode, string>> = {
  manual: "ask",
  "accept-edits": "edits",
  auto: "full",
}

/**
 * The commands the composer offers on its own: `/auto` with tiers, one per model, and one per
 * permission mode. Each exists only when the composer can make that change.
 */
export function builtInCommands({
  models,
  onSelectModel,
  onResetModelSelection,
  onApprovalModeChange,
  messages,
}: {
  readonly models: readonly LanguageModel[]
  readonly onSelectModel?: (model: LanguageModel) => void
  readonly onResetModelSelection?: () => void
  readonly onApprovalModeChange?: (mode: AgentApprovalMode) => void
  readonly messages: AgentMessages["commands"]
}): ComposerCommand[] {
  const commands: ComposerCommand[] = []
  if (onResetModelSelection && hasTiers(models)) {
    commands.push({ name: "auto", label: messages.auto, run: onResetModelSelection })
  }
  if (onSelectModel) {
    for (const model of models) {
      commands.push({
        name: commandName(model.name),
        label: messages.model(model.name),
        run: () => onSelectModel(model),
      })
    }
  }
  if (onApprovalModeChange) {
    for (const mode of AGENT_APPROVAL_MODES) {
      commands.push({
        name: MODE_COMMANDS[mode],
        label: messages.modes[mode],
        run: () => onApprovalModeChange(mode),
      })
    }
  }
  return commands
}

/** `Claude Opus 5.5` → `claude-opus-5-5`. */
function commandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export interface ComposerCommandListProps {
  readonly open: boolean
  readonly query: string
  readonly commands: readonly ComposerCommand[]
  readonly activeIndex: number
  readonly onActiveIndexChange: (index: number) => void
  readonly onRun: (command: ComposerCommand) => void
}

/** The commands matching what is typed, over the composer; Enter runs the highlighted one. */
export function ComposerCommandList({
  open,
  query,
  commands,
  activeIndex,
  onActiveIndexChange,
  onRun,
}: ComposerCommandListProps) {
  const messages = useAgentMessages().commands
  if (!open) return null

  return (
    <div
      role="listbox"
      aria-label={messages.list}
      className="sixb-composer-glass absolute bottom-[calc(100%+0.625rem)] left-0 z-20 flex w-[21.25rem] max-w-full flex-col gap-px rounded-[20px] p-1.5"
    >
      {commands.slice(0, 6).map((command, index) => {
        const active = index === activeIndex
        const at = command.name.indexOf(query)
        return (
          <button
            key={`${command.name}:${index}`}
            type="button"
            role="option"
            aria-selected={active}
            onPointerEnter={() => onActiveIndexChange(index)}
            // Keep the focus in the message while choosing.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onRun(command)}
            className={cn(
              COMPOSER_MENU_ROW_CLASS_NAME,
              active && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
            )}
          >
            <span className="min-w-[62px] shrink-0 font-mono text-[12.5px] text-foreground">
              /
              {query && at >= 0 ? (
                <>
                  {command.name.slice(0, at)}
                  <mark className="rounded-[3px] bg-black/[0.08] text-inherit dark:bg-white/[0.14]">
                    {command.name.slice(at, at + query.length)}
                  </mark>
                  {command.name.slice(at + query.length)}
                </>
              ) : (
                command.name
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/75">{command.label}</span>
            {active ? <ComposerKey>↩</ComposerKey> : null}
          </button>
        )
      })}
    </div>
  )
}

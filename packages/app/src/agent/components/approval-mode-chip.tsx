import { cn } from "@sixb/ui/lib/utils"
import { Hand, type LucideIcon, PencilLine, Zap } from "lucide-react"
import { useId, useState } from "react"
import { AGENT_APPROVAL_MODES, type AgentApprovalMode } from "../approvals"
import { useAgentMessages } from "../i18n"
import { moveRadioFocus } from "../utils/radio-group"
import {
  COMPOSER_MENU_ROW_CLASS_NAME,
  COMPOSER_TRIGGER_CLASS_NAME,
  ComposerMenu,
  ComposerMenuCheck,
  ComposerMenuRowText,
} from "./composer-menu"

export const APPROVAL_MODE_ICONS: Readonly<Record<AgentApprovalMode, LucideIcon>> = {
  manual: Hand,
  "accept-edits": PencilLine,
  auto: Zap,
}

export interface ApprovalModeChipProps {
  readonly mode: AgentApprovalMode
  /** A choice the composer's owner keeps, here and for the reader's next conversations. */
  readonly onChange: (mode: AgentApprovalMode) => void
  readonly disabled?: boolean
}

/**
 * What the agent may change without asking: a quiet control in the composer's toolbar, beside
 * `+`. It always names the mode, in muted text like the controls around it. A phone opens a sheet.
 */
export function ApprovalModeChip({ mode, onChange, disabled }: ApprovalModeChipProps) {
  const messages = useAgentMessages().approvalModes
  const [open, setOpen] = useState(false)
  const Icon = APPROVAL_MODE_ICONS[mode]
  const label = messages.modes[mode].label

  const choose = (next: AgentApprovalMode) => {
    setOpen(false)
    if (next !== mode) onChange(next)
  }

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label={messages.chip(label)}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={messages.shortcut}
      data-approval-mode={mode}
      className={cn(COMPOSER_TRIGGER_CLASS_NAME, "shrink-0")}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <ComposerMenu
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      title={messages.title}
      align="start"
    >
      <ApprovalModeMenu mode={mode} onChoose={choose} />
    </ComposerMenu>
  )
}

function ApprovalModeMenu({
  mode,
  onChoose,
}: {
  readonly mode: AgentApprovalMode
  readonly onChoose: (mode: AgentApprovalMode) => void
}) {
  const messages = useAgentMessages().approvalModes
  const groupId = useId()

  return (
    <div className="p-1.5">
      <div
        role="radiogroup"
        aria-label={messages.title}
        onKeyDown={(event) => moveRadioFocus(event)}
      >
        {AGENT_APPROVAL_MODES.map((option) => {
          const selected = option === mode
          const descriptionId = `${groupId}-${option}`
          const Icon = APPROVAL_MODE_ICONS[option]
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              aria-describedby={descriptionId}
              onClick={() => onChoose(option)}
              className={cn(COMPOSER_MENU_ROW_CLASS_NAME, "items-start")}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <ComposerMenuRowText
                title={messages.modes[option].label}
                description={messages.modes[option].description}
                descriptionId={descriptionId}
                selected={selected}
              />
              <span className="mt-0.5">
                <ComposerMenuCheck checked={selected} />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

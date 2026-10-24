import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { Check, ChevronDown, type LucideIcon, PencilLine, ShieldCheck, Zap } from "lucide-react"
import { useId, useState } from "react"
import { AGENT_APPROVAL_MODES, type AgentApprovalMode } from "../approvals"
import { useAgentMessages } from "../i18n"

export const APPROVAL_MODE_ICONS: Readonly<Record<AgentApprovalMode, LucideIcon>> = {
  manual: ShieldCheck,
  "accept-edits": PencilLine,
  auto: Zap,
}

export interface ApprovalModeChipProps {
  readonly mode: AgentApprovalMode
  /** The reader's mode for new conversations, which the menu offers to change. */
  readonly defaultMode?: AgentApprovalMode
  readonly onChange: (mode: AgentApprovalMode) => void
  readonly onMakeDefault?: (mode: AgentApprovalMode) => void
  readonly disabled?: boolean
}

/**
 * What the agent may change without asking, in the composer: a pill that names the mode, and a
 * menu of the three with what each does. A phone shows the icon alone and opens a bottom sheet.
 */
export function ApprovalModeChip({
  mode,
  defaultMode,
  onChange,
  onMakeDefault,
  disabled,
}: ApprovalModeChipProps) {
  const messages = useAgentMessages().approvalModes
  const mobile = useIsMobile()
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
      aria-keyshortcuts="Shift+Tab"
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`${label} · ${messages.shortcut}`}
      data-approval-mode={mode}
      onClick={mobile ? () => setOpen(true) : undefined}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none transition-colors",
        "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-default disabled:opacity-60 max-sm:w-9 max-sm:justify-center max-sm:px-0",
        open && "bg-muted text-foreground",
        mode === "auto" &&
          "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="max-sm:hidden">{label}</span>
      <ChevronDown className="size-3.5 shrink-0 opacity-60 max-sm:hidden" aria-hidden="true" />
    </button>
  )

  const menu = (
    <ApprovalModeMenu
      mode={mode}
      defaultMode={defaultMode}
      onChoose={choose}
      onMakeDefault={
        onMakeDefault
          ? (next) => {
              setOpen(false)
              onMakeDefault(next)
            }
          : undefined
      }
    />
  )

  if (mobile) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[85dvh]">
            <div className="px-4 pt-3 pb-1">
              <DrawerTitle className="text-base">{messages.title}</DrawerTitle>
              <DrawerDescription className="sr-only">{messages.shortcut}</DrawerDescription>
            </div>
            <div className="pb-[max(0.75rem,env(safe-area-inset-bottom))]">{menu}</div>
          </DrawerContent>
        </Drawer>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={10}
        collisionPadding={8}
        aria-label={messages.title}
        className="w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl p-0 shadow-xl shadow-black/10"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <p className="text-xs font-medium text-muted-foreground">{messages.title}</p>
          <span className="shrink-0 text-[11px] text-muted-foreground/80" title={messages.shortcut}>
            <Kbd className="h-[18px] text-[10px]">⇧ Tab</Kbd>
          </span>
        </div>
        {menu}
      </PopoverContent>
    </Popover>
  )
}

function ApprovalModeMenu({
  mode,
  defaultMode,
  onChoose,
  onMakeDefault,
}: {
  readonly mode: AgentApprovalMode
  readonly defaultMode?: AgentApprovalMode
  readonly onChoose: (mode: AgentApprovalMode) => void
  readonly onMakeDefault?: (mode: AgentApprovalMode) => void
}) {
  const messages = useAgentMessages().approvalModes
  const groupId = useId()

  return (
    <>
      <div role="radiogroup" aria-label={messages.title} className="space-y-0.5 p-1.5">
        {AGENT_APPROVAL_MODES.map((option) => {
          const Icon = APPROVAL_MODE_ICONS[option]
          const selected = option === mode
          const descriptionId = `${groupId}-${option}`
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={descriptionId}
              onClick={() => onChoose(option)}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors",
                "hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30",
                selected && "bg-muted/70"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground",
                  option === "auto" && "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {messages.modes[option].label}
                </span>
                <span
                  id={descriptionId}
                  className="mt-0.5 block text-xs leading-snug text-muted-foreground"
                >
                  {messages.modes[option].description}
                </span>
              </span>
              <Check
                className={cn("mt-1.5 size-4 shrink-0 text-foreground", !selected && "invisible")}
                aria-hidden="true"
              />
            </button>
          )
        })}
      </div>
      {onMakeDefault ? (
        <div className="flex min-h-10 items-center border-t border-border/60 px-4 py-1.5 text-xs">
          {defaultMode === mode ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Check className="size-3.5" aria-hidden="true" />
              {messages.isDefault}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onMakeDefault(mode)}
              className="-ml-2 rounded-md px-2 py-1 font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {messages.makeDefault}
            </button>
          )}
        </div>
      ) : null}
    </>
  )
}

import { LANGUAGE_MODEL_TIERS, type ModelReasoningLevel } from "@sixb/core/models"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronDown, Search } from "lucide-react"
import { Fragment, useEffect, useId, useMemo, useState } from "react"
import { AGENT_APPROVAL_MODES, type AgentApprovalMode } from "../approvals"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import { defaultLanguageModel, hasTiers, sameModel } from "../model-selection"
import type { LanguageModel } from "../types"
import { moveRadioFocus } from "../utils/radio-group"
import { APPROVAL_MODE_ICONS } from "./approval-mode-icons"
import {
  COMPOSER_MENU_ROW_CLASS_NAME,
  COMPOSER_MENU_ROW_SELECTED_CLASS_NAME,
  COMPOSER_MENU_SECTION_CLASS_NAME,
  ComposerMenu,
  ComposerMenuDivider,
  ComposerMenuHeader,
  ComposerMenuRowText,
  ComposerMenuScroll,
} from "./composer-menu"
import { ModelPickerRow } from "./model-picker-row"
import { ProviderLogo } from "./provider-logo"
import { ReasoningEffortSlider } from "./reasoning-effort-slider"

/** The same names as the `Composer` props they come from, so a composer can pass them through. */
export interface ComposerSettingsProps {
  readonly models?: readonly LanguageModel[]
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: ModelReasoningLevel
  readonly modelsLoading?: boolean
  readonly modelsError?: boolean
  /** With `onSelectReasoning`, the model section shows. */
  readonly onSelectModel?: (model: LanguageModel) => void
  readonly onSelectReasoning?: (reasoning: ModelReasoningLevel) => void
  /** Back to the selected model's default thinking. */
  readonly onResetReasoning?: () => void
  /** The selection follows the project defaults: nothing was chosen explicitly. */
  readonly usingDefaultModel?: boolean
  /** Follow the project defaults again. With tiers, this is Auto, shown when no model is pinned. */
  readonly onResetModelSelection?: () => void
  /** With tiers: a decision model picks each message's model on Auto. */
  readonly modelRouting?: boolean
  /** With `onApprovalModeChange`, the permissions section shows. */
  readonly approvalMode?: AgentApprovalMode
  readonly onApprovalModeChange?: (mode: AgentApprovalMode) => void
  /** Keeps the model as it is, as while an answer is under way. The permissions stay open. */
  readonly disabled?: boolean
}

/**
 * How the agent works on the next message, as one quiet chip that names it: "Auto", or the pinned
 * model with its provider's mark, then the permissions' icon unless the agent has full access. Its
 * menu holds the model, with the chosen model's thinking under it, and the permissions.
 */
export function ComposerSettings(props: ComposerSettingsProps) {
  const {
    models = [],
    selectedModel,
    selectedReasoning,
    modelsLoading,
    modelsError,
    onSelectModel,
    onSelectReasoning,
    usingDefaultModel,
    onResetModelSelection,
    approvalMode,
    onApprovalModeChange,
    disabled,
  } = props
  const agentMessages = useAgentMessages()
  const [open, setOpen] = useState(false)
  const choosesModel = onSelectModel !== undefined && onSelectReasoning !== undefined
  const choosesMode = approvalMode !== undefined && onApprovalModeChange !== undefined
  if (!choosesModel && !choosesMode) return null

  const auto = choosesModel && autoModels(models, onResetModelSelection) && !selectedModel
  const modeLabel = approvalMode ? agentMessages.approvalModes.modes[approvalMode].label : undefined
  const ModeIcon = approvalMode ? APPROVAL_MODE_ICONS[approvalMode] : undefined
  const name = !choosesModel
    ? modeLabel
    : auto
      ? agentMessages.models.auto
      : (selectedModel?.name ??
        (modelsError ? agentMessages.models.unavailable : agentMessages.models.defaultModel))
  const level = auto
    ? undefined
    : reasoningLabel(selectedModel, selectedReasoning, agentMessages.reasoning)
  const summary = [name, level, choosesModel ? modeLabel : undefined].filter(Boolean)
  const tooltip = summary.join(" · ")

  return (
    <ComposerMenu
      open={open}
      onOpenChange={setOpen}
      title={agentMessages.settings.title}
      align="end"
      trigger={
        <button
          type="button"
          disabled={!choosesMode && (disabled || modelsLoading || models.length === 0)}
          aria-label={agentMessages.settings.chip(summary.join(", "))}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={
            choosesModel && !auto && usingDefaultModel
              ? agentMessages.models.defaultSummary(tooltip)
              : tooltip
          }
          data-approval-mode={approvalMode}
          className="group/settings mb-0.5 flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-full pr-[9px] pl-[11px] text-[13.5px] font-medium text-foreground/80 outline-none transition-colors hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-60 aria-expanded:bg-black/[0.05] dark:hover:bg-white/[0.08] dark:aria-expanded:bg-white/[0.08]"
        >
          {choosesModel && !auto && selectedModel ? (
            <ProviderLogo model={selectedModel} className="size-3.5" />
          ) : null}
          {!choosesModel && ModeIcon ? (
            <ModeIcon className="size-[15px] shrink-0" strokeWidth={1.9} aria-hidden="true" />
          ) : null}
          <span className="max-w-[11rem] truncate max-sm:max-w-[7rem]">{name}</span>
          {choosesModel && choosesMode && approvalMode !== "auto" && ModeIcon ? (
            <>
              <span aria-hidden="true" className="mx-px h-[13px] w-px bg-current opacity-20" />
              <ModeIcon className="size-[15px] shrink-0" strokeWidth={1.9} aria-hidden="true" />
            </>
          ) : null}
          <ChevronDown
            className="-ml-px size-3 shrink-0 text-muted-foreground transition-transform group-aria-expanded/settings:rotate-180"
            strokeWidth={2.6}
            aria-hidden="true"
          />
        </button>
      }
    >
      {choosesModel && models.length > 0 ? (
        <ModelSection {...props} models={models} onClose={() => setOpen(false)} />
      ) : null}
      {choosesMode ? (
        <PermissionsSection
          mode={approvalMode}
          onChange={onApprovalModeChange}
          divided={choosesModel && models.length > 0}
        />
      ) : null}
    </ComposerMenu>
  )
}

/** Tiers with a way back to Auto: the list opens on Auto, and choosing a model pins it. */
function autoModels(models: readonly LanguageModel[], onResetModelSelection?: () => void) {
  return hasTiers(models) && onResetModelSelection !== undefined
}

interface ModelEntry {
  readonly model: LanguageModel
  /** Named at the end of the first model of each tier. */
  readonly tier?: { readonly id: string; readonly label: string }
  /** The label naming this model's tier, on its tier's first row. */
  readonly describedBy?: string
  /** A hairline above: this model starts a tier. */
  readonly divided: boolean
}

function ModelSection({
  models,
  selectedModel,
  selectedReasoning,
  usingDefaultModel = false,
  onSelectModel,
  onSelectReasoning,
  onResetReasoning,
  onResetModelSelection,
  modelRouting = false,
  disabled,
  onClose,
}: ComposerSettingsProps & {
  readonly models: readonly LanguageModel[]
  readonly onClose: () => void
}) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.models
  const groupId = useId()
  const [query, setQuery] = useState("")
  const auto = autoModels(models, onResetModelSelection)
  const defaultModel = defaultLanguageModel(models)
  const standard = auto ? defaultModel : undefined
  const autoDescription =
    modelRouting || !standard ? messages.autoRouting : messages.autoStandard(standard.name)
  const normalizedQuery = query.trim().toLowerCase()
  const listId = `${groupId}-list`

  // A long list opens on the chosen model, with its thinking in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the menu opens
  useEffect(() => {
    document
      .getElementById(listId)
      ?.querySelector("[aria-checked=true]")
      ?.closest("[data-model-choice]")
      ?.scrollIntoView({ block: "nearest" })
  }, [])

  const entries = useMemo((): ModelEntry[] => {
    const matching = normalizedQuery
      ? models.filter((model) =>
          [model.name, model.publisher.name, model.modelId, model.via].some((value) =>
            value?.toLowerCase().includes(normalizedQuery)
          )
        )
      : models
    if (!auto) return matching.map((model) => ({ model, divided: false }))
    return LANGUAGE_MODEL_TIERS.flatMap((tier, tierIndex) =>
      matching
        .filter((model) => model.tier === tier)
        .map((model, index) => {
          const id = `${groupId}-${tier}`
          return {
            model,
            ...(index === 0
              ? { tier: { id, label: agentMessages.delegation.tiers[tier] } }
              : { describedBy: id }),
            divided: index === 0 && tierIndex > 0,
          }
        })
    ).map((entry, index) => (index === 0 ? { ...entry, divided: false } : entry))
  }, [agentMessages.delegation.tiers, auto, groupId, models, normalizedQuery])

  // Without tiers, the default model's row follows the project default instead of pinning it.
  const choose = (model: LanguageModel) => {
    if (
      !auto &&
      onResetModelSelection &&
      !usingDefaultModel &&
      defaultModel &&
      sameModel(model, defaultModel)
    ) {
      onResetModelSelection()
    } else {
      onSelectModel?.(model)
    }
  }

  const chooseAuto = () => {
    onClose()
    onResetModelSelection?.()
  }

  return (
    <>
      <ComposerMenuHeader>{messages.title}</ComposerMenuHeader>
      {/* A short catalog is a list to scan; a long one is searched. */}
      {models.length > 10 ? (
        <div className="mx-2.5 mb-1 flex h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-black/[0.08] text-muted-foreground focus-within:border-foreground/30 dark:border-white/[0.1]">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={messages.search}
            aria-label={messages.search}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : null}
      {/* Only radios belong to the radio group: each describes itself with its tier's label. */}
      <ComposerMenuScroll
        id={listId}
        role="radiogroup"
        aria-label={messages.title}
        onKeyDown={(event) => moveRadioFocus(event)}
        // Short enough beside the permissions for the menu to fit under a composer in the middle
        // of the page; a long list scrolls, fading out where it continues.
        className="flex-1 overscroll-contain pb-1.5 md:max-h-[max(15rem,min(22rem,calc(100dvh-36rem)))]"
      >
        {auto ? (
          <>
            <AutoRow
              selected={!selectedModel}
              description={autoDescription}
              disabled={disabled}
              onChoose={chooseAuto}
            />
            <ComposerMenuDivider strong />
          </>
        ) : null}
        {entries.map((entry) => {
          const selected = sameModel(entry.model, selectedModel)
          return (
            <Fragment key={`${entry.model.provider}:${entry.model.modelId}`}>
              {entry.divided ? <ComposerMenuDivider /> : null}
              <div
                data-model-choice=""
                className={cn("rounded-xl", selected && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME)}
              >
                <ModelPickerRow
                  model={entry.model}
                  selected={selected}
                  disabled={disabled}
                  radio
                  tier={entry.tier}
                  describedBy={entry.describedBy}
                  note={
                    !auto && defaultModel && sameModel(entry.model, defaultModel)
                      ? messages.default
                      : undefined
                  }
                  onSelect={choose}
                />
                {selected && selectedModel && selectedReasoning && onSelectReasoning ? (
                  <div className="pr-3 pb-2.5 pl-[39px]">
                    <ReasoningEffortSlider
                      model={selectedModel}
                      value={selectedReasoning}
                      disabled={disabled}
                      onChange={onSelectReasoning}
                      onReset={onResetReasoning}
                    />
                  </div>
                ) : null}
              </div>
            </Fragment>
          )
        })}
        {entries.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">{messages.empty}</p>
        ) : null}
      </ComposerMenuScroll>
    </>
  )
}

function AutoRow({
  selected,
  description,
  disabled,
  onChoose,
}: {
  readonly selected: boolean
  readonly description: string
  readonly disabled?: boolean
  readonly onChoose: () => void
}) {
  const messages = useAgentMessages().models
  const descriptionId = useId()
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      aria-describedby={descriptionId}
      disabled={disabled}
      onClick={onChoose}
      className={cn(
        COMPOSER_MENU_ROW_CLASS_NAME,
        "items-start",
        selected && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
      )}
    >
      {/* Solid, as the provider marks under it are. */}
      <span className="mt-px flex size-[18px] shrink-0 items-center justify-center text-foreground">
        <AutoMark />
      </span>
      <ComposerMenuRowText
        title={messages.auto}
        description={description}
        descriptionId={descriptionId}
      />
    </button>
  )
}

/** Auto's mark: a four-pointed star with narrow waists, filled as the provider marks are. */
function AutoMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  )
}

/** What the agent may do without asking: three choices side by side, the chosen one explained. */
function PermissionsSection({
  mode,
  onChange,
  divided,
}: {
  readonly mode: AgentApprovalMode
  readonly onChange: (mode: AgentApprovalMode) => void
  /** A hairline above, under the model section. */
  readonly divided: boolean
}) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.approvalModes
  const descriptionId = useId()

  return (
    <div
      className={cn(COMPOSER_MENU_SECTION_CLASS_NAME, "-mx-1.5 -mb-1.5", !divided && "border-t-0")}
    >
      <div className="text-xs text-muted-foreground">{agentMessages.settings.permissions}</div>
      <div
        role="radiogroup"
        aria-label={messages.title}
        aria-describedby={descriptionId}
        title={messages.shortcut}
        onKeyDown={(event) => moveRadioFocus(event, { select: true })}
        className="mt-2 grid grid-cols-3 gap-0.5 rounded-[14px] bg-black/[0.055] p-[3px] dark:bg-white/[0.08]"
      >
        {AGENT_APPROVAL_MODES.map((option) => {
          const selected = option === mode
          const Icon = APPROVAL_MODE_ICONS[option]
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!selected) onChange(option)
              }}
              className={cn(
                "flex h-14 min-w-0 flex-col items-center justify-center gap-[5px] rounded-[11px] px-1 text-xs text-foreground/75 outline-none transition-[background-color,box-shadow] duration-150 hover:bg-white/50 focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-white/[0.06]",
                selected &&
                  "bg-background font-medium text-foreground shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_2px_8px_-2px_rgb(0_0_0/0.16)] hover:bg-background dark:bg-white/[0.14] dark:hover:bg-white/[0.14]"
              )}
            >
              <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
              <span className="max-w-full truncate">{messages.modes[option].label}</span>
            </button>
          )
        })}
      </div>
      <p id={descriptionId} className="px-0.5 pt-2.5 text-xs leading-4 text-muted-foreground">
        {messages.modes[mode].description}
      </p>
    </div>
  )
}

/** The chip's thinking level, in its tooltip: an explicit one the model offers a choice of. */
function reasoningLabel(
  model: LanguageModel | undefined,
  reasoning: ModelReasoningLevel | undefined,
  messages: AgentMessages["reasoning"]
): string | undefined {
  if (!model || model.reasoningLevels.length <= 1 || !reasoning) return undefined
  if (reasoning === "none" || reasoning === "provider-default") return undefined
  return messages.levels[reasoning]
}

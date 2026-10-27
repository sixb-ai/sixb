import { LANGUAGE_MODEL_TIERS, type ModelReasoningLevel } from "@sixb/core/models"
import { cn } from "@sixb/ui/lib/utils"
import { Sparkles } from "lucide-react"
import { useId, useState } from "react"
import { useAgentMessages } from "../i18n"
import { defaultLanguageModel } from "../model-selection"
import type { LanguageModel } from "../types"
import { moveRadioFocus } from "../utils/radio-group"
import {
  COMPOSER_MENU_ROW_CLASS_NAME,
  COMPOSER_MENU_ROW_SELECTED_CLASS_NAME,
  COMPOSER_MENU_SECTION_CLASS_NAME,
  ComposerMenu,
  ComposerMenuCheck,
  ComposerMenuDivider,
  ComposerMenuHeader,
  ComposerMenuRowText,
  ComposerMenuScroll,
} from "./composer-menu"
import { ModelTrigger, reasoningLabel, sameModel } from "./model-controls"
import { ModelPickerRow } from "./model-picker-row"
import { ProviderLogo } from "./provider-logo"
import { ReasoningEffortSlider } from "./reasoning-effort-slider"

export interface AutoModelChipProps {
  readonly models: readonly LanguageModel[]
  /** The model pinned in this conversation; without one, Auto. */
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: ModelReasoningLevel
  /** A decision model picks each message's model on Auto; without one, Auto runs `standard`. */
  readonly routing?: boolean
  readonly disabled?: boolean
  readonly onSelectModel: (model: LanguageModel) => void
  readonly onSelectReasoning: (reasoning: ModelReasoningLevel) => void
  readonly onResetReasoning?: () => void
  /** Forget the conversation's pin, including one whose model left the catalog. */
  readonly onChooseAuto: () => void
}

/**
 * The model choice when `models.language` uses tiers, beside the send button: "Auto" until a
 * model is pinned, then that model. The menu lists Auto, which is also the way back, then each
 * tier's models; a pinned model's thinking shows under them.
 */
export function AutoModelChip({
  models,
  selectedModel,
  selectedReasoning,
  routing = false,
  disabled,
  onSelectModel,
  onSelectReasoning,
  onResetReasoning,
  onChooseAuto,
}: AutoModelChipProps) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.models
  const [open, setOpen] = useState(false)
  const name = selectedModel?.name ?? messages.auto
  const level = reasoningLabel(selectedModel, selectedReasoning, agentMessages.reasoning)
  const standard = defaultLanguageModel(models)
  const autoDescription =
    routing || !standard ? messages.autoRouting : messages.autoStandard(standard.name)

  const chooseAuto = () => {
    setOpen(false)
    onChooseAuto()
  }

  return (
    <ComposerMenu
      open={open}
      onOpenChange={setOpen}
      title={messages.title}
      align="end"
      trigger={
        <ModelTrigger
          icon={
            selectedModel ? (
              <ProviderLogo model={selectedModel} className="size-4" />
            ) : (
              <Sparkles className="size-4 shrink-0" aria-hidden="true" />
            )
          }
          name={name}
          level={level}
          open={open}
          disabled={disabled || models.length === 0}
          aria-label={messages.chip(level ? `${name} ${level}` : name)}
          aria-haspopup="dialog"
          title={selectedModel ? name : autoDescription}
        />
      }
    >
      <AutoModelMenu
        models={models}
        selectedModel={selectedModel}
        selectedReasoning={selectedReasoning}
        autoDescription={autoDescription}
        disabled={disabled}
        onChooseAuto={chooseAuto}
        onSelectModel={onSelectModel}
        onSelectReasoning={onSelectReasoning}
        onResetReasoning={onResetReasoning}
      />
    </ComposerMenu>
  )
}

function AutoModelMenu({
  models,
  selectedModel,
  selectedReasoning,
  autoDescription,
  disabled,
  onChooseAuto,
  onSelectModel,
  onSelectReasoning,
  onResetReasoning,
}: Omit<AutoModelChipProps, "routing"> & { readonly autoDescription: string }) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.models
  const groupId = useId()
  const autoDescriptionId = `${groupId}-auto`
  const auto = selectedModel === undefined
  const tiers = LANGUAGE_MODEL_TIERS.map((tier) => ({
    tier,
    models: models.filter((model) => model.tier === tier),
  })).filter((group) => group.models.length > 0)
  const headed = tiers.some((group) => group.models.length > 1)

  return (
    <>
      {/* Only radios belong to a radio group: each describes itself with its tier's label. */}
      <ComposerMenuScroll
        role="radiogroup"
        aria-label={messages.title}
        onKeyDown={(event) => moveRadioFocus(event)}
        className="flex-1 overscroll-contain p-1.5"
      >
        <button
          type="button"
          role="radio"
          aria-checked={auto}
          tabIndex={auto ? 0 : -1}
          aria-describedby={autoDescriptionId}
          disabled={disabled}
          onClick={onChooseAuto}
          className={cn(
            COMPOSER_MENU_ROW_CLASS_NAME,
            "items-start",
            auto && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
          )}
        >
          <Sparkles className="mt-0.5 size-[18px] shrink-0 text-foreground" aria-hidden="true" />
          <ComposerMenuRowText
            title={messages.auto}
            description={autoDescription}
            descriptionId={autoDescriptionId}
            selected={auto}
          />
          <span className="mt-0.5">
            <ComposerMenuCheck checked={auto} />
          </span>
        </button>
        <ComposerMenuDivider />
        {headed
          ? tiers.map((group) => (
              <div key={group.tier}>
                <div id={`${groupId}-${group.tier}`}>
                  <ComposerMenuHeader>
                    {agentMessages.delegation.tiers[group.tier]}
                  </ComposerMenuHeader>
                </div>
                {group.models.map((model) => (
                  <ModelPickerRow
                    key={`${model.provider}:${model.modelId}`}
                    model={model}
                    selected={sameModel(model, selectedModel)}
                    disabled={disabled}
                    radio
                    describedBy={`${groupId}-${group.tier}`}
                    onSelect={onSelectModel}
                  />
                ))}
              </div>
            ))
          : // One model a tier: the tier reads after the name, not as a heading over each.
            tiers.map((group) =>
              group.models.map((model) => (
                <ModelPickerRow
                  key={`${model.provider}:${model.modelId}`}
                  model={model}
                  selected={sameModel(model, selectedModel)}
                  disabled={disabled}
                  radio
                  tier={{
                    id: `${groupId}-${group.tier}`,
                    label: agentMessages.delegation.tiers[group.tier],
                  }}
                  onSelect={onSelectModel}
                />
              ))
            )}
      </ComposerMenuScroll>
      {selectedModel && selectedReasoning ? (
        <div className={COMPOSER_MENU_SECTION_CLASS_NAME}>
          <ReasoningEffortSlider
            model={selectedModel}
            value={selectedReasoning}
            disabled={disabled}
            onChange={onSelectReasoning}
            onReset={onResetReasoning}
          />
        </div>
      ) : null}
    </>
  )
}

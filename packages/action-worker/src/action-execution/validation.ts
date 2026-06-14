import type { ActionDefinition, ActionRunRecord } from "@sixb/core"
import { ActionValidationError, isObjectActionDefinition } from "@sixb/core"
import { type BasePhaseContext, requireObjectTarget } from "./context"
import type { LoadedObjectTarget, RuntimePhaseHandler } from "./types"

export async function runValidators(input: {
  readonly action: ActionDefinition
  readonly run: ActionRunRecord
  readonly baseContext: BasePhaseContext
  readonly objectTarget: LoadedObjectTarget | null
}): Promise<void> {
  const validators = input.action.phases.validate as readonly RuntimePhaseHandler[]
  if (validators.length === 0) {
    return
  }

  if (!isObjectActionDefinition(input.action)) {
    for (const validator of validators) {
      const result = await validator(input.baseContext)
      if (isValidatorErrorResult(result)) {
        throw new ActionValidationError(result.error, {
          actionId: input.action.id,
          subject: input.run.subject,
        })
      }
    }
    return
  }

  const target = requireObjectTarget(input.objectTarget, input.action.id)
  for (const validator of validators) {
    const result = await validator({
      ...input.baseContext,
      target: target.snapshot,
    })
    if (isValidatorErrorResult(result)) {
      throw new ActionValidationError(result.error, {
        actionId: input.action.id,
        subject: input.run.subject,
      })
    }
  }
}

function isValidatorErrorResult(value: unknown): value is { readonly error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  )
}

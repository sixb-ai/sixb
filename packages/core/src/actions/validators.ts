import { ActionValidationError } from "../objects/action/errors"
import type { ActionDefinition, ActionSubject, ActionTargetObject } from "./types"
import { isObjectActionDefinition } from "./validation"

type RuntimePhaseHandler = (ctx: unknown) => unknown | Promise<unknown>

export async function runActionValidators<TBaseContext extends object>(input: {
  readonly action: ActionDefinition
  readonly subject: ActionSubject
  readonly baseContext: TBaseContext
  readonly target?: ActionTargetObject | null
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
          subject: input.subject,
        })
      }
    }
    return
  }

  if (!input.target) {
    throw new Error(`[Sixb] Action '${input.action.id}' requires an object target.`)
  }

  for (const validator of validators) {
    const result = await validator({
      ...input.baseContext,
      target: input.target,
    })
    if (isValidatorErrorResult(result)) {
      throw new ActionValidationError(result.error, {
        actionId: input.action.id,
        subject: input.subject,
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

import { SixbError } from "../../errors"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import { effectsWithoutEditsMessage } from "../errors"
import type {
  ActionBuilder,
  ActionEditsHandler,
  ActionEffectsHandler,
  ActionParamsConfig,
  ActionValidator,
  ActionWritebackHandler,
  GlobalActionDefinition,
  GlobalActionEditsHandler,
  GlobalActionEffectsHandler,
  GlobalActionPhaseBuilder,
  GlobalActionValidator,
  GlobalActionWritebackHandler,
  ObjectActionDefinition,
  ObjectActionPhaseBuilder,
} from "../types"
import { assertNonEmpty } from "../validation"

type ActionOptions = {
  description?: string
}

export function defineAction<const TId extends string>(
  id: TId,
  options?: ActionOptions
): ActionBuilder<TId> {
  assertNonEmpty(id, "id")

  return asPublicActionType<ActionBuilder<TId>>(createActionBuilder(id, options))
}

function createActionBuilder(id: string, options?: ActionOptions) {
  const builder = {
    params(params: ActionParamsConfig) {
      return createGlobalActionPhaseBuilder(id, params, options)
    },
    on(objectType: ObjectTypeWithPropertyTokens) {
      assertNonEmpty(objectType.id, "target id")
      return createObjectActionParamsBuilder(id, objectType, options)
    },
  }

  return builder
}

function createGlobalActionPhaseBuilder(
  id: string,
  params: ActionParamsConfig,
  options?: ActionOptions
): GlobalActionPhaseBuilder<string, ActionParamsConfig> {
  const validators: GlobalActionValidator<Record<string, unknown>>[] = []

  const builder = {
    validate(validator: GlobalActionValidator<Record<string, unknown>>) {
      validators.push(validator)
      return builder
    },
    writeback(handler: GlobalActionWritebackHandler<Record<string, unknown>, unknown>) {
      return createGlobalDefinition({
        id,
        params,
        description: options?.description,
        validators,
        writeback: handler,
      })
    },
    edits(handler: GlobalActionEditsHandler<Record<string, unknown>, undefined>) {
      return createGlobalDefinition({
        id,
        params,
        description: options?.description,
        validators,
        edits: handler,
      })
    },
  }

  return asPublicActionType<GlobalActionPhaseBuilder<string, ActionParamsConfig>>(builder)
}

function createObjectActionParamsBuilder(
  id: string,
  objectType: ObjectTypeWithPropertyTokens,
  options?: ActionOptions
) {
  return {
    params(params: ActionParamsConfig) {
      return createObjectActionPhaseBuilder(id, objectType, params, options)
    },
  }
}

function createObjectActionPhaseBuilder(
  id: string,
  objectType: ObjectTypeWithPropertyTokens,
  params: ActionParamsConfig,
  options?: ActionOptions
): ObjectActionPhaseBuilder<string, ObjectTypeWithPropertyTokens, ActionParamsConfig> {
  const validators: ActionValidator<ObjectTypeWithPropertyTokens, Record<string, unknown>>[] = []

  const builder = {
    validate(validator: ActionValidator<ObjectTypeWithPropertyTokens, Record<string, unknown>>) {
      validators.push(validator)
      return builder
    },
    writeback(
      handler: ActionWritebackHandler<
        ObjectTypeWithPropertyTokens,
        Record<string, unknown>,
        unknown
      >
    ) {
      return createObjectDefinition({
        id,
        objectType,
        params,
        description: options?.description,
        validators,
        writeback: handler,
      })
    },
    edits(
      handler: ActionEditsHandler<ObjectTypeWithPropertyTokens, Record<string, unknown>, undefined>
    ) {
      return createObjectDefinition({
        id,
        objectType,
        params,
        description: options?.description,
        validators,
        edits: handler,
      })
    },
  }

  return asPublicActionType<
    ObjectActionPhaseBuilder<string, ObjectTypeWithPropertyTokens, ActionParamsConfig>
  >(builder)
}

function createGlobalDefinition(input: {
  readonly id: string
  readonly params: ActionParamsConfig
  readonly description?: string
  readonly validators: readonly unknown[]
  readonly writeback?: unknown
  readonly edits?: unknown
  readonly effects?: unknown
}): GlobalActionDefinition {
  const definition = {
    kind: "action",
    id: input.id,
    binding: { kind: "global" },
    params: input.params,
    phases: {
      validate: [...input.validators],
      ...(input.writeback ? { writeback: input.writeback } : {}),
      ...(input.edits ? { edits: input.edits } : {}),
      ...(input.effects ? { effects: input.effects } : {}),
    },
    ...(input.description !== undefined ? { description: input.description } : {}),
  }

  return asPublicActionType<GlobalActionDefinition>(
    Object.assign(definition, {
      edits(handler: GlobalActionEditsHandler<Record<string, unknown>, unknown>) {
        return createGlobalDefinition({
          ...input,
          edits: handler,
        })
      },
      effects(handler: GlobalActionEffectsHandler<Record<string, unknown>, unknown>) {
        if (!input.edits) {
          throw new SixbError("runtime.invalid_definition", effectsWithoutEditsMessage(input.id))
        }
        return createGlobalDefinition({
          ...input,
          effects: handler,
        })
      },
    })
  )
}

function createObjectDefinition(input: {
  readonly id: string
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly params: ActionParamsConfig
  readonly description?: string
  readonly validators: readonly unknown[]
  readonly writeback?: unknown
  readonly edits?: unknown
  readonly effects?: unknown
}): ObjectActionDefinition {
  const definition = {
    kind: "action",
    id: input.id,
    binding: { kind: "object", objectType: input.objectType },
    params: input.params,
    phases: {
      validate: [...input.validators],
      ...(input.writeback ? { writeback: input.writeback } : {}),
      ...(input.edits ? { edits: input.edits } : {}),
      ...(input.effects ? { effects: input.effects } : {}),
    },
    ...(input.description !== undefined ? { description: input.description } : {}),
  }

  return asPublicActionType<ObjectActionDefinition>(
    Object.assign(definition, {
      edits(
        handler: ActionEditsHandler<ObjectTypeWithPropertyTokens, Record<string, unknown>, unknown>
      ) {
        return createObjectDefinition({
          ...input,
          edits: handler,
        })
      },
      effects(
        handler: ActionEffectsHandler<
          ObjectTypeWithPropertyTokens,
          Record<string, unknown>,
          unknown
        >
      ) {
        if (!input.edits) {
          throw new SixbError("runtime.invalid_definition", effectsWithoutEditsMessage(input.id))
        }
        return createObjectDefinition({
          ...input,
          effects: handler,
        })
      },
    })
  )
}

// Runtime builders are plain objects; public builder types carry phase-order inference.
function asPublicActionType<TPublic>(value: unknown): TPublic {
  return value as TPublic
}

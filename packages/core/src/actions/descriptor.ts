import type { ActionDefinition, ActionParamsConfig } from "./types"

type DeepReadonly<T> = T extends object ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> } : T

export type ActionDescriptorBinding =
  | { readonly kind: "global" }
  | { readonly kind: "object"; readonly objectTypeId: string }

export type ActionParamDescriptor = DeepReadonly<ActionParamsConfig[string]>

export interface ActionPhaseDescriptor {
  readonly validate: boolean
  readonly writeback: boolean
  readonly edits: boolean
  readonly effects: boolean
}

/** Immutable metadata exposed by the execution-bound Actions catalog. */
export interface ActionDescriptor<TId extends string = string> {
  readonly id: TId
  readonly description?: string
  readonly binding: ActionDescriptorBinding
  readonly params: Readonly<Record<string, ActionParamDescriptor>>
  readonly phases: ActionPhaseDescriptor
}

/** Project an executable definition into inert, detached public metadata. */
export function snapshotActionDescriptor(action: ActionDefinition): ActionDescriptor {
  const params = Object.fromEntries(
    Object.entries(action.params).map(([id, config]) => [id, structuredClone(config)])
  ) as Record<string, ActionParamDescriptor>

  return deepFreeze({
    id: action.id,
    ...(action.description === undefined ? {} : { description: action.description }),
    binding:
      action.binding.kind === "global"
        ? { kind: "global" as const }
        : { kind: "object" as const, objectTypeId: action.binding.objectType.id },
    params,
    phases: {
      validate: action.phases.validate.length > 0,
      writeback: action.phases.writeback !== undefined,
      edits: action.phases.edits !== undefined,
      effects: action.phases.effects !== undefined,
    },
  })
}

function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

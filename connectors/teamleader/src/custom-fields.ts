import type {
  TeamleaderCustomField,
  TeamleaderCustomFieldDefinition,
  TeamleaderCustomFieldValue,
} from "./types"

export function customFieldsByDefinitionId(
  customFields: readonly TeamleaderCustomField[] | null | undefined
): ReadonlyMap<string, TeamleaderCustomFieldValue> {
  const values = new Map<string, TeamleaderCustomFieldValue>()

  for (const customField of customFields ?? []) {
    values.set(customField.definition.id, customField.value)
  }

  return values
}

export function customFieldsByLabel(
  customFields: readonly TeamleaderCustomField[] | null | undefined,
  definitions: readonly TeamleaderCustomFieldDefinition[] | null | undefined
): ReadonlyMap<string, TeamleaderCustomFieldValue> {
  const definitionsById = new Map<string, TeamleaderCustomFieldDefinition>()
  for (const definition of definitions ?? []) {
    definitionsById.set(definition.id, definition)
  }

  const values = new Map<string, TeamleaderCustomFieldValue>()
  for (const customField of customFields ?? []) {
    const label = definitionsById.get(customField.definition.id)?.label
    if (label) {
      values.set(label, customField.value)
    }
  }

  return values
}

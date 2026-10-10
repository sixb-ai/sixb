export class ActionDefinitionError extends Error {
  readonly name = "ActionDefinitionError"
}

export function missingActionMutationMessage(actionId: string): string {
  return `Action "${actionId}" must declare .writeback(...) or .edits(...).`
}

export function effectsWithoutEditsMessage(actionId: string): string {
  return `Action "${actionId}" cannot declare .effects(...) without .edits(...).`
}

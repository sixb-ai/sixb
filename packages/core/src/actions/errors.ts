export class ActionDefinitionError extends Error {
  readonly name = "ActionDefinitionError"
}

export class ActionEditCommitError extends Error {
  readonly name = "ActionEditCommitError"
}

export function missingActionMutationMessage(actionId: string): string {
  return `Action "${actionId}" must declare .writeback(...) or .edits(...).`
}

export function effectsWithoutEditsMessage(actionId: string): string {
  return `Action "${actionId}" cannot declare .effects(...) without .edits(...).`
}

export const legacyRunMessage =
  "Actions V2 no longer supports .run(...). Use .writeback(...), .edits(...), and .effects(...) instead."

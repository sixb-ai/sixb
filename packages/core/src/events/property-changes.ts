/** The semantic change applied to one ontology property. */
export type PropertyChangeOperation = "created" | "updated" | "cleared"

export type PropertyChange<TValue = unknown> =
  | { readonly operation: "created"; readonly after: TValue }
  | { readonly operation: "updated"; readonly before: TValue; readonly after: TValue }
  | { readonly operation: "cleared"; readonly before: TValue; readonly after: null }

export type PropertyChangeMap<TValue = unknown> = Record<string, PropertyChange<TValue>>

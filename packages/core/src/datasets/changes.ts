export type MergeChange<Row, Key> =
  | { readonly kind: "upsert"; readonly row: Row }
  | { readonly kind: "delete"; readonly key: Key; readonly sequence?: string | number | Date }

export const change = {
  upsert<const Row extends object>(row: Row): { readonly kind: "upsert"; readonly row: Row } {
    return { kind: "upsert", row }
  },

  delete: deleteChange,
}

function deleteChange<const Key extends object>(
  key: Key
): { readonly kind: "delete"; readonly key: Key }
function deleteChange<const Key extends object, const Sequence extends string | number | Date>(
  key: Key,
  options: { readonly sequence: Sequence }
): { readonly kind: "delete"; readonly key: Key; readonly sequence: Sequence }
function deleteChange<Key extends object>(
  key: Key,
  options?: { readonly sequence: string | number | Date }
): { readonly kind: "delete"; readonly key: Key; readonly sequence?: string | number | Date } {
  return { kind: "delete", key, ...(options ? { sequence: options.sequence } : {}) }
}

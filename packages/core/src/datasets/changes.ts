export type MergeChange<Row, Key> =
  | { readonly kind: "upsert"; readonly row: Row }
  | { readonly kind: "delete"; readonly key: Key }

export const change = {
  upsert<const Row extends object>(row: Row): { readonly kind: "upsert"; readonly row: Row } {
    return { kind: "upsert", row }
  },

  delete<const Key extends object>(key: Key): { readonly kind: "delete"; readonly key: Key } {
    return { kind: "delete", key }
  },
}

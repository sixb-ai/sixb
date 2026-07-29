export type QueryRow<TQuery> = TQuery extends { first(): Promise<infer TRow> }
  ? NonNullable<TRow>
  : never

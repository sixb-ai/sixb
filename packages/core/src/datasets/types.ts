export type DatasetColumnType =
  | "string"
  | "boolean"
  | "int64"
  | "float64"
  | "decimal"
  | "date"
  | "timestamp"
  | "json"
  | "fileRef"

export interface DatasetColumnDefinition<
  TName extends string = string,
  TType extends DatasetColumnType = DatasetColumnType,
> {
  readonly name: TName
  readonly type: TType
  readonly nullable?: boolean
}

export interface DatasetSchema<
  TColumns extends readonly DatasetColumnDefinition[] = readonly DatasetColumnDefinition[],
> {
  readonly columns: TColumns
}

export interface DatasetDefinition<
  TId extends string = string,
  TColumns extends readonly DatasetColumnDefinition[] = readonly DatasetColumnDefinition[],
> {
  readonly kind: "dataset"
  readonly id: TId
  readonly schema: DatasetSchema<TColumns>
  readonly partitionBy?: readonly string[]
  readonly description?: string
}

export type DatasetColumnUnionOf<TDataset extends DatasetDefinition> =
  TDataset["schema"]["columns"][number]

export type DatasetColumnNameOf<TDataset extends DatasetDefinition> =
  DatasetColumnUnionOf<TDataset>["name"]

export type DatasetColumnDefinitionOf<
  TDataset extends DatasetDefinition,
  TName extends DatasetColumnNameOf<TDataset>,
> = Extract<DatasetColumnUnionOf<TDataset>, { readonly name: TName }>

export type DatasetColumnTypeOf<
  TDataset extends DatasetDefinition,
  TName extends DatasetColumnNameOf<TDataset>,
> = DatasetColumnDefinitionOf<TDataset, TName>["type"]

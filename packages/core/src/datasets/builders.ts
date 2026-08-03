import { SixbError } from "../errors"
import type {
  DatasetColumnDefinition,
  DatasetColumnNameOf,
  DatasetColumnType,
  DatasetDefinition,
} from "./types"
import { assertDatasetColumnDefinition, assertDatasetDefinition } from "./validation"

type DatasetColumnOptions = {
  readonly nullable?: boolean
}

type DefineDatasetOptions = {
  readonly schema: readonly DatasetColumnDefinition[]
  readonly partitionBy?: readonly string[]
  readonly description?: string
}

type DeriveDatasetOptions<TParent extends DatasetDefinition> = {
  readonly pick?: readonly DatasetColumnNameOf<TParent>[]
  readonly add?: readonly DatasetColumnDefinition[]
  readonly partitionBy?: readonly string[]
  readonly description?: string
}

type FieldFromOptions<TOptions, TKey extends string, TFallback> = TOptions extends {
  readonly [K in TKey]: infer TValue
}
  ? TValue extends TFallback
    ? { readonly [K in TKey]: TValue }
    : { readonly [K in TKey]?: TFallback }
  : { readonly [K in TKey]?: TFallback }

type ColumnNameOf<TColumns extends readonly DatasetColumnDefinition[]> = TColumns[number]["name"]

type ColumnDefinitionOf<
  TColumns extends readonly DatasetColumnDefinition[],
  TName extends ColumnNameOf<TColumns>,
> = Extract<TColumns[number], { readonly name: TName }>

type PickColumns<
  TColumns extends readonly DatasetColumnDefinition[],
  TNames extends readonly ColumnNameOf<TColumns>[],
> = TNames extends readonly [infer THead, ...infer TTail]
  ? THead extends ColumnNameOf<TColumns>
    ? TTail extends readonly ColumnNameOf<TColumns>[]
      ? readonly [ColumnDefinitionOf<TColumns, THead>, ...PickColumns<TColumns, TTail>]
      : never
    : never
  : TNames extends readonly []
    ? readonly []
    : readonly ColumnDefinitionOf<TColumns, TNames[number]>[]

type AddColumns<
  TColumns extends readonly DatasetColumnDefinition[],
  TAdd extends readonly DatasetColumnDefinition[],
> = readonly [...TColumns, ...TAdd]

type DerivedBaseColumns<
  TParent extends DatasetDefinition,
  TOptions extends DeriveDatasetOptions<TParent> | undefined,
> = TOptions extends { readonly pick: infer TPick }
  ? TPick extends readonly DatasetColumnNameOf<TParent>[]
    ? PickColumns<TParent["schema"]["columns"], TPick>
    : TParent["schema"]["columns"]
  : TParent["schema"]["columns"]

type DerivedColumns<
  TParent extends DatasetDefinition,
  TOptions extends DeriveDatasetOptions<TParent> | undefined,
> = TOptions extends { readonly add: infer TAdd }
  ? TAdd extends readonly DatasetColumnDefinition[]
    ? AddColumns<DerivedBaseColumns<TParent, TOptions>, TAdd>
    : DerivedBaseColumns<TParent, TOptions>
  : DerivedBaseColumns<TParent, TOptions>

type DatasetColumnResult<
  TName extends string,
  TType extends DatasetColumnType,
  TOptions extends DatasetColumnOptions | undefined,
> = {
  readonly name: TName
  readonly type: TType
} & FieldFromOptions<TOptions, "nullable", boolean>

type DatasetDefinitionResult<TId extends string, TOptions extends DefineDatasetOptions> = Omit<
  DatasetDefinition<TId, TOptions["schema"]>,
  "partitionBy" | "description"
> &
  FieldFromOptions<TOptions, "partitionBy", readonly string[]> &
  FieldFromOptions<TOptions, "description", string>

type DerivedDatasetDefinitionResult<
  TId extends string,
  TParent extends DatasetDefinition,
  TOptions extends DeriveDatasetOptions<TParent> | undefined,
> = Omit<DatasetDefinition<TId, DerivedColumns<TParent, TOptions>>, "partitionBy" | "description"> &
  FieldFromOptions<TOptions, "partitionBy", readonly string[]> &
  FieldFromOptions<TOptions, "description", string>

export function col<const TName extends string, const TType extends DatasetColumnType>(
  name: TName,
  type: TType
): DatasetColumnResult<TName, TType, undefined>
export function col<
  const TName extends string,
  const TType extends DatasetColumnType,
  const TOptions extends DatasetColumnOptions,
>(name: TName, type: TType, options: TOptions): DatasetColumnResult<TName, TType, TOptions>
export function col(
  name: string,
  type: DatasetColumnType,
  options?: DatasetColumnOptions
): DatasetColumnDefinition {
  const column: DatasetColumnDefinition = {
    name,
    type,
    ...(options?.nullable !== undefined ? { nullable: options.nullable } : {}),
  }

  assertDatasetColumnDefinition(
    column,
    (message) => new SixbError("runtime.invalid_definition", message)
  )
  return column
}

function assertDatasetId(id: string): void {
  if (!id.trim()) {
    throw new SixbError("runtime.invalid_definition", "Dataset id must not be empty.")
  }
}

function createDatasetDefinition(id: string, options: DefineDatasetOptions): DatasetDefinition {
  const definition: DatasetDefinition = {
    kind: "dataset",
    id,
    schema: {
      columns: [...options.schema],
    },
    ...(options.partitionBy !== undefined ? { partitionBy: [...options.partitionBy] } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  }

  assertDatasetDefinition(
    definition,
    (message) => new SixbError("runtime.invalid_definition", message)
  )
  return definition
}

function assertStringArray(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new SixbError("runtime.invalid_definition", `${field} must be an array of column names.`)
  }

  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new SixbError(
        "runtime.invalid_definition",
        `${field} must contain only non-empty column names.`
      )
    }
  }
}

function deriveDatasetDefinition(
  id: string,
  parent: DatasetDefinition,
  options: DeriveDatasetOptions<DatasetDefinition> = {}
): DatasetDefinition {
  assertDatasetDefinition(parent, (message) => new SixbError("runtime.invalid_definition", message))

  if (options.pick !== undefined) {
    assertStringArray(options.pick, "Dataset derive pick")
  }

  if (options.add !== undefined && !Array.isArray(options.add)) {
    throw new SixbError(
      "runtime.invalid_definition",
      "Dataset derive add must be an array of columns."
    )
  }

  const parentColumnsByName = new Map(
    parent.schema.columns.map((column) => [column.name, column] as const)
  )
  const pickedColumns =
    options.pick === undefined
      ? parent.schema.columns
      : options.pick.map((columnName) => {
          const column = parentColumnsByName.get(columnName)
          if (column === undefined) {
            throw new SixbError(
              "runtime.invalid_definition",
              `Dataset derive pick column '${columnName}' is not declared on parent dataset '${parent.id}'.`
            )
          }
          return column
        })

  return createDatasetDefinition(id, {
    schema: [...pickedColumns, ...(options.add ?? [])],
    ...(options.partitionBy !== undefined ? { partitionBy: options.partitionBy } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  })
}

function createDatasetDeriveBuilder<TId extends string>(id: TId) {
  assertDatasetId(id)

  function derive<const TParent extends DatasetDefinition>(
    parent: TParent
  ): DerivedDatasetDefinitionResult<TId, TParent, undefined>
  function derive<
    const TParent extends DatasetDefinition,
    const TOptions extends DeriveDatasetOptions<TParent>,
  >(parent: TParent, options: TOptions): DerivedDatasetDefinitionResult<TId, TParent, TOptions>
  function derive(
    parent: DatasetDefinition,
    options?: DeriveDatasetOptions<DatasetDefinition>
  ): DatasetDefinition {
    return deriveDatasetDefinition(id, parent, options)
  }

  return { derive }
}

export function defineDataset<const TId extends string>(
  id: TId
): ReturnType<typeof createDatasetDeriveBuilder<TId>>
export function defineDataset<
  const TId extends string,
  const TOptions extends DefineDatasetOptions,
>(id: TId, options: TOptions): DatasetDefinitionResult<TId, TOptions>
export function defineDataset(
  id: string,
  options?: DefineDatasetOptions
): DatasetDefinition | ReturnType<typeof createDatasetDeriveBuilder<string>> {
  if (options === undefined) {
    return createDatasetDeriveBuilder(id)
  }

  return createDatasetDefinition(id, options)
}

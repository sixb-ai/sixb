import { markingIdsFrom } from "../security/builders"
import type { MarkingDefinition } from "../security/types"
import { DatasetValidationError } from "./errors"
import type {
  DatasetColumnDefinition,
  DatasetColumnNameOf,
  DatasetColumnType,
  DatasetDefinition,
  DatasetPrimaryKey,
} from "./types"
import { assertDatasetColumnDefinition, assertDatasetDefinition } from "./validation"

type DatasetColumnOptions = {
  readonly nullable?: boolean
  /** Principals need a clearance for every marking to read this column. */
  readonly markings?: readonly MarkingDefinition[]
}

type DefineDatasetOptions = {
  readonly schema: readonly DatasetColumnDefinition[]
  readonly primaryKey?: DatasetPrimaryKey
  readonly sequenceBy?: string
  readonly partitionBy?: readonly string[]
  readonly description?: string
}

type DeriveDatasetOptions<TParent extends DatasetDefinition> = {
  readonly pick?: readonly DatasetColumnNameOf<TParent>[]
  readonly add?: readonly DatasetColumnDefinition[]
  readonly primaryKey?: DatasetPrimaryKey
  readonly sequenceBy?: string
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

type PrimaryKeyColumnNameOf<TColumns extends readonly DatasetColumnDefinition[]> =
  string extends ColumnNameOf<TColumns>
    ? string
    : {
        [TName in ColumnNameOf<TColumns>]: ColumnDefinitionOf<
          TColumns,
          TName
        >["type"] extends "string"
          ? ColumnDefinitionOf<TColumns, TName> extends { readonly nullable: true }
            ? never
            : TName
          : never
      }[ColumnNameOf<TColumns>]

type CheckedDefineDatasetOptions<TOptions extends DefineDatasetOptions> = TOptions & {
  readonly primaryKey?: DatasetPrimaryKey<PrimaryKeyColumnNameOf<TOptions["schema"]>>
  readonly sequenceBy?: SequenceColumnNameOf<TOptions["schema"]>
}

type SequenceColumnNameOf<TColumns extends readonly DatasetColumnDefinition[]> =
  string extends ColumnNameOf<TColumns>
    ? string
    : {
        [TName in ColumnNameOf<TColumns>]: ColumnDefinitionOf<TColumns, TName>["type"] extends
          | "timestamp"
          | "int64"
          ? ColumnDefinitionOf<TColumns, TName> extends { readonly nullable: true }
            ? never
            : TName
          : never
      }[ColumnNameOf<TColumns>]

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

/** A dataset read through some of its columns: `rawInvoices.pick("id", "title")`. */
type PickableDataset<TId extends string, TColumns extends readonly DatasetColumnDefinition[]> = {
  /**
   * The same dataset with only these columns, in this order. A pipeline step given it as an input
   * reads nothing else, so its output inherits no other column's markings.
   */
  pick<const TNames extends readonly [ColumnNameOf<TColumns>, ...ColumnNameOf<TColumns>[]]>(
    ...columns: TNames
  ): DatasetDefinition<TId, PickColumns<TColumns, TNames>>
}

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

/** The column records marking ids; only a declared, non-empty list marks it. */
type MarkingsFromOptions<TOptions> = TOptions extends {
  readonly markings: readonly [MarkingDefinition, ...MarkingDefinition[]]
}
  ? { readonly markings: readonly string[] }
  : { readonly markings?: readonly string[] }

type DatasetColumnResult<
  TName extends string,
  TType extends DatasetColumnType,
  TOptions extends DatasetColumnOptions | undefined,
> = {
  readonly name: TName
  readonly type: TType
} & FieldFromOptions<TOptions, "nullable", boolean> &
  MarkingsFromOptions<TOptions>

type DatasetDefinitionResult<TId extends string, TOptions extends DefineDatasetOptions> = Omit<
  DatasetDefinition<TId, TOptions["schema"]>,
  "primaryKey" | "sequenceBy" | "partitionBy" | "description"
> &
  FieldFromOptions<TOptions, "sequenceBy", string> &
  FieldFromOptions<TOptions, "primaryKey", DatasetPrimaryKey> &
  FieldFromOptions<TOptions, "partitionBy", readonly string[]> &
  FieldFromOptions<TOptions, "description", string> &
  PickableDataset<TId, TOptions["schema"]>

type DerivedDatasetDefinitionResult<
  TId extends string,
  TParent extends DatasetDefinition,
  TOptions extends DeriveDatasetOptions<TParent> | undefined,
> = Omit<
  DatasetDefinition<TId, DerivedColumns<TParent, TOptions>>,
  "primaryKey" | "sequenceBy" | "partitionBy" | "description"
> &
  FieldFromOptions<TOptions, "sequenceBy", string> &
  FieldFromOptions<TOptions, "primaryKey", DatasetPrimaryKey> &
  FieldFromOptions<TOptions, "partitionBy", readonly string[]> &
  FieldFromOptions<TOptions, "description", string> &
  PickableDataset<TId, DerivedColumns<TParent, TOptions>>

type CheckedDeriveDatasetOptions<
  TParent extends DatasetDefinition,
  TOptions extends DeriveDatasetOptions<TParent>,
> = TOptions & {
  readonly primaryKey?: DatasetPrimaryKey<PrimaryKeyColumnNameOf<DerivedColumns<TParent, TOptions>>>
  readonly sequenceBy?: SequenceColumnNameOf<DerivedColumns<TParent, TOptions>>
}

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
  const markings = options?.markings
  const column: DatasetColumnDefinition = {
    name,
    type,
    ...(options?.nullable !== undefined ? { nullable: options.nullable } : {}),
    ...(markings && markings.length > 0
      ? { markings: markingIdsFrom(markings, `Dataset column '${name}' markings`) }
      : {}),
  }

  assertDatasetColumnDefinition(column, (message) => new DatasetValidationError(message))
  return column
}

function assertDatasetId(id: string): void {
  if (!id.trim()) {
    throw new DatasetValidationError("Dataset id must not be empty.")
  }
}

function createDatasetDefinition(id: string, options: DefineDatasetOptions): DatasetDefinition {
  const definition: unknown = {
    kind: "dataset",
    id,
    schema: {
      columns: [...options.schema],
    },
    ...(options.primaryKey !== undefined
      ? {
          primaryKey: Array.isArray(options.primaryKey)
            ? [...options.primaryKey]
            : options.primaryKey,
        }
      : {}),
    ...(options.partitionBy !== undefined ? { partitionBy: [...options.partitionBy] } : {}),
    ...(options.sequenceBy !== undefined ? { sequenceBy: options.sequenceBy } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  }

  assertDatasetDefinition(definition, (message) => new DatasetValidationError(message))

  // Not enumerable: the definition stays plain data for cloning, spreading, and storage.
  Object.defineProperty(definition, "pick", {
    value: (...columns: string[]) => pickDatasetColumns(definition, columns),
  })

  return definition
}

const datasetPick: unique symbol = Symbol("sixb.datasetPick")

/**
 * Whether a definition was made by `pick()`. Only a pick may hold some of a dataset's columns: any
 * other definition with a registered id stands for the whole dataset.
 */
export function isDatasetPick(dataset: DatasetDefinition): boolean {
  return (dataset as { readonly [datasetPick]?: true })[datasetPick] === true
}

function pickDatasetColumns(
  dataset: DatasetDefinition,
  columnNames: readonly string[]
): DatasetDefinition {
  if (columnNames.length === 0) {
    throw new DatasetValidationError(
      `[Sixb] Dataset '${dataset.id}' pick needs at least one column.`
    )
  }

  const columnsByName = new Map(dataset.schema.columns.map((column) => [column.name, column]))
  const picked = new Set<string>()
  const columns = columnNames.map((columnName) => {
    if (picked.has(columnName)) {
      throw new DatasetValidationError(
        `[Sixb] Dataset '${dataset.id}' pick lists column '${columnName}' twice.`
      )
    }
    picked.add(columnName)

    const column = columnsByName.get(columnName)
    if (column === undefined) {
      throw new DatasetValidationError(
        `[Sixb] Dataset '${dataset.id}' has no column '${columnName}' to pick.`
      )
    }

    return column
  })

  const pick: DatasetDefinition = { kind: "dataset", id: dataset.id, schema: { columns } }
  Object.defineProperty(pick, datasetPick, { value: true })
  return pick
}

function assertStringArray(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new DatasetValidationError(`${field} must be an array of column names.`)
  }

  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new DatasetValidationError(`${field} must contain only non-empty column names.`)
    }
  }
}

function deriveDatasetDefinition(
  id: string,
  parent: DatasetDefinition,
  options: DeriveDatasetOptions<DatasetDefinition> = {}
): DatasetDefinition {
  assertDatasetDefinition(parent, (message) => new DatasetValidationError(message))

  if (options.pick !== undefined) {
    assertStringArray(options.pick, "Dataset derive pick")
  }

  if (options.add !== undefined && !Array.isArray(options.add)) {
    throw new DatasetValidationError("Dataset derive add must be an array of columns.")
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
            throw new DatasetValidationError(
              `Dataset derive pick column '${columnName}' is not declared on parent dataset '${parent.id}'.`
            )
          }
          return column
        })

  return createDatasetDefinition(id, {
    schema: [...pickedColumns, ...(options.add ?? [])],
    ...(options.primaryKey !== undefined ? { primaryKey: options.primaryKey } : {}),
    ...(options.sequenceBy !== undefined ? { sequenceBy: options.sequenceBy } : {}),
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
  >(
    parent: TParent,
    options: CheckedDeriveDatasetOptions<TParent, TOptions>
  ): DerivedDatasetDefinitionResult<TId, TParent, TOptions>
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
>(id: TId, options: CheckedDefineDatasetOptions<TOptions>): DatasetDefinitionResult<TId, TOptions>
export function defineDataset(
  id: string,
  options?: DefineDatasetOptions
): DatasetDefinition | ReturnType<typeof createDatasetDeriveBuilder<string>> {
  if (options === undefined) {
    return createDatasetDeriveBuilder(id)
  }

  return createDatasetDefinition(id, options)
}

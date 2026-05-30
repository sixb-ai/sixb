import { randomUUID } from "node:crypto"
import type {
  DatasetDefinition,
  DatasetDefinitionUpdatePlan,
  DatasetSchema,
  DatasetSchemaUpdatePlan,
} from "@sixb/core"
import { LakeStorageError, planDatasetDefinitionUpdate } from "@sixb/core"
import type { DuckLakeStorageOptions } from "../types"
import { getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { readCurrentDatasetDefinitions } from "./ducklake-current-dataset-definitions"
import { encodeDatasetTableName } from "./names"
import {
  type DuckDbColumnMetadata,
  datasetColumnToDuckDbSql,
  datasetSchemaToDuckDbColumnsSql,
  duckDbColumnsToDatasetSchema,
} from "./schema"
import { duckLakeAlias, qualifiedTableName, quoteIdentifier, quoteSqlString } from "./sql"

/**
 * Translates between Sixb dataset definitions and DuckLake table metadata.
 *
 * DuckLake stays the source of truth for the physical table, schema, comments,
 * and partitioning. Sixb only decides which definition changes are safe to
 * translate into DuckLake DDL.
 */
export class DuckLakeDatasetCatalog {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager
  ) {}

  async createDataset(definition: DatasetDefinition): Promise<DatasetDefinition> {
    this.assertSchema(definition)

    // Step 1: read the current DuckLake table back into Sixb shape. The
    // existing definition is DuckLake's catalog state; the next definition is
    // the developer's current source definition.
    const existing = await this.getDataset(definition.id)

    if (existing) {
      const plan = planDatasetDefinitionUpdate(existing, definition)
      if (plan.changed) {
        await this.applyExistingDatasetUpdate(plan)
        this.connections.markLocalCatalogChanged()
        await this.connections.resetRuntime()
      }

      return (await this.getDataset(definition.id)) ?? plan.definition
    }

    // New datasets materialize as one DuckLake table with native columns. The
    // table name is reversible, so no sidecar mapping is needed.
    const tableName = encodeDatasetTableName(definition.id)
    const qualifiedName = qualifiedTableName(this.options, tableName)

    // Creating a dataset can be several catalog DDL statements. Keep them in
    // one runtime slot so writes cannot observe a half-created table.
    await this.connections.withExclusiveAttached(async (runtime) => {
      await runtime.run(
        `CREATE TABLE ${qualifiedName} (${datasetSchemaToDuckDbColumnsSql(definition.schema)})`
      )

      if (definition.description !== undefined) {
        await runtime.run(
          `COMMENT ON TABLE ${qualifiedName} IS ${quoteSqlString(definition.description)}`
        )
      }

      await this.applyPartitionBy(runtime, qualifiedName, definition)
    })
    this.connections.markLocalCatalogChanged()

    return structuredClone(definition)
  }

  async assertDatasetDefinitionsCompatible(
    definitions: readonly DatasetDefinition[]
  ): Promise<void> {
    const failures: string[] = []
    const checkedDefinitions: DatasetDefinition[] = []

    for (const definition of definitions) {
      try {
        this.assertSchema(definition)
        checkedDefinitions.push(definition)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`- ${definition.id}: ${message}`)
      }
    }

    const existingById = await this.readCurrentDatasetDefinitions({
      datasetIds: checkedDefinitions.map((definition) => definition.id),
    })

    for (const definition of checkedDefinitions) {
      const existing = existingById.get(definition.id)
      if (!existing) {
        continue
      }

      try {
        planDatasetDefinitionUpdate(existing, definition)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`- ${definition.id}: ${message}`)
      }
    }

    if (failures.length > 0) {
      const details = failures.join("\n")
      throw new LakeStorageError(
        `[SixbLake] Lake dataset definition check failed for ${failures.length} dataset(s).\n${details}`
      )
    }
  }

  async getDataset(datasetId: string): Promise<DatasetDefinition | null> {
    this.connections.assertOpen()

    return this.connections.withAttachedRuntime((runtime) =>
      this.getDatasetOnRuntime(runtime, datasetId)
    )
  }

  async getDatasetOnRuntime(
    runtime: DuckDbQueryRuntime,
    datasetId: string
  ): Promise<DatasetDefinition | null> {
    return (
      (
        await this.readCurrentDatasetDefinitionsOnRuntime(runtime, {
          datasetIds: [datasetId],
        })
      ).get(datasetId) ?? null
    )
  }

  async listDatasets(): Promise<readonly DatasetDefinition[]> {
    this.connections.assertOpen()

    return this.connections.withAttachedRuntime(async (runtime) => {
      return [...(await this.readCurrentDatasetDefinitionsOnRuntime(runtime)).values()].sort(
        (left, right) => left.id.localeCompare(right.id)
      )
    })
  }

  private async readCurrentDatasetDefinitions(options?: {
    readonly datasetIds?: readonly string[]
  }): Promise<Map<string, DatasetDefinition>> {
    if (options?.datasetIds?.length === 0) {
      return new Map()
    }

    return this.connections.withAttachedRuntime((runtime) =>
      this.readCurrentDatasetDefinitionsOnRuntime(runtime, options)
    )
  }

  private async readCurrentDatasetDefinitionsOnRuntime(
    runtime: DuckDbQueryRuntime,
    options?: { readonly datasetIds?: readonly string[] }
  ): Promise<Map<string, DatasetDefinition>> {
    return readCurrentDatasetDefinitions({
      options: this.options,
      runtime,
      datasetIds: options?.datasetIds,
    })
  }

  async getDatasetSchemaAtSnapshot(
    runtime: DuckDbQueryRuntime,
    datasetId: string,
    snapshotId: string
  ): Promise<DatasetSchema> {
    assertDuckLakeSnapshotId(snapshotId)

    const tableName = encodeDatasetTableName(datasetId)
    return this.describeDatasetSchema(runtime, tableName, snapshotId)
  }

  assertSchema(definition: DatasetDefinition): void {
    if (!definition.schema) {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset '${definition.id}' requires a schema for DuckLake storage.`
      )
    }
  }

  private async applyExistingDatasetUpdate(plan: DatasetDefinitionUpdatePlan): Promise<void> {
    const tableName = encodeDatasetTableName(plan.definition.id)
    const qualifiedName = qualifiedTableName(this.options, tableName)

    await this.connections.withExclusiveAttached(async (runtime) => {
      if (plan.schema.kind === "none") {
        await this.applyMetadataDelta(runtime, qualifiedName, plan)
        return
      }

      // Schema-only DuckLake snapshots still matter to Sixb. Apply schema and
      // compatible metadata DDL atomically, then tag the commit so versions can
      // treat it as this dataset's schema-change version.
      await runtime.run("BEGIN TRANSACTION")
      let committed = false
      try {
        await this.applySchemaEvolutionDdl(runtime, qualifiedName, plan.schema)
        await this.applyMetadataDelta(runtime, qualifiedName, plan)
        await this.setSchemaEvolutionCommitMetadata(runtime, plan.definition.id, plan.schema)

        await runtime.run("COMMIT")
        committed = true
      } catch (error) {
        if (!committed) {
          await this.rollbackTransaction(runtime)
        }
        throw error
      }
    })
  }

  private async applySchemaEvolutionDdl(
    runtime: DuckDbQueryRuntime,
    qualifiedName: string,
    plan: Extract<DatasetSchemaUpdatePlan, { readonly kind: "addNullableColumns" }>
  ): Promise<void> {
    for (const column of plan.columns) {
      await runtime.run(
        `ALTER TABLE ${qualifiedName} ADD COLUMN ${datasetColumnToDuckDbSql(column)}`
      )
    }
  }

  private async applyMetadataDelta(
    runtime: DuckDbQueryRuntime,
    qualifiedName: string,
    plan: DatasetDefinitionUpdatePlan
  ): Promise<void> {
    // A compatible merge may add optional metadata after first creation. Apply
    // those deltas explicitly so createDataset never silently accepts a change
    // that DuckLake did not persist.
    if (plan.metadata.descriptionChanged && plan.definition.description !== undefined) {
      await runtime.run(
        `COMMENT ON TABLE ${qualifiedName} IS ${quoteSqlString(plan.definition.description)}`
      )
    }

    if (plan.metadata.partitionByChanged) {
      await this.applyPartitionBy(runtime, qualifiedName, plan.definition)
    }
  }

  private async applyPartitionBy(
    runtime: DuckDbQueryRuntime,
    qualifiedName: string,
    definition: DatasetDefinition
  ): Promise<void> {
    if (definition.partitionBy === undefined || definition.partitionBy.length === 0) {
      return
    }

    // Partitioning is DuckLake physical metadata. If DuckLake cannot apply it,
    // fail with the original driver message instead of returning stale
    // partition metadata.
    try {
      await runtime.run(
        `ALTER TABLE ${qualifiedName} SET PARTITIONED BY (${definition.partitionBy
          .map((columnName) => quoteIdentifier(columnName))
          .join(", ")})`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset '${definition.id}' cannot apply partitionBy because DuckLake rejected ALTER TABLE SET PARTITIONED BY: ${message}`
      )
    }
  }

  private async setSchemaEvolutionCommitMetadata(
    runtime: DuckDbQueryRuntime,
    datasetId: string,
    plan: Extract<DatasetSchemaUpdatePlan, { readonly kind: "addNullableColumns" }>
  ): Promise<void> {
    await runtime.run(
      `CALL ${quoteIdentifier(duckLakeAlias(this.options))}.set_commit_message(${quoteSqlString(
        "Sixb"
      )}, ${quoteSqlString(`evolve dataset ${datasetId} schema`)}, extra_info => ${quoteSqlString(
        JSON.stringify({
          sixb: {
            kind: "datasetVersion",
            datasetId,
            commitId: randomUUID(),
            mode: "schema",
            schemaChange: {
              addColumns: plan.columns.map((column) => column.name),
            },
          },
        })
      )})`
    )
  }

  private async rollbackTransaction(runtime: DuckDbQueryRuntime): Promise<void> {
    try {
      await runtime.run("ROLLBACK")
    } catch {
      // Preserve the original DDL failure. DuckDB may already have closed the
      // transaction if COMMIT itself failed.
    }
  }

  private async describeDatasetSchema(
    runtime: DuckDbQueryRuntime,
    tableName: string,
    snapshotId?: string
  ): Promise<DatasetSchema> {
    const tableSql = qualifiedTableName(this.options, tableName)
    const versionSql = snapshotId === undefined ? "" : ` AT (VERSION => ${snapshotId})`
    const relationSql = `${tableSql}${versionSql}`
    const rows = await runtime.query(`DESCRIBE SELECT * FROM ${relationSql}`)

    const columns = rows.map((row) => ({
      name: getString(row, "column_name"),
      type: getString(row, "column_type"),
      nullable: getDescribeColumnNullable(row),
    })) satisfies DuckDbColumnMetadata[]

    return duckDbColumnsToDatasetSchema(columns)
  }
}

function assertDuckLakeSnapshotId(snapshotId: string): void {
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[SixbDuckLake] Invalid DuckLake snapshot id '${snapshotId}'.`)
  }
}

function getDescribeColumnNullable(row: Readonly<Record<string, unknown>>): boolean {
  // DuckDB DESCRIBE reports nullability as text in a column named "null".
  // Normalize that provider shape into the boolean used by DatasetColumnDefinition.
  const value = getString(row, "null")
  if (value === "YES") {
    return true
  }

  if (value === "NO") {
    return false
  }

  throw new LakeStorageError(
    `[SixbDuckLake] Expected DuckDB DESCRIBE column 'null' to be YES or NO.`
  )
}

import { randomUUID } from "node:crypto"
import type {
  DatasetDefinition,
  DatasetDefinitionUpdatePlan,
  DatasetSchema,
  DatasetSchemaUpdatePlan,
} from "@pario/core"
import { LakeStorageError, planDatasetDefinitionUpdate } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import { getOptionalString, getString } from "./duckdb-row"
import type { DuckDbRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { decodeDatasetTableName, encodeDatasetTableName } from "./names"
import {
  type DuckDbColumnMetadata,
  datasetColumnToDuckDbSql,
  datasetSchemaToDuckDbColumnsSql,
  duckDbColumnsToDatasetSchema,
} from "./schema"
import {
  duckLakeAlias,
  duckLakeMetadataTableName,
  qualifiedTableName,
  quoteIdentifier,
  quoteSqlString,
} from "./sql"

interface DatasetTableRow {
  readonly comment?: string
}

interface PartitionColumnRow {
  readonly columnName: string
  readonly transform: string
}

/**
 * Translates between Pario dataset definitions and DuckLake table metadata.
 *
 * DuckLake stays the source of truth for the physical table, schema, comments,
 * and partitioning. Pario only decides which definition changes are safe to
 * translate into DuckLake DDL.
 */
export class DuckLakeDatasetCatalog {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager
  ) {}

  async createDataset(definition: DatasetDefinition): Promise<DatasetDefinition> {
    this.assertSchema(definition)

    // Step 1: read the current DuckLake table back into Pario shape. The
    // existing definition is DuckLake's catalog state; the next definition is
    // the developer's current source definition.
    const existing = await this.getDataset(definition.id)

    if (existing) {
      const plan = planDatasetDefinitionUpdate(existing, definition)
      if (plan.changed) {
        await this.applyExistingDatasetUpdate(plan)
        await this.connections.resetRuntime()
      }

      return (await this.getDataset(definition.id)) ?? plan.definition
    }

    // New datasets materialize as one DuckLake table with native columns. The
    // table name is reversible, so no sidecar mapping is needed.
    const tableName = encodeDatasetTableName(definition.id)
    const qualifiedName = qualifiedTableName(this.options, tableName)
    const runtime = await this.runtime()

    await runtime.run(
      `CREATE TABLE ${qualifiedName} (${datasetSchemaToDuckDbColumnsSql(definition.schema)})`
    )

    if (definition.description !== undefined) {
      await runtime.run(
        `COMMENT ON TABLE ${qualifiedName} IS ${quoteSqlString(definition.description)}`
      )
    }

    await this.applyPartitionBy(runtime, qualifiedName, definition)

    return structuredClone(definition)
  }

  async assertDatasetDefinitionCompatible(definition: DatasetDefinition): Promise<void> {
    this.assertSchema(definition)

    const existing = await this.getDataset(definition.id)
    if (!existing) {
      return
    }

    planDatasetDefinitionUpdate(existing, definition)
  }

  async getDataset(datasetId: string): Promise<DatasetDefinition | null> {
    this.connections.assertOpen()

    // Reconstruct definitions from DuckLake instead of trusting caller input.
    // This keeps repeated createDataset calls honest across provider instances.
    const tableName = encodeDatasetTableName(datasetId)
    const table = await this.getDatasetTable(tableName)
    if (!table) {
      return null
    }

    const schema = await this.describeDatasetSchema(await this.runtime(), tableName)
    const partitionBy = await this.getDatasetPartitionBy(tableName)

    return {
      kind: "dataset",
      id: datasetId,
      schema,
      ...(partitionBy.length > 0 ? { partitionBy } : {}),
      ...(table.comment !== undefined ? { description: table.comment } : {}),
    }
  }

  async listDatasets(): Promise<readonly DatasetDefinition[]> {
    this.connections.assertOpen()

    // Only Pario-encoded dataset tables are surfaced. Any DuckLake metadata,
    // internal tables, or unrelated user tables remain invisible to LakeStorage.
    const runtime = await this.runtime()
    const rows = await runtime.query(
      `SELECT table_name FROM duckdb_tables() WHERE database_name = ${quoteSqlString(
        duckLakeAlias(this.options)
      )} AND schema_name = 'main' AND NOT internal ORDER BY table_name`
    )

    const datasets: DatasetDefinition[] = []
    for (const row of rows) {
      const tableName = getString(row, "table_name")
      const datasetId = decodeDatasetTableName(tableName)
      if (datasetId === null) {
        continue
      }

      const definition = await this.getDataset(datasetId)
      if (definition) {
        datasets.push(definition)
      }
    }

    return datasets.sort((left, right) => left.id.localeCompare(right.id))
  }

  async getDatasetSchemaAtSnapshot(
    runtime: DuckDbRuntime,
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
        `[ParioDuckLake] Dataset '${definition.id}' requires a schema for DuckLake storage.`
      )
    }
  }

  private async runtime() {
    return this.connections.runtime()
  }

  private async applyExistingDatasetUpdate(plan: DatasetDefinitionUpdatePlan): Promise<void> {
    const tableName = encodeDatasetTableName(plan.definition.id)
    const qualifiedName = qualifiedTableName(this.options, tableName)
    const runtime = await this.runtime()

    if (plan.schema.kind === "none") {
      await this.applyMetadataDelta(runtime, qualifiedName, plan)
      return
    }

    // Schema-only DuckLake snapshots still matter to Pario. Apply schema and
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
  }

  private async applySchemaEvolutionDdl(
    runtime: DuckDbRuntime,
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
    runtime: DuckDbRuntime,
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
    runtime: DuckDbRuntime,
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
        `[ParioDuckLake] Dataset '${definition.id}' cannot apply partitionBy because DuckLake rejected ALTER TABLE SET PARTITIONED BY: ${message}`
      )
    }
  }

  private async setSchemaEvolutionCommitMetadata(
    runtime: DuckDbRuntime,
    datasetId: string,
    plan: Extract<DatasetSchemaUpdatePlan, { readonly kind: "addNullableColumns" }>
  ): Promise<void> {
    await runtime.run(
      `CALL ${quoteIdentifier(duckLakeAlias(this.options))}.set_commit_message(${quoteSqlString(
        "Pario"
      )}, ${quoteSqlString(`evolve dataset ${datasetId} schema`)}, extra_info => ${quoteSqlString(
        JSON.stringify({
          pario: {
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

  private async rollbackTransaction(runtime: DuckDbRuntime): Promise<void> {
    try {
      await runtime.run("ROLLBACK")
    } catch {
      // Preserve the original DDL failure. DuckDB may already have closed the
      // transaction if COMMIT itself failed.
    }
  }

  private async getDatasetTable(tableName: string): Promise<DatasetTableRow | null> {
    // duckdb_tables() gives us the user-facing table comment without reaching
    // into DuckLake's private metadata tables.
    const runtime = await this.runtime()
    const rows = await runtime.query(
      `SELECT table_name, comment FROM duckdb_tables() WHERE database_name = ${quoteSqlString(
        duckLakeAlias(this.options)
      )} AND schema_name = 'main' AND table_name = ${quoteSqlString(tableName)} AND NOT internal`
    )

    const row = rows[0]
    if (row === undefined) {
      return null
    }

    return {
      comment: getOptionalString(row, "comment"),
    }
  }

  private async describeDatasetSchema(
    runtime: DuckDbRuntime,
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

  private async getDatasetPartitionBy(tableName: string): Promise<readonly string[]> {
    const runtime = await this.runtime()
    const ducklakeTable = duckLakeMetadataTableName(this.options, "ducklake_table")
    const ducklakePartitionInfo = duckLakeMetadataTableName(this.options, "ducklake_partition_info")
    const ducklakePartitionColumn = duckLakeMetadataTableName(
      this.options,
      "ducklake_partition_column"
    )
    const ducklakeColumn = duckLakeMetadataTableName(this.options, "ducklake_column")

    // DuckLake exposes current partition metadata through the metadata catalog
    // attached beside the user-facing lake catalog. V1 only accepts identity
    // transforms because Pario's dataset definition stores partition columns,
    // not arbitrary partition expressions such as year(orderDate).
    const rows = await runtime.query(`
      SELECT column_meta.column_name, partition_column.transform
      FROM ${ducklakeTable} table_meta
      JOIN ${ducklakePartitionInfo} partition_info
        ON partition_info.table_id = table_meta.table_id
        AND partition_info.end_snapshot IS NULL
      JOIN ${ducklakePartitionColumn} partition_column
        ON partition_column.table_id = table_meta.table_id
        AND partition_column.partition_id = partition_info.partition_id
      JOIN ${ducklakeColumn} column_meta
        ON column_meta.table_id = table_meta.table_id
        AND column_meta.column_id = partition_column.column_id
        AND column_meta.end_snapshot IS NULL
      WHERE table_meta.end_snapshot IS NULL
        AND table_meta.table_name = ${quoteSqlString(tableName)}
      ORDER BY partition_column.partition_key_index
    `)

    return rows.map((row) => {
      const partition = {
        columnName: getString(row, "column_name"),
        transform: getString(row, "transform"),
      } satisfies PartitionColumnRow

      if (partition.transform !== "identity") {
        throw new LakeStorageError(
          `[ParioDuckLake] Dataset table '${tableName}' uses unsupported DuckLake partition transform '${partition.transform}'.`
        )
      }

      return partition.columnName
    })
  }
}

function assertDuckLakeSnapshotId(snapshotId: string): void {
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[ParioDuckLake] Invalid DuckLake snapshot id '${snapshotId}'.`)
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
    `[ParioDuckLake] Expected DuckDB DESCRIBE column 'null' to be YES or NO.`
  )
}

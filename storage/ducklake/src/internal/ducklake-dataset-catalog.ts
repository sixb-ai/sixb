import { randomUUID } from "node:crypto"
import type { DatasetDefinition, DatasetSchema } from "@sixb/core"
import type {
  DatasetDefinitionUpdatePlan,
  DatasetSchemaUpdatePlan,
  DatasetVersionLineage,
} from "@sixb/core/lake-storage"
import {
  assertDatasetDefinition,
  LakeStorageError,
  lineageAtCommit,
  planDatasetDefinitionUpdate,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike, getBoolean, getOptionalBigIntLike, getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import {
  DATASET_SEQUENCE_COLUMN_COMMENT,
  type DuckLakeCatalogColumn,
  duckLakeCatalogColumnsToDatasetSchema,
  duckLakePrimaryKeyColumnComment,
} from "./ducklake-catalog-schema"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { readCurrentDatasetDefinitions } from "./ducklake-current-dataset-definitions"
import type { DatasetTableRef } from "./ducklake-dataset-table-ref"
import type { DuckLakeVersionSummary } from "./ducklake-snapshot-reader"
import {
  beginTransactionOnLatestVersion,
  commitVersionTransaction,
  type LatestVersionAtSnapshot,
  rerunWhenCatalogMoves,
} from "./ducklake-version-transaction"
import { encodeLineage } from "./lineage-encoding"
import { encodeDatasetSequenceTableName, encodeDatasetTableName } from "./names"
import { datasetColumnToDuckDbSql, datasetSchemaToDuckDbColumnsSql } from "./schema"
import {
  duckLakeAlias,
  duckLakeMetadataTableName,
  qualifiedTableName,
  quoteIdentifier,
  quoteSqlString,
} from "./sql"

/**
 * Reads the latest version of a dataset, which a schema change keeps the rows of, as
 * `BeginVersionTransactionInput.readLatestVersion`.
 */
export type LatestDatasetVersionReader = (
  runtime: DuckDbQueryRuntime,
  definition: DatasetDefinition
) => Promise<LatestVersionAtSnapshot<DuckLakeVersionSummary>>

export interface DatasetSchemaAtSnapshotRequest {
  readonly table: DatasetTableRef
  readonly snapshotId: string
}

/** A row of `ducklake_column`: one column of one table, alive over a snapshot range. */
interface DuckLakeColumnVersion {
  readonly tableId: bigint
  readonly beginSnapshot: bigint
  readonly endSnapshot?: bigint
  readonly column: Omit<DuckLakeCatalogColumn, "tableName">
}

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

  async createDataset(
    definition: DatasetDefinition,
    readLatestVersion: LatestDatasetVersionReader
  ): Promise<DatasetDefinition> {
    this.assertSchema(definition)

    // Step 1: read the current DuckLake table back into Sixb shape. The
    // existing definition is DuckLake's catalog state; the next definition is
    // the developer's current source definition.
    const existing = await this.getDataset(definition.id)

    if (existing) {
      // A schema change the catalog moved under, such as one another host applied concurrently,
      // reruns from the stored definition: it may have nothing left to change.
      const plan = await rerunWhenCatalogMoves(definition.id, async (attempt) => {
        const current = attempt === 1 ? existing : await this.getDataset(definition.id)
        if (!current) {
          throw new LakeStorageError(
            `[SixbDuckLake] Dataset '${definition.id}' was removed while its definition was updated.`
          )
        }

        const plan = planDatasetDefinitionUpdate(current, definition)
        if (plan.changed) {
          await this.applyExistingDatasetUpdate(plan, readLatestVersion)
        }

        return plan
      })

      if (plan.changed) {
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
    // one transaction and runtime slot so nothing can observe a partial definition.
    await this.connections.withExclusiveAttached(async (runtime) => {
      await runtime.run("BEGIN TRANSACTION")
      let committed = false
      try {
        await runtime.run(
          `CREATE TABLE ${qualifiedName} (${datasetSchemaToDuckDbColumnsSql(definition.schema)})`
        )

        if (definition.description !== undefined) {
          await runtime.run(
            `COMMENT ON TABLE ${qualifiedName} IS ${quoteSqlString(definition.description)}`
          )
        }

        await this.applyPrimaryKey(runtime, qualifiedName, definition)
        if (definition.sequenceBy !== undefined) {
          await runtime.run(
            `COMMENT ON COLUMN ${qualifiedName}.${quoteIdentifier(definition.sequenceBy)} IS ${quoteSqlString(DATASET_SEQUENCE_COLUMN_COMMENT)}`
          )
          await runtime.run(
            `CREATE TABLE ${qualifiedTableName(this.options, encodeDatasetSequenceTableName(definition.id))} (source_key VARCHAR NOT NULL, sequence VARCHAR NOT NULL, content VARCHAR)`
          )
        }
        await this.applyPartitionBy(runtime, qualifiedName, definition)

        await runtime.run("COMMIT")
        committed = true
      } catch (error) {
        if (!committed) {
          await this.rollbackTransaction(runtime)
        }
        throw error
      }
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

  /**
   * Dataset schemas at DuckLake snapshots, in request order, from one catalog read: a column row
   * is visible from its begin_snapshot until its end_snapshot, so the rows alive anywhere between
   * the oldest and the newest requested snapshot answer every request.
   */
  async getDatasetSchemasAtSnapshots(
    runtime: DuckDbQueryRuntime,
    requests: readonly DatasetSchemaAtSnapshotRequest[]
  ): Promise<readonly DatasetSchema[]> {
    if (requests.length === 0) {
      return []
    }

    for (const request of requests) {
      assertDuckLakeSnapshotId(request.snapshotId)
    }

    const snapshots = requests.map((request) => BigInt(request.snapshotId))
    const rows = await this.readDatasetColumnsBetweenSnapshots(
      runtime,
      requests.map((request) => request.table),
      snapshots.reduce((oldest, snapshot) => (snapshot < oldest ? snapshot : oldest)),
      snapshots.reduce((newest, snapshot) => (snapshot > newest ? snapshot : newest))
    )

    return requests.map(({ table, snapshotId }, index) => {
      const snapshot = snapshots[index]
      const columns = rows
        .filter(
          (row) =>
            row.tableId === table.tableId &&
            row.beginSnapshot <= snapshot &&
            (row.endSnapshot === undefined || row.endSnapshot > snapshot)
        )
        .map((row) => ({ tableName: table.tableName, ...row.column }))

      if (columns.length === 0) {
        throw new LakeStorageError(
          `[SixbDuckLake] Could not reconstruct schema for dataset '${table.datasetId}' at DuckLake snapshot '${snapshotId}'.`
        )
      }

      return duckLakeCatalogColumnsToDatasetSchema(table.tableName, columns)
    })
  }

  assertSchema(definition: DatasetDefinition): void {
    assertDatasetDefinition(
      definition,
      (message) => new LakeStorageError(`[SixbDuckLake] ${message}`)
    )
  }

  private async applyExistingDatasetUpdate(
    plan: DatasetDefinitionUpdatePlan,
    readLatestVersion: LatestDatasetVersionReader
  ): Promise<void> {
    const tableName = encodeDatasetTableName(plan.definition.id)
    const qualifiedName = qualifiedTableName(this.options, tableName)
    const { schema } = plan

    if (schema.kind === "none") {
      await this.connections.withExclusiveAttached((runtime) =>
        this.applyMetadataDelta(runtime, qualifiedName, plan)
      )
      return
    }

    // Schema-only DuckLake snapshots still matter to Sixb. Apply schema and
    // compatible metadata DDL atomically, then tag the commit so versions can
    // treat it as this dataset's schema-change version. It keeps the rows of
    // the latest version, and so its lineage. ALTER TABLE claims the table, and
    // changes no rows: it commits on the snapshot it read, or fails and reruns.
    await this.connections.withExclusiveAttached(async (runtime) => {
      let committed = false
      try {
        const parent = await beginTransactionOnLatestVersion({
          options: this.options,
          runtime,
          datasetId: plan.definition.id,
          readLatestVersion: () => readLatestVersion(runtime, plan.definition),
        })

        await this.applySchemaEvolutionDdl(runtime, qualifiedName, schema)
        await this.applyMetadataDelta(runtime, qualifiedName, plan)
        await this.setSchemaEvolutionCommitMetadata(
          runtime,
          plan.definition.id,
          schema,
          lineageAtCommit({ mode: "schema", schema: plan.definition.schema, parent })
        )

        await commitVersionTransaction(runtime, plan.definition.id, {
          poisonRuntime: () => this.connections.poisonRuntime(),
        })
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

  private async applyPrimaryKey(
    runtime: DuckDbQueryRuntime,
    qualifiedName: string,
    definition: DatasetDefinition
  ): Promise<void> {
    if (definition.primaryKey === undefined) {
      return
    }

    const columnNames =
      typeof definition.primaryKey === "string" ? [definition.primaryKey] : definition.primaryKey
    for (const [ordinal, columnName] of columnNames.entries()) {
      await runtime.run(
        `COMMENT ON COLUMN ${qualifiedName}.${quoteIdentifier(columnName)} IS ${quoteSqlString(
          duckLakePrimaryKeyColumnComment(ordinal)
        )}`
      )
    }
  }

  private async setSchemaEvolutionCommitMetadata(
    runtime: DuckDbQueryRuntime,
    datasetId: string,
    plan: Extract<DatasetSchemaUpdatePlan, { readonly kind: "addNullableColumns" }>,
    lineage: DatasetVersionLineage | undefined
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
            ...(lineage === undefined ? {} : { lineage: encodeLineage(lineage) }),
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

  private async readDatasetColumnsBetweenSnapshots(
    runtime: DuckDbQueryRuntime,
    tables: readonly DatasetTableRef[],
    oldestSnapshot: bigint,
    newestSnapshot: bigint
  ): Promise<readonly DuckLakeColumnVersion[]> {
    const tableIds = new Set(tables.map((table) => table.tableId))
    const ducklakeColumn = duckLakeMetadataTableName(this.options, "ducklake_column")
    const rows = await runtime.query(`
      SELECT
        table_id,
        column_id,
        column_order,
        column_name,
        column_type,
        CAST(nulls_allowed AS BOOLEAN) AS nulls_allowed,
        parent_column,
        begin_snapshot,
        end_snapshot
      FROM ${ducklakeColumn}
      WHERE table_id IN (${[...tableIds].join(", ")})
        AND begin_snapshot <= ${newestSnapshot}
        AND (end_snapshot IS NULL OR end_snapshot > ${oldestSnapshot})
      ORDER BY column_order, column_id
    `)

    return rows.map((row) => ({
      tableId: getBigIntLike(row, "table_id"),
      beginSnapshot: getBigIntLike(row, "begin_snapshot"),
      endSnapshot: getOptionalBigIntLike(row, "end_snapshot"),
      column: {
        columnId: getBigIntLike(row, "column_id"),
        columnOrder: getBigIntLike(row, "column_order"),
        columnName: getString(row, "column_name"),
        columnType: getString(row, "column_type"),
        nullsAllowed: getBoolean(row, "nulls_allowed"),
        parentColumnId: getOptionalBigIntLike(row, "parent_column"),
      },
    }))
  }
}

function assertDuckLakeSnapshotId(snapshotId: string): void {
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[SixbDuckLake] Invalid DuckLake snapshot id '${snapshotId}'.`)
  }
}

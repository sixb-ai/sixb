/**
 * DuckLake catalog connection settings.
 *
 * The catalog stores DuckLake metadata. Physical table data still lives under
 * `dataPath` and is managed by DuckLake, not by Pario sidecar tables.
 */
export type DuckLakeCatalogOptions =
  | { readonly type: "duckdb"; readonly path: string }
  | { readonly type: "sqlite"; readonly path: string }
  | PostgresDuckLakeCatalogOptions
  /** Escape hatch for DuckLake catalog URI forms Pario does not model yet. */
  | {
      readonly type: "custom"
      readonly uri: string
      readonly extensions?: readonly string[]
      readonly metadataParameters?: Readonly<Record<string, string>>
    }

/**
 * Friendly PostgreSQL catalog settings.
 *
 * The provider renders these to the libpq string required by DuckLake. Use
 * `custom` for raw DuckLake catalog URIs that need unsupported options.
 */
export interface PostgresDuckLakeCatalogOptions {
  readonly type: "postgres"
  readonly host: string
  readonly database: string
  readonly port?: number
  readonly user?: string
  readonly password?: string
  readonly sslMode?: "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full"
  readonly applicationName?: string
  readonly connectTimeoutSeconds?: number
  readonly metadataSchema?: string
  readonly parameters?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Runtime settings for the embedded DuckDB process that loads DuckLake.
 */
export interface DuckDbRuntimeOptions {
  readonly path?: string
  readonly config?: Readonly<Record<string, string>>
}

/**
 * DuckDB PostgreSQL extension pool settings for a Postgres-backed DuckLake
 * metadata catalog.
 */
export interface DuckLakePostgresPoolOptions {
  readonly maxConnections?: number
  readonly waitTimeoutMillis?: number
  readonly maxLifetimeMillis?: number
  readonly idleTimeoutMillis?: number
  readonly enableThreadLocalCache?: boolean
  readonly enableReaperThread?: boolean
  readonly healthCheckQuery?: string
}

/**
 * Common CREATE SECRET options shared by DuckDB object-store integrations.
 */
interface BaseSecretOptions {
  readonly name?: string
  readonly persistent?: boolean
  readonly scope?: string
}

/**
 * Shared options for DuckDB secrets that use the S3-compatible HTTPFS layer.
 *
 * R2 and GCS are modeled as first-class DuckDB secret types, but they still use
 * the same S3 API client under the hood.
 */
interface S3ApiSecretOptions extends BaseSecretOptions {
  readonly provider?: "config" | "credential_chain"
  readonly keyId?: string
  readonly secret?: string
  readonly sessionToken?: string
  readonly region?: string
  readonly endpoint?: string
  readonly urlStyle?: "path" | "vhost"
  readonly useSsl?: boolean
  readonly verifySsl?: boolean
  readonly chain?: string
  readonly profile?: string
}

export interface S3SecretOptions extends S3ApiSecretOptions {
  readonly type: "s3"
  readonly kmsKeyId?: string
  readonly requesterPays?: boolean
}

export interface R2SecretOptions extends S3ApiSecretOptions {
  readonly type: "r2"
  readonly accountId?: string
}

export interface GcsSecretOptions extends S3ApiSecretOptions {
  readonly type: "gcs"
}

export interface AzureSecretOptions extends BaseSecretOptions {
  readonly type: "azure"
  readonly connectionString?: string
  readonly accountName?: string
  readonly accountKey?: string
  readonly tenantId?: string
  readonly clientId?: string
  readonly clientSecret?: string
}

export type DuckDbSecretOptions =
  | S3SecretOptions
  | R2SecretOptions
  | GcsSecretOptions
  | AzureSecretOptions

/**
 * Public provider configuration for `new DuckLakeStorage(...)`.
 *
 * Defaults:
 * - `alias`: "pario_lake"
 * - `createIfNotExists`: true
 * - `readOnly`: false
 * - `duckdb.path`: ":memory:"
 */
export interface DuckLakeStorageOptions {
  readonly catalog: DuckLakeCatalogOptions
  readonly dataPath?: string
  readonly alias?: string
  readonly duckdb?: DuckDbRuntimeOptions
  readonly postgresPool?: DuckLakePostgresPoolOptions
  readonly secrets?: readonly DuckDbSecretOptions[]
  /** Runs after DuckLake/catalog extensions load and before ATTACH. */
  readonly setupSql?: readonly string[]
  readonly createIfNotExists?: boolean
  readonly readOnly?: boolean
}

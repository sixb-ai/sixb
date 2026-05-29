import { LakeStorageError } from "@pario/core"
import type {
  AzureSecretOptions,
  DuckDbSecretOptions,
  DuckLakeCatalogOptions,
  DuckLakeStorageOptions,
  GcsSecretOptions,
  PostgresDuckLakeCatalogOptions,
  R2SecretOptions,
  S3SecretOptions,
} from "../types"

const DEFAULT_ALIAS = "pario_lake"

/**
 * Resolve the DuckLake attachment alias used by all provider SQL.
 */
export function duckLakeAlias(options: Pick<DuckLakeStorageOptions, "alias">): string {
  return options.alias ?? DEFAULT_ALIAS
}

/**
 * DuckLake exposes catalog metadata through an attached DuckDB database whose
 * name is derived from the user-facing DuckLake alias.
 */
function duckLakeMetadataCatalog(options: Pick<DuckLakeStorageOptions, "alias">): string {
  return `__ducklake_metadata_${duckLakeAlias(options)}`
}

/**
 * Configure the PostgreSQL extension pool used by DuckLake's attached metadata
 * catalog. DuckDB worker threads can otherwise pin pooled Postgres connections
 * in the thread-local cache until the pool is exhausted during repeated
 * DuckLake metadata reads.
 */
export function buildConfigurePostgresMetadataPoolSql(
  options: Pick<DuckLakeStorageOptions, "alias" | "postgresPool">
): string {
  const parameters = [
    `catalog_name=${quoteSqlString(duckLakeMetadataCatalog(options))}`,
    ...postgresPoolParameters(options.postgresPool).map(({ name, value }) => `${name}=${value}`),
  ]

  return `FROM postgres_configure_pool(${parameters.join(", ")})`
}

/**
 * Configure DuckDB's PostgreSQL extension before ATTACH. These settings only
 * affect databases attached after they are set.
 */
export function buildSetPostgresPoolSql(
  options: Pick<DuckLakeStorageOptions, "postgresPool">
): readonly string[] {
  return postgresPoolParameters(options.postgresPool).map(
    ({ name, value }) => `SET pg_pool_${name} = ${value}`
  )
}

/**
 * Render a fully-qualified DuckLake metadata table path.
 *
 * PostgreSQL catalogs expose DuckLake metadata tables under the configured
 * metadata schema inside the attached metadata catalog. Local catalogs use
 * DuckDB's default `main` schema.
 */
export function duckLakeMetadataTableName(
  options: Pick<DuckLakeStorageOptions, "alias" | "catalog">,
  tableName: string
): string {
  const schemaName =
    options.catalog.type === "postgres" ? (options.catalog.metadataSchema ?? "main") : "main"

  return `${quoteIdentifier(duckLakeMetadataCatalog(options))}.${quoteIdentifier(
    schemaName
  )}.${quoteIdentifier(tableName)}`
}

/**
 * Quote a SQL identifier after validating it is already identifier-shaped.
 *
 * Dataset table names are produced by `names.ts`; user text should never be
 * passed here without first going through a deterministic encoder.
 */
export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new LakeStorageError(`[ParioDuckLake] Invalid SQL identifier '${identifier}'.`)
  }

  return `"${identifier}"`
}

/**
 * Quote a SQL string literal for DDL statements that DuckDB does not parameterize.
 */
export function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Render a fully-qualified table path.
 */
export function qualifiedTableName(
  options: Pick<DuckLakeStorageOptions, "alias">,
  tableName: string
): string {
  return `${quoteIdentifier(duckLakeAlias(options))}.main.${quoteIdentifier(tableName)}`
}

/**
 * Build the catalog URI expected by DuckLake's ATTACH statement.
 */
export function catalogUri(catalog: DuckLakeCatalogOptions): string {
  switch (catalog.type) {
    case "duckdb":
      return `ducklake:${catalog.path}`
    case "sqlite":
      return `ducklake:sqlite:${catalog.path}`
    case "postgres":
      return `ducklake:postgres:${postgresConnectionString(catalog)}`
    case "custom":
      return `ducklake:${catalog.uri}`
  }
}

/**
 * Render typed PostgreSQL options to the libpq connection string DuckLake expects.
 */
export function postgresConnectionString(catalog: PostgresDuckLakeCatalogOptions): string {
  const parameters: string[] = []
  const names = new Set<string>()

  appendPostgresConnectionParameter(parameters, names, "dbname", catalog.database)
  appendPostgresConnectionParameter(parameters, names, "host", catalog.host)
  appendPostgresConnectionParameter(parameters, names, "port", catalog.port)
  appendPostgresConnectionParameter(parameters, names, "user", catalog.user)
  appendPostgresConnectionParameter(parameters, names, "password", catalog.password)
  appendPostgresConnectionParameter(parameters, names, "sslmode", catalog.sslMode)
  appendPostgresConnectionParameter(parameters, names, "application_name", catalog.applicationName)
  appendPostgresConnectionParameter(
    parameters,
    names,
    "connect_timeout",
    catalog.connectTimeoutSeconds
  )

  for (const [name, value] of Object.entries(catalog.parameters ?? {})) {
    appendPostgresConnectionParameter(parameters, names, name, value)
  }

  return parameters.join(" ")
}

/**
 * Catalog extensions that must be available before ATTACH.
 */
function catalogExtensions(catalog: DuckLakeCatalogOptions): readonly string[] {
  switch (catalog.type) {
    case "duckdb":
      return []
    case "sqlite":
      return ["sqlite"]
    case "postgres":
      return ["postgres"]
    case "custom":
      return catalog.extensions ?? []
  }
}

/**
 * Extensions needed by the catalog, data path, and typed secrets.
 */
export function requiredExtensions(options: DuckLakeStorageOptions): readonly string[] {
  const extensions = new Set<string>(catalogExtensions(options.catalog))

  for (const extension of storageExtensions(options.dataPath)) {
    extensions.add(extension)
  }

  for (const secret of options.secrets ?? []) {
    for (const extension of secretExtensions(secret)) {
      extensions.add(extension)
    }
  }

  return [...extensions]
}

/**
 * Build a typed DuckDB CREATE SECRET statement.
 */
export function buildCreateSecretSql(secret: DuckDbSecretOptions): string {
  const persistence = secret.persistent ? "PERSISTENT " : "TEMPORARY "
  const nameSql = secret.name === undefined ? "" : `${quoteIdentifier(secret.name)} `
  return `CREATE OR REPLACE ${persistence}SECRET ${nameSql}(${secretParameters(secret).join(", ")})`
}

/**
 * Build the DuckLake ATTACH statement from public provider options.
 */
export function buildAttachSql(options: DuckLakeStorageOptions): string {
  const parameters: string[] = []

  if (options.dataPath !== undefined) {
    parameters.push(`DATA_PATH ${quoteSqlString(options.dataPath)}`)
  }

  parameters.push(`CREATE_IF_NOT_EXISTS ${options.createIfNotExists ?? true}`)

  if (options.readOnly) {
    parameters.push("READ_ONLY")
  }

  if (options.catalog.type === "postgres" && options.catalog.metadataSchema !== undefined) {
    parameters.push(`METADATA_SCHEMA ${quoteSqlString(options.catalog.metadataSchema)}`)
  }

  if (
    options.catalog.type === "custom" &&
    options.catalog.metadataParameters !== undefined &&
    Object.keys(options.catalog.metadataParameters).length > 0
  ) {
    const entries = Object.entries(options.catalog.metadataParameters).map(
      ([key, value]) => `${quoteSqlString(key)}: ${quoteSqlString(value)}`
    )
    parameters.push(`METADATA_PARAMETERS MAP {${entries.join(", ")}}`)
  }

  return `ATTACH ${quoteSqlString(catalogUri(options.catalog))} AS ${quoteIdentifier(
    duckLakeAlias(options)
  )} (${parameters.join(", ")})`
}

function storageExtensions(path: string | undefined): readonly string[] {
  if (path === undefined) {
    return []
  }

  switch (pathScheme(path)) {
    case "s3":
    case "r2":
    case "gcs":
    case "gs":
      return ["httpfs"]
    case "az":
    case "azure":
    case "abfss":
      return ["azure"]
    default:
      return []
  }
}

/**
 * The single source of truth for PostgreSQL pool options. Both the pre-attach
 * `SET pg_pool_*` form and the post-attach `postgres_configure_pool(...)` form
 * render from this list so the two stay in sync. `name` is the unprefixed
 * option key; `value` is already rendered (numbers/booleans bare, strings
 * quoted as SQL literals).
 */
function postgresPoolParameters(
  pool: DuckLakeStorageOptions["postgresPool"]
): readonly { readonly name: string; readonly value: string }[] {
  const parameters: { name: string; value: string }[] = [
    { name: "enable_thread_local_cache", value: String(pool?.enableThreadLocalCache ?? false) },
  ]

  appendPoolNumber(parameters, "max_connections", pool?.maxConnections)
  appendPoolNumber(parameters, "wait_timeout_millis", pool?.waitTimeoutMillis)
  appendPoolNumber(parameters, "max_lifetime_millis", pool?.maxLifetimeMillis)
  appendPoolNumber(parameters, "idle_timeout_millis", pool?.idleTimeoutMillis)

  if (pool?.enableReaperThread !== undefined) {
    parameters.push({ name: "enable_reaper_thread", value: String(pool.enableReaperThread) })
  }

  if (pool?.healthCheckQuery !== undefined) {
    parameters.push({ name: "health_check_query", value: quoteSqlString(pool.healthCheckQuery) })
  }

  return parameters
}

function appendPoolNumber(
  parameters: { name: string; value: string }[],
  name: string,
  value: number | undefined
): void {
  if (value === undefined) {
    return
  }

  parameters.push({ name, value: String(value) })
}

function secretExtensions(secret: DuckDbSecretOptions): readonly string[] {
  switch (secret.type) {
    case "s3":
    case "r2":
    case "gcs":
      return ["httpfs"]
    case "azure":
      return ["azure"]
  }
}

function secretParameters(secret: DuckDbSecretOptions): readonly string[] {
  switch (secret.type) {
    case "s3":
      return withCommonSecretParameters(secret, [
        "TYPE s3",
        ...s3ApiSecretParameters(secret),
        ...optionalStringParameter("KMS_KEY_ID", secret.kmsKeyId),
        ...optionalBooleanParameter("REQUESTER_PAYS", secret.requesterPays),
      ])
    case "r2":
      return withCommonSecretParameters(secret, [
        "TYPE r2",
        ...s3ApiSecretParameters(secret),
        ...optionalStringParameter("ACCOUNT_ID", secret.accountId),
      ])
    case "gcs":
      return withCommonSecretParameters(secret, ["TYPE gcs", ...s3ApiSecretParameters(secret)])
    case "azure":
      return withCommonSecretParameters(secret, azureSecretParameters(secret))
  }
}

function s3ApiSecretParameters(
  secret: S3SecretOptions | R2SecretOptions | GcsSecretOptions
): readonly string[] {
  return [
    ...optionalIdentifierParameter("PROVIDER", secret.provider),
    ...optionalStringParameter("KEY_ID", secret.keyId),
    ...optionalStringParameter("SECRET", secret.secret),
    ...optionalStringParameter("SESSION_TOKEN", secret.sessionToken),
    ...optionalStringParameter("REGION", secret.region),
    ...optionalStringParameter("ENDPOINT", secret.endpoint),
    ...optionalStringParameter("URL_STYLE", secret.urlStyle),
    ...optionalBooleanParameter("USE_SSL", secret.useSsl),
    ...optionalBooleanParameter("VERIFY_SSL", secret.verifySsl),
    ...optionalStringParameter("CHAIN", secret.chain),
    ...optionalStringParameter("PROFILE", secret.profile),
  ]
}

function azureSecretParameters(secret: AzureSecretOptions): readonly string[] {
  if (
    secret.tenantId !== undefined ||
    secret.clientId !== undefined ||
    secret.clientSecret !== undefined
  ) {
    return [
      "TYPE azure",
      "PROVIDER service_principal",
      ...optionalStringParameter("TENANT_ID", secret.tenantId),
      ...optionalStringParameter("CLIENT_ID", secret.clientId),
      ...optionalStringParameter("CLIENT_SECRET", secret.clientSecret),
      ...optionalStringParameter("ACCOUNT_NAME", secret.accountName),
    ]
  }

  const connectionString =
    secret.connectionString ??
    (secret.accountName !== undefined && secret.accountKey !== undefined
      ? `DefaultEndpointsProtocol=https;AccountName=${secret.accountName};AccountKey=${secret.accountKey};EndpointSuffix=core.windows.net`
      : undefined)

  if (connectionString !== undefined) {
    return ["TYPE azure", ...optionalStringParameter("CONNECTION_STRING", connectionString)]
  }

  return [
    "TYPE azure",
    "PROVIDER credential_chain",
    ...optionalStringParameter("ACCOUNT_NAME", secret.accountName),
  ]
}

function withCommonSecretParameters(
  secret: DuckDbSecretOptions,
  parameters: readonly string[]
): readonly string[] {
  return [...parameters, ...optionalStringParameter("SCOPE", secret.scope)]
}

function optionalStringParameter(name: string, value: string | undefined): readonly string[] {
  return value === undefined ? [] : [`${name} ${quoteSqlString(value)}`]
}

function optionalBooleanParameter(name: string, value: boolean | undefined): readonly string[] {
  return value === undefined ? [] : [`${name} ${value}`]
}

function optionalIdentifierParameter(name: string, value: string | undefined): readonly string[] {
  if (value === undefined) {
    return []
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new LakeStorageError(`[ParioDuckLake] Invalid SQL identifier '${value}'.`)
  }

  return [`${name} ${value}`]
}

function appendPostgresConnectionParameter(
  parameters: string[],
  names: Set<string>,
  name: string,
  value: string | number | boolean | undefined
): void {
  if (value === undefined) {
    return
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new LakeStorageError(`[ParioDuckLake] Invalid PostgreSQL catalog parameter '${name}'.`)
  }

  const normalizedName = name.toLowerCase()
  if (names.has(normalizedName)) {
    throw new LakeStorageError(`[ParioDuckLake] Duplicate PostgreSQL catalog parameter '${name}'.`)
  }

  names.add(normalizedName)
  parameters.push(`${name}=${quotePostgresConnectionValue(String(value))}`)
}

function quotePostgresConnectionValue(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
}

function pathScheme(path: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)
  return match ? match[1].toLowerCase() : null
}

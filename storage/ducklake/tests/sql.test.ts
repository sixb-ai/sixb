import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localCatalogCoordinationKey } from "../src/internal/catalog-key"
import {
  buildAttachSql,
  buildConfigurePostgresMetadataPoolSql,
  buildCreateSecretSql,
  buildSetPostgresPoolSql,
  catalogUri,
  duckLakeMetadataTableName,
  postgresConnectionString,
  requiredExtensions,
} from "../src/internal/sql"

describe("DuckLake SQL rendering", () => {
  test("builds catalog URIs", () => {
    expect(catalogUri({ type: "duckdb", path: "metadata.ducklake" })).toBe(
      "ducklake:metadata.ducklake"
    )
    expect(catalogUri({ type: "sqlite", path: "metadata.sqlite" })).toBe(
      "ducklake:sqlite:metadata.sqlite"
    )
    expect(catalogUri({ type: "postgres", host: "127.0.0.1", database: "ducklake" })).toBe(
      "ducklake:postgres:dbname='ducklake' host='127.0.0.1'"
    )
    expect(catalogUri({ type: "custom", uri: "secret_name" })).toBe("ducklake:secret_name")
  })

  test("builds PostgreSQL connection strings from typed catalog options", () => {
    expect(
      postgresConnectionString({
        type: "postgres",
        host: "db.example.com",
        port: 5432,
        database: "duck lake",
        user: "sixb",
        password: "pa'ss\\word",
        sslMode: "require",
        applicationName: "sixb worker",
        connectTimeoutSeconds: 10,
        parameters: {
          keepalives: true,
        },
      })
    ).toBe(
      "dbname='duck lake' host='db.example.com' port='5432' user='sixb' password='pa\\'ss\\\\word' sslmode='require' application_name='sixb worker' connect_timeout='10' keepalives='true'"
    )

    expect(() =>
      postgresConnectionString({
        type: "postgres",
        host: "db.example.com",
        database: "ducklake",
        parameters: { host: "other.example.com" },
      })
    ).toThrow("Duplicate PostgreSQL catalog parameter 'host'")
  })

  test("builds attach SQL with catalog options", () => {
    expect(
      buildAttachSql({
        alias: "lake",
        catalog: {
          type: "postgres",
          host: "127.0.0.1",
          port: 5432,
          database: "ducklake",
          user: "postgres",
          password: "test",
          metadataSchema: "sixb_meta",
        },
        dataPath: "s3://bucket/lake",
        createIfNotExists: false,
        readOnly: true,
      })
    ).toBe(
      "ATTACH 'ducklake:postgres:dbname=''ducklake'' host=''127.0.0.1'' port=''5432'' user=''postgres'' password=''test''' AS \"lake\" (DATA_PATH 's3://bucket/lake', CREATE_IF_NOT_EXISTS false, READ_ONLY, METADATA_SCHEMA 'sixb_meta')"
    )

    expect(
      buildAttachSql({
        catalog: {
          type: "custom",
          uri: "custom:catalog",
          metadataParameters: { sslmode: "require", application_name: "sixb" },
        },
      })
    ).toBe(
      "ATTACH 'ducklake:custom:catalog' AS \"sixb_lake\" (CREATE_IF_NOT_EXISTS true, METADATA_PARAMETERS MAP {'sslmode': 'require', 'application_name': 'sixb'})"
    )
  })

  test("builds metadata table names for local and PostgreSQL catalogs", () => {
    expect(
      duckLakeMetadataTableName(
        {
          catalog: { type: "duckdb", path: "metadata.ducklake" },
        },
        "ducklake_table"
      )
    ).toBe('"__ducklake_metadata_sixb_lake"."main"."ducklake_table"')

    expect(
      duckLakeMetadataTableName(
        {
          alias: "lake",
          catalog: {
            type: "postgres",
            host: "127.0.0.1",
            database: "postgres",
            metadataSchema: "sixb_meta",
          },
        },
        "ducklake_snapshot"
      )
    ).toBe('"__ducklake_metadata_lake"."sixb_meta"."ducklake_snapshot"')
  })

  test("builds PostgreSQL metadata pool configuration SQL", () => {
    expect(buildConfigurePostgresMetadataPoolSql({ alias: "lake" })).toBe(
      "FROM postgres_configure_pool(catalog_name='__ducklake_metadata_lake', enable_thread_local_cache=false)"
    )

    expect(
      buildSetPostgresPoolSql({
        postgresPool: {
          maxConnections: 4,
          waitTimeoutMillis: 10_000,
          idleTimeoutMillis: 1_000,
          enableThreadLocalCache: false,
          enableReaperThread: true,
          healthCheckQuery: "SELECT 1",
        },
      })
    ).toEqual([
      "SET pg_pool_enable_thread_local_cache = false",
      "SET pg_pool_max_connections = 4",
      "SET pg_pool_wait_timeout_millis = 10000",
      "SET pg_pool_idle_timeout_millis = 1000",
      "SET pg_pool_enable_reaper_thread = true",
      "SET pg_pool_health_check_query = 'SELECT 1'",
    ])

    expect(
      buildConfigurePostgresMetadataPoolSql({
        alias: "lake",
        postgresPool: {
          maxConnections: 4,
          waitTimeoutMillis: 10_000,
          idleTimeoutMillis: 1_000,
          enableThreadLocalCache: false,
          enableReaperThread: true,
          healthCheckQuery: "SELECT 1",
        },
      })
    ).toBe(
      "FROM postgres_configure_pool(catalog_name='__ducklake_metadata_lake', enable_thread_local_cache=false, max_connections=4, wait_timeout_millis=10000, idle_timeout_millis=1000, enable_reaper_thread=true, health_check_query='SELECT 1')"
    )
  })

  test("loads extensions required by catalogs, data paths, and secrets", () => {
    expect(
      requiredExtensions({
        catalog: { type: "postgres", host: "127.0.0.1", database: "ducklake" },
        dataPath: "s3://bucket/lake",
        secrets: [{ type: "azure", accountName: "storage" }],
      })
    ).toEqual(["postgres", "httpfs", "azure"])

    expect(
      requiredExtensions({
        catalog: { type: "custom", uri: "custom", extensions: ["sqlite", "httpfs"] },
        dataPath: "az://container/lake",
        secrets: [{ type: "s3", keyId: "key", secret: "secret" }],
      })
    ).toEqual(["sqlite", "httpfs", "azure"])
  })

  test("builds typed DuckDB secrets", () => {
    expect(
      buildCreateSecretSql({
        type: "s3",
        name: "minio",
        keyId: "sixb",
        secret: "sixb-secret",
        region: "us-east-1",
        endpoint: "127.0.0.1:9000",
        urlStyle: "path",
        useSsl: false,
        scope: "s3://bucket",
      })
    ).toBe(
      "CREATE OR REPLACE TEMPORARY SECRET \"minio\" (TYPE s3, KEY_ID 'sixb', SECRET 'sixb-secret', REGION 'us-east-1', ENDPOINT '127.0.0.1:9000', URL_STYLE 'path', USE_SSL false, SCOPE 's3://bucket')"
    )

    expect(
      buildCreateSecretSql({
        type: "r2",
        persistent: true,
        accountId: "account",
        keyId: "key",
        secret: "secret",
      })
    ).toBe(
      "CREATE OR REPLACE PERSISTENT SECRET (TYPE r2, KEY_ID 'key', SECRET 'secret', ACCOUNT_ID 'account')"
    )

    expect(
      buildCreateSecretSql({
        type: "gcs",
        provider: "credential_chain",
        chain: "env;config",
        keyId: "key",
        secret: "secret",
        sessionToken: "token",
        verifySsl: false,
      })
    ).toBe(
      "CREATE OR REPLACE TEMPORARY SECRET (TYPE gcs, PROVIDER credential_chain, KEY_ID 'key', SECRET 'secret', SESSION_TOKEN 'token', VERIFY_SSL false, CHAIN 'env;config')"
    )

    expect(
      buildCreateSecretSql({
        type: "azure",
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        accountName: "storage",
      })
    ).toBe(
      "CREATE OR REPLACE TEMPORARY SECRET (TYPE azure, PROVIDER service_principal, TENANT_ID 'tenant', CLIENT_ID 'client', CLIENT_SECRET 'secret', ACCOUNT_NAME 'storage')"
    )

    expect(
      buildCreateSecretSql({
        type: "azure",
        accountName: "storage",
        accountKey: "account-key",
      })
    ).toBe(
      "CREATE OR REPLACE TEMPORARY SECRET (TYPE azure, CONNECTION_STRING 'DefaultEndpointsProtocol=https;AccountName=storage;AccountKey=account-key;EndpointSuffix=core.windows.net')"
    )
  })

  test("normalizes local catalog coordination keys", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-catalog-key-"))

    try {
      await mkdir(join(rootDir, "alias"))
      const directPath = join(rootDir, "metadata.ducklake")
      const equivalentPath = `${rootDir}/alias/../metadata.ducklake`

      expect(
        localCatalogCoordinationKey({
          catalog: { type: "duckdb", path: directPath },
        })
      ).toBe(
        localCatalogCoordinationKey({
          catalog: { type: "duckdb", path: equivalentPath },
        })
      )
      expect(
        localCatalogCoordinationKey({
          catalog: { type: "sqlite", path: directPath },
        })
      ).toBe(
        localCatalogCoordinationKey({
          catalog: { type: "sqlite", path: equivalentPath },
        })
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

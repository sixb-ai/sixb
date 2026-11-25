export { checkStorageSchema, type StorageSchemaCheck } from "./check-schema"
export { isMigrationCapableStorage, migrateStorage } from "./migrate-storage"
export {
  defineMigrations,
  defineStorageMigrations,
  describeMigrationHistory,
  runMigrationSet,
  step,
} from "./migration-set"
export type {
  TypeShapeCheck,
  TypeShapeFinding,
  TypeShapeMode,
  TypeShapeTypeCheck,
} from "./type-shapes"
export type {
  DefineMigrationsOptions,
  DefineStorageMigrationsOptions,
  MigrationCapableStorage,
  MigrationHistoryStore,
  MigrationRecord,
  MigrationReport,
  MigrationSet,
  MigrationState,
  MigrationStatus,
  MigrationStep,
  MigrationStepInfo,
  MigrationStepOptions,
  StorageMigrationOptions,
  StorageMigrationResult,
  StorageMigrator,
} from "./types"

/**
 * Every long-running production role, and what its startup has to know about itself.
 *
 * Total over the role union on purpose: a new role does not compile until it answers both
 * questions here.
 */
const PRODUCTION_ROLES = {
  api: { onEventPlane: true, usesStorageSchema: true },
  rules: { onEventPlane: true, usesStorageSchema: true },
  scheduler: { onEventPlane: true, usesStorageSchema: true },
  orchestrator: { onEventPlane: true, usesStorageSchema: true },
  worker: { onEventPlane: true, usesStorageSchema: true },
  "worker-group": { onEventPlane: true, usesStorageSchema: true },
  atlas: { onEventPlane: false, usesStorageSchema: false },
  app: { onEventPlane: false, usesStorageSchema: false },
} as const satisfies Record<string, ProductionRoleFacts>

interface ProductionRoleFacts {
  /**
   * Whether the role publishes to or claims from the event plane. `atlas` and `app` only serve
   * a browser bundle, so refusing to boot them on a process-local provider would block a valid
   * UI-only container.
   */
  readonly onEventPlane: boolean

  /**
   * Whether the role should bring the storage schema up to date at startup. `atlas` and `app`
   * are the tier facing the internet, and a container serving a bundle has no business holding
   * a DDL grant.
   */
  readonly usesStorageSchema: boolean
}

export type ProductionRole = keyof typeof PRODUCTION_ROLES

/**
 * The roles that migrate storage at startup, derived from the map rather than restated: a role
 * declared `usesStorageSchema: false` cannot be passed to `migrateStorageForRole` at all.
 */
export type StorageSchemaRole = {
  [Role in ProductionRole]: (typeof PRODUCTION_ROLES)[Role]["usesStorageSchema"] extends true
    ? Role
    : never
}[ProductionRole]

export function productionRoleFacts(role: ProductionRole): ProductionRoleFacts {
  return PRODUCTION_ROLES[role]
}

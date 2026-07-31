/**
 * Every long-running production role, and the facts a role's startup has to know
 * about itself.
 *
 * This is a total map over the role union on purpose. A new role does not compile
 * until it appears here, which forces both questions to be answered once rather than
 * discovered in production.
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
   * Whether the role publishes to or claims from the event plane.
   *
   * `atlas` and `app` only serve a browser bundle: they read `auth.isEnabled()` and
   * the project id off the runtime and never touch the broker or the queues, so a
   * process-local provider cannot hurt them and refusing to boot would block a valid
   * UI-only container.
   */
  readonly onEventPlane: boolean

  /**
   * Whether the role reads or writes through the storage schema, and therefore whether
   * it should bring that schema up to date at startup.
   *
   * `atlas` and `app` are excluded for the same reason they are off the event plane,
   * plus one of their own: they are the tier you put in front of the internet, and a
   * container that serves a bundle has no business holding a DDL grant.
   */
  readonly usesStorageSchema: boolean
}

export type ProductionRole = keyof typeof PRODUCTION_ROLES

/**
 * The roles that migrate storage at startup, derived from the map rather than restated.
 *
 * Narrowing the type is what keeps the decision in one place: a role declared
 * `usesStorageSchema: false` cannot be passed to `migrateStorageForRole`, so the two
 * cannot drift and there is no runtime branch that only ever returns "not my job".
 */
export type StorageSchemaRole = {
  [Role in ProductionRole]: (typeof PRODUCTION_ROLES)[Role]["usesStorageSchema"] extends true
    ? Role
    : never
}[ProductionRole]

export function productionRoleFacts(role: ProductionRole): ProductionRoleFacts {
  return PRODUCTION_ROLES[role]
}

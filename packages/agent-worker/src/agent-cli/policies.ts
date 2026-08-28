export const CLI_LIMITS = {
  list: { default: 20, maximum: 1_000 },
  search: { default: 20, maximum: 50 },
  telemetryHistory: { default: 100, maximum: 1_000 },
  linkPage: { default: 100, maximum: 1_000 },
  inspect: {
    depth: { default: 2, maximum: 3 },
    objects: { default: 20, maximum: 100 },
    links: { default: 50, maximum: 500 },
    maximumPages: 10,
  },
} as const

export const DEFAULT_LIST_ORDER = "desc" as const
export const DEFAULT_OBJECT_ORDER_BY = "updatedAt" as const
export const DEFAULT_TELEMETRY_ORDER = "desc" as const

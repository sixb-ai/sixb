export const JSON_CONTENT_TYPE = "application/json"

// Internal HTTP page size for the auto-pagination loop. Collections are
// returned in full to consumers; this only controls per-request batch size.
export const PAGE_SIZE = 500

// Hard ceiling for `listDatasetVersions`, which the upstream API does not
// expose as an offset-paginable endpoint (only `limit`).
export const DATASET_VERSION_MAX = 500

export const OBJECT_LIST_ORDER_BY = "primaryId"
export const OBJECT_LIST_ORDER = "asc"
export const SYNC_RUN_LIST_ORDER = "desc"

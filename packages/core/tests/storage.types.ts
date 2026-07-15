import type {
  ObjectQueryCapabilities,
  ObjectStorage,
  QueryObjectsInput,
  QueryObjectsResult,
} from "../src/storage"

const capabilities: ObjectQueryCapabilities = {
  queryObjects: true,
  nodes: {
    start: true,
    filter: true,
    limit: true,
  },
  predicateOps: {
    and: true,
    eq: true,
  },
  sortKinds: {
    property: true,
  },
  traversalDirections: {
    outgoing: true,
  },
  setOps: {
    union: true,
  },
  limits: {
    maxLimit: 100,
    totalCount: true,
  },
}

const queryObjects = async (input: QueryObjectsInput): Promise<QueryObjectsResult> => {
  void input.projectId
  void input.query
  return {
    objects: [],
    hasMore: false,
    total: 0,
  }
}

const providerQuerySurface: Pick<ObjectStorage, "queryCapabilities" | "queryObjects"> = {
  queryCapabilities: () => capabilities,
  queryObjects,
}

void providerQuerySurface

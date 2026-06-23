/**
 * Browser-safe object query entrypoint (`@sixb/core/query`).
 *
 * Exposes the query IR, the fluent builder, and the executor contract without
 * pulling in the server runtime. `@sixb/client` builds its HTTP executor on
 * top of this module.
 */

export type { ObjectQueryPlanningIssue } from "./objects/query/errors"
export {
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
} from "./objects/query/errors"
export type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryDirection,
  ObjectQueryExpand,
  ObjectQueryFilter,
  ObjectQueryLimit,
  ObjectQueryPage,
  ObjectQueryPredicate,
  ObjectQueryPredicateComparison,
  ObjectQueryPredicateContains,
  ObjectQueryPredicateExists,
  ObjectQueryPredicateGroup,
  ObjectQueryPredicateIn,
  ObjectQueryPredicateNot,
  ObjectQueryProject,
  ObjectQueryResultShape,
  ObjectQuerySet,
  ObjectQuerySetOperation,
  ObjectQuerySort,
  ObjectQuerySortDirection,
  ObjectQuerySortField,
  ObjectQueryStart,
  ObjectQueryText,
  ObjectQueryTraverse,
  ObjectQueryVector,
} from "./objects/query/ir"
export { normalizeObjectQuery } from "./objects/query/normalize"
export { createObjectQueryBuilder } from "./objects/sdk/query-builder"
export type {
  ObjectQueryExecutor,
  ObjectQueryExecutorExpandedRow,
  ObjectQueryExecutorFacetRequest,
  ObjectQueryExecutorLinks,
  ObjectQueryExecutorLinkValue,
  ObjectQueryExecutorListResult,
  ObjectQueryExecutorRow,
} from "./objects/sdk/query-executor"
export type {
  LinkToken,
  ObjectTypeWithPropertyTokens,
  ObjectTypeWithTokens,
  PropertyToken,
} from "./ontology/tokens"
export type { ValueType } from "./ontology/types"
export type {
  ListResult,
  ListResultWithoutTotal,
  ObjectExpandBuilder,
  ObjectExpandOptions,
  ObjectExpansionSort,
  ObjectQueryBuilder,
  ObjectQueryFacetBucket,
  ObjectQueryFacetInput,
  ObjectQueryFacetResult,
  ObjectQueryListOptions,
  ObjectQueryRow,
  ObjectWhereBuilder,
  ObjectWhereClause,
  TwinObject,
} from "./runtime/types"

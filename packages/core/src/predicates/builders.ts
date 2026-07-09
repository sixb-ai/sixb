import type {
  LinkPredicate,
  LinkPredicateBuilder,
  Predicate,
  PredicateValue,
  PropertyPredicate,
  PropertyPredicateOperator,
} from "./types"
import { isPredicateValue } from "./validation"

export type RuntimePropertyPredicateBuilder<TResult = PropertyPredicate> = {
  eq(value: PredicateValue): TResult
  notEq(value: PredicateValue): TResult
  gt(value: PredicateValue): TResult
  gte(value: PredicateValue): TResult
  lt(value: PredicateValue): TResult
  lte(value: PredicateValue): TResult
  isPresent(): TResult
  isMissing(): TResult
}

export type PropertyPredicateBuilderOptions<TResult> = {
  readonly subject?: string
  readonly createError?: (message: string) => Error
  readonly wrap?: (predicate: PropertyPredicate) => TResult
}

function defaultError(message: string): Error {
  return new Error(message)
}

function assertSerializablePredicateValue(
  value: PredicateValue,
  subject: string,
  createError: (message: string) => Error
): void {
  if (!isPredicateValue(value)) {
    throw createError(`${subject} predicate values must be serializable scalar values.`)
  }
}

export function createPropertyPredicate(
  propertyId: string,
  op: PropertyPredicateOperator,
  value?: PredicateValue,
  options: Pick<PropertyPredicateBuilderOptions<unknown>, "subject" | "createError"> = {}
): PropertyPredicate {
  const subject = options.subject ?? "Predicate"
  const createError = options.createError ?? defaultError
  if (value !== undefined) {
    assertSerializablePredicateValue(value, subject, createError)
  }

  return {
    kind: "property",
    propertyId,
    op,
    ...(value !== undefined ? { value } : {}),
  }
}

export function createPropertyPredicateBuilder<TResult = PropertyPredicate>(
  propertyId: string,
  options: PropertyPredicateBuilderOptions<TResult> = {}
): RuntimePropertyPredicateBuilder<TResult> {
  const wrap = options.wrap ?? ((predicate: PropertyPredicate) => predicate as TResult)
  const createPredicate = (op: PropertyPredicateOperator, value?: PredicateValue) =>
    wrap(createPropertyPredicate(propertyId, op, value, options))

  return {
    eq(value) {
      return createPredicate("eq", value)
    },
    notEq(value) {
      return createPredicate("notEq", value)
    },
    gt(value) {
      return createPredicate("gt", value)
    },
    gte(value) {
      return createPredicate("gte", value)
    },
    lt(value) {
      return createPredicate("lt", value)
    },
    lte(value) {
      return createPredicate("lte", value)
    },
    isPresent() {
      return createPredicate("isPresent")
    },
    isMissing() {
      return createPredicate("isMissing")
    },
  }
}

export function createLinkPredicateBuilder(linkId: string): LinkPredicateBuilder {
  return {
    exists(): LinkPredicate {
      return {
        kind: "link",
        linkId,
        op: "exists",
      }
    },
    isMissing(): LinkPredicate {
      return {
        kind: "link",
        linkId,
        op: "isMissing",
      }
    },
  }
}

export function allPredicates(predicates: readonly Predicate[]): Predicate {
  return {
    kind: "all",
    predicates: [...predicates],
  }
}

export function anyPredicates(predicates: readonly Predicate[]): Predicate {
  return {
    kind: "any",
    predicates: [...predicates],
  }
}

export function notPredicate(predicate: Predicate): Predicate {
  return {
    kind: "not",
    predicate,
  }
}

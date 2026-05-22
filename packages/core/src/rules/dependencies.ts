import type { RuleDefinition, RuleEventDependency, RulePredicate } from "./types"

/**
 * Derive the event surface that can change whether a rule is active.
 *
 * Every object-scoped rule depends on object upserts for its subject type.
 * Link predicates also depend on link upserts/removals for the referenced
 * links. Property predicates need no extra dependency because property changes
 * arrive through `object.upserted`.
 */
export function deriveRuleEventDependencies(rule: RuleDefinition): readonly RuleEventDependency[] {
  const dependencies: RuleEventDependency[] = [
    {
      type: "object.upserted",
      objectTypeId: rule.subject.objectTypeId,
    },
  ]

  const linkIds: string[] = []
  const seenLinkIds = new Set<string>()
  collectLinkPredicateIds(rule.predicate, linkIds, seenLinkIds)

  for (const linkId of linkIds) {
    dependencies.push(
      {
        type: "link.upserted",
        sourceTypeId: rule.subject.objectTypeId,
        linkId,
      },
      {
        type: "link.removed",
        sourceTypeId: rule.subject.objectTypeId,
        linkId,
      }
    )
  }

  return dependencies
}

/** Collect unique link ids in first-seen order so dependency output is stable. */
function collectLinkPredicateIds(
  predicate: RulePredicate,
  target: string[],
  seen: Set<string>
): void {
  if (predicate.kind === "link") {
    if (!seen.has(predicate.linkId)) {
      seen.add(predicate.linkId)
      target.push(predicate.linkId)
    }
    return
  }

  if (predicate.kind === "not") {
    collectLinkPredicateIds(predicate.predicate, target, seen)
    return
  }

  if (predicate.kind === "all" || predicate.kind === "any") {
    for (const child of predicate.predicates) {
      collectLinkPredicateIds(child, target, seen)
    }
  }
}

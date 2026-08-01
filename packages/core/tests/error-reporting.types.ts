import type { SixbErrorContext, SixbFailedRun, SixbRunKind } from "../src"

type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/**
 * `SIXB_RUN_KINDS` is the one list of things Sixb runs, so `SixbFailedRun` must have exactly one
 * variant per kind. Adding a kind without a failure shape — or the reverse — fails here rather than
 * silently leaving a primitive unable to report why it broke.
 */
type _everyRunKindCanFail = Expect<Equal<SixbFailedRun["kind"], SixbRunKind>>

/**
 * Every variant carries a `runId`, which is what makes the invariant above meaningful: a kind that
 * cannot name its run does not belong on the list. Rules are the case that proved it — evaluated live
 * per subject with no run record, so they are not a run kind and report through
 * `rule.evaluation.failed` instead.
 */
type _everyFailedRunIsIdentifiable = Expect<Equal<SixbFailedRun["runId"], string>>

/** The error context is discriminated on `type`, and every member carries a dedup key. */
type _errorContextIsDiscriminated = Expect<
  Equal<SixbErrorContext["type"], "run.failed" | "event.delivery.failed" | "rule.evaluation.failed">
>
type _errorContextAlwaysDeduplicable = Expect<Equal<SixbErrorContext["notificationId"], string>>

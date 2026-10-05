# Object reads

`read-scope.ts` derives visible objects, links and property grants from the selected roots and
paths. The selected reader holds its traversal-budget probe and terminal statements on one WAL
snapshot. SQL must filter by those relations before ranking or limiting results.

SQLite flattens CTEs. Expose identity columns from the grant/visible relation and put authorized
parents before indexed lookups with `CROSS JOIN`; exposing stored identities can cause a full
grant scan per traversed edge. The query-plan regression test checks those lookups.

Vector `list()` materializes at most the candidate budget plus one identity/vector pair per
eligible object. Its count controls distance evaluation and travels with the ranked rows, so
admission, total and ranking share one scan. Returned objects are hydrated after top-k; candidate
filters and traversals may still evaluate masked properties while deciding eligibility.
Overflow fails before exposing rows; it never silently ranks a truncated candidate set.

An outer zero limit can suppress the count row; that case uses the separate bounded probe.
Count, existence and facet terminals also retain that probe. Totals count the top-k set before
the outer limit, and all candidates must grant every profile source property.

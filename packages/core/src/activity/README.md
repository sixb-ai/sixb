# Activity

Internal invariants for app usage history. For setup, see the
[developer guide](../../../../docs/apps/activity.md).

## Data model

| Record | Purpose |
| --- | --- |
| Source | Capture state of one verified session, shared by its tabs: current visit, last activity, sequence and quota window. Unrelated to `utm_source`. |
| Visit | Actor, session id, first and last activity, page-view count and arrival attribution. A new visit starts after inactivity, or once the current one is a day old. |
| Page view | Normalized route, server receipt time and sequence within the visit. |

A source is keyed by the actor type and the session id: the `SessionRecord` id for a user, the
shared session's id for a share. Neither is a secret (a user session's token is stored as
`tokenHash`). The visit keeps the same id, so it can be joined with the execution ledger
(`authority_session_id`) and with the session's device. Reads never return it.

`page.view` is a load or a navigation and is stored. `visit.activity` is foreground activity: it
moves the visit's last activity and the source's state, counts toward the quota, and inserts
nothing, except when it opens a visit (someone back on a page after inactivity): it is then stored
as the visit's first page view, of that route. Hidden navigation is reported once visible. This is
not audit evidence.

A visit continues while its session is active and it is younger than a day
(`ACTIVITY_MAX_VISIT_MS`): the next event after either limit starts another. The cap is what lets a
period read bound `started_at` on both sides. A source whose current visit was deleted starts a
new one with its next event.

## Capture and storage

- **Authority:** actor and session come from verified authorization only; a browser never names
  either. HTTP capture takes a non-bearer cookie session or a shared-link session, nothing else.
  Every read requires `can.observe(project.activity)`.
- **Atomic append:** providers serialize writes per source, including across replicas, and take
  part in the storage transaction they run in. The [shared policy](../storage/activity/policy.ts)
  owns deduplication, the quota, visit assignment, sequence and monotonic receipt time.
- **Retries:** an event whose id the session already stored is a retry, whether it was sent as a
  page view or as the activity that opened a visit: it neither extends the visit nor uses quota,
  and the same id with another route or attribution fails. Other activity is not stored, so a
  retried `visit.activity` counts again: it moves last activity to the retry's receipt and uses
  quota. The browser gives up within about a minute, so that drift is bounded.
- **Browser:** capture-config supplies enabled and the idle timeout once per authority; the server
  stays authoritative. The in-memory queue is discarded on disposal, with at most three attempts,
  one-minute expiry and ten seconds per request. A refusal (4xx) drops the batch; a 429 waits for
  its `Retry-After`. Delivery and exact duration are not guaranteed.
- **Clock:** receipt time never moves back within a session, so a server clock stepping back
  cannot reorder a visit.
- **Retention:** no automatic expiration. Deleting one user's history is deleting their visits
  (`user_id`), whose page views cascade, and the sources whose current visit was one of them.

## Attribution

| Value | Meaning |
| --- | --- |
| `{ source, medium, campaign }` | Available UTM labels, each limited to 100 characters. Missing labels stay absent. |
| `{ referrer }` | External hostname only; never a full URL. |
| `{}` | Direct arrival. |
| `null` | Not collected. |

- The first accepted event of a visit, page view or activity, fixes its attribution. A page view
  keeps its own attribution only to recognize a retry.
- Later events send `{}`, so a visit started by inactivity does not inherit an old campaign. A
  fresh document captures its own arrival. These are browser claims, not authorization evidence.
- Sixb redirects keep sanitized arrival metadata in per-tab, API- and authority-scoped
  `sessionStorage` for 30 minutes, consumed on return. New UTMs take priority. Blocked storage
  falls back to the current URL and referrer without blocking navigation.

## Reads and counting

- **UTC everywhere.** A period `[from, to)`, at most 31 days, lists the visits it overlaps
  (`started_at < to` and `last_seen_at >= from`) and counts the page views received in it. As a
  visit lasts less than a day, the read also bounds `started_at >= from - 1 day`, which keeps it to
  a range of the `started_at` indexes. A visit's own `pageViews` and `lastSeenAt` are the whole
  visit's.
- A visit spanning midnight counts on both days, even when one of them holds only activity.
  Never sum daily visits into a period total. Shares never count as identified users.
- The calendar covers one UTC year from the user's visits; days are expanded by the policy, so
  every provider counts them alike.
- User filters precede counts and pagination. Display names resolve only for the accounts of
  one page; no emails or other profile fields are returned.
- Visit and user cursors use last activity plus id, newest first. Ids compare byte by byte
  (`COLLATE "C"` in PostgreSQL); generated visit ids are ASCII, so every provider orders them alike.
  Timelines use sequence. Live activity can move a visit between pages, so clients deduplicate
  ids and offer a refresh.

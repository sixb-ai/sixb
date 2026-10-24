# Activity

Internal invariants for app usage history. For setup, see the
[developer guide](../../../../docs/apps/activity.md).

## Data model

| Record | Purpose |
| --- | --- |
| Source | Capture state of one verified session, shared by its tabs: current visit, last activity, sequence and quota window. Unrelated to `utm_source`. |
| Visit | Actor, session id, first and last activity, page-view and interaction counts and arrival attribution. A new visit starts after inactivity, or once the current one is a day old. |
| Page view | Normalized route, server receipt time and sequence within the visit. |
| Interaction | Name the app chose, normalized route, server receipt time and sequence, shared with page views. |

A source is keyed by the actor type and the session id: the `SessionRecord` id for a user, the
shared session's id for a share. Neither is a secret (a user session's token is stored as
`tokenHash`). The visit keeps the same id, so it can be joined with the execution ledger
(`authority_session_id`) and with the session's device. Reads never return it.

`page.view` is a load or a navigation and is stored. `visit.activity` is foreground activity: it
moves the visit's last activity and the source's state, counts toward the quota, and inserts
nothing, except when it opens a visit (someone back on a page after inactivity): it is then stored
as the visit's first page view, of that route. Hidden navigation is reported once visible. This is
not audit evidence.

`ui.interaction` is something the app marked, by name: it is stored, and is activity as well. Page
views and interactions take the visit's sequence in the order a batch sends them, so the timeline
reads both in one ordered, bounded pass. An interaction carries no attribution. One that opens a
visit (after the day-long cap, inactivity the browser had not seen, or a deleted visit) opens it as
activity does, on a page view of its route: that row's id is the interaction's with `.page`
appended, outside the event-id alphabet, and the visit's arrival is direct (`{}`). A retry of the
interaction is recognized by its own id, so neither row repeats.

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
  page view or as the activity that opened a visit, or is an interaction: it neither extends the
  visit nor uses quota, and the same id with another type, name, route or attribution fails. Other
  activity is not stored, so a retried `visit.activity` counts again: it moves last activity to the
  retry's receipt and uses quota. The browser gives up within about a minute, so that drift is
  bounded.
- **Browser:** capture-config supplies enabled and the idle timeout once per authority; the server
  stays authoritative. The in-memory queue is discarded on disposal, with at most three attempts,
  one-minute expiry and ten seconds per request. A refusal (4xx) drops the batch; a 429 waits for
  its `Retry-After`. Delivery and exact duration are not guaranteed.
- **Clock:** receipt time never moves back within a session, so a server clock stepping back
  cannot reorder a visit.
- **Interactions:** explicit marking only, by `data-sixb-track` or `trackSixbEvent`; no
  autocapture, element text, selector or value. Names are lowercase dotted segments, each starting
  with a letter, at most 40 characters and without a run of four digits, 100 in all
  (`ACTIVITY_INTERACTION_NAME_PATTERN`): what fails is usually a value. No pattern catches every
  value; names are meant to be constants. The browser drops an invalid name and warns, for the
  first 20 distinct ones; the API refuses the batch.
- **Browser interactions:** one capture-phase click listener on the document, trusted events only,
  finds the marked element on the event's composed path. A click inside a disabled or
  `aria-disabled` part of it is ignored, and so is a click on a label whose control is inside the
  same marked element: the click the browser forwards to the control records it once. The same
  name within a second is recorded once. A marked click is input, so it keeps the visit going; a
  `trackSixbEvent` call is not, and is dropped once the person has been idle for the idle timeout,
  so background code cannot keep a visit alive. Before the capture settings load, in a hidden tab
  or on an unrecorded page, an interaction is dropped, not queued: it would otherwise reach the
  server before its page view.
- **Retention:** no automatic expiration. Deleting one user's history is deleting their visits
  (`user_id`), whose page views and interactions cascade, and the sources whose current visit was
  one of them.

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
  one page; no emails or other profile fields are returned. Shared visits name their link's share
  definition (`actor.definitionId` on `ActivityVisitView`, never on the stored actor), from one
  grant read for the page or visit; a grant that is gone leaves the grant id alone. The timeline
  reuses that grant for the share connection's status.
- Visit and user cursors use last activity plus id, newest first. Ids compare byte by byte
  (`COLLATE "C"` in PostgreSQL); generated visit ids are ASCII, so every provider orders them alike.
  A visit's page views and interactions read by their shared sequence, the first 200 of them in
  its timeline, which is the only read of one visit. Live activity can move a visit between pages,
  so clients deduplicate ids and offer a refresh.

## Timeline and connections

A visit's timeline joins it with what its session did, by the session id alone: never by user and
time range, so the same user's other browser, active at the same time, stays out.

- **Join:** roots are the executions without a parent whose verified session is the visit's,
  `authority_session_id` for a user and `authority_delegation_session_id` for a share. Read-only
  requests write none. Their descendants are found through `parent_execution_id`, not
  `correlation_id`, which a client can set. An Agent execution copies its parent's session; requiring
  no parent keeps it from counting as a root.
- **Window:** roots created in `[start - 30 s, last activity + 30 s)`, capped 30 s before the
  visit's day-long limit. A click right after a return reaches the server before the activity
  that opens the visit, and an action just before leaving may follow the last activity sent. Half
  the shortest idle timeout keeps two visits of a session from sharing an execution. Descendants
  are not time-filtered: a queued workflow or an Agent's tools may run long after the visit.
- **Entries:** page views, interactions, action runs, workflow runs and conversation Agent runs, by
  time; page views and interactions in their sequence. An action execution without a recorded run
  is `incomplete`: in flight, or interrupted. An Agent run's cost includes everything below it,
  subagents and tools included; a Workflow's Agent steps are not conversations and have no entry.
  Page views and interactions are at their server receipt, executions at their creation: the
  app's steps credit an execution to the last page view before it, so one started as the page
  changed can land in the neighboring step.
- **Content:** a run shows its thread's message count, never its messages. Its title, under
  `thread`, only for a viewer who also holds `can.observe(agent.threads)`, the grant that opens
  the conversation itself (`sixb.agent.observed`); `thread` is also what tells the app it may link
  there. Activity alone never reveals a conversation. An action
  names its object only when the viewer's own object reader returns it, so object type grants,
  markings and deletion all hide it. `runVisible` says whether the viewer may read the run
  itself, decided as the runs reads decide it (`viewableActionRuns` and the subject type's
  markings, `canViewWorkflowRun`); the app links a run only then.
- **Bounds:** 200 page views and interactions together, and 200 recorded executions, roots first
  and the earliest first. Past either limit `truncated` is set and the timeline stops at the last
  page view or interaction, or the last root, it kept: the cut leaves no gap where one source is
  missing. One read per source: the visit, the ledger, the session, action runs, workflow runs,
  Agent runs, costs, threads, and one object batch per object type.
- **Connections:** a user's sessions, revoked and expired ones too, newest first, with the device
  their user agent names (browser and system only), a native client's label, and each session's
  visit count and latest five visits. No address, user agent or session id is returned: the
  cursor holds a creation time and how many sessions created then were returned. A share's
  session has no device: its connection is the link's grant, and it reads as revoked or expired
  once either the session or the grant is.


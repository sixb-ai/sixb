import type { GitHubBodyFormatOptions } from "./attachments"
import type { GitHubPaginationOptions, GitHubRequestOptions, GitHubUser } from "./common"
import type { GitHubIssue } from "./issues"

export interface ListIssueTimelineOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions,
    GitHubBodyFormatOptions {}

/** The fields GitHub's issue events share: who did it, when, and the commit behind it if any. */
interface GitHubIssueEventFields {
  readonly id: number
  readonly node_id: string
  readonly url: string
  /** `null` when the account was deleted. */
  readonly actor: GitHubUser | null
  readonly commit_id: string | null
  readonly commit_url: string | null
  readonly created_at: string
}

/** An issue as a sub-issue or parent event names it. */
export interface GitHubTimelineIssueSummary {
  readonly number: number
  readonly title: string
  readonly state: "open" | "closed"
  readonly state_reason: string | null
  readonly repository: { readonly id: number; readonly name: string; readonly full_name: string }
}

export interface GitHubTimelineLabelEvent extends GitHubIssueEventFields {
  readonly event: "labeled" | "unlabeled"
  readonly label: { readonly name: string; readonly color: string }
}

export interface GitHubTimelineAssigneeEvent extends GitHubIssueEventFields {
  readonly event: "assigned" | "unassigned"
  readonly assignee: GitHubUser
}

export interface GitHubTimelineMilestoneEvent extends GitHubIssueEventFields {
  readonly event: "milestoned" | "demilestoned"
  readonly milestone: { readonly title: string }
}

export interface GitHubTimelineRenameEvent extends GitHubIssueEventFields {
  readonly event: "renamed"
  readonly rename: { readonly from: string; readonly to: string }
}

export interface GitHubTimelineCloseEvent extends GitHubIssueEventFields {
  readonly event: "closed"
  /** `completed`, `not_planned`, `duplicate`, or `null`. */
  readonly state_reason: string | null
}

export interface GitHubTimelineLockEvent extends GitHubIssueEventFields {
  readonly event: "locked"
  readonly lock_reason: string | null
}

export interface GitHubTimelineReviewRequestEvent extends GitHubIssueEventFields {
  readonly event: "review_requested" | "review_request_removed"
  readonly review_requester: GitHubUser
  readonly requested_reviewer?: GitHubUser
  readonly requested_team?: { readonly name: string; readonly slug: string }
}

export interface GitHubTimelineSubIssueEvent extends GitHubIssueEventFields {
  readonly event: "sub_issue_added" | "sub_issue_removed"
  readonly sub_issue: GitHubTimelineIssueSummary
}

export interface GitHubTimelineParentIssueEvent extends GitHubIssueEventFields {
  readonly event: "parent_issue_added" | "parent_issue_removed"
  readonly parent_issue: GitHubTimelineIssueSummary
}

/**
 * Events that carry nothing beyond who and when. `referenced` names the commit that mentioned the
 * issue in `commit_id`.
 */
export interface GitHubTimelinePlainEvent extends GitHubIssueEventFields {
  readonly event:
    | "reopened"
    | "referenced"
    | "unlocked"
    | "mentioned"
    | "subscribed"
    | "unsubscribed"
    | "connected"
    | "disconnected"
    | "pinned"
    | "unpinned"
    | "merged"
    | "head_ref_deleted"
    | "head_ref_restored"
    | "ready_for_review"
    | "convert_to_draft"
    | "copilot_work_started"
}

export interface GitHubTimelineCommentEvent {
  readonly event: "commented"
  readonly id: number
  readonly node_id: string
  readonly url: string
  readonly html_url: string
  readonly issue_url: string
  readonly body: string
  /** With `bodyFormat` `text` or `full`. */
  readonly body_text?: string | null
  /** With `bodyFormat` `html` or `full`. */
  readonly body_html?: string | null
  readonly user: GitHubUser
  readonly actor: GitHubUser
  readonly author_association: string
  readonly created_at: string
  readonly updated_at: string
}

/** Another issue or pull request mentioned this one. A pull request carries `pull_request`. */
export interface GitHubTimelineCrossReferenceEvent {
  readonly event: "cross-referenced"
  readonly actor: GitHubUser | null
  readonly created_at: string
  readonly updated_at: string
  readonly source: { readonly type: "issue"; readonly issue: GitHubIssue }
}

/** A commit pushed to a pull request. Its time is `author.date` or `committer.date`. */
export interface GitHubTimelineCommitEvent {
  readonly event: "committed"
  readonly sha: string
  readonly node_id: string
  readonly url: string
  readonly html_url: string
  readonly message: string
  readonly author: { readonly name: string; readonly email: string; readonly date: string }
  readonly committer: { readonly name: string; readonly email: string; readonly date: string }
  readonly parents: readonly {
    readonly sha: string
    readonly url: string
    readonly html_url: string
  }[]
}

/** A review on a pull request. Its time is `submitted_at`; `state` is lowercase here. */
export interface GitHubTimelineReviewEvent {
  readonly event: "reviewed"
  readonly id: number
  readonly node_id: string
  readonly user: GitHubUser | null
  readonly body: string | null
  /** With `bodyFormat` `html` or `full`. */
  readonly body_html?: string | null
  readonly state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending"
  readonly commit_id: string
  readonly html_url: string
  readonly pull_request_url: string
  readonly submitted_at: string
  readonly author_association: string
}

/**
 * One entry of an issue's or pull request's timeline, discriminated by `event`. GitHub adds events
 * over time, and an entry naming one this union doesn't list still arrives: treat an `event` you
 * don't handle as unknown.
 */
export type GitHubTimelineEvent =
  | GitHubTimelineCommentEvent
  | GitHubTimelineCrossReferenceEvent
  | GitHubTimelineCommitEvent
  | GitHubTimelineReviewEvent
  | GitHubTimelineLabelEvent
  | GitHubTimelineAssigneeEvent
  | GitHubTimelineMilestoneEvent
  | GitHubTimelineRenameEvent
  | GitHubTimelineCloseEvent
  | GitHubTimelineLockEvent
  | GitHubTimelineReviewRequestEvent
  | GitHubTimelineSubIssueEvent
  | GitHubTimelineParentIssueEvent
  | GitHubTimelinePlainEvent

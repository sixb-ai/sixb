import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathId,
  pathPart,
  readDownload,
  readJson,
  readNoContent,
  readWrappedPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type {
  GitHubWorkflow,
  GitHubWorkflowArtifact,
  GitHubWorkflowJob,
  GitHubWorkflowRef,
  GitHubWorkflowRun,
  ListWorkflowArtifactsOptions,
  ListWorkflowJobsOptions,
  ListWorkflowRunsOptions,
  RepositoryActionsApi,
  RerunWorkflowRunOptions,
  WorkflowRunAttemptOptions,
} from "../types/actions"
import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRepositoryTarget,
  GitHubRequestOptions,
} from "../types/common"

export function createRepositoryActionsApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryActionsApi {
  const actions = `${repositoryPath(target)}/actions`
  const runPath = (runId: number, attempt?: number) =>
    `${actions}/runs/${pathId(runId, "runId")}${
      attempt === undefined ? "" : `/attempts/${pathId(attempt, "attempt")}`
    }`

  const page = async <T>(
    path: string,
    params: URLSearchParams,
    key: string,
    options: (GitHubPaginationOptions & GitHubRequestOptions) | undefined
  ): Promise<GitHubPage<T>> => {
    applyPaging(params, options)
    return readWrappedPage<T>(
      await context.http.get(resolvePagePath(withQuery(path, params), options), {
        signal: options?.signal,
      }),
      context.apiBaseUrl,
      key
    )
  }

  return {
    workflows: {
      async list(options) {
        return page<GitHubWorkflow>(
          `${actions}/workflows`,
          new URLSearchParams(),
          "workflows",
          options
        )
      },

      async get(workflow, options) {
        return readJson<GitHubWorkflow>(
          await context.http.get(workflowPath(actions, workflow), { signal: options?.signal })
        )
      },
    },

    runs: {
      async list(options?: ListWorkflowRunsOptions) {
        const path =
          options?.workflow === undefined
            ? `${actions}/runs`
            : `${workflowPath(actions, options.workflow)}/runs`
        return page<GitHubWorkflowRun>(path, runFilters(options), "workflow_runs", options)
      },

      async get(runId: number, options?: WorkflowRunAttemptOptions) {
        return readJson<GitHubWorkflowRun>(
          await context.http.get(runPath(runId, options?.attempt), { signal: options?.signal })
        )
      },

      async jobs(runId: number, options?: ListWorkflowJobsOptions) {
        const params = new URLSearchParams()
        // An attempt names its jobs exactly; `filter` chooses among attempts otherwise.
        if (options?.filter && options.attempt === undefined) params.set("filter", options.filter)
        return page<GitHubWorkflowJob>(
          `${runPath(runId, options?.attempt)}/jobs`,
          params,
          "jobs",
          options
        )
      },

      async artifacts(runId: number, options?: ListWorkflowArtifactsOptions) {
        const params = new URLSearchParams()
        if (options?.name) params.set("name", options.name)
        return page<GitHubWorkflowArtifact>(
          `${runPath(runId)}/artifacts`,
          params,
          "artifacts",
          options
        )
      },

      async logs(runId: number, options?: WorkflowRunAttemptOptions) {
        return readDownload(context, `${runPath(runId, options?.attempt)}/logs`, {
          signal: options?.signal,
        })
      },

      async rerun(runId: number, options?: RerunWorkflowRunOptions) {
        const path = `${runPath(runId)}/${options?.failedOnly ? "rerun-failed-jobs" : "rerun"}`
        const body = options?.enableDebugLogging ? { enable_debug_logging: true } : {}
        await readNoContent(await context.http.post(path, body, { signal: options?.signal }))
      },

      async cancel(runId: number, options?: GitHubRequestOptions) {
        await readNoContent(
          await context.http.post(`${runPath(runId)}/cancel`, {}, { signal: options?.signal })
        )
      },
    },

    jobs: {
      async get(jobId, options) {
        return readJson<GitHubWorkflowJob>(
          await context.http.get(`${actions}/jobs/${pathId(jobId, "jobId")}`, {
            signal: options?.signal,
          })
        )
      },

      async logs(jobId, options) {
        return readDownload(context, `${actions}/jobs/${pathId(jobId, "jobId")}/logs`, {
          signal: options?.signal,
        })
      },
    },

    artifacts: {
      async download(artifactId, options) {
        return readDownload(
          context,
          `${actions}/artifacts/${pathId(artifactId, "artifactId")}/zip`,
          { signal: options?.signal }
        )
      },
    },
  }
}

/** A workflow by id, or by its file name, which GitHub accepts in its place. */
function workflowPath(actions: string, workflow: GitHubWorkflowRef): string {
  const id =
    typeof workflow === "number" ? pathId(workflow, "workflow") : pathPart(workflow, "workflow")
  return `${actions}/workflows/${id}`
}

function runFilters(options: ListWorkflowRunsOptions | undefined): URLSearchParams {
  const params = new URLSearchParams()
  if (!options) return params
  if (options.branch) params.set("branch", options.branch)
  if (options.event) params.set("event", options.event)
  if (options.status) params.set("status", options.status)
  if (options.actor) params.set("actor", options.actor)
  if (options.headSha) params.set("head_sha", options.headSha)
  if (options.created) params.set("created", options.created)
  if (options.checkSuiteId !== undefined) {
    params.set("check_suite_id", pathId(options.checkSuiteId, "checkSuiteId"))
  }
  if (options.excludePullRequests) params.set("exclude_pull_requests", "true")
  return params
}

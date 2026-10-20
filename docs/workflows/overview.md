# Workflows

A workflow runs a sequence of steps, passing data from one step to the next. Combine code, AI
tasks, and actions into a process that Sixb runs and tracks.

## Define a workflow

Export a workflow from `workflows/`. Sixb discovers it automatically. Define steps with
`defineWorkflowStep()`, then add them to a workflow with `.then()`.

A step declares its input, output, and the code to run. This step reads an invoice and prepares a
reminder:

File: `workflows/invoice-reminder.ts`

```ts
import { defineWorkflow, defineWorkflowStep, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const prepareReminder = defineWorkflowStep("prepare-reminder")
  .input({ invoice: ref(Invoice) })
  .output({ invoice: ref(Invoice), message: "string" })
  .run(async ({ input, sixb }) => {
    const invoice = await sixb.objects(Invoice).get(input.invoice.primaryId)
    if (!invoice) throw new Error("Invoice not found.")

    return {
      invoice: input.invoice,
      message: `Please arrange payment for invoice ${invoice.properties.number}.`,
    }
  })

export const invoiceReminder = defineWorkflow("invoice-reminder")
  .input({ invoice: ref(Invoice) })
  .then(prepareReminder)
```

`ref(Invoice)` declares an invoice reference containing `objectTypeId` and `primaryId`.
The step's `sixb` context gives you access to objects, connectors, and other framework APIs.

Steps run in order. Sixb validates their inputs and outputs, and a failed step stops the run.

## Pass data between steps

The first step receives the workflow's input. Each following `.then(step)` receives the previous
step's output, which must contain the fields it needs.

To change that input, pass a mapper as the second argument to `.then()`. It receives the original
workflow `input` and earlier outputs in `steps`. Step IDs become camelCase keys:
`prepare-reminder` becomes `steps.prepareReminder`.

## Run an action

Add an [action](../actions/overview.md) with `.then(action, mapper)`. The mapper returns the action's
`subject` and `params`. The workflow runs the action and continues once it succeeds; a failed action
stops the run.

For a project action named `sendReminder` that accepts a `message` parameter, extend the workflow
above like this:

```ts
import { sendReminder } from "../actions/send-reminder"

export const invoiceReminder = defineWorkflow("invoice-reminder")
  .input({ invoice: ref(Invoice) })
  .then(prepareReminder)
  .then(sendReminder, ({ input, steps }) => ({
    subject: input.invoice,
    params: { message: steps.prepareReminder.message },
  }))
```

For a global action, return only `params`.

## Add an AI task

Use `defineAgentStep()` when a task needs an AI model to work with tools. Declare the input and
expected output, then provide instructions and a prompt:

```ts
import { defineAgentStep, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"
import { finance } from "../security/groups/finance"

export const draftReminder = defineAgentStep("draft-reminder", {
  instructions: "Read the invoice and draft a reminder. Do not send it.",
  groups: [finance],
})
  .input({ invoice: ref(Invoice) })
  .output({ message: "string" })
  .prompt(({ input }) => `Draft a reminder for invoice '${input.invoice.primaryId}'.`)
```

Add it with `.then(draftReminder)`, just like a regular step. The workflow waits for its validated
output before continuing.

The task uses your [configured language model](../models/configuration.md#language-models) and built-in sandbox
tools. `groups` controls its access to project data; grant the example's `finance` group permission
to read invoices. Without groups, it has no project grants. Actions the task requests keep the
workflow run's requester, if any (a scheduled or event-triggered run has none), while its access
stays its `groups`. To add custom tools, select them with `tools: [...]` and register them in
`createSixb({ tools })`. To give it
[skills](../models/tools-and-authorization.md#add-a-skill), list their names in
`skills: ["invoice-review"]`. A task receives no tools and no skills unless it selects them.

For a single model call that does not need tools, use an ordinary step with
[`sixb.models.language.generate()`](../models/configuration.md#generate-a-response).

## Work in a repository

Give an AI task its own `sandbox` to work in a checkout of a repository, for example to fix a bug
and open a pull request. Pass a [sandbox factory](../sandboxes/overview.md) with a static recipe:

File: `lib/app-repo.ts`

```ts
import { githubApp } from "@sixb/connector-github/sandbox"
import { VercelSandboxFactory } from "@sixb/sandboxes-vercel"

export const appRepo = new VercelSandboxFactory({
  image: "sixb-agent:<version>",
  sessionTimeoutMs: 15 * 60_000,
  source: { type: "git", url: "https://github.com/acme/app.git", access: "write" },
  setup: ["bun install"],
  network: { mode: "restricted", allow: [{ name: "npm", origin: "https://registry.npmjs.org" }] },
  auth: githubApp({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
  }),
})
```

Vercel's default runtime has neither `gh` nor `bun`, so the factory boots the Sixb agent image,
which has both: push it to your Vercel project as shown in
[Use with a sandbox provider](https://github.com/sixb-ai/sixb/tree/main/sandboxes/agent-image#use-with-a-sandbox-provider)
(Vercel). `sessionTimeoutMs` must cover the task's time limit, the agent worker's turn budget:
10 minutes unless you [change it](../cli/overview.md#worker-options). Vercel's default session
lasts 5 minutes.

File: `workflows/incident-to-pr.ts`

```ts
import { defineAgentStep, ref } from "@sixb/core"
import { appRepo } from "../lib/app-repo"
import { Incident } from "../ontology/incident"
import { engineering } from "../security/groups/engineering"

export const fixIncident = defineAgentStep("fix-incident", {
  instructions:
    "Fix the bug and add a test. Push to the branch named in the request, then open a pull request from it unless one is already open.",
  groups: [engineering],
  sandbox: appRepo,
})
  .input({ incident: ref(Incident) })
  .output({ pullRequestUrl: "string", summary: "string" })
  .prompt(
    ({ input }) =>
      `Fix incident ${input.incident.primaryId} on branch fix/incident-${input.incident.primaryId}.`
  )
```

Each run gets a fresh sandbox: Sixb clones the repository, runs `setup`, and destroys the sandbox
when the run ends, including after a failure or a cancellation. Nothing carries over between runs,
so setup runs every time. Cloning and setup count toward the task's time limit.

If a worker stops mid-task, the task runs again in a fresh checkout. Write instructions that are
safe to repeat, as above: a branch name derived from the input, and a check for an existing pull
request. Protect the default branch, since write access covers every branch.

The sandbox always reaches the Sixb API, the repository and the origins `auth` issues
credentials for; without `network`, nothing else. A `restricted` network lists what the project
adds, here the registry `bun install` downloads from.

With `access: "write"`, the task can push branches and open pull requests with `git` and `gh`.
`githubApp` keeps the credentials outside the sandbox and revokes them when the run ends; after a
worker crash, they stay valid until they expire, within an hour. An authenticated repository
needs a provider that injects credentials outside the sandbox, such as Vercel. The recipe must be
static: factories with `params` or `resolve` are not supported here.

Vercel sandboxes run remotely and call your Sixb API at its
[public origin](../deployment/overview.md#configure-public-origins), so it must be an HTTPS
address reachable from the internet. In local development, expose the API through a tunnel and
set `SIXB_API_PUBLIC_ORIGIN` to the tunnel's URL.

`createSixb({ sandboxes })` is still required for tasks without `sandbox` and for conversations.

## Start a workflow

Run a workflow from its page in your app's [Ontology](../apps/overview.md#ontology) section, such as
`/ontology/workflows/review-deal`, or request it from your own pages with the
[Client SDK](../client/typed-queries.md#react-hooks). Use `requestWorkflowRunMutation()` from
`@sixb/client/hooks` to submit its input from a React component.

To start automatically, attach a [schedule](../schedules/overview.md) with `.when()` before the first
step. For an event schedule, map the event into the workflow's input. Using the `highValueInvoice`
schedule from the [Schedules guide](../schedules/overview.md#run-on-an-event):

```ts
import { highValueInvoice } from "../schedules/invoices"

export const invoiceReminder = defineWorkflow("invoice-reminder")
  .input({ invoice: ref(Invoice) })
  .when(highValueInvoice, ({ event }) => ({
    invoice: { objectTypeId: Invoice.id, primaryId: event.object.primaryId },
  }))
  .then(prepareReminder)
  .then(sendReminder, ({ input, steps }) => ({
    subject: input.invoice,
    params: { message: steps.prepareReminder.message },
  }))
```

Cron schedules do not supply input, so workflows attached to them must declare `.input({})`.

To pause for a review before sending, add an intervention. See
[Human-in-the-Loop](interventions.md) for defining the review and submitting a response.

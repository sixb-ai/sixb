# AI

Sixb includes a general-purpose agent for working with your application. Connect the models you
want to offer, and the agent can explore your domain, work with its data, and carry out tasks
within the permissions you define.

## How the agent works

The Sixb harness is the runtime around the model. It manages the conversation and gives the
agent a sandbox where it can read files, run commands, and work through a task.

Think of the sandbox as the agent's computer. Sixb equips it with the [Sixb CLI](../cli/overview.md),
which lets the agent inspect your ontology, query live data, request actions, and start workflows.
Your domain definitions give the agent a way to discover what exists and what it can do.

Before working with a type, the agent reads a reference file that Sixb writes from your ontology
and [your notes](../ontology/overview.md#explain-it-to-the-agent).

The same agent can work across your application as its domain grows. Add
[tools and skills](./tools-and-authorization.md) when it needs additional capabilities or
instructions for a particular task.

## Configure the agent

Choose your [models](./configuration.md) and a [sandbox provider](../sandboxes/overview.md).
Install their packages and set the provider credentials, then add them to your existing configuration:

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    language: [vercelGateway("openai/gpt-5.5")],
  },
  sandboxes: new LocalSandboxFactory(),
})
```

You can offer models from multiple providers through the same harness. In chat, users choose
from your configured catalog and adjust the reasoning effort supported by their selected model.
Each model can carry a [default reasoning](./configuration.md#default-reasoning).

## Give it project instructions

Write guidance that applies to every conversation, such as your team's vocabulary, tone, or
conventions, in a `SIXB.md` file at the project root:

File: `SIXB.md`

```md
Answer in French. Amounts are in euros, excluding VAT.
A "dossier" is a `Case`; always mention its reference.
```

The chat agent receives the file as written in every conversation, so keep it short. Put
instructions for a particular task in a [skill](./tools-and-authorization.md#add-a-skill), which
the agent reads only when relevant. AI workflow steps use their own `instructions` instead.

## Control access

The agent's access depends on where it runs:

| Context | Permissions |
| --- | --- |
| Chat | The signed-in user's permissions. |
| Workflow step | Permissions granted through the step's configured groups. |

Sixb enforces permissions when the agent, or a [tool](./tools-and-authorization.md#use-project-data-in-a-tool)
it calls, accesses project data or requests an operation. Instructions and skills do not grant
access.

For example, this role lets members of your existing employees group use the agent and read invoices:

File: `security/roles/assistant-user.ts`

```ts
import { agent, can, defineRole } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"
import { employees } from "../groups/employees"

export const assistantUser = defineRole("assistant.user", {
  grantedTo: [employees],
  grants: [can.run(agent), can.view(Invoice)],
})
```

Grant access to actions and workflows through [roles](../auth/authorization.md) as needed.

Each person sees their own conversations and the ones [shared with them](#share-a-conversation).
`can.observe(agent.threads)` lets others [read them](../apps/activity.md#read-a-conversation),
read-only.

## Use in your app

[Sixb apps](../apps/overview.md) include a chat interface. In your app, open `/agents`
or embed `AgentPanel` in a page and give it context:

File: `app/_components/invoice-assistant.tsx`

```tsx
import { AgentPanel, agentContext } from "@sixb/app"
import { Invoice } from "../../ontology/invoice"

export function InvoiceAssistant({ invoiceId }: { invoiceId: string }) {
  return (
    <AgentPanel
      className="h-[32rem]"
      context={[agentContext.object(Invoice, invoiceId)]}
    />
  )
}
```

Context tells the agent what the user is looking at. It does not grant additional access.

The chat labels an object by the property its type declares as `search.title`, or by its id when
there is none. Pass a `label` to show your own text instead. It is only displayed: the agent still
reads the object itself.

```tsx
agentContext.object(Project, project.id, { label: project.name })
```

## Share a conversation

A conversation's owner can add other users of the project to it. They read the whole
conversation, its files and the answer as it streams, and they can write in it too:

```ts
await sixb.agent.threads.participants.add(thread.id, [{ type: "user", id: "usr_bob" }])

const { threads } = await sixb.agent.threads.list({ sharedWithMe: true })
threads[0].participants // [{ principal: { type: "user", id: "usr_bob" }, addedAt, addedBy }]

await sixb.agent.runs.request({ threadId: thread.id, text: "Why did Acme slip?" })
```

- **Each message runs with its sender's permissions**, as every conversation does. The agent
  knows who wrote each message.
- **Everyone sees everything.** Participants see the messages already there and the ones that
  follow, including data the agent read with someone else's access that they could not open
  themselves. Nothing checks it when you share: warn the person sharing.
- **One answer at a time.** A message sent while the agent answers is refused with a 409.
- **Only the owner adds or removes participants**, and recreates the conversation's sandbox. A
  participant can remove themself to leave.
- **Whoever sent a message can retry it; the owner can stop any answer.**
- **Removing someone applies to what comes next.** They no longer read the conversation, and a
  message of theirs still waiting for an answer is cancelled. An answer already being written
  finishes, and a live stream they had open keeps running until that answer ends.

Add a user by id or by their account's email: `{ email: "bob@acme.com" }`. Only active users
who can use the agent can be added, at most 50 per conversation. Sharing a conversation is unrelated to
[shared access](../auth/shared-access.md), which gives someone outside your team a link to one
object.

Over HTTP: `POST /api/agent-threads/:threadId/participants` with `{ "users": [...] }`,
`DELETE /api/agent-threads/:threadId/participants/:userId`, and
`GET /api/agent-threads?sharedWithMe=true`.

## Continue a conversation

Copy a conversation of yours, or one [shared with you](#share-a-conversation), into a new one
that belongs to you alone, with no participants:

```ts
const mine = await sixb.agent.threads.fork(thread.id)
```

- The copy holds the finished messages and their files. A turn still running is not copied.
- In the copy, the agent works with the permissions of its owner.
- The artifacts the agent published in the original stay there.
- The copy starts with a new [sandbox](../sandboxes/overview.md#keep-files-across-conversation-runs).
  Files from the original's sandbox are not in it, and the agent is told so.

Over HTTP, call `POST /api/agent-threads/:threadId/fork`, or `forkAgentThread` from the
[generated client](../client/overview.md).

## Use in a workflow

An [AI workflow step](../workflows/overview.md#add-an-ai-task) gives the same harness a specific
assignment. Use `defineAgentStep()` to supply instructions, declare its input and output, and
choose the groups that grant access to the data and operations it needs.

The agent completes the task and returns validated output for the workflow to continue.
For a single model call with context supplied by your code, use
[model generation](./configuration.md#generate-a-response).

For choices, rubric scores and probabilities in actions or ordinary workflow steps, use
[decision models](./configuration.md#decision-models). They share model usage accounting and do not require an agent.

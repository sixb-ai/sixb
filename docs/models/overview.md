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

The agent also knows which project member it works for: the one who asked, or who started the
workflow. A request such as "assign this to me" resolves to that member's
[user reference](../ontology/properties.md#reference-a-user).

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
With [tiers](./configuration.md#tiers), the chat starts on **Auto**, where a
[decision model](./configuration.md#decision-models) picks each message's model. Choosing one pins
it in that conversation until the person goes back to Auto.
Each model can carry a [default reasoning](./configuration.md#default-reasoning).

### Limit its steps

A step is one model call. Cap how many a run may take:

```ts
export const sixb = createSixb({
  // ...
  agent: { maxSteps: 200, subagentMaxSteps: 100 },
})
```

| Run | Default | At the limit |
| --- | --- | --- |
| Conversation turn (`maxSteps`) | No limit: someone watches it and can stop it. | It ends with its work kept, says it reached the step limit, and offers **Continue**. |
| [Sub-agent](#it-delegates) (`subagentMaxSteps`) | 500 | It fails with `agent.step_limit_reached`. |
| [Workflow AI task](../workflows/overview.md#add-an-ai-task) (its own `maxSteps`) | 500 | It fails with `agent.step_limit_reached`. |

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

## It remembers

The chat agent keeps a memory for each user: what it learned in earlier conversations, such as their
preferences, vocabulary, and how they measure things. Memory is a folder of Markdown files with a
`MEMORY.md` entry point. The agent reads `MEMORY.md` at the start of every conversation, opens the
other files when it needs them, and saves what it learns as it goes. Below its reply, the chat shows
each thing it saved.

Memory needs no configuration and no grant. A user's memory is theirs alone, and AI workflow steps
have none. A conversation keeps the `MEMORY.md` it started with, so what it saves shapes the next
conversation, or the same one once its history is summarized.

The project also has a memory, built up from everyone's conversations, for what every user's agent
should know: your team's vocabulary, conventions, and how things are measured. The agent decides
what goes there and what stays in the user's own memory, and the chat says which it saved to.
Everyone who can use the agent reads and adds to it. Because people who cannot see the same data
read it, the agent only puts there what users told it, never records, data, or anything about a
particular person. Each save is recorded with who made it and in which conversation. A conversation
shared with others reads and saves the project's memory only, never the memory of whoever writes.

Deleting the project's memory requires `can.manage(agent.memory)`:

File: `security/roles/knowledge-keeper.ts`

```ts
import { agent, can, defineRole } from "@sixb/core"
import { teamLeads } from "../groups/team-leads"

export const knowledgeKeeper = defineRole("assistant.knowledge-keeper", {
  grantedTo: [teamLeads],
  grants: [can.manage(agent.memory)],
})
```

Settings › Memory shows both memories, as the agent reads them. A person can correct any entry,
see every change with who made it, restore a file as an earlier change left it, or delete their
memory. Their edits are saves like the agent's, and the next conversation reads them.

Read or delete the project's memory from your code:

```ts
const { revision, files } = await sixb.agent.memory.get("project")
const before = await sixb.agent.memory.get("project", { revision: 3 })
await sixb.agent.memory.delete("project")
```

A user's memory is reachable only as that user: in their conversations, in Settings › Memory, or
through `/api/agent-memory/user` with their session. Your code runs as the system, so
`get("user")` there reads the system's own memory, not a person's.

Each save is a revision with the agent's own description of what it learned. `MEMORY.md` holds at
most 16 KB, any other file 256 KB, and each memory 4 MB in all. Earlier versions of a file are
kept for 90 days.

## It delegates

When a request splits into independent investigations, the chat agent can hand each one to a
sub-agent, let them work in parallel, and answer from what they return. It does not delegate a
simple lookup; for a second opinion it [asks another model](./configuration.md#call-models-over-the-api).

- **A sub-agent works for the same user**, with their permissions and
  [approval mode](#approve-what-the-agent-changes), on the [tier](./configuration.md#tiers) or the
  model whose [description](./configuration.md#name-and-description) fits its task.
- **It knows the project, not the conversation.** It gets `SIXB.md`, the ontology reference files,
  the user's time zone and language, and the memory, which it reads but never saves to. It sees only
  the task the agent writes, and answers the agent, not the user.
- **Files go both ways.** The agent hands it files from its own sandbox, such as an attachment,
  and the sub-agent finds them at the same paths. What the sub-agent writes to `out/` comes back
  to the agent when it finishes, up to 50 files of 25 MB, 100 MB in all, and stays in the
  conversation's files, shown in the agent's work. Past those limits only its answer comes back,
  with why; a sub-agent that fails or is stopped returns none.
- **What it publishes lands in the conversation**, like the agent's own
  [artifacts](../artifacts/overview.md), and the agent can revise it in the same turn.
- **Its work is a thread you can open**: its task, then what it did, read by whoever reads the
  conversation. It is never listed with your conversations and takes no messages of its own.
- **It stops with the turn that started it**, whether the turn ends or is stopped. A sub-agent cut
  short by a worker crash is not run again unless the agent asks for it.
  One waiting on a question is the exception, below.
- **The agent can steer a sub-agent at work.** It sends it a message to correct its course, add
  what it lacks or narrow its task, and the sub-agent reads it before its next step. One that
  comes as the sub-agent answers makes it write its result again, and the agent keeps both
  answers. A sub-agent that finished, or waits for your approval, takes no new message, and the
  agent is told so; one sent just before it paused reaches it when it continues.
- **A sub-agent can ask the agent a question** when only the agent or you can settle it, such as
  "Calendar year or the April–March fiscal year?". Otherwise it makes a reasonable assumption and
  says so in its answer. The agent answers from the conversation when it can. When the answer is
  yours to give, the agent asks you and its turn ends: the sub-agent pauses on its question, and
  once you reply, the agent passes your answer on and the sub-agent continues where it stopped,
  with its work and files. If you stop the turn instead, the sub-agent stops with it.
- **A call that waits for your approval pauses it, not the others.** The agent's turn waits for
  its other sub-agents, then pauses. Once you decide, the sub-agent continues where it stopped,
  with its files, and the agent gets its answer.
- **A paused sub-agent keeps its whole sandbox** on a provider that keeps files, such as Vercel.
  Elsewhere it gets back the files it was handed and its `out/`, and is told the rest is gone.
- **In the chat, a reply's sub-agents are one line under the work that started them**: their
  avatars and a sentence that names them by how they stand ("Terms and Disputes are working ·
  History finished"), or counts them when there are many. The line opens them beside the
  conversation (in a sheet on a phone): each one's task, model, time, steps, answer and the files
  it made. What the agent told it, what it asked and the calls it waits on stay in the reply under
  the line. Whoever may stop the turn can stop a sub-agent at work from its thread; once the reply
  waits on a sub-agent's call, "Stop waiting" on that call stops the reply.
- **The conversation's owner and participants see its sub-agents**, live or once they ended:
  `GET /api/agent-threads/:threadId/children` lists them (`?runId=` for those one turn spawned),
  each with its thread, runs, status, usage and cost; its thread's messages are what it did. A
  paused one says what it waits for (`awaiting`: your decisions, its turn's resume, or the answer
  to its question), or why it will not continue (`ended`). Observers read them through
  `/api/observed-agent-threads`, by polling. Whoever asked for the turn, or the conversation's
  owner, can stop one at work: `POST /api/agent-runs/:runId/cancel` with its `activeRunId`.
- **It stops at its [step limit](#limit-its-steps)**, 500 model calls unless you set one. The agent
  can ask a sub-agent for fewer when it spawns it. One that stops there fails with
  `agent.step_limit_reached`, and the agent gets the last text it wrote as `partialAnswer`, to
  decide what to do next.
- It cannot delegate again or start a workflow. Its model calls count toward the user's
  [AI usage](./usage-and-limits.md), and toward the `usage` and `cost` of the turn that started
  it. So does a workflow the agent's tools started, even for what it spends after the turn ends, as
  in Activity.

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

## Approve what the agent changes

Each user chooses what the agent may change without asking them:

| Mode | Action that only changes Sixb | Action with a writeback or effects | Workflow start |
| --- | --- | --- | --- |
| `manual` | waits | waits | waits |
| `accept-edits` | runs | waits | waits |
| `auto` (default) | runs | runs | runs |

In the app, the composer's settings chip shows the mode and switches it, as Ask first (`manual`),
Allow edits (`accept-edits`) or Full access (`auto`), and the mode you pick becomes your default
for new conversations. In an empty message, Shift+Tab cycles the modes, and `/ask`, `/edits` and
`/full` switch to one. Settings › Personal sets your default too. A call
that waits shows as a card in the reply: what it does, to which record, with which values, and
whether it reaches an external system. Approve, Deny or "Always allow" answer it there, and the
reply continues under the card. Once decided, the card folds to a line that says how it ended and
opens to its values. "Always allow" says which mode it switches you to, and which other
waiting calls of the reply it approves with it. "Stop waiting" sets every call of the reply
aside, for its sender or the conversation's owner. In a shared conversation, the others see the card
and who decides, and are warned that sending a message sets it aside. The thread list puts the
conversations waiting for you first.

> A turn whose sender chose no mode runs in `auto`: nothing waits for an approval. To make the
> agent ask first, a person picks a stricter mode, and code passes `approvalMode` or sets its
> principal's default with `preferences.update`.

```ts
await sixb.agent.preferences.update({ approvalMode: "accept-edits" }) // your default
await sixb.agent.threads.setApprovalMode(thread.id, "manual") // yours here; null follows your default
await sixb.agent.runs.request({ threadId: thread.id, text: "Mark INV-2041 paid", approvalMode: "manual" })

const { approvals } = await sixb.agent.approvals.list({ threadId: thread.id, statuses: ["pending"] })
const { approval, run } = await sixb.agent.approvals.decide(approvals[0].id, { decision: "approve" })
// approval.outcome: what the call gave; run: the turn that picks up from there
```

- **A turn keeps the mode it started with**: the message's, else the sender's choice in the
  conversation, else their default. Participants each have their own. `getApprovalMode` and the
  thread's `GET` say where yours comes from: `thread`, `default` or `fallback`.
- **A call that waits does not run.** Sixb holds it, whatever the agent does. A call that would be
  refused, such as a workflow start with invalid input, is refused instead of held. Only whoever
  sent the message decides; an approved call runs with their permissions, as it was asked, and
  returns its result on the approval. `always: true` also raises their mode in the conversation,
  and approves the turn's other calls that mode runs.
- **The turn pauses, then resumes.** After the step that made the call, the turn ends `succeeded`
  with `finishReason: "awaiting_approval"`, and keeps that finish reason; it holds no worker
  meanwhile. Once every call it held is decided, even days later, a new turn continues it with the
  same model and reasoning, and the agent reads how each call ended. Its mode is the paused turn's,
  raised only by `always: true` on one of its calls, and lowered to the sender's choice in the
  conversation if they made it stricter meanwhile. `decide` returns that turn as `run`.
- **`decide` stands once the call ran.** If the turn cannot resume, `resume` says why
  (`{ status: "refused", code, message, retrying }`). With `retrying`, as after an AI limit, Sixb
  resumes the turn once it can; otherwise the next message reports the calls.
- **What keeps a turn from resuming.** A new message sets the calls still waiting aside, and the
  agent learns once that they never ran; a call approved meanwhile reports its result with a later
  message. Stopping the paused turn (`runs.cancel`, even once its calls are decided), its sender
  leaving the conversation, or a call expiring after 7 days stops it too: the next message reports
  its calls. A turn that fails or is stopped while running cancels its own.
- If a crash kept an approved call from running and the sender's sign-in ended since, Sixb does not
  run it later: its outcome is `agent.approval_authority_lost`. Ask the Agent again.
- **A sub-agent asks with its turn's mode.** When one of its calls waits, the sub-agent pauses
  after that step, and the call waits on the turn that started it. Its card says which sub-agent
  asked; over HTTP, the approval's `caller`. The turn pauses once none of its other sub-agents is
  still at work, and a turn that pauses on its own call waits for them first too. When it resumes,
  the sub-agent continues first, in its thread, from how its calls ended; deciding while the
  turn still runs takes effect once it pauses. A new message instead of a decision continues no
  sub-agent.
- [Tools](./tools-and-authorization.md) run their actions without asking, whatever the mode.

Over HTTP: `GET`/`PUT /api/agent/preferences`, `PUT /api/agent-threads/:threadId/approval-mode`,
`approvalMode` on `POST /api/agent-threads/:threadId/messages`,
`GET /api/agent-threads/:threadId/approvals`,
`POST /api/agent-threads/:threadId/approvals/:approvalId/decision` with
`{ "decision": "approve" | "deny", "always"?: true }`, and `GET /api/agent-approvals` for yours
across conversations.

## Use in your app

[Sixb apps](../apps/overview.md) include a chat interface. The home page starts a thread, each
thread has its own page at `/threads/<id>`, and `/threads` lists every thread the person can open,
their own and those shared with them. The clock button in a thread's header goes there; pass
`onOpenThreads` to `AgentPanel` or `AgentSurface` to show it in your own chat.

Files join a message from the `+` button, a drop, or a paste, such as a screenshot. Pasted text
stays text, even when the app it comes from copies a picture of it too. A message can be files
alone. While the agent answers, the person writes the next message; it sends once the answer ends.

To talk with the agent from one of your pages, embed `AgentPanel` and
give it context:

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

### Dictation

Declare a [transcription model](./configuration.md#audio-transcription) and the chat gets a
microphone:

```ts
models: {
  audio: { transcription: [vercelGateway.transcription("microsoft/mai-transcribe-2")] },
}
```

- The microphone turns the composer into a recording bar: the voice as a waveform, a timer,
  ✕ to cancel and ✓ to finish (or Escape and Enter). The transcript is added to the message, to
  edit before sending.
- The audio goes to the project's model, as inline bytes: it is never stored. The browser's own
  speech recognition, which sends audio to Google or Apple, is never used.
- Only people granted `can.run(project.models)` see the microphone. Calls count against the
  same [AI limits](./usage-and-limits.md) as other model calls.
- A recording stops on its own after five minutes.

Pass `dictation={false}` to `AgentPanel`, `AgentSurface` or `AgentChatPage` to hide it.

### Build your own chat

`AgentPanel` is assembled from parts that `@sixb/app` exports, so a chat with its own layout keeps
the built-in behavior: streaming, retries, attachments, `@` context and the model picker.
`useAgentConversation` runs one conversation and returns the props for its transcript and its
composer:

File: `app/_components/assistant.tsx`

```tsx
import {
  ArtifactPanelRoot,
  Composer,
  SandboxRecovery,
  Transcript,
  useAgentConversation,
  useRegisteredAgentContext,
} from "@sixb/app"
import { useState } from "react"

export function Assistant() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const conversation = useAgentConversation({ threadId, onThreadCreated: setThreadId })
  const pageContext = useRegisteredAgentContext()

  return (
    <ArtifactPanelRoot scopeKey={threadId ?? "new"}>
      <div className="flex h-full flex-col">
        <Transcript {...conversation.transcriptProps} />
        {conversation.sandboxRecoveryProps && (
          <SandboxRecovery {...conversation.sandboxRecoveryProps} />
        )}
        <Composer
          {...conversation.composerProps}
          ambientContext={pageContext}
          placeholder="Ask about invoices"
        />
      </div>
    </ArtifactPanelRoot>
  )
}
```

`ArtifactPanelRoot` opens the files and artifacts a reply shows. Without it, they cannot be opened.
Pass `compact` when the chat is narrow so they open in a dialog. `SandboxRecovery` appears when a
thread's sandbox stops responding; the composer stays disabled until the person starts over.

Before showing the conversation, handle `conversation.agentLoading`, `conversation.agentError`, no
`conversation.currentAgent` once loaded (the project has no agent), and
`conversation.threadUnavailable` (the thread was deleted or is not theirs).

| Part | Use it for |
| --- | --- |
| `useAgentConversation` | One conversation: messages, the turn, models with `modelChoice`, `selectModel` and `resetModelSelection`, `send`, `stop`, `retry` and `continue`; held calls with `approvals`, `canDecide` and `decide`, and the mode with `approvalMode` and `setApprovalMode` |
| `Transcript` | The messages, the streaming reply, retry or continue after a run stops early, a card for each call waiting for approval, and a line for the sub-agents of each reply |
| `AgentMessageBody` | An agent reply's content, drawn as the built-in chat draws it |
| `AgentToolPart` | One tool call: your `toolViews`, else Sixb's view, else a row to inspect it |
| `Composer` | Text, attachments (picked, dropped or pasted), `@` context, [slash commands](#slash-commands), one chip for the model (Auto with tiers) and the permissions, and the [dictation](#dictation) microphone |
| `AgentThreads` | Every thread the person can open, to search and open one; the body of `/threads` |
| `ThreadsButton` | A header button to your list of threads, counting those waiting for the person |
| `ThreadArtifactsMenu` | The artifacts a thread produced |
| `ComposerSettings` | The composer's chip on its own: the model with its thinking, and the permissions; `ProviderLogo` and `ReasoningEffortSlider` to build another |
| `ContextChips`, `ContextPicker` | Show selected context, and list matches for it |
| `useRegisteredAgentContext` | The context open pages set with `useAgentContext` |

With [tiers](./configuration.md#tiers), `conversation.modelChoice` is `"auto"` until the person
pins a model, and `selectedModel` is unset; `resetModelSelection()` returns to Auto.
`conversation.modelRouting` says whether a decision model picks on Auto. `Composer` and
`ComposerSettings` show all this as Auto when given `onResetModelSelection`.

Types such as `AgentThread`, `AgentConversationMessage` and `AgentFileRef` are exported alongside
them.

#### Slash commands

A message that is one slash word is a command: `/auto`, one per model (`/claude-opus-5-5`), and
`/ask`, `/edits` and `/full` for the permissions. Enter runs the highlighted one; Escape closes
the list and sends the text as typed. Add your own with `commands`, listed after the built-in ones:

```tsx
<Composer
  {...conversation.composerProps}
  commands={[{ name: "summary", label: "Summarize this page", run: () => summarize() }]}
/>
```

#### Draw your own messages

`conversation.messages` is the whole conversation in one list: saved messages, the one just sent,
and the reply as it streams. Draw each in a bubble of your own, with `AgentMessageBody` for the
agent's reply as the built-in chat draws it, or from its `parts` for full control:

```tsx
conversation.messages.map((message) => (
  <Bubble key={message.key} mine={message.role === "user"}>
    {message.role === "assistant" ? (
      <AgentMessageBody message={message} />
    ) : (
      message.parts.map((part, index) => part.type === "text" && <p key={index}>{part.text}</p>)
    )}
  </Bubble>
))
```

| `message` | |
| --- | --- |
| `key` | Stays the same from sending or streaming to the saved copy: use it as the React key |
| `role`, `status` | `user` or `assistant`; `pending` (sent, not saved), `streaming` or `complete` |
| `author` | Who wrote a user message: `id`, `displayName`, and `isReader` for the person reading |
| `parts` | `text`, `reasoning`, `file` and `tool`, in order. A tool part's `state` says which of `input`, `output` and `errorText` it holds, as for a tool view; draw it with `<AgentToolPart part={part} />` |
| `diagnostics` | Why a saved reply stopped short of finishing |
| `unfinished` | A reply cut short as it streamed: `failed`, or `cancelled` when someone stopped it |

The thinking shimmer and the notice of a turn that ended short are not messages: draw them from
`conversation.turn`.

| `turn.kind` | |
| --- | --- |
| `idle` | Nothing in progress |
| `responding` | The agent answers. `waitingLonger` while it queues; `answeringFor` when someone else asked |
| `failed`, `cancelled` | The turn failed or was stopped without an answer. A started answer cut short says so with `message.unfinished` |
| `timeout`, `interrupted` | The turn was cut short; `hasProgress` when it saved part of its answer |

`turn.canStop`, `turn.canRetry` and `turn.canContinue` say when `conversation.stop()`,
`conversation.retry()` and `conversation.continue()` apply. `conversation.sendError` and
`conversation.messagesError` are codes, such as `{ code: "busy", someoneElse: true }`, for your
chat to word.

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
- **A conversation that [runs on its owner's computer](../cli/overview.md#work-with-the-agent) is
  read-only for the others.** Its turns run as the owner, in their folder: a participant's message
  is refused with a 403, and the app shows them no composer.
- **Everyone sees everything.** Participants see the messages already there and the ones that
  follow, including data the agent read with someone else's access that they could not open
  themselves. Nothing checks it when you share: warn the person sharing.
- **One answer at a time.** A message sent while the agent answers is refused with a 409.
- **Only the owner adds or removes participants**, and recreates the conversation's sandbox. A
  participant can remove themself to leave.
- **Whoever sent a message can retry it; the owner can stop any answer.**
- **The agent's artifacts are shared with the conversation.** Participants read and revise them,
  in the app or through the agent, as [artifacts](../artifacts/overview.md#shared-in-a-conversation)
  describes.
- **Removing someone applies to what comes next.** They no longer read the conversation, and a
  message of theirs still waiting for an answer is cancelled. An answer already being written
  finishes, and a live stream they had open keeps running until that answer ends.

Add a user by id or by their account's email: `{ email: "bob@acme.com" }`. Only active users
who can use the agent can be added, at most 50 per conversation.

In the app, the share dialog suggests the people you already share threads with. To let people
find any colleague by name or email there, grant them the
[member directory](../auth/members.md#read-the-member-directory), `can.view(project.users)`.
Without it, they add someone new by typing their full email. Sharing a conversation is
unrelated to [shared access](../auth/shared-access.md), which gives someone outside your team a
link to one object.

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
- The copy gets its own copies of the artifacts the original shares, with their history: they are
  yours, and its messages show them at the versions they showed. An artifact that embeds or links
  another still names the original one inside its content.
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

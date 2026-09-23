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

## Control access

The agent's access depends on where it runs:

| Context | Permissions |
| --- | --- |
| Chat | The signed-in user's permissions. |
| Workflow step | Permissions granted through the step's configured groups. |

Sixb enforces permissions when the agent accesses project data or requests an operation.
Instructions and skills do not grant access.

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

## Use in your app

Atlas and [Sixb apps](../apps/overview.md) include a chat interface. In your app, open `/agents`
or embed `AgentPanel` in a page and give it context:

File: `app/_components/invoice-assistant.tsx`

```tsx
import { AgentPanel, agentContext } from "@sixb/app/agents"
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

## Use in a workflow

An [AI workflow step](../workflows/overview.md#add-an-ai-task) gives the same harness a specific
assignment. Use `defineAgentStep()` to supply instructions, declare its input and output, and
choose the groups that grant access to the data and operations it needs.

The agent completes the task and returns validated output for the workflow to continue.
For a single model call with context supplied by your code, use
[model generation](./configuration.md#generate-a-response).

For choices, rubric scores and probabilities in actions or ordinary workflow steps, use
[decision models](./decisions.md). They share model usage accounting and do not require an agent.

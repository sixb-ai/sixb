# Decisions

Use `sixb.models.decision.evaluate()` for choices, rubric scores and probabilities.
The same questions work in action writeback/effects handlers and ordinary workflow steps.

## Configure

Configure a decision provider in `models.decision`. For example, the optional
[TypeSafe provider](../../models/typesafe/README.md) supplies Jev:

```ts
import { createSixb } from "@sixb/core"
import { typesafe } from "@sixb/typesafe"

export const sixb = createSixb({
  // ...your existing storage, queues, broker and other providers
  models: {
    decision: [typesafe("jev-1.13.0")],
  },
})
```

The first decision model is the default. A decision-only project needs no language model.
An explicit `model` selects a configured binding when the project has a model catalog,
just like language generation. Pin a version when you have calibrated application thresholds;
an alias can change which model answers.

## Reusable questions

```ts
import { question } from "@sixb/core"

export const triageQuestions = {
  category: question.choice({
    instructions: "Identify the main issue in description.",
    options: {
      maintenance: "Breakdowns, leaks, and repairs",
      billing: "Invoices, payments, and refunds",
      other: "Any other request",
    },
  }),
  severity: question.score({
    instructions: "Assess the operational impact described in description.",
    levels: [
      "No operational impact",
      "Degraded operation; workaround available",
      "Operation stopped; no workaround",
    ],
  }),
  blocked: question.probability(
    "Does description explicitly report equipment that cannot operate?"
  ),
}

const { output, callId, usage, cost, responseModelId } =
  await sixb.models.decision.evaluate({
    input: { description: "The cooling unit has stopped." },
    questions: triageQuestions,
  })

output.category.choice // "maintenance" | "billing" | "other"
output.category.probabilities.maintenance // number
output.severity.score // number, possibly fractional, from 0 to 2
output.severity.probabilities // one probability per level, in declared order
output.blocked.probability // number from 0 to 1
```

Question builders return serializable descriptors. They need no registration or discovery.
Text and JSON objects/arrays are accepted as inputs and instructions. Choice descriptions
can be null. Invalid or unsupported questions reject before inference when locally verifiable.

A Choice selects one option. Use multiple probability questions for independent yes/no
judgments such as multilabel tagging. A Score is the expected level index, not a percentage.
A provider may attach `confidence` to a Choice or Score. Its meaning is provider-defined;
it is not comparable across providers or a guarantee of correctness. Validate thresholds
on your application's data.

## In a workflow

`decisionOutput()` derives ordinary Sixb schemas, retaining the literal choice types.

```ts
import { decisionOutput, defineWorkflowStep } from "@sixb/core"
import { triageQuestions } from "../lib/triage-questions"

export const triage = defineWorkflowStep("triage")
  .input({ description: "string" })
  .output(decisionOutput(triageQuestions))
  .run(async ({ input, sixb }) => {
    const { output } = await sixb.models.decision.evaluate({
      input,
      questions: triageQuestions,
    })
    return output
  })
```

Workflow steps persist their outputs. Several independent questions can share one call.
Questions whose input depends on an earlier answer need separate calls. Decisions do not
introduce conditional workflow branches or automatic human interventions.

## In an action

Evaluate in writeback; apply the stored answer in edits. This example assumes `Ticket`
has `description` and `category` string properties.

```ts
import { defineAction } from "@sixb/core"
import { Ticket } from "../ontology/ticket"
import { triageQuestions } from "../lib/triage-questions"

export const triageTicket = defineAction("triage-ticket")
  .on(Ticket)
  .params({})
  .writeback(async ({ target, sixb }) => {
    const description = target.properties.description
    const { output, callId } = await sixb.models.decision.evaluate({
      input: { description },
      questions: triageQuestions,
    })
    return {
      description,
      previousCategory: target.properties.category ?? null,
      output,
      callId,
    }
  })
  .edits(async ({ read, objects, subject, writeback }) => {
    const current = await read.objects(Ticket).get(subject.primaryId)
    if (
      !current ||
      current.properties.description !== writeback.description ||
      (current.properties.category ?? null) !== writeback.previousCategory
    ) {
      throw new Error("Ticket changed; request a new triage.")
    }
    objects(Ticket).byId(subject.primaryId).update({
      category: writeback.output.category.choice,
    })
  })
```

The guard checks the fields relevant to this example, including a category someone may have
edited while inference ran. The exact read also fences changes before commit. This is a
value comparison, not an object-incarnation or complete revision guarantee: choose source
identity and freshness rules for your domain. Current action writeback persistence does not
preserve every read dependency across attempts, so do not rely solely on reads from a
previous attempt. See the [executable example](../../models/typesafe/examples/triage.ts).

## Failure and accounting

Evaluation validates answer keys, choice options, probability bounds and distributions.
It records the provider's usage before returning, including when an answer is rejected or
an execution is cancelled after a billable response. Unknown usage or price stays unknown.

`signal` combines with execution cancellation. Sixb does not automatically retry inference;
provider transport settings are documented by each adapter. A crash after provider completion
can still leave ambiguous billing; resuming an execution is not an exactly-once inference
guarantee.

Admission reuses Sixb's estimated token/cost reservations. Input is estimated from serialized
UTF-8 bytes divided by four; output uses the existing 4,096-token allowance. This allowance
is an estimate, not a provider-enforced output cap. Actual input and output meters replace the
estimate when known. Output tokens remain part of usage even when a provider does not charge
for them.

Context limits depend on the selected model. Sixb's reservation estimate is not an exact
context check. A provider rejection is surfaced without automatic truncation, summarization
or chunking. Choose relevant fields and prepare oversized inputs explicitly.

Provider access uses the same execution rules as generation. No inference is added to
properties, rules, pipelines or agent tools. The existing recovery worker can run without
an agent sandbox in decision-only projects. See [Usage and limits](./usage-and-limits.md).

## Provider contract

Providers implement `DecisionModel` from `@sixb/core/models` and declare the question types
they support. Unsupported primitives and declared choice/level limits reject before inference.
Providers must honor the input, instructions and criteria; they must not silently omit them.
Return decoded answers as `DecisionModelResult.output` (`DecisionAnswers<DecisionQuestions>`).
Sixb still validates answer keys, options and distributions against the original questions
at runtime; the provider type does not establish those semantic guarantees.

The contract represents probabilistic decisions: choices include the complete distribution,
scores include a distribution over the declared levels, and probabilities describe a yes/no
proposition. A label-only classifier or an arbitrary similarity score does not satisfy it.
Adapters must not invent probabilities to fit the contract. Distribution validation does not
establish statistical calibration or model accuracy; evaluate those on your own data.

One evaluation has one accounting identity. Providers must not hide retries or split the
questions into independently billable requests. Missing usage and prices can stay unknown;
an enforced budget may reject a call it cannot reserve. See [Usage and limits](./usage-and-limits.md).

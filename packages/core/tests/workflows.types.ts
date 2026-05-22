import {
  actionParam,
  defineAction,
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  type InferSchemaOrRef,
  type ObjectRef,
  prop,
  ref,
} from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const workflowInput = {
  transaction: ref(Transaction),
}

type WorkflowInputValue = { transaction: InferSchemaOrRef<typeof workflowInput.transaction> }
type _workflowInputValue = Expect<
  Equal<WorkflowInputValue, { transaction: ObjectRef<"Transaction"> }>
>

const findBestInvoice = defineWorkflowStep("find-best-invoice")
  .input(workflowInput)
  .output({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .run(async (ctx) => {
    const transaction: ObjectRef<"Transaction"> = ctx.input.transaction
    ctx.pario.objects(Transaction)

    // @ts-expect-error step handlers only receive their own input
    ctx.input.invoice

    // @ts-expect-error step handlers do not receive workflow mapper context
    ctx.steps

    return {
      transaction,
      invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
      confidence: 0.98,
    }
  })

defineWorkflowStep("bad-output")
  .input({})
  .output({
    invoice: ref(Invoice),
  })
  .run(() => ({
    // @ts-expect-error step output must match the declared output contract
    invoice: { objectTypeId: "Transaction", primaryId: "transaction:1" },
  }))

const reviewInvoiceMatch = defineWorkflowStep("review-invoice-match")
  .input({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(({ input }) => ({
    invoice: input.invoice,
  }))

const persistReview = defineWorkflowStep("persist-review")
  .input({
    invoice: ref(Invoice),
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(({ input }) => ({
    invoice: input.invoice,
  }))

const attachInvoice = defineAction("attach-invoice")
  .target(Transaction)
  .params({
    invoice: actionParam(ref(Invoice), { required: true }),
  })
  .run(async () => {})

const workflow = defineWorkflow("reconcile-transaction")
  .input(workflowInput)
  .then(findBestInvoice)
  .then(reviewInvoiceMatch, ({ input, steps }) => {
    const transaction: ObjectRef<"Transaction"> = input.transaction
    const invoice: ObjectRef<"Invoice"> = steps.findBestInvoice.invoice
    const confidence: number = steps.findBestInvoice.confidence

    // @ts-expect-error later step outputs are not available yet
    steps.reviewInvoiceMatch

    return {
      transaction,
      invoice,
      confidence,
    }
  })
  .then(attachInvoice, ({ input, steps }) => ({
    target: input.transaction,
    params: {
      invoice: steps.reviewInvoiceMatch.invoice,
    },
  }))
  .then(persistReview, ({ steps }) => {
    // @ts-expect-error action nodes do not expose business output in steps
    steps.attachInvoice

    return {
      invoice: steps.reviewInvoiceMatch.invoice,
    }
  })

defineWorkflow("direct-step-dataflow")
  .input(workflowInput)
  .then(findBestInvoice)
  .then(reviewInvoiceMatch)

// @ts-expect-error workflow input has no invoice for this direct first step
defineWorkflow("direct-step-mismatch").input(workflowInput).then(persistReview)

// @ts-expect-error action mapper is mandatory
defineWorkflow("missing-action-mapper").input(workflowInput).then(attachInvoice)

// @ts-expect-error aliases are not supported in V1
defineWorkflow("step-alias").input(workflowInput).then(findBestInvoice, "find")

defineWorkflow("step-mapper-alias")
  .input(workflowInput)
  // @ts-expect-error aliases are not supported in V1
  .then(findBestInvoice, ({ input }) => input, "find")

defineWorkflow("bad-action-target")
  .input(workflowInput)
  .then(findBestInvoice)
  // @ts-expect-error action target must be a Transaction ref
  .then(attachInvoice, ({ steps }) => ({
    target: steps.findBestInvoice.invoice,
    params: {
      invoice: steps.findBestInvoice.invoice,
    },
  }))

defineWorkflow("bad-action-param")
  .input(workflowInput)
  .then(findBestInvoice)
  // @ts-expect-error invoice param must be an Invoice ref
  .then(attachInvoice, ({ input }) => ({
    target: input.transaction,
    params: {
      invoice: input.transaction,
    },
  }))

void workflow

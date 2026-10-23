import { defineAgentTool } from "@sixb/core"
import { type AgentToolView, type AgentToolViewProps, defineAgentToolView } from "../src"

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false
type Expect<TValue extends true> = TValue

const quoteShipping = defineAgentTool("quote_shipping")
  .description("Quote a shipment for an order.")
  .input({ orderId: "string" })
  .run(async ({ input }) => ({ orderId: input.orderId, carrier: "DHL", price: 42 }))

const countRows = defineAgentTool("count_rows")
  .description("Count rows.")
  .input({ table: "string" })
  .run(({ input }) => input.table.length)

// ── The tool's name is checked against its definition ─────────────────────

defineAgentToolView<typeof quoteShipping>("quote_shipping")

// Reproduce: type `name` as `string` in defineAgentToolView and this directive is unused.
// @ts-expect-error the view names a tool other than the one it is typed with
defineAgentToolView<typeof quoteShipping>("quote_shiping")

// @ts-expect-error a placement outside the closed set
defineAgentToolView<typeof quoteShipping>("quote_shipping", { placement: "body" })

// ── Input and output follow the state ────────────────────────────────────

type QuoteProps = AgentToolViewProps<typeof quoteShipping>

type _availableInput = Expect<
  Equal<Extract<QuoteProps, { state: "input-available" }>["input"], { readonly orderId: string }>
>
type _output = Expect<
  Equal<
    Extract<QuoteProps, { state: "output-available" }>["output"],
    { orderId: string; carrier: string; price: number }
  >
>
type _noOutputUntilAvailable = Expect<
  Equal<Exclude<QuoteProps, { state: "output-available" }>["output"], undefined>
>
type _noInputWhileStreaming = Expect<
  Equal<Extract<QuoteProps, { state: "input-streaming" }>["input"], undefined>
>
type _errorText = Expect<Equal<Extract<QuoteProps, { state: "output-error" }>["errorText"], string>>
type _outputInput = Expect<
  Equal<Extract<QuoteProps, { state: "output-available" }>["input"], { readonly orderId: string }>
>
// A call refused for its input carries what the model sent, which need not match the schema.
type _errorInput = Expect<Equal<Extract<QuoteProps, { state: "output-error" }>["input"], unknown>>

// Destructured props narrow by state, as the documented view writes them.
export const quoteView = defineAgentToolView<typeof quoteShipping>("quote_shipping", {
  placement: "answer",
}).render(({ state, input, output }) => {
  if (state === "output-available") {
    const carrier: string = output.carrier
    return `${carrier} ${output.price}`
  }

  // @ts-expect-error output is undefined before the call succeeds
  output.carrier

  if (state === "output-error") {
    // @ts-expect-error a refused input is not the tool's input
    input?.orderId
    return null
  }

  const orderId: string | undefined = input?.orderId
  return orderId ?? null
})

const countView = defineAgentToolView<typeof countRows>("count_rows").render((props) =>
  props.state === "output-available" ? props.output.toFixed(0) : null
)

// Views of different tools make one list, as the layout's `toolViews` export holds them.
export const toolViews: readonly AgentToolView[] = [quoteView, countView]

type _toolName = Expect<Equal<typeof quoteView.toolName, "quote_shipping">>

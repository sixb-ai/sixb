import { defineWebhook, webhookConnector } from "../src"

const schema = {
  parse(value: unknown): { name: string } {
    if (typeof value !== "object" || value === null || !("name" in value)) {
      throw new Error("name is required")
    }

    return { name: String(value.name) }
  },
}

webhookConnector({
  webhooks: [
    defineWebhook("typed")
      .post()
      .json(schema)
      .verify((context) => {
        // @ts-expect-error verification runs before trusted Webhook authority is admitted
        context.sixb
        // @ts-expect-error verification is not attached to a durable run yet
        context.logger
      })
      .idempotencyKey((context) => {
        const { body } = context
        // @ts-expect-error idempotency resolution also runs before admission
        context.sixb
        // @ts-expect-error idempotency resolution is not attached to a durable run yet
        context.logger
        return body.name
      })
      .handle(async ({ body, client, logger }) => {
        logger.info("handle")
        const _name: string = body.name
        const connector = await client()
        const _kind: "webhook" = connector.kind

        // @ts-expect-error validated JSON bodies only expose schema-returned fields
        body.missing
      }),
  ],
})

defineWebhook("unknown")
  .post()
  .json()
  .handle(({ body }) => {
    // @ts-expect-error arbitrary JSON webhooks keep body unknown
    body.name
  })

// @ts-expect-error typed JSON webhooks require a runtime parser argument
defineWebhook("type-only").post().json<{ name: string }>()

defineWebhook("managed")
  .post()
  .json(schema)
  .verify((context) => {
    // @ts-expect-error verification cannot resolve managed connections
    context.connections
  })
  .handle<{ read(): Promise<void> }>(async (context) => {
    const _name: string = context.body.name
    for (const target of await context.connections.forAccount(context.body.name)) {
      const _account: string = target.connection.account.id
      await (await target.client()).read()
      // @ts-expect-error client type is preserved through connection lookup
      ;(await target.client()).missing()
    }
    const _request: Request = context.request
    // @ts-expect-error parsed payload shape is inferred
    context.body.missing
  })

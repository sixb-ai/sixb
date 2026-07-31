/**
 * How a webhook is allowed to treat the signature its provider sends.
 *
 * A union, so a webhook that verifies nothing cannot be written by accident: no value carries
 * neither branch. `resolveWebhookVerification` covers the path where the secret arrives as
 * `string | undefined` from the environment, which no type can narrow.
 */
export type WebhookVerification =
  | { readonly secret: string; readonly allowUnsigned?: never }
  | {
      readonly secret?: never
      /**
       * Accept deliveries this webhook cannot verify. Without a secret the route accepts
       * unsigned requests from anyone who can reach it, so it has to be asked for.
       */
      readonly allowUnsigned: true
    }

/** How to name a webhook in a message about its verification. */
export interface WebhookVerificationSubject {
  /** The connector, as it appears in its own message prefix — `GitHub`, `Mercury`. */
  readonly connector: string
  /** The signature header this webhook verifies when a secret is configured. */
  readonly header: string
  /** How to configure the secret, in the words the connector's own options use. */
  readonly secretOption: string
}

export class UnverifiedWebhookError extends Error {
  readonly name = "UnverifiedWebhookError"
}

/**
 * Narrows a secret that may be absent into a {@link WebhookVerification}, or refuses.
 *
 * Returns the union so a caller spreads the result into the builder instead of deciding again,
 * which keeps one rule and one message across three connectors.
 *
 * Refusing is the point. Every connector with an optional secret used to do the same thing when it
 * was missing — `if (!options.secret) return` inside `.verify()` — and the route then accepted any
 * request that reached it. A console warning was not enough: one of the three is a banking
 * connector. Throwing here means `createSixb()` fails and the API role never starts open.
 */
export function resolveWebhookVerification(
  subject: WebhookVerificationSubject,
  options: { readonly secret?: string; readonly allowUnsigned?: boolean }
): WebhookVerification {
  if (options.secret) return { secret: options.secret }

  if (!options.allowUnsigned) {
    throw new UnverifiedWebhookError(
      `[${subject.connector}] This webhook has no secret, so ${subject.header} cannot be ` +
        `verified and the route would accept unsigned requests from anyone who can reach it. Set ` +
        `${subject.secretOption}, or pass \`allowUnsigned: true\` to accept that.`
    )
  }

  return { allowUnsigned: true }
}

/**
 * Announces a webhook whose author chose to accept unsigned deliveries. Called where the webhook
 * is defined, not inside `verify()`: once per boot is a fact, once per request is noise.
 */
export function warnUnsignedWebhook(
  subject: WebhookVerificationSubject,
  verification: WebhookVerification
): void {
  if (verification.secret) return

  console.warn(
    `[${subject.connector}] \`allowUnsigned: true\`, so ${subject.header} is not verified ` +
      `and this route accepts unsigned requests from anyone who can reach it. Set ` +
      `${subject.secretOption} before exposing it.`
  )
}

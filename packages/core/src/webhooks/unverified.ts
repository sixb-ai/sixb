/**
 * How a webhook is allowed to treat the credential its provider sends.
 *
 * A union, so a webhook that verifies nothing cannot be written by accident: no value carries
 * neither branch. `resolveWebhookVerification` covers the path where the credential arrives as
 * `TSecret | undefined` from the environment, which no type can narrow.
 *
 * Generic because a credential is not always a signing secret: PandaDoc resolves a shared key,
 * Pipedrive compares HTTP basic auth.
 */
export type WebhookVerification<TSecret = string> =
  | { readonly secret: TSecret; readonly allowUnverified?: never }
  | {
      readonly secret?: never
      /**
       * Accept deliveries this webhook cannot verify. Without a secret the route accepts
       * requests from anyone who can reach it, so it has to be asked for.
       */
      readonly allowUnverified: true
    }

/** How to name a webhook in a message about its verification. */
export interface WebhookVerificationSubject {
  /** The connector, as it appears in its own message prefix — `SixbGitHub`, `SixbMercury`. */
  readonly connector: string
  /** What this webhook checks when a secret is configured, as a noun phrase. */
  readonly verifies: string
  /** How to configure the secret, in the words the connector's own options use. */
  readonly secretOption: string
}

export class UnverifiedWebhookError extends Error {
  readonly name = "UnverifiedWebhookError"
}

/**
 * Narrows a credential that may be absent into a {@link WebhookVerification}, or refuses.
 *
 * Returns the union so a caller spreads the result into the builder instead of deciding again,
 * which keeps one rule and one message across every connector.
 *
 * Refusing is the point. Every connector with an optional credential used to do the same thing when
 * it was missing — `if (!options.secret) return` inside `.verify()` — and the route then accepted
 * any request that reached it. A console warning was not enough: one of them is a banking
 * connector. Throwing here means `createSixb()` fails and the API role never starts open.
 */
export function resolveWebhookVerification<TSecret>(
  subject: WebhookVerificationSubject,
  options: { readonly secret?: TSecret; readonly allowUnverified?: boolean }
): WebhookVerification<TSecret> {
  if (options.secret) return { secret: options.secret }

  if (!options.allowUnverified) {
    throw new UnverifiedWebhookError(
      `[${subject.connector}] This webhook has no secret, so ${subject.verifies} cannot be ` +
        `checked and the route would accept unverified requests from anyone who can reach it. ` +
        `Set ${subject.secretOption}, or pass \`allowUnverified: true\` to accept that.`
    )
  }

  return { allowUnverified: true }
}

/**
 * Announces a webhook whose author chose to accept unverified deliveries. Called where the webhook
 * is defined, not inside `verify()`: once per boot is a fact, once per request is noise.
 */
export function warnUnverifiedWebhook<TSecret>(
  subject: WebhookVerificationSubject,
  verification: WebhookVerification<TSecret>
): void {
  if (verification.secret) return

  console.warn(
    `[${subject.connector}] \`allowUnverified: true\`, so ${subject.verifies} is not checked ` +
      `and this route accepts unverified requests from anyone who can reach it. ` +
      `Set ${subject.secretOption} before exposing it.`
  )
}

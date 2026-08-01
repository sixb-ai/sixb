/**
 * How a webhook is allowed to treat the credential its provider sends.
 *
 * A union, so no value carries neither branch. `resolveWebhookVerification` covers the path
 * where the credential arrives as `TCredential | undefined` from the environment, which no type
 * can narrow. Generic because a credential is not always a signing secret: PandaDoc resolves a
 * shared key, Pipedrive compares a username and password.
 */
export type WebhookVerification<TCredential = string> =
  | { readonly credential: TCredential; readonly allowUnverified?: never }
  | {
      readonly credential?: never
      /**
       * Accept deliveries this webhook cannot verify. Without a credential the route accepts
       * requests from anyone who can reach it, so it has to be asked for.
       */
      readonly allowUnverified: true
    }

/**
 * How to name a webhook, and its options, in a message about its verification.
 *
 * The options are part of the subject because a connector has two entry points with different
 * names for the same thing: a message fixed to one sends half the callers to an option their
 * API does not have.
 */
export interface WebhookVerificationSubject {
  /** The connector, as it appears in its own message prefix — `SixbGitHub`, `SixbMercury`. */
  readonly connector: string
  /** What this webhook checks when a credential is configured, as a noun phrase. */
  readonly verifies: string
  /** The option carrying the credential, written as the caller would type it. */
  readonly credentialOption: string
  /** The option that accepts unverified deliveries, written as the caller would type it. */
  readonly allowOption: string
}

export class UnverifiedWebhookError extends Error {
  readonly name = "UnverifiedWebhookError"
}

/**
 * Narrows a credential that may be absent into a {@link WebhookVerification}, or refuses.
 *
 * Returns the union so a caller spreads the result into the builder instead of deciding again.
 * Refusing is the point: a missing credential used to mean `.verify()` returned early and the
 * route accepted anything that reached it. Throwing here fails `createSixb()` instead, so the
 * API role never starts open.
 */
export function resolveWebhookVerification<TCredential>(
  subject: WebhookVerificationSubject,
  options: { readonly credential?: TCredential; readonly allowUnverified?: boolean }
): WebhookVerification<TCredential> {
  if (options.credential) return { credential: options.credential }

  if (!options.allowUnverified) {
    throw new UnverifiedWebhookError(
      `[${subject.connector}] This webhook has no credential, so ${subject.verifies} cannot be ` +
        `checked and the route would accept unverified requests from anyone who can reach it. ` +
        `Set ${subject.credentialOption}, or pass ${subject.allowOption} to accept that.`
    )
  }

  return { allowUnverified: true }
}

/**
 * Announces a webhook whose author chose to accept unverified deliveries. Called where the
 * webhook is defined, not inside `verify()`: once per boot is a fact, once per request is noise.
 */
export function warnUnverifiedWebhook<TCredential>(
  subject: WebhookVerificationSubject,
  verification: WebhookVerification<TCredential>
): void {
  if (verification.credential) return

  console.warn(
    `[${subject.connector}] ${subject.allowOption}, so ${subject.verifies} is not checked ` +
      `and this route accepts unverified requests from anyone who can reach it. ` +
      `Set ${subject.credentialOption} before exposing it.`
  )
}

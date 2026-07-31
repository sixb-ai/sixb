export interface WebhookVerificationRequirement {
  /** The connector, as it appears in its own message prefix — `GitHub`, `Mercury`. */
  readonly connector: string
  /** The signature header this webhook verifies when a secret is configured. */
  readonly header: string
  /** How to configure the secret, in the words the connector's own options use. */
  readonly secretOption: string
  /** The configured secret, if any. */
  readonly secret: string | undefined
  /** The caller's explicit decision to accept unsigned requests. */
  readonly allowUnsigned: boolean | undefined
}

export class UnverifiedWebhookError extends Error {
  readonly name = "UnverifiedWebhookError"
}

/**
 * Refuses a webhook that would accept unsigned requests without being asked to.
 *
 * Every connector with an optional secret used to do the same thing when it was
 * missing: `if (!options.secret) return` inside `.verify()`, and the route then
 * accepted any request that reached it. A console warning was not enough — one of the
 * three is a banking connector, and a warning in a startup log is read by nobody.
 *
 * So the default is closed. No secret and no `allowUnsigned: true` throws where the
 * webhook is defined, which is inside `createSixb()`: the config fails to load, so the
 * API role never starts rather than starting open. Accepting unsigned deliveries stays
 * possible — a provider that cannot sign, a captured payload replayed locally — but it
 * is now a sentence someone wrote on purpose.
 *
 * Called at definition time, not inside `verify()`: once per boot is a fact about the
 * deployment, once per request is noise that gets filtered.
 */
export function requireWebhookVerification(requirement: WebhookVerificationRequirement): void {
  if (requirement.secret) return

  if (!requirement.allowUnsigned) {
    throw new UnverifiedWebhookError(
      `[${requirement.connector}] This webhook has no secret, so ${requirement.header} cannot be ` +
        `verified and the route would accept unsigned requests from anyone who can reach it. Set ` +
        `${requirement.secretOption}, or pass \`allowUnsigned: true\` to accept that.`
    )
  }

  console.warn(
    `[${requirement.connector}] \`allowUnsigned: true\`, so ${requirement.header} is not verified ` +
      `and this route accepts unsigned requests from anyone who can reach it. Set ` +
      `${requirement.secretOption} before exposing it.`
  )
}

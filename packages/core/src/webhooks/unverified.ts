export interface UnverifiedWebhookWarning {
  /** The connector, as it appears in its own message prefix — `GitHub`, `Mercury`. */
  readonly connector: string
  /** The signature header this webhook verifies when a secret is configured. */
  readonly header: string
  /** How to configure the secret, in the words the connector's own options use. */
  readonly secretOption: string
}

/**
 * Announces a webhook that will accept unsigned requests.
 *
 * Every connector with an optional secret does the same thing when it is missing:
 * `if (!options.secret) return` inside `.verify()`, and the route then accepts any
 * request that reaches it. That is a defensible default for local development and an
 * open door in production, and none of them said so — one of the three is a banking
 * connector.
 *
 * Call this where the webhook is defined, not inside `verify()`: once per boot is a
 * fact about the deployment, once per request is noise that gets filtered.
 */
export function warnUnverifiedWebhook(warning: UnverifiedWebhookWarning): void {
  console.warn(
    `[${warning.connector}] No webhook secret is configured, so ${warning.header} is not ` +
      `verified and this route accepts unsigned requests from anyone who can reach it. Set ` +
      `${warning.secretOption} before exposing it.`
  )
}

import { createHmac, timingSafeEqual } from "node:crypto"
import { MicrosoftConfigurationError } from "./errors"

/**
 * A Graph subscription's `clientState` is the only secret a notification carries, so it is how the
 * receiver knows a notification came from a subscription this connector made.
 *
 * An application connection sends the webhook secret itself. A person's connection sends
 * `v1.<account id>.<MAC>`. Graph echoes `clientState` on change and lifecycle notifications alike,
 * and a lifecycle notification carries nothing else that names the mailbox, so the value itself
 * has to say whose subscription it is. The MAC keeps a value made for one account from naming
 * another.
 */

const VERSION = "v1"
const ENTRA_OBJECT_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

/** Makes the clientState a subscription carries; called when one is created. */
export type ClientStateSource = () => string

export function personalClientState(secret: string, accountId: string): string {
  if (!ENTRA_OBJECT_ID.test(accountId))
    throw new MicrosoftConfigurationError(
      "A personal subscription needs the connection's account to be an Entra object id."
    )
  return `${VERSION}.${accountId}.${mac(secret, accountId)}`
}

/** The account a personal clientState names, or undefined when it is not one this secret signed. */
export function personalClientStateAccount(
  secret: string,
  clientState: string
): string | undefined {
  const [version, accountId, signature, ...rest] = clientState.split(".")
  if (
    version !== VERSION ||
    accountId === undefined ||
    signature === undefined ||
    rest.length > 0 ||
    !ENTRA_OBJECT_ID.test(accountId)
  )
    return undefined
  return equal(signature, mac(secret, accountId)) ? accountId : undefined
}

export function sharedClientStateMatches(secret: string, clientState: string): boolean {
  return equal(clientState, secret)
}

function mac(secret: string, accountId: string): string {
  return createHmac("sha256", secret)
    .update(`sixb-microsoft-client-state.${VERSION}.${accountId}`)
    .digest("base64url")
}

function equal(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

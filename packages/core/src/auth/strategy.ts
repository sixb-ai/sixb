/**
 * Auth strategy provider contract (`@sixb/core/auth/strategy`).
 *
 * The contract auth-strategy packages (e.g. `@sixb/auth-magic-link`,
 * `@sixb/auth-oidc`) implement, without the server-side auth runtime that
 * `./index` carries. Strategy authors should not need anything beyond this
 * entry plus the storage contracts from `@sixb/core/storage`.
 */

export type {
  AuthEmailDeliveryStatus,
  AuthInvitationRecipientInput,
  AuthInvitationRecipientResult,
  AuthInvitationRecipientStatus,
  AuthRequestResult,
  AuthStrategy,
  AuthStrategyKind,
  InvitationDeliveryAuthStrategy,
  InvitationDeliveryInput,
  InvitationRecipientInput,
  InvitationRecipientResult,
  InvitationRecipientStatus,
  InviteDeliveryResult,
  InviteDeliveryStatus,
  MagicLinkAuthStrategy,
  MagicLinkCallbackInput,
  MagicLinkCallbackResult,
  MagicLinkInvitationRecipientInput,
  MagicLinkInvitationRecipientResult,
  MagicLinkInvitationRecipientStatus,
  MagicLinkPeekInput,
  MagicLinkPeekResult,
  MagicLinkRequestInput,
  MagicLinkRequestResult,
  MagicLinkRequestStatus,
  OidcAuthStrategy,
  OidcCallbackInput,
  OidcCallbackResult,
  OidcStartSignInInput,
  OidcStartSignInResult,
  RevealedInvitationLink,
} from "./types"
export {
  isInvitationDeliveryAuthStrategy,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
} from "./validation"

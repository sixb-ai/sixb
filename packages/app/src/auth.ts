export type AuthExperienceState =
  | { readonly kind: "signIn" }
  | { readonly kind: "checkEmail" }
  | {
      readonly kind: "confirm"
      readonly email?: string
      /** The link creates the person's account: ask for their name and pass it to `confirmSignIn`. */
      readonly firstSignIn?: true
    }
  | { readonly kind: "invalidLink" }
  | { readonly kind: "error" }

export interface AuthExperienceActions {
  requestMagicLink(email: string): void
  /** `displayName` names a new account; it is ignored when the person already has one. */
  confirmSignIn(input?: { readonly displayName?: string }): void
  restartSignIn(): void
}

export interface AuthExperienceProps {
  readonly state: AuthExperienceState
  readonly actions: AuthExperienceActions
}

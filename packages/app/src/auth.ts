export type AuthExperienceState =
  | { readonly kind: "signIn" }
  | { readonly kind: "checkEmail" }
  | { readonly kind: "confirm"; readonly email?: string }
  | { readonly kind: "invalidLink" }
  | { readonly kind: "error" }

export interface AuthExperienceActions {
  requestMagicLink(email: string): void
  confirmSignIn(): void
  restartSignIn(): void
}

export interface AuthExperienceProps {
  readonly state: AuthExperienceState
  readonly actions: AuthExperienceActions
}

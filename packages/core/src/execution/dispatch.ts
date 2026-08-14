/**
 * Typed boundary for turning one resolved primitive run intent into durable state and transport.
 * Implementations own their primitive-specific validation, persistence, and queue publication.
 */
export interface RunDispatcher<TInput, TResult> {
  dispatch(input: TInput): Promise<TResult>
}

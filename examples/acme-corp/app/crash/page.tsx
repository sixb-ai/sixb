// Dev-only fixture for the custom app's default error boundary. This route
// throws on render, so visiting /crash lands directly on the built-in
// "Something went wrong" fallback (no app/error.tsx override defined).
export default function CrashTest(): never {
  throw new Error("Forced render error from /crash")
}

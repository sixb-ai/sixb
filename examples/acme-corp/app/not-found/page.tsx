import { getObjectOptions } from "@sixb/client/hooks"
import { encodeObjectId } from "@sixb/client/models"
import { useQuery } from "@tanstack/react-query"

// Dev-only fixture for the custom app's default not-found view. Querying a
// guaranteed-missing object with `throwOnError` escalates the 404 (a
// SixbApiError with status 404) to the error boundary, which renders the
// built-in "Not found" view. Visit /not-found.
//
// (An unknown URL such as /does-not-exist hits the catch-all route and renders
// the same view without any fixture.)
export default function NotFoundTest() {
  const objectId = encodeObjectId("Project", "does-not-exist:forced-404")
  useQuery({
    ...getObjectOptions({ path: { objectId } }),
    throwOnError: true,
    retry: false,
  })
  return null
}

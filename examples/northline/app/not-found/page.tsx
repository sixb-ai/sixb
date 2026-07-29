import { Button } from "@sixb/ui/components"
import { Link } from "react-router-dom"

export default function NotFoundPage() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <p className="font-mono text-xs font-semibold text-primary">404</p>
        <h1 className="mt-2 text-2xl font-bold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This Northline Operations route does not exist.
        </p>
        <Button asChild className="mt-5">
          <Link to="/">Return to Today</Link>
        </Button>
      </div>
    </div>
  )
}

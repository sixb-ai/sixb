import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { App } from "../../src/App"
import { docs } from "../../src/generated/docs"

interface DocPageProps {
  readonly params: Promise<{
    readonly slug: string[]
  }>
}

export const dynamicParams = false

export function generateStaticParams() {
  return docs.map((doc) => ({
    slug: doc.routePath.replace(/^\//, "").split("/"),
  }))
}

export async function generateMetadata({ params }: DocPageProps): Promise<Metadata> {
  const path = pathFromSlug((await params).slug)
  const doc = docs.find((entry) => entry.routePath === path)

  if (!doc) return {}

  const description = doc.summary.replace(/\s+/g, " ").trim()

  return {
    title: doc.title,
    description,
    alternates: {
      canonical: doc.routePath,
    },
    openGraph: {
      type: "article",
      url: doc.routePath,
      siteName: "Sixb Docs",
      title: `${doc.title} | Sixb Docs`,
      description,
    },
  }
}

export default async function DocPage({ params }: DocPageProps) {
  const path = pathFromSlug((await params).slug)
  const doc = docs.find((entry) => entry.routePath === path)

  if (!doc) notFound()

  return <App initialPath={doc.routePath} />
}

function pathFromSlug(slug: readonly string[]): string {
  return `/${slug.join("/")}`
}

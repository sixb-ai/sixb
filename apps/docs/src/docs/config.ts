import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..", "..", "..", "..")
const docsRoot = join(repoRoot, "docs")

export interface DocConfig {
  readonly title: string
  readonly section: string
  readonly routePath: string
  readonly markdownPath: string
  readonly sourcePath: string
}

export const docsConfig: readonly DocConfig[] = [
  {
    title: "Get Started",
    section: "Get started",
    routePath: "/get-started",
    markdownPath: "/get-started.md",
    sourcePath: join(docsRoot, "README.md"),
  },
  {
    title: "Ontology",
    section: "Core concepts",
    routePath: "/concepts/ontology",
    markdownPath: "/concepts/ontology.md",
    sourcePath: join(docsRoot, "concepts", "ontology.md"),
  },
  {
    title: "Dataset",
    section: "Core concepts",
    routePath: "/concepts/datasets",
    markdownPath: "/concepts/datasets.md",
    sourcePath: join(docsRoot, "concepts", "datasets.md"),
  },
  {
    title: "Connector",
    section: "Core concepts",
    routePath: "/concepts/connector",
    markdownPath: "/concepts/connector.md",
    sourcePath: join(docsRoot, "concepts", "connector.md"),
  },
  {
    title: "Sync",
    section: "Core concepts",
    routePath: "/concepts/sync",
    markdownPath: "/concepts/sync.md",
    sourcePath: join(docsRoot, "concepts", "sync.md"),
  },
  {
    title: "Pipeline",
    section: "Core concepts",
    routePath: "/concepts/pipeline",
    markdownPath: "/concepts/pipeline.md",
    sourcePath: join(docsRoot, "concepts", "pipeline.md"),
  },
  {
    title: "Projection",
    section: "Core concepts",
    routePath: "/concepts/projection",
    markdownPath: "/concepts/projection.md",
    sourcePath: join(docsRoot, "concepts", "projection.md"),
  },
  {
    title: "Rules",
    section: "Core concepts",
    routePath: "/concepts/rules",
    markdownPath: "/concepts/rules.md",
    sourcePath: join(docsRoot, "concepts", "rules.md"),
  },
  {
    title: "Workflow",
    section: "Core concepts",
    routePath: "/concepts/workflows",
    markdownPath: "/concepts/workflows.md",
    sourcePath: join(docsRoot, "concepts", "workflows.md"),
  },
]

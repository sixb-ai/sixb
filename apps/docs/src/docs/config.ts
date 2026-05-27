import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..", "..", "..", "..")
const docsRoot = join(repoRoot, "docs")

export interface DocConfig {
  readonly title: string
  readonly routePath: string
  readonly markdownPath: string
  readonly sourcePath: string
}

export const docsConfig: readonly DocConfig[] = [
  {
    title: "Get Started",
    routePath: "/get-started",
    markdownPath: "/get-started.md",
    sourcePath: join(docsRoot, "README.md"),
  },
  {
    title: "Ontology",
    routePath: "/concepts/ontology",
    markdownPath: "/concepts/ontology.md",
    sourcePath: join(docsRoot, "concepts", "ontology.md"),
  },
  {
    title: "Dataset",
    routePath: "/concepts/datasets",
    markdownPath: "/concepts/datasets.md",
    sourcePath: join(docsRoot, "concepts", "datasets.md"),
  },
  {
    title: "Connector",
    routePath: "/concepts/connector",
    markdownPath: "/concepts/connector.md",
    sourcePath: join(docsRoot, "concepts", "connector.md"),
  },
  {
    title: "Sync",
    routePath: "/concepts/sync",
    markdownPath: "/concepts/sync.md",
    sourcePath: join(docsRoot, "concepts", "sync.md"),
  },
  {
    title: "Pipeline",
    routePath: "/concepts/pipeline",
    markdownPath: "/concepts/pipeline.md",
    sourcePath: join(docsRoot, "concepts", "pipeline.md"),
  },
  {
    title: "Projection",
    routePath: "/concepts/projection",
    markdownPath: "/concepts/projection.md",
    sourcePath: join(docsRoot, "concepts", "projection.md"),
  },
  {
    title: "Rules",
    routePath: "/concepts/rules",
    markdownPath: "/concepts/rules.md",
    sourcePath: join(docsRoot, "concepts", "rules.md"),
  },
  {
    title: "Workflow",
    routePath: "/concepts/workflows",
    markdownPath: "/concepts/workflows.md",
    sourcePath: join(docsRoot, "concepts", "workflows.md"),
  },
]

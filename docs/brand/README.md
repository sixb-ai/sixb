# README artwork

Regenerate the light and dark architecture illustrations from the repository root:

```bash
bun --filter @sixb/docs generate:readme
```

The exporter reuses the docs landing page's `FrameworkStack.tsx` artwork, colors from
`homeWalkthrough.css`, and connector logos. It arranges the layers horizontally and embeds
the logos so each SVG renders independently on GitHub. Edit the source, then regenerate
both variants instead of editing the SVGs directly.

Atlas and app screenshots show the local `examples/northline` project with fictional demo
data. When refreshing a screenshot, capture the same view in light and dark mode and keep
its existing filename pair so the README continues to follow the reader's theme.

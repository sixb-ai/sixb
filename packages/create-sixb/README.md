# create-sixb

Create a new [Sixb](https://github.com/sixb-ai/sixb) project with Bun.

```bash
bun create sixb my-app
cd my-app
bun install
bun run dev
```

The package owns the project template and scaffolding implementation without pulling the full Sixb
CLI dependency tree. The generated project installs the CLI and uses its local `sixb` command.

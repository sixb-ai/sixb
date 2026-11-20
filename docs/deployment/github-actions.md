# Deploy from GitHub Actions

A workflow deploys on every push the same way you do from your laptop: it checks out the commit and runs `sixb deploy`. What it needs is a way to reach the server over SSH as the deploy account. The job has no SSH config of yours, so `sixb.deploy.ts` names that account with `user`.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

# One deploy at a time: a push during a deploy waits for it.
concurrency:
  group: deploy
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json
      # The job only reads sixb.deploy.ts and sends the commit; the server runs install scripts.
      - run: bun install --frozen-lockfile --ignore-scripts
      - name: Reach the server
        run: |
          install -d -m 700 ~/.ssh
          printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
          printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts
        env:
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
      - run: bun sixb deploy
```

Store two secrets in the repository's `production` environment:

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | The private half of a key made for this workflow (`ssh-keygen -t ed25519 -N "" -f deploy`), whose public half is in the deploy account's `authorized_keys` on the server |
| `DEPLOY_KNOWN_HOSTS` | The server's host keys, from a connection you have checked: `ssh-keygen -F <host>` on your machine |

Pinning the host keys means the workflow deploys to your server and refuses anything else that answers at its address. To require an approval before each deploy, add required reviewers to the `production` environment.

## Over Tailscale

When the server is reachable only over a tailnet, the job joins it instead of holding a key, and `host` in `sixb.deploy.ts` is the server's Tailscale name. With [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh) allowing the job's tag to log in as the deploy account, replace the "Reach the server" step:

```yaml
      - uses: tailscale/github-action@v3
        with:
          oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
          oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
          tags: tag:ci
      - name: Trust the server
        run: |
          install -d -m 700 ~/.ssh
          printf 'Host *.ts.net\n  StrictHostKeyChecking accept-new\n' >> ~/.ssh/config
```

## The project's own variables

The workflow needs no secrets for them. With [a source](environment-variables.md#deploy), the server pulls `.env` itself, so the job never holds a value or a token.

## Environment variables in `sixb.deploy.ts`

When `sixb.deploy.ts` reads environment variables, set them for the job:

```yaml
jobs:
  deploy:
    env:
      SHOP_DEPLOY_HOST: 203.0.113.10
```

`sixb deploy status` shows each deploy as made by the GitHub user who pushed, through GitHub Actions.

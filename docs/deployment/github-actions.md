# Deploy from GitHub Actions

Deploy on every push to a branch. Once the server is [set up](servers.md#set-up-the-server), run this from the project, logged in to the [GitHub CLI](https://cli.github.com) as someone who can change the repository's settings:

```bash
bun sixb deploy ci
```

It uses that login even when the project's `.env` sets `GITHUB_TOKEN`, for example for a connector. To run it with another token, set `GH_TOKEN`.

It:

1. Creates an SSH key for the repository's deploys and authorizes it on the server. The key can run commands and nothing else: no port forwarding and no terminal. Its private half goes straight to GitHub and is never saved on your machine.
2. Stores the key, with the server's host keys, as secrets of the repository's `production` environment. The host keys come from your own connection, which SSH has already verified, so the workflow deploys to your server and refuses anything else that answers at its address.
3. Revokes the keys it made for this repository before, once GitHub holds the new one.
4. Writes `.github/workflows/deploy-<name>.yml`.

Commit the workflow and push. Every push to the default branch then deploys; `--branch <name>` picks another branch. `sixb deploy status` shows each deploy as made by the GitHub user who pushed, through GitHub Actions.

The workflow can read the repository and nothing else, runs one deploy at a time (a push during a deploy waits for it), and pins each action to an exact commit. To require an approval before each deploy, add required reviewers to the `production` environment in the repository's settings. An existing `production` environment keeps its rules.

## Rotate the key

Run `sixb deploy ci` again. It stores a new key before revoking the old one.

An existing workflow file is kept as it is, with your edits. To get a fresh one, for example after the server's address changes, delete the file and run the command again.

## Private submodules

The workflow checks out submodules at their recorded commits. When one is private, the workflow's own token cannot read it, and `sixb deploy ci` names the repositories that need a token. Create a fine-grained personal access token with read access to their contents, then store it:

```bash
gh secret set SIXB_GITHUB_TOKEN --env production
```

Without that secret, the workflow stops at its first step and says which secret to set.

## Environment variables in `sixb.deploy.ts`

The workflow connects to the server directly, so `host` must be an address GitHub's runners can reach, not a server behind a jump host. When `sixb.deploy.ts` reads environment variables, set them for the job in the workflow:

```yaml
jobs:
  deploy:
    env:
      SHOP_DEPLOY_HOST: 203.0.113.10
```

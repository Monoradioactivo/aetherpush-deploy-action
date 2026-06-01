# Aether Deploy

GitHub Action that pushes React Native over-the-air updates with Aether.

## Status: pre-release

This action is under active development and is not yet functional. The
composite step in `action.yml` is a placeholder echo. Do not adopt this
action in production workflows yet — wait for `v1.0.0`.

Track progress in the issues and milestones of this repo.

## What it does

Wraps the [`@aetherpush/cli`](https://www.npmjs.com/package/@aetherpush/cli)
release commands so they run inside a GitHub Actions workflow. Once
functional, the action:

- Authenticates with an Aether API key
- Bundles and uploads a release via `aether release` or `aether release-react`
- Emits structured outputs (label, package hash, size, etc.) for downstream steps
- Auto-enriches the release description with CI metadata (`[ci=github sha=... branch=... pr=...]`)

## Preview of the API

The public surface of the action lives in `action.yml` from this commit
onward. A future workflow will look like this:

```yaml
- uses: Monoradioactivo/aetherpush-deploy-action@v1
  with:
    access-key: ${{ secrets.AETHER_ACCESS_KEY }}
    app-name: my-rn-app
    platform: ios
    deployment-name: Production
    rollout: '25%'
```

Outputs are accessible via `steps.<id>.outputs.<name>`:

```yaml
- uses: Monoradioactivo/aetherpush-deploy-action@v1
  id: release
  with:
    access-key: ${{ secrets.AETHER_ACCESS_KEY }}
    app-name: my-rn-app
    platform: ios

- name: Notify
  run: |
    echo "Released ${{ steps.release.outputs.label }} (hash: ${{ steps.release.outputs.package-hash }})"
```

## Authentication

Use an Aether **API key**, not a session access key.

Create one with:

```sh
aether api-key add github-actions-<repo> --scopes deploy
```

The CLI prints a value with the prefix `aether_sk_live_`. Store it as a
GitHub repository secret named `AETHER_ACCESS_KEY`. Session keys created
with `aether access-key add` invalidate when you reset your password and
expire after 60 days — they are not suitable for CI.

## Roadmap to v1.0.0

| Phase | What |
|---|---|
| PR #1 (this) | Scaffolding, API declared, no behavior |
| PR #2 | Implement `command: release` |
| PR #3 | Implement `command: release-react` |
| PR #4 | Self-test workflow against staging |
| PR #5 | Usage examples (multi-env, monorepo) |
| PR #6 | Move-major-minor-tags job, then `v1.0.0-rc1` |

## License

MIT. See [LICENSE](./LICENSE).

## Related

- [`@aetherpush/cli`](https://www.npmjs.com/package/@aetherpush/cli) — the underlying CLI
- [Aether](https://aetherpush.com) — over-the-air updates for React Native
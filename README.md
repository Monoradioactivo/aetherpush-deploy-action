# Aether Deploy

GitHub Action that pushes React Native over-the-air updates with Aether.

## Status

Version 0.x. The action is functional, but the input/output API may still
change before 1.0.0. Pin to an exact version (see [Versioning](#versioning)).

## What it does

Wraps the [`@aetherpush/cli`](https://www.npmjs.com/package/@aetherpush/cli)
release commands so a workflow can ship an OTA update from CI. It installs the
pinned CLI, logs in with your API key, runs `release` or `release-react`, and
exposes the package metadata as step outputs.

## Quick start

```yaml
name: OTA update
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: Monoradioactivo/aetherpush-deploy-action@v0.3.0
        with:
          access-key: ${{ secrets.AETHER_ACCESS_KEY }}
          app-name: my-rn-app
          command: release-react
          platform: android
          target-binary-version: 1.4.0
          deployment-name: Production
```

## Authentication

Use an Aether API key, not a session access key.

```sh
aether api-key add github-actions-<repo> --scopes deploy
```

The CLI prints a value with the prefix `aether_sk_live_`. Store it as a GitHub
repository secret named `AETHER_ACCESS_KEY`. Session keys from `aether
access-key add` invalidate on password reset and expire after 60 days, so they
don't belong in CI.

## Inputs

### Common

| Input | Required | Default | Description |
|---|---|---|---|
| `access-key` | yes | | Aether API key (`aether_sk_live_…`). |
| `app-name` | yes | | App to release to. |
| `command` | no | `release-react` | `release` or `release-react`. |
| `deployment-name` | no | `Staging` | Deployment channel. |
| `description` | no | | Release description. |
| `rollout` | no | `100%` | Percentage of clients. |
| `mandatory` | no | `false` | Force install on clients. |
| `disabled` | no | `false` | Upload in a disabled state. |
| `no-duplicate-release-error` | no | `false` | Warn instead of error on an identical release. |
| `ci-metadata` | no | `true` | Append a `[ci=…]` tag to the description. |
| `force` | no | `false` | Skip destructive-action prompts. |
| `api-url` | no | | Override the server URL (e.g. staging). |
| `working-directory` | no | `.` | Run from a subdirectory (monorepos). |
| `node-version` | no | `22` | Node version for setup-node. |

### `release` only

| Input | Required | Description |
|---|---|---|
| `update-contents-path` | yes | Path to the bundle file or directory. |
| `target-binary-version` | yes | Semver range of target binary versions. |

### `release-react` only

| Input | Required | Description |
|---|---|---|
| `platform` | yes | `ios` or `android`. |
| `target-binary-version` | no | Omit to read from Info.plist / build.gradle. |
| `bundle-name` | no | JS bundle filename. |
| `entry-file` | no | App entry JS file. |
| `gradle-file` | no | build.gradle path (Android). |
| `plist-file` | no | Info.plist path (iOS). |
| `use-hermes` | no | Enable Hermes. |
| `development` | no | Build a dev bundle. |
| `output-dir` | no | Where to write bundle and sourcemap. |
| `sourcemap-output` | no | Sourcemap path. |
| `private-key-path` | no | Code-signing private key. |

## Outputs

| Output | Description |
|---|---|
| `status` | `success` or `failure`. |
| `label` | Release label (e.g. `v4`). |
| `package-hash` | SHA-256 of the package. |
| `size` | Package size in bytes. |
| `app-version` | Targeted binary version. |
| `blob-url` | Signed download URL (time-limited). |
| `manifest-blob-url` | Signed manifest URL. |
| `description` | Final description, with `[ci=…]` appended when enabled. |
| `released-by` | Releaser email (empty when using an API key). |
| `release-method` | `Upload`, `Promote`, or `Rollback`. |
| `upload-time` | Unix timestamp in milliseconds. |
| `rollout` | Rollout percentage; empty when the rollout is complete. |
| `is-mandatory` | `true` or `false`. |
| `is-disabled` | `true` or `false`. |

## Examples

### Release a prebuilt bundle

For a JS bundle you already built, use `command: release` with an explicit path
and target version.

```yaml
- uses: Monoradioactivo/aetherpush-deploy-action@v0.3.0
  with:
    access-key: ${{ secrets.AETHER_ACCESS_KEY }}
    app-name: my-app
    command: release
    update-contents-path: ./build/main.jsbundle
    target-binary-version: 1.0.0
    deployment-name: Production
```

### Release a React Native app

`command: release-react` bundles the project and uploads it. Omit
`target-binary-version` to let the CLI read the version from the native project.

```yaml
- uses: Monoradioactivo/aetherpush-deploy-action@v0.3.0
  with:
    access-key: ${{ secrets.AETHER_ACCESS_KEY }}
    app-name: my-rn-app
    command: release-react
    platform: android
    deployment-name: Production
```

### Multi-environment: staging on PR, production on push

Release to Staging when a PR opens, and to Production when it merges to main.

```yaml
name: OTA deploy
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: Monoradioactivo/aetherpush-deploy-action@v0.3.0
        with:
          access-key: ${{ secrets.AETHER_ACCESS_KEY }}
          app-name: my-rn-app
          command: release-react
          platform: android
          target-binary-version: 1.4.0
          deployment-name: ${{ github.event_name == 'push' && 'Production' || 'Staging' }}
```

### Monorepo

When the app lives in a subdirectory, set `working-directory` and filter the
trigger with `paths` so the deploy only runs when the app changes.

```yaml
name: OTA deploy (mobile)
on:
  push:
    branches: [main]
    paths:
      - 'apps/mobile/**'
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
        working-directory: apps/mobile
      - uses: Monoradioactivo/aetherpush-deploy-action@v0.3.0
        with:
          access-key: ${{ secrets.AETHER_ACCESS_KEY }}
          app-name: my-rn-app
          command: release-react
          platform: android
          target-binary-version: 1.4.0
          working-directory: apps/mobile
```

## Versioning

While the action is in 0.x, pin to an exact version:

```yaml
uses: Monoradioactivo/aetherpush-deploy-action@v0.3.0
```

Moving tags (`@v1`, `@v1.2`) arrive at 1.0.0. Until then, bump the exact version
when you want a newer release.

## License

MIT. See [LICENSE](./LICENSE).

## Related

- [`@aetherpush/cli`](https://www.npmjs.com/package/@aetherpush/cli): the CLI this wraps
- [Aether](https://aetherpush.com): over-the-air updates for React Native

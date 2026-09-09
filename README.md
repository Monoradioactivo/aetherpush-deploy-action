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
      - uses: Monoradioactivo/aetherpush-deploy-action@v0.3.3
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

Create it in the Aether dashboard, under **API Keys**, scoped to `deploy`. Name it
after the repository, such as `github-actions-<repo>`, so you can revoke one pipeline's
key without disturbing the others.

The dashboard shows a value with the prefix `aether_sk_live_` exactly once. Store it as a GitHub
repository secret named `AETHER_ACCESS_KEY`. Session access keys (created in
the dashboard under Account → CLI access keys; `aether access-key add` no longer
works from the terminal) invalidate on password reset and expire after 60 days,
so they don't belong in CI.

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
| `no-duplicate-release-error` | no | `false` | The CLI warns and the step succeeds with empty release outputs for a 409 reported as a duplicate package, or reported without a named cause. A 409 reported as an unfinished rollout, or under any other name, fails the step. |
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
| `status` | `success` or `failure`. `success` includes a swallowed duplicate-package 409 when `no-duplicate-release-error` is true. |
| `label` | Release label (e.g. `v4`). Empty when the CLI printed no release object. |
| `package-hash` | SHA-256 of the package. Empty when the CLI printed no release object. |
| `size` | Package size in bytes. Empty when the CLI printed no release object. |
| `app-version` | Targeted binary version. Empty when the CLI printed no release object. |
| `description` | Final description, with `[ci=…]` appended when enabled. Empty when the CLI printed no release object. |
| `release-method` | `Upload`, `Promote`, or `Rollback`. Empty when the CLI printed no release object. |
| `upload-time` | Unix timestamp in milliseconds. Empty when the CLI printed no release object. |
| `rollout` | Rollout percentage. `100` once complete. Empty when the CLI printed no release object. |
| `is-mandatory` | `true` or `false` when a release was mapped; empty otherwise. |
| `is-disabled` | `true` or `false` when a release was mapped; empty otherwise. |

When `no-duplicate-release-error` is true and the CLI prints no JSON, `status` is
`success` and the metadata outputs stay empty. Put `id: release` on the action
step, then gate later steps with `if: steps.release.outputs.label != ''`. A job
that uses `needs:` must pass `label` through that job's `outputs` map; `steps`
is not visible across jobs. The CLI warning in the log names the conflict the
server reported. A 409 reported as an unfinished rollout, or under any other
name, makes the CLI exit with an error and the step fails. One case still goes
the old way: the server's contract lets a conflict outside those two causes
answer without naming one, and the CLI cannot tell an unnamed conflict from a
duplicate, so it swallows that too and the step reports a skip.

The action has no output for the bundle download URL. The CLI returns a presigned URL
that stays valid for seven days, and there is no way to revoke a single link. A step
output goes further than the workflow that produced it: the runner writes it to the job
log whenever step debug logging is on, and any job that reads the output can print it
again. The bundle is not secret content, since the same file is served to every client
holding the deployment key, but a release that is disabled or still rolling out can be
fetched through the URL before it is reachable through the app.

The action writes `$RUNNER_TEMP/aether-release.json` while mapping the CLI `--json`
object onto the outputs above, then deletes the URL field from that file. Later
steps in the same job read those outputs, not the file. Two action steps in one job
overwrite the same temp path. In a workflow YAML `path:`, that directory is
`${{ runner.temp }}`. The action does not upload that file, and neither should you.

## Examples

### Release a prebuilt bundle

For a JS bundle you already built, use `command: release` with an explicit path
and target version.

```yaml
- uses: Monoradioactivo/aetherpush-deploy-action@v0.3.3
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
- uses: Monoradioactivo/aetherpush-deploy-action@v0.3.3
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
      - uses: Monoradioactivo/aetherpush-deploy-action@v0.3.3
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
      - uses: Monoradioactivo/aetherpush-deploy-action@v0.3.3
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
uses: Monoradioactivo/aetherpush-deploy-action@v0.3.3
```

Moving tags (`@v1`, `@v1.2`) arrive at 1.0.0. Until then, bump the exact version
when you want a newer release.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Related

- [`@aetherpush/cli`](https://www.npmjs.com/package/@aetherpush/cli): the CLI this wraps
- [Aether](https://aetherpush.com): over-the-air updates for React Native

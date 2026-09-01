#!/usr/bin/env bash

set -euo pipefail

echo "status=failure" >> "$GITHUB_OUTPUT"

eof_marker="AETHER_EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
  echo "::error::RUNNER_TEMP is unset or not a directory. This action must run on a GitHub Actions runner."
  exit 1
fi
RELEASE_JSON="$RUNNER_TEMP/aether-release.json"
RELEASE_JSON_TMP="$RELEASE_JSON.tmp"

cd "$WORKING_DIR" || { echo "::error::working-directory '$WORKING_DIR' does not exist."; exit 1; }

case "$COMMAND" in
  release)
    if [ -z "$UPDATE_PATH" ]; then
      echo "::error::Input 'update-contents-path' is required when command is 'release'"
      exit 1
    fi
    if [ -z "$TARGET_BIN" ]; then
      echo "::error::Input 'target-binary-version' is required when command is 'release'"
      exit 1
    fi
    args=("$APP_NAME" "$UPDATE_PATH" "$TARGET_BIN")
    args+=(-d "$DEPLOYMENT_NAME" -r "$ROLLOUT")
    [ -n "$DESCRIPTION" ] && args+=(--description "$DESCRIPTION")
    [ "$MANDATORY" = "true" ] && args+=(-m)
    [ "$DISABLED" = "true" ] && args+=(-x)
    [ "$NO_DUP" = "true" ] && args+=(--noDuplicateReleaseError)
    [ "$FORCE" = "true" ] && args+=(--force)
    [ "$CI_METADATA" = "false" ] && args+=(--no-ci-metadata)
    args+=(--json)
    echo "Running: aether release ${args[*]}"
    aether release "${args[@]}" > "$RELEASE_JSON"
    ;;
  release-react)
    if [ -z "$PLATFORM" ]; then
      echo "::error::Input 'platform' is required when command is 'release-react'"
      exit 1
    fi
    if [ "$PLATFORM" != "ios" ] && [ "$PLATFORM" != "android" ]; then
      echo "::error::Input 'platform' must be 'ios' or 'android', got '$PLATFORM'"
      exit 1
    fi
    args=("$APP_NAME" "$PLATFORM")
    args+=(-d "$DEPLOYMENT_NAME" -r "$ROLLOUT")
    [ -n "$DESCRIPTION" ] && args+=(--description "$DESCRIPTION")
    [ -n "$TARGET_BIN" ] && args+=(-t "$TARGET_BIN")
    [ -n "$BUNDLE_NAME" ] && args+=(-b "$BUNDLE_NAME")
    [ -n "$ENTRY_FILE" ] && args+=(-e "$ENTRY_FILE")
    [ -n "$GRADLE_FILE" ] && args+=(-g "$GRADLE_FILE")
    [ -n "$PLIST_FILE" ] && args+=(-p "$PLIST_FILE")
    [ -n "$OUTPUT_DIR" ] && args+=(-o "$OUTPUT_DIR")
    [ -n "$SOURCEMAP_OUTPUT" ] && args+=(-s "$SOURCEMAP_OUTPUT")
    [ -n "$PRIVATE_KEY_PATH" ] && args+=(-k "$PRIVATE_KEY_PATH")
    [ "$USE_HERMES" = "true" ] && args+=(--useHermes)
    [ "$DEVELOPMENT" = "true" ] && args+=(--development)
    [ "$MANDATORY" = "true" ] && args+=(-m)
    [ "$DISABLED" = "true" ] && args+=(-x)
    [ "$NO_DUP" = "true" ] && args+=(--noDuplicateReleaseError)
    [ "$FORCE" = "true" ] && args+=(--force)
    [ "$CI_METADATA" = "false" ] && args+=(--no-ci-metadata)
    args+=(--json)
    echo "Running: aether release-react ${args[*]}"
    aether release-react "${args[@]}" > "$RELEASE_JSON"
    ;;
  *)
    echo "::error::Invalid command '$COMMAND'. Must be 'release' or 'release-react'."
    exit 1
    ;;
esac

awk 'NF { line = $0 } END { print line }' "$RELEASE_JSON" > "$RELEASE_JSON_TMP"
mv "$RELEASE_JSON_TMP" "$RELEASE_JSON"

if ! jq -e 'type == "object" and has("label")' "$RELEASE_JSON" > /dev/null 2>&1; then
  if [ "$NO_DUP" = "true" ] && ! jq -e . "$RELEASE_JSON" > /dev/null 2>&1; then
    echo "::warning::CLI exited 0 without printing a release object. With 'no-duplicate-release-error' on, a skipped release looks like this."
    echo "The CLI warning above gives the reason. Check the deployment history; if it holds no such release, this is a CLI bug worth reporting."
    echo "status=success" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  echo "::error::CLI exited 0 without printing a release object. This indicates a CLI bug — please report."
  exit 1
fi

jq -c 'del(.blobUrl, .manifestBlobUrl)' "$RELEASE_JSON" > "$RELEASE_JSON_TMP"
mv "$RELEASE_JSON_TMP" "$RELEASE_JSON"

emit() {
  local key="$1" val="$2"
  if [[ "$val" == *$'\n'* ]]; then
    {
      echo "${key}<<${eof_marker}"
      echo "$val"
      echo "${eof_marker}"
    } >> "$GITHUB_OUTPUT"
  else
    echo "${key}=${val}" >> "$GITHUB_OUTPUT"
  fi
}

emit label             "$(jq -r '.label // empty' "$RELEASE_JSON")"
emit package-hash      "$(jq -r '.packageHash // empty' "$RELEASE_JSON")"
emit size              "$(jq -r '.size // empty' "$RELEASE_JSON")"
emit app-version       "$(jq -r '.appVersion // empty' "$RELEASE_JSON")"
emit description       "$(jq -r '.description // empty' "$RELEASE_JSON")"
emit released-by       "$(jq -r '.releasedBy // empty' "$RELEASE_JSON")"
emit release-method    "$(jq -r '.releaseMethod // empty' "$RELEASE_JSON")"
emit upload-time       "$(jq -r '.uploadTime // empty' "$RELEASE_JSON")"
emit rollout           "$(jq -r '.rollout // empty' "$RELEASE_JSON")"
emit is-mandatory      "$(jq -r '.isMandatory // false' "$RELEASE_JSON")"
emit is-disabled       "$(jq -r '.isDisabled // false' "$RELEASE_JSON")"

echo "status=success" >> "$GITHUB_OUTPUT"

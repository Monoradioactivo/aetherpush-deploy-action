#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
: "${AETHER_ACTION_PATH:=$repo_root}"
fixtures="$repo_root/tests/fixtures"
stub_bin="$repo_root/tests/bin"
parser="$repo_root/tests/parse-github-output.py"

if command -v python3 > /dev/null 2>&1; then
  python_bin=python3
else
  python_bin=python
fi

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  local expected="$1" actual="$2" context="$3"
  [ "$actual" = "$expected" ] || fail "$context: expected '$expected', got '$actual'"
}

actual_env=$(awk '
  /^    - name: Run aether$/ { step = 1; next }
  step && /^      env:$/ { env = 1; next }
  env && /^      run:/ { exit }
  env { sub(/^        /, ""); print }
' "$repo_root/action.yml")
expected_env='AETHER_ACTION_PATH: ${{ github.action_path }}
COMMAND: ${{ inputs.command }}
WORKING_DIR: ${{ inputs.working-directory }}
APP_NAME: ${{ inputs.app-name }}
UPDATE_PATH: ${{ inputs.update-contents-path }}
TARGET_BIN: ${{ inputs.target-binary-version }}
PLATFORM: ${{ inputs.platform }}
DEPLOYMENT_NAME: ${{ inputs.deployment-name }}
DESCRIPTION: ${{ inputs.description }}
MANDATORY: ${{ inputs.mandatory }}
ROLLOUT: ${{ inputs.rollout }}
DISABLED: ${{ inputs.disabled }}
NO_DUP: ${{ inputs.no-duplicate-release-error }}
FORCE: ${{ inputs.force }}
CI_METADATA: ${{ inputs.ci-metadata }}
BUNDLE_NAME: ${{ inputs.bundle-name }}
ENTRY_FILE: ${{ inputs.entry-file }}
GRADLE_FILE: ${{ inputs.gradle-file }}
PLIST_FILE: ${{ inputs.plist-file }}
OUTPUT_DIR: ${{ inputs.output-dir }}
SOURCEMAP_OUTPUT: ${{ inputs.sourcemap-output }}
PRIVATE_KEY_PATH: ${{ inputs.private-key-path }}
USE_HERMES: ${{ inputs.use-hermes }}
DEVELOPMENT: ${{ inputs.development }}'
assert_equal "$expected_env" "$actual_env" "Run aether environment"

actual_run=$(awk '
  /^    - name: Run aether$/ { step = 1; next }
  step && /^      run:/ { sub(/^      run: /, ""); print; exit }
' "$repo_root/action.yml")
assert_equal 'bash "$AETHER_ACTION_PATH/scripts/run-aether.sh"' "$actual_run" "Run aether invocation"

install_pin=$(awk 'match($0, /@aetherpush\/cli@[0-9]+\.[0-9]+\.[0-9]+/) { print substr($0, RSTART + 16, RLENGTH - 16); exit }' "$repo_root/action.yml")
expected_pin=$(awk -F'"' '/EXPECTED="[0-9]+\.[0-9]+\.[0-9]+"/ { print $2; exit }' "$repo_root/action.yml")
fixture_pin=$(tr -d ' \r\n' < "$fixtures/CLI_VERSION")
assert_equal "$install_pin" "$expected_pin" "CLI pins"
assert_equal "$install_pin" "$fixture_pin" "fixture provenance"

test_tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/aether-action-tests.XXXXXX")
case "$test_tmp_root" in
  */aether-action-tests.*) ;;
  *) fail "unexpected temporary directory '$test_tmp_root'" ;;
esac
trap 'rm -r "$test_tmp_root"' EXIT

run_case() {
  local name="$1" fixture="$2" expected_exit="$3" expected_outputs="$4" expected_diagnostic="$5"
  shift 5
  local case_dir="$test_tmp_root/$name"
  local working_dir="$case_dir/work"
  mkdir -p "$working_dir"
  local logical_working_dir
  logical_working_dir=$(cd "$working_dir" && pwd -L)
  local output_file="$case_dir/github-output"
  local trace_file="$case_dir/trace"
  local log_file="$case_dir/log"
  local runner_temp="$case_dir/runner-temp"
  mkdir -p "$runner_temp"
  local decoy='{"label":"decoy","blobUrl":"https://example.invalid/decoy","manifestBlobUrl":"https://example.invalid/decoy-manifest"}'
  printf '%s\n' "$decoy" > "$working_dir/release.json"
  : > "$output_file"

  set +e
  (
    export PATH="$stub_bin:$PATH"
    export AETHER_STUB_FIXTURE="$fixtures/$fixture"
    export AETHER_STUB_TRACE="$trace_file"
    export AETHER_STUB_VERSION_FILE="$fixtures/CLI_VERSION"
    export GITHUB_OUTPUT="$output_file"
    export RUNNER_TEMP="$runner_temp"
    export COMMAND="${COMMAND:-release-react}"
    export WORKING_DIR="$working_dir"
    export APP_NAME="${APP_NAME:-FixtureApp}"
    export UPDATE_PATH="${UPDATE_PATH:-}"
    export TARGET_BIN="${TARGET_BIN:-}"
    export PLATFORM="${PLATFORM:-ios}"
    export DEPLOYMENT_NAME="${DEPLOYMENT_NAME:-Staging}"
    export DESCRIPTION="${DESCRIPTION:-}"
    export MANDATORY="${MANDATORY:-false}"
    export ROLLOUT="${ROLLOUT:-100}"
    export DISABLED="${DISABLED:-false}"
    export NO_DUP="${NO_DUP:-false}"
    export FORCE="${FORCE:-false}"
    export CI_METADATA="${CI_METADATA:-true}"
    export BUNDLE_NAME="${BUNDLE_NAME:-}"
    export ENTRY_FILE="${ENTRY_FILE:-}"
    export GRADLE_FILE="${GRADLE_FILE:-}"
    export PLIST_FILE="${PLIST_FILE:-}"
    export OUTPUT_DIR="${OUTPUT_DIR:-}"
    export SOURCEMAP_OUTPUT="${SOURCEMAP_OUTPUT:-}"
    export PRIVATE_KEY_PATH="${PRIVATE_KEY_PATH:-}"
    export USE_HERMES="${USE_HERMES:-false}"
    export DEVELOPMENT="${DEVELOPMENT:-false}"
    if [ -n "${AETHER_SCRIPT_BODY:-}" ]; then
      bash -c "$AETHER_SCRIPT_BODY"
    else
      bash "$AETHER_ACTION_PATH/scripts/run-aether.sh"
    fi
  ) > "$log_file" 2>&1
  local exit_code=$?
  set -e

  if [ "$exit_code" != "$expected_exit" ]; then
    cat "$log_file" >&2
    fail "$name exit: expected '$expected_exit', got '$exit_code'"
  fi
  "$python_bin" "$parser" "$output_file" "$expected_outputs"
  grep -Fq "$expected_diagnostic" "$log_file" || fail "$name diagnostic"

  assert_equal "$decoy" "$(cat "$working_dir/release.json")" "$name workspace decoy"
  [ ! -e "$working_dir/release.json.tmp" ] || fail "$name workspace release.json.tmp"
  [ ! -e "$runner_temp/aether-release.json.tmp" ] || fail "$name leftover aether-release.json.tmp"

  if [ "$expected_exit" = "0" ] && [ "$expected_outputs" != "skip" ]; then
    [ -f "$runner_temp/aether-release.json" ] || fail "$name aether-release.json missing"
    assert_equal "1" "$(wc -l < "$runner_temp/aether-release.json" | tr -d ' ')" "$name aether-release.json lines"
    jq -e 'has("label") and (has("blobUrl") | not) and (has("manifestBlobUrl") | not)' "$runner_temp/aether-release.json" > /dev/null
    local mapped_label
    mapped_label=$(jq -r '.label' "$runner_temp/aether-release.json")
    [ "$mapped_label" != "decoy" ] || fail "$name mapped decoy label"
    assert_equal "cwd=$logical_working_dir" "$(awk 'NR == 1 { print; exit }' "$trace_file")" "$name cwd"
    local expected_trace="$1"
    assert_equal "$expected_trace" "$(awk 'NR > 1 { print }' "$trace_file")" "$name argv"
  fi
}

PRIVATE_KEY_PATH="$test_tmp_root/signing.pem" run_case \
  signed signed.stdout 0 signed 'Running: aether release-react' \
  'arg=release-react
arg=FixtureApp
arg=ios
arg=-d
arg=Staging
arg=-r
arg=100
arg=-k
arg='"$test_tmp_root"'/signing.pem
arg=--json'

COMMAND=release UPDATE_PATH=./bundle.js TARGET_BIN=2.0.0 DEPLOYMENT_NAME=Production ROLLOUT=25 DESCRIPTION='fixture release' CI_METADATA=false run_case \
  unsigned unsigned.stdout 0 unsigned 'Running: aether release' \
  'arg=release
arg=FixtureApp
arg=./bundle.js
arg=2.0.0
arg=-d
arg=Production
arg=-r
arg=25
arg=--description
arg=fixture release
arg=--no-ci-metadata
arg=--json'

run_case empty empty.stdout 1 failure 'This indicates a CLI bug'
NO_DUP=true run_case empty-duplicate empty.stdout 0 skip "::warning::CLI exited 0 without printing a release object. With 'no-duplicate-release-error' on"
run_case invalid invalid.stdout 1 failure 'This indicates a CLI bug'
NO_DUP=true run_case wrong-shape wrong-shape.stdout 1 failure 'This indicates a CLI bug'

unset_dir="$test_tmp_root/unset-runner-temp"
mkdir -p "$unset_dir/work"
: > "$unset_dir/github-output"
set +e
(
  export PATH="$stub_bin:$PATH"
  export AETHER_STUB_FIXTURE="$fixtures/unsigned.stdout"
  export AETHER_STUB_TRACE="$unset_dir/trace"
  export AETHER_STUB_VERSION_FILE="$fixtures/CLI_VERSION"
  export GITHUB_OUTPUT="$unset_dir/github-output"
  export COMMAND=release-react
  export WORKING_DIR="$unset_dir/work"
  export APP_NAME=FixtureApp
  export UPDATE_PATH=
  export TARGET_BIN=
  export PLATFORM=ios
  export DEPLOYMENT_NAME=Staging
  export DESCRIPTION=
  export MANDATORY=false
  export ROLLOUT=100
  export DISABLED=false
  export NO_DUP=false
  export FORCE=false
  export CI_METADATA=true
  export BUNDLE_NAME=
  export ENTRY_FILE=
  export GRADLE_FILE=
  export PLIST_FILE=
  export OUTPUT_DIR=
  export SOURCEMAP_OUTPUT=
  export PRIVATE_KEY_PATH=
  export USE_HERMES=false
  export DEVELOPMENT=false
  env -u RUNNER_TEMP bash "$AETHER_ACTION_PATH/scripts/run-aether.sh"
) > "$unset_dir/log" 2>&1
unset_exit=$?
set -e
[ "$unset_exit" = "1" ] || fail "unset RUNNER_TEMP exit: expected '1', got '$unset_exit'"
grep -Fq '::error::RUNNER_TEMP is unset or not a directory' "$unset_dir/log" || fail "unset RUNNER_TEMP diagnostic"
[ ! -e "$unset_dir/work/release.json" ] || fail "unset RUNNER_TEMP wrote workspace release.json"

printf 'PASS: 7 step script executions (6 fixture cases, 1 unset RUNNER_TEMP)\n'

#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pin=$(awk 'match($0, /@aetherpush\/cli@[0-9]+\.[0-9]+\.[0-9]+/) { print substr($0, RSTART + 16, RLENGTH - 16); exit }' "$repo_root/action.yml")
[ -n "$pin" ] || fail "CLI pin not found in action.yml"

test_tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/aether-cli-install.XXXXXX")
case "$test_tmp_root" in
  */aether-cli-install.*) ;;
  *) fail "unexpected temporary directory '$test_tmp_root'" ;;
esac
trap 'rm -r "$test_tmp_root"' EXIT

prefix="$test_tmp_root/prefix"
npm_config_cache="$test_tmp_root/cache" npm install -g --prefix "$prefix" --no-audit --no-fund "@aetherpush/cli@$pin"

cli="$prefix/bin/aether"
[ -x "$cli" ] || fail "installed CLI is not executable"

installed=$("$cli" --version 2>/dev/null | tr -d ' \r\n')
[ "$installed" = "$pin" ] || fail "installed CLI version '$installed' does not match pin '$pin'"

assert_help_options() {
  local command_name="$1"
  shift
  local help_text
  help_text=$("$cli" "$command_name" --help)
  local option
  for option in "$@"; do
    grep -Fq -- "$option" <<< "$help_text" || fail "$command_name help is missing $option"
  done
}

assert_help_options login \
  --accessKey \
  --serverUrl

assert_parses_to_auth() {
  local command_name="$1"
  shift
  local output exit_code
  set +e
  output=$(LOCALAPPDATA="$test_tmp_root/config" "$cli" "$command_name" "$@" 2>&1)
  exit_code=$?
  set -e
  [ "$exit_code" != "0" ] || fail "$command_name unexpectedly ran without credentials"
  grep -Fq 'You are not currently logged in' <<< "$output" || fail "$command_name arguments failed before authentication: $output"
}

assert_parses_to_auth release \
  FixtureApp \
  ./bundle.js \
  1.0.0 \
  -d Staging \
  -r 100 \
  --description fixture \
  -m \
  -x \
  --noDuplicateReleaseError \
  --force \
  --no-ci-metadata \
  --json

assert_parses_to_auth release-react \
  FixtureApp \
  ios \
  -d Staging \
  -r 100 \
  --description fixture \
  -t 1.0.0 \
  -b main.jsbundle \
  -e index.js \
  -g build.gradle \
  -p Info.plist \
  -o output \
  -s output.map \
  -k key.pem \
  --useHermes \
  --development \
  -m \
  -x \
  --noDuplicateReleaseError \
  --force \
  --no-ci-metadata \
  --json

printf 'PASS: installed @aetherpush/cli@%s and verified the action command contract\n' "$pin"

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PENDING_LABEL,
  RERUN_HINT,
  TAGGED_LABEL,
  createGitHub,
  isNotFound,
  releaseTag,
  run,
} from "./settle-release-labels.mjs";

const REPO = "Monoradioactivo/aetherpush-deploy-action";
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "settle-release-labels.mjs");
const RELEASE_CONFIG = join(HERE, "..", "..", "release-please-config.json");

function fakeGitHub({ pulls = [], releases = {}, failOn = {} } = {}) {
  const writes = [];
  const write = (kind, number, value) => {
    if (failOn[kind] === number) throw Object.assign(new Error("refused"), { stderr: `gh: ${kind} refused (HTTP 403)` });
    writes.push([kind, number, value]);
  };
  return {
    writes,
    pendingReleasePulls: () => pulls,
    releaseUrl: (tag) => releases[tag] ?? null,
    addLabel: (number, label) => write("add", number, label),
    removeLabel: (number, label) => write("remove", number, label),
    comment: (number, body) => write("comment", number, body),
  };
}

function settle(github, tagStepOutcome) {
  const lines = [];
  const result = run({ github, tagStepOutcome, summary: (line) => lines.push(line) });
  return { ...result, lines };
}

function notFound() {
  return Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)\n" });
}

test("releaseTag reads the version from a release-please title", () => {
  assert.equal(releaseTag("chore(main): release 0.7.0"), "v0.7.0");
  assert.equal(releaseTag("chore(main): release 1.0.0-rc.1"), "v1.0.0-rc.1");
  assert.equal(releaseTag("chore(main): release aetherpush-deploy-action 0.7.0"), null);
  assert.equal(releaseTag("fix(deps): update dependency @aetherpush/cli to v0.10.1"), null);
  assert.equal(releaseTag(undefined), null);
});

test("the release-please config keeps the title and tag shape releaseTag assumes", () => {
  const config = JSON.parse(readFileSync(RELEASE_CONFIG, "utf8"));
  const scopes = [config, ...Object.values(config.packages ?? {})];
  assert.equal(config["include-component-in-tag"], false);
  for (const scope of scopes) {
    assert.equal(scope["pull-request-title-pattern"], undefined);
    assert.notEqual(scope["include-v-in-tag"], false);
    assert.notEqual(scope.draft, true);
    assert.notEqual(scope["include-component-in-tag"], true);
  }
  assert.equal(config["target-branch"] ?? "main", "main");
});

test("isNotFound matches only a 404 from gh", () => {
  assert.equal(isNotFound(notFound()), true);
  assert.equal(isNotFound(Object.assign(new Error("x"), { stderr: "gh: Forbidden (HTTP 403)" })), false);
  assert.equal(isNotFound(undefined), false);
});

test("a tagged release moves its merged pull request from pending to tagged", () => {
  const github = fakeGitHub({
    pulls: [{ number: 105, title: "chore(main): release 0.7.0" }],
    releases: { "v0.7.0": "https://github.com/x/releases/tag/v0.7.0" },
  });
  const result = settle(github, "failure");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.settled, [{ number: 105, tag: "v0.7.0" }]);
  assert.deepEqual(github.writes, [
    ["add", 105, TAGGED_LABEL],
    ["remove", 105, PENDING_LABEL],
    ["comment", 105, "Release [v0.7.0](https://github.com/x/releases/tag/v0.7.0) is tagged."],
  ]);
});

test("a pending pull request whose release does not exist fails and is left pending", () => {
  const github = fakeGitHub({ pulls: [{ number: 110, title: "chore(main): release 0.7.1" }] });
  const result = settle(github, "failure");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /#110 .* release v0\.7\.1 does not exist/);
  assert.ok(result.failures[0].endsWith(RERUN_HINT));
  assert.deepEqual(github.writes, []);
  assert.ok(result.lines.some((line) => line.startsWith("Failed: #110")));
  assert.ok(result.lines.every((line) => !line.includes("::error::")));
});

test("a pending pull request that is not a release is skipped like release-please skips it", () => {
  const github = fakeGitHub({ pulls: [{ number: 7, title: "docs: hand labelled" }] });
  const result = settle(github, "success");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(github.writes, []);
  assert.match(result.lines[0], /Skipped #7/);
});

test("a skipped non-release pull request does not explain a failed tag step", () => {
  const github = fakeGitHub({ pulls: [{ number: 7, title: "docs: hand labelled" }] });
  const result = settle(github, "failure");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /tag step ended "failure"/);
});

test("a failed tag step with nothing to settle fails with the re-run hint", () => {
  const result = settle(fakeGitHub(), "failure");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /tag step ended "failure"/);
  assert.ok(result.failures[0].endsWith(RERUN_HINT));
});

test("a missing tag step outcome with nothing to settle fails", () => {
  const result = settle(fakeGitHub(), "");
  assert.match(result.failures[0], /tag step ended "unknown"/);
});

test("a successful tag step with nothing pending passes without writes", () => {
  const github = fakeGitHub();
  const result = settle(github, "success");
  assert.deepEqual(result, { settled: [], failures: [], lines: [] });
  assert.deepEqual(github.writes, []);
});

test("one settled and one broken pull request settle the first and fail the run", () => {
  const github = fakeGitHub({
    pulls: [
      { number: 105, title: "chore(main): release 0.7.0" },
      { number: 110, title: "chore(main): release 0.7.1" },
    ],
    releases: { "v0.7.0": "https://example.test/v0.7.0" },
  });
  const result = settle(github, "failure");
  assert.deepEqual(result.settled, [{ number: 105, tag: "v0.7.0" }]);
  assert.equal(result.failures.length, 1);
});

test("a refused label write fails that pull request and the loop goes on to the next", () => {
  const github = fakeGitHub({
    pulls: [
      { number: 104, title: "chore(main): release 0.6.9" },
      { number: 105, title: "chore(main): release 0.7.0" },
    ],
    releases: { "v0.6.9": "https://example.test/v0.6.9", "v0.7.0": "https://example.test/v0.7.0" },
    failOn: { add: 104 },
  });
  const result = settle(github, "failure");
  assert.deepEqual(result.settled, [{ number: 105, tag: "v0.7.0" }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /#104: moving the label .*\(HTTP 403\)/);
  assert.ok(github.writes.every(([, number]) => number === 105));
});

test("a refused comment leaves the pull request settled and the run green", () => {
  const github = fakeGitHub({
    pulls: [{ number: 105, title: "chore(main): release 0.7.0" }],
    releases: { "v0.7.0": "https://example.test/v0.7.0" },
    failOn: { comment: 105 },
  });
  const result = settle(github, "failure");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.settled, [{ number: 105, tag: "v0.7.0" }]);
  assert.ok(result.lines.some((line) => /Settled #105 without its comment: .*HTTP 403/.test(line)));
});

test("createGitHub sends the release bot token and the expected API calls", () => {
  const calls = [];
  const gh = (args, token) => {
    calls.push({ args, token });
    if (args.includes(`repos/${REPO}/issues`)) return JSON.stringify([{ number: 105, title: "chore(main): release 0.7.0" }]);
    if (args[1] === `repos/${REPO}/releases/tags/v0.7.0`) return "https://example.test/v0.7.0\n";
    return "";
  };
  const github = createGitHub({ gh, repository: REPO, token: "app-token" });
  assert.deepEqual(github.pendingReleasePulls(), [{ number: 105, title: "chore(main): release 0.7.0" }]);
  assert.equal(github.releaseUrl("v0.7.0"), "https://example.test/v0.7.0");
  github.addLabel(105, TAGGED_LABEL);
  github.removeLabel(105, PENDING_LABEL);
  github.comment(105, "body text");
  assert.ok(calls.every((call) => call.token === "app-token"));
  assert.deepEqual(calls[0].args, [
    "api", "--method", "GET", `repos/${REPO}/issues`,
    "-f", "state=closed", "-f", `labels=${PENDING_LABEL}`, "-f", "per_page=100",
    "--jq", "[.[] | select(.pull_request.merged_at != null) | {number, title}]",
  ]);
  assert.deepEqual(calls[2].args, [
    "api", "--method", "POST", `repos/${REPO}/issues/105/labels`, "-f", `labels[]=${TAGGED_LABEL}`,
  ]);
  assert.deepEqual(calls[3].args, [
    "api", "--method", "DELETE", `repos/${REPO}/issues/105/labels/autorelease%3A%20pending`,
  ]);
  assert.deepEqual(calls[4].args, ["api", "--method", "POST", `repos/${REPO}/issues/105/comments`, "-f", "body=body text"]);
});

test("createGitHub maps a missing release to null and rethrows other errors", () => {
  const missing = createGitHub({ gh: () => { throw notFound(); }, repository: REPO, token: "t" });
  assert.equal(missing.releaseUrl("v9.9.9"), null);
  const forbidden = Object.assign(new Error("Command failed"), { stderr: "gh: Forbidden (HTTP 403)" });
  const broken = createGitHub({ gh: () => { throw forbidden; }, repository: REPO, token: "t" });
  assert.throws(() => broken.releaseUrl("v0.7.0"), forbidden);
});

test("createGitHub tolerates an already removed pending label and rethrows other errors", () => {
  const gone = createGitHub({ gh: () => { throw notFound(); }, repository: REPO, token: "t" });
  assert.doesNotThrow(() => gone.removeLabel(105, PENDING_LABEL));
  const forbidden = Object.assign(new Error("Command failed"), { stderr: "gh: Resource not accessible by integration (HTTP 403)" });
  const refused = createGitHub({ gh: () => { throw forbidden; }, repository: REPO, token: "t" });
  assert.throws(() => refused.removeLabel(105, PENDING_LABEL), forbidden);
});

function runScript({ outcome, pulls, releaseExists }) {
  const dir = mkdtempSync(join(tmpdir(), "settle-release-labels-"));
  try {
    const log = join(dir, "calls.jsonl");
    const summaryFile = join(dir, "summary.md");
    const stub = join(dir, "gh");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.GH_TOKEN }) + "\\n");
if (args[3] === ${JSON.stringify(`repos/${REPO}/issues`)}) { process.stdout.write(${JSON.stringify(JSON.stringify(pulls))}); process.exit(0); }
if (String(args[1]).includes("/releases/tags/")) {
  if (${releaseExists}) { process.stdout.write("https://example.test/release\\n"); process.exit(0); }
  process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1);
}
process.exit(0);
`,
    );
    chmodSync(stub, 0o755);
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: REPO,
        GITHUB_STEP_SUMMARY: summaryFile,
        RELEASE_BOT_TOKEN: "bot-token",
        TAG_STEP_OUTCOME: outcome,
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const summary = readFileSync(summaryFile, "utf8");
    return { status: result.status, stdout: result.stdout, calls, summary };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the script settles through gh with the release bot token and exits 0", () => {
  const result = runScript({
    outcome: "failure",
    pulls: [{ number: 105, title: "chore(main): release 0.7.0" }],
    releaseExists: true,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.ok(result.calls.every((call) => call.token === "bot-token"));
  assert.deepEqual(
    result.calls.map((call) => call.args.slice(0, 4).join(" ")),
    [
      `api --method GET repos/${REPO}/issues`,
      `api repos/${REPO}/releases/tags/v0.7.0 --jq .html_url`,
      `api --method POST repos/${REPO}/issues/105/labels`,
      `api --method DELETE repos/${REPO}/issues/105/labels/autorelease%3A%20pending`,
      `api --method POST repos/${REPO}/issues/105/comments`,
    ],
  );
  assert.match(result.summary, /Settled #105/);
});

test("the script exits 1 with an annotation on stdout and plain text in the summary", () => {
  const result = runScript({
    outcome: "failure",
    pulls: [{ number: 110, title: "chore(main): release 0.7.1" }],
    releaseExists: false,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::#110 /m);
  assert.match(result.summary, /^Failed: #110 /m);
  assert.doesNotMatch(result.summary, /::error::/);
  assert.equal(result.calls.length, 2);
});

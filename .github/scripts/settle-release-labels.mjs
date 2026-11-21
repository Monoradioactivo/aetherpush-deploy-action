import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PENDING_LABEL = "autorelease: pending";
export const TAGGED_LABEL = "autorelease: tagged";
export const RERUN_HINT = 'Use "Re-run all jobs": "Re-run failed jobs" reuses the stored tag step result.';
const RELEASE_TITLE = /^chore\(main\): release (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function releaseTag(title) {
  const match = RELEASE_TITLE.exec(String(title ?? ""));
  return match ? `v${match[1]}` : null;
}

export function isNotFound(error) {
  return /HTTP 404/.test(String(error?.stderr ?? error?.message ?? ""));
}

function errorText(error) {
  return String(error?.stderr || error?.message || error).trim();
}

export function createGitHub({ gh, repository, token }) {
  const call = (args) => gh(args, token);
  const issue = (number) => `repos/${repository}/issues/${number}`;
  return {
    pendingReleasePulls: () =>
      JSON.parse(
        call([
          "api",
          "--method",
          "GET",
          `repos/${repository}/issues`,
          "-f",
          "state=closed",
          "-f",
          `labels=${PENDING_LABEL}`,
          "-f",
          "per_page=100",
          "--jq",
          "[.[] | select(.pull_request.merged_at != null) | {number, title}]",
        ]),
      ),
    releaseUrl: (tag) => {
      try {
        return call(["api", `repos/${repository}/releases/tags/${tag}`, "--jq", ".html_url"]).trim();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    addLabel: (number, label) =>
      call(["api", "--method", "POST", `${issue(number)}/labels`, "-f", `labels[]=${label}`]),
    removeLabel: (number, label) => {
      try {
        call(["api", "--method", "DELETE", `${issue(number)}/labels/${encodeURIComponent(label)}`]);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    comment: (number, body) => call(["api", "--method", "POST", `${issue(number)}/comments`, "-f", `body=${body}`]),
  };
}

export function run({ github, tagStepOutcome, summary }) {
  const settled = [];
  const failures = [];
  for (const pull of github.pendingReleasePulls()) {
    const tag = releaseTag(pull.title);
    if (!tag) {
      summary(`Skipped #${pull.number}: "${pull.title}" is not a release title.`);
      continue;
    }
    const url = github.releaseUrl(tag);
    if (!url) {
      failures.push(`#${pull.number} is merged and marked "${PENDING_LABEL}" but release ${tag} does not exist. ${RERUN_HINT}`);
      continue;
    }
    try {
      github.addLabel(pull.number, TAGGED_LABEL);
      github.removeLabel(pull.number, PENDING_LABEL);
    } catch (error) {
      failures.push(`#${pull.number}: moving the label to "${TAGGED_LABEL}" failed: ${errorText(error)}`);
      continue;
    }
    settled.push({ number: pull.number, tag });
    summary(`Settled #${pull.number}: ${tag} exists, label set to "${TAGGED_LABEL}".`);
    try {
      github.comment(pull.number, `Release [${tag}](${url}) is tagged.`);
    } catch (error) {
      summary(`Settled #${pull.number} without its comment: ${errorText(error)}`);
    }
  }
  if (tagStepOutcome !== "success" && settled.length === 0 && failures.length === 0) {
    failures.push(
      `The tag step ended "${tagStepOutcome || "unknown"}" and no merged release pull request explains it. ${RERUN_HINT}`,
    );
  }
  for (const failure of failures) summary(`Failed: ${failure}`);
  return { settled, failures };
}

function ghRunner(args, token) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function main() {
  const github = createGitHub({
    gh: ghRunner,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.RELEASE_BOT_TOKEN,
  });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const summary = (line) => {
    console.log(line);
    if (summaryPath) appendFileSync(summaryPath, `${line}\n`);
  };
  const result = run({ github, tagStepOutcome: process.env.TAG_STEP_OUTCOME, summary });
  for (const failure of result.failures) console.log(`::error::${failure}`);
  console.log(JSON.stringify(result));
  if (result.failures.length > 0) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

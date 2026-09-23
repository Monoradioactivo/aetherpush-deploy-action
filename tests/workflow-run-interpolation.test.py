#!/usr/bin/env python3

from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import yaml
except ImportError:
    print("FAIL: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

repo_root = Path(__file__).resolve().parents[1]
workflows_dir = repo_root / ".github" / "workflows"


def run_interpolations(doc: object) -> list[str]:
    hits: list[str] = []
    if not isinstance(doc, dict):
        return hits
    jobs = doc.get("jobs") or {}
    if not isinstance(jobs, dict):
        return hits
    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps") or []
        if not isinstance(steps, list):
            continue
        for i, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            run = step.get("run")
            if isinstance(run, str) and "${{" in run:
                name = step.get("name") or "(unnamed)"
                hits.append(f"{job_id}[{i}] {name}")
    return hits


def gate_workflow() -> dict:
    return yaml.safe_load((workflows_dir / "auto-merge-release.yml").read_text(encoding="utf-8"))


def gate_steps() -> list[dict]:
    return gate_workflow()["jobs"]["gate"]["steps"]


def softens_failure(node: dict) -> bool:
    return "continue-on-error" in node


def index_of_step(steps: list[dict], name: str) -> int:
    for i, step in enumerate(steps):
        if isinstance(step, dict) and step.get("name") == name:
            return i
    return -1


EXPECTED_REFUSE_IF = "steps.gate.outputs.ok == 'false' && github.event_name != 'schedule'"
CARVE_OUT_NEEDLE = "schedule carve-out"
EXIT_1_NEEDLE = "no longer exits 1"


def clone_gate() -> dict:
    return copy.deepcopy(gate_workflow())


def normalize_if(condition: object) -> str:
    return " ".join(str(condition or "").split())


def check_refuse_schedule_carve_out(steps: list[dict] | None = None) -> list[str]:
    failures: list[str] = []
    if steps is None:
        steps = gate_steps()
    refuse = index_of_step(steps, "Fail when the release is not accounted for")
    if refuse == -1:
        return ["the gate job has no 'Fail when the release is not accounted for' step"]
    if normalize_if(steps[refuse].get("if")) != EXPECTED_REFUSE_IF:
        failures.append(
            "the refuse step must fail closed on pull_request and dispatch while staying green on schedule. Doctrine pins the schedule carve-out (ci-release-gate-scheduled-hold-noise); dropping != 'schedule' reopens hold-noise email, and dropping the ok==false half greens an unaccounted release PR check."
        )
    if not re.search(r"^\s*exit 1\s*$", steps[refuse].get("run") or "", re.MULTILINE):
        failures.append(
            "the refuse step keeps its if: but no longer exits 1, so a held release PR can report the required check green"
        )
    return failures


def drop_schedule_carve_out(step: dict) -> None:
    step["if"] = "steps.gate.outputs.ok == 'false'"


def never_run_refuse(step: dict) -> None:
    step["if"] = "false"


def refuse_without_exit(step: dict) -> None:
    step["run"] = 'echo "::error::The release contains commits this gate cannot vouch for."'


def planted_refuse_must_fail(mutator, needle: str) -> list[str]:
    doc = clone_gate()
    steps = doc["jobs"]["gate"]["steps"]
    refuse = index_of_step(steps, "Fail when the release is not accounted for")
    if refuse == -1:
        return ["planted refuse mutation: refuse step missing"]
    mutator(steps[refuse])
    failures = check_refuse_schedule_carve_out(steps)
    if not failures:
        return [f"planted refuse mutation was not caught ({needle})"]
    joined = " ".join(failures)
    if needle not in joined:
        return [f"planted refuse mutation failed for the wrong reason: {joined}"]
    return []


def reads_verdict(step: dict) -> bool:
    sources = [step.get("if")]
    for key in ("env", "with"):
        section = step.get(key)
        if isinstance(section, dict):
            sources.extend(section.values())
    return any(isinstance(s, str) and "gate.outputs." in s for s in sources)


def check_absent_verdict_step() -> list[str]:
    failures: list[str] = []
    steps = gate_steps()
    verdict = index_of_step(steps, "Require a verdict from the gate")
    if verdict == -1:
        return ["the gate job has no 'Require a verdict from the gate' step"]

    expected_if = "steps.pr.outputs.number != '' && steps.gate.outputs.ok == ''"
    if steps[verdict].get("if") != expected_if:
        failures.append(f"the verdict step's if is {steps[verdict].get('if')!r}, not {expected_if!r}")
    if not re.search(r"^\s*exit 1\s*$", steps[verdict].get("run") or "", re.MULTILINE):
        failures.append("the verdict step does not fail the job")
    if softens_failure(steps[verdict]):
        failures.append("the verdict step carries continue-on-error, so its failure may not red the job")

    refuse = index_of_step(steps, "Fail when the release is not accounted for")
    if refuse == -1:
        failures.append("the gate job has no 'Fail when the release is not accounted for' step")
    elif softens_failure(steps[refuse]):
        failures.append("the step that reds an unaccounted release carries continue-on-error")
    if refuse != -1:
        failures.extend(check_refuse_schedule_carve_out(steps))

    doc = gate_workflow()
    job = doc["jobs"]["gate"]
    if softens_failure(job):
        failures.append("the gate job carries continue-on-error, so the run may pass even when the job fails")
    if "strategy" in job:
        failures.append("a matrix renames the check, so the required context never reports and every pull request waits on it")
    if "if" in job:
        failures.append("these four deliberately carry no job-level if (doctrine/shipping.md); one that can skip the release pull request makes the required check report satisfied")
    if list(doc["jobs"]) != ["gate"]:
        failures.append("another job in this workflow can take the gate's required-check name or make it skip through needs")

    context = (doc.get("env") or {}).get("GATE_CONTEXT")
    if not isinstance(context, str) or not context:
        failures.append("GATE_CONTEXT is missing or empty, and the required-check lookup then matches a blank line")
    elif job.get("name") != context:
        failures.append("the gate job's name no longer matches GATE_CONTEXT, the name the ruleset requires")

    gate = index_of_step(steps, "Evaluate the gate")
    if gate == -1:
        failures.append("the gate job has no 'Evaluate the gate' step")
    else:
        if steps[gate].get("id") != "gate":
            failures.append("the verdict step reads steps.gate.outputs.ok, which is empty on every run unless the evaluate step's id is gate")
        if not str(steps[verdict].get("if")).startswith(f"{steps[gate].get('if')} &&"):
            failures.append("the verdict step can fire where the gate itself was skipped")

    consumers = [i for i, step in enumerate(steps) if i != verdict and reads_verdict(step)]
    if not consumers:
        failures.append("no step reads gate.outputs.ok, so the verdict step guards nothing")
    for i in consumers:
        if i < verdict:
            failures.append(f"step {i} ({steps[i].get('name')}) reads the verdict before the check")

    disarm = index_of_step(steps, "Disarm if this run failed")
    if disarm == -1:
        failures.append("the gate job has no 'Disarm if this run failed' step")
    else:
        if disarm < verdict:
            failures.append("a failed verdict check never reaches the step that drops a stale arm")
        if "failure()" not in str(steps[disarm].get("if")):
            failures.append("the disarm step no longer runs on failure")
    return failures


def check_verdict_consumers() -> list[str]:
    failures: list[str] = []
    steps = gate_steps()
    consumers = [
        step
        for step in steps
        if isinstance(step.get("if"), str)
        and "steps.gate.outputs.ok" in step["if"]
        and step.get("name") != "Require a verdict from the gate"
    ]
    if len(consumers) < 3:
        failures.append("a step that acted on the verdict stopped naming steps.gate.outputs.ok")
    for step in consumers:
        if not re.search(r"steps\.gate\.outputs\.ok == '(true|false)'", step["if"]):
            failures.append(f"{step.get('name')} reads ok without a literal")

    arm_at = index_of_step(steps, "Arm the merge")
    required_at = index_of_step(steps, "Confirm this gate is a required check")
    if arm_at == -1 or required_at == -1:
        failures.append("the gate job lost its arm or required-check step")
        return failures
    arm_if = str(steps[arm_at].get("if"))
    if "steps.gate.outputs.ok" in arm_if:
        failures.append("the arm step reads the verdict directly instead of through the required-check step")
    if "steps.required.outputs.required == 'true'" not in arm_if:
        failures.append("the arm step no longer waits for the required-check confirmation")
    if "steps.gate.outputs.ok == 'true'" not in str(steps[required_at].get("if")):
        failures.append("the required-check step no longer waits for a true verdict")
    return failures


RESOLVE_REPO = "Monoradioactivo/release-gate-fixture"
RELEASE_HEAD = "release-please--branches--main--components--fixture"
RELEASE_BOT = "aetherpush-release-bot[bot]"
EMPTY_NEEDLE = "resolved empty"

RESOLVE_STUB = "\n".join(
    [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$GH_CALLS"',
        'FILTER=""',
        'PREV=""',
        'for ARG in "$@"; do',
        '  if [ "$PREV" = "--jq" ]; then FILTER="$ARG"; fi',
        '  PREV="$ARG"',
        "done",
        'case "$1 $2" in',
        '  "pr list") BODY="$STUB_OPEN_PULLS" ;;',
        '  "api repos/$GITHUB_REPOSITORY/pulls/"*) BODY="$STUB_PULL" ;;',
        '  *) echo "unexpected gh: $*" >&2; exit 1 ;;',
        "esac",
        'printf "%s" "$BODY" | jq -r "$FILTER"',
        "",
    ]
)

STEP_EXPRESSIONS = {
    "${{ github.event_name }}": "event",
    "${{ github.head_ref }}": "head_ref",
    "${{ github.event.pull_request.state }}": "pr_state",
    "${{ github.event.pull_request.number }}": "event_pr",
    "${{ steps.app-token.outputs.token }}": "token",
}


class StepFailure(Exception):
    pass


def run_step(doc: dict, step: dict, context: dict) -> tuple[dict, str]:
    if not isinstance(step.get("run"), str):
        raise StepFailure(f"{step.get('name')} has no run script")
    env = {
        "PATH": "",
        "GITHUB_REPOSITORY": RESOLVE_REPO,
        "STUB_OPEN_PULLS": context.get("open_pulls", "[]"),
        "STUB_PULL": context.get("pull", ""),
    }
    env.update({key: str(value) for key, value in (doc.get("env") or {}).items()})
    for key, expression in (step.get("env") or {}).items():
        field = STEP_EXPRESSIONS.get(expression)
        if field is None:
            raise StepFailure(f"{step.get('name')} reads {expression}, which this harness does not model")
        env[key] = context.get(field, "")

    with tempfile.TemporaryDirectory(prefix="release-pr-resolve-") as tmp:
        root = Path(tmp)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        stub = bin_dir / "gh"
        stub.write_text(RESOLVE_STUB, encoding="utf-8")
        stub.chmod(0o755)
        script = root / "step.sh"
        script.write_text(step["run"], encoding="utf-8")
        output = root / "github_output"
        output.write_text("", encoding="utf-8")
        calls = root / "gh_calls"
        calls.write_text("", encoding="utf-8")
        env["PATH"] = f"{bin_dir}:/usr/bin:/bin"
        env["GITHUB_OUTPUT"] = str(output)
        env["GH_CALLS"] = str(calls)
        result = subprocess.run(
            ["bash", "-e", str(script)], env=env, capture_output=True, text=True, timeout=30
        )
        if "unexpected gh:" in result.stderr:
            raise StepFailure(f"{step.get('name')} asked the stub something it does not answer: {result.stderr}")
        if result.returncode != 0:
            raise StepFailure(f"{step.get('name')} exited {result.returncode}: {result.stderr}")
        outputs: dict = {}
        for line in output.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key:
                outputs[key] = value
        return outputs, calls.read_text(encoding="utf-8")


def resolve_release_pull_request(doc: dict, context: dict) -> dict:
    steps = doc["jobs"]["gate"]["steps"]
    scope_at = index_of_step(steps, "Decide whether this run has anything to do")
    resolve_at = index_of_step(steps, "Resolve the release pull request")
    gate_at = index_of_step(steps, "Evaluate the gate")
    if -1 in (scope_at, resolve_at, gate_at):
        raise StepFailure("the gate job lost its scope, resolve, or evaluate step")
    scope, resolve, gate = steps[scope_at], steps[resolve_at], steps[gate_at]
    if scope.get("id") != "scope" or resolve.get("id") != "pr":
        raise StepFailure("the scope or resolve step changed its id, so the outputs the gate reads are empty")
    if normalize_if(resolve.get("if")) != "steps.scope.outputs.applies == 'true'":
        raise StepFailure(f"the resolve step's if is {resolve.get('if')!r}")
    if normalize_if(gate.get("if")) != "steps.pr.outputs.number != ''":
        raise StepFailure(f"the evaluate step's if is {gate.get('if')!r}")

    full = {"token": "stub-app-token", "event_pr": "", "head_ref": "", "pr_state": "", **context}
    scoped, _ = run_step(doc, scope, full)
    if scoped.get("applies") != "true":
        return {"applies": scoped.get("applies"), "number": "", "calls": ""}
    resolved, calls = run_step(doc, resolve, full)
    if "number" not in resolved:
        raise StepFailure("the resolve step exited without writing number")
    return {"applies": "true", "number": resolved["number"], "calls": calls}


def pull_facts(author: str = RELEASE_BOT, head: str = RELEASE_HEAD, state: str = "open") -> str:
    return json.dumps({"user": {"login": author}, "head": {"ref": head}, "state": state})


def open_pulls(*pulls: tuple[int, str]) -> str:
    return json.dumps([{"number": number, "headRefName": head} for number, head in pulls])


def check_genuine_release_resolves(doc: dict) -> list[str]:
    failures: list[str] = []
    on_event = resolve_release_pull_request(
        doc,
        {"event": "pull_request", "event_pr": "160", "head_ref": RELEASE_HEAD, "pr_state": "open", "pull": pull_facts()},
    )
    if on_event["number"] != "160":
        failures.append(
            f"a genuine release pull request event {EMPTY_NEEDLE}, so the gate and its backstop skip and the check reports green"
        )
    on_schedule = resolve_release_pull_request(
        doc,
        {
            "event": "schedule",
            "open_pulls": open_pulls((12, "feat/unrelated"), (160, RELEASE_HEAD)),
            "pull": pull_facts(),
        },
    )
    if on_schedule["number"] != "160":
        failures.append(
            f"a scheduled run {EMPTY_NEEDLE} with a genuine release pull request open, so the gate never evaluates it"
        )
    return failures


def check_release_pull_request_resolution() -> list[str]:
    doc = gate_workflow()
    failures = check_genuine_release_resolves(doc)

    on_event = resolve_release_pull_request(
        doc,
        {"event": "pull_request", "event_pr": "160", "head_ref": RELEASE_HEAD, "pr_state": "open", "pull": pull_facts()},
    )
    if not re.search(rf"^api repos/{RESOLVE_REPO}/pulls/160 ", on_event["calls"], re.MULTILINE):
        failures.append("the resolve step did not read the pull request the event names")
    if re.search(r"^pr list", on_event["calls"], re.MULTILINE):
        failures.append("the resolve step listed pull requests on a pull_request event")

    empty_cases = {
        "no open release branch": {"event": "schedule", "open_pulls": open_pulls((12, "feat/unrelated"))},
        "a release branch pull request not authored by the release bot": {
            "event": "pull_request",
            "event_pr": "161",
            "head_ref": RELEASE_HEAD,
            "pr_state": "open",
            "pull": pull_facts(author="drive-by"),
        },
        "a release pull request that is no longer open": {
            "event": "workflow_dispatch",
            "open_pulls": open_pulls((160, RELEASE_HEAD)),
            "pull": pull_facts(state="closed"),
        },
        "a bot pull request whose head is not a release branch": {
            "event": "workflow_dispatch",
            "open_pulls": open_pulls((160, RELEASE_HEAD)),
            "pull": pull_facts(head="feat/not-a-release"),
        },
    }
    for label, context in empty_cases.items():
        run = resolve_release_pull_request(doc, context)
        if run["applies"] != "true":
            failures.append(f"{label}: the scope step skipped resolution")
        if run["number"] != "":
            failures.append(f"{label}: resolved to {run['number']!r} instead of empty")

    listing = resolve_release_pull_request(doc, empty_cases["no open release branch"])
    if "pulls/" in listing["calls"]:
        failures.append("no open release branch still read a pull request")
    if not re.search(rf"^pr list --repo {RESOLVE_REPO} --state open ", listing["calls"], re.MULTILINE):
        failures.append("the scheduled lookup no longer lists only this repository's open pull requests")

    ordinary = resolve_release_pull_request(
        doc, {"event": "pull_request", "event_pr": "12", "head_ref": "feat/unrelated", "pr_state": "open"}
    )
    if ordinary["applies"] != "false" or ordinary["number"] != "":
        failures.append("an ordinary pull request reached resolution")
    return failures


def drop_resolved_number(doc: dict) -> None:
    steps = doc["jobs"]["gate"]["steps"]
    resolve = steps[index_of_step(steps, "Resolve the release pull request")]
    planted = resolve["run"].replace('echo "number=$CANDIDATE"', 'echo "number="')
    if planted == resolve["run"]:
        raise StepFailure("the resolve step no longer writes number=$CANDIDATE, so this mutation plants nothing")
    resolve["run"] = planted


def miss_release_prefix(doc: dict) -> None:
    doc["env"]["RELEASE_BRANCH_PREFIX"] = "release-please--branches--master"


def wrong_release_bot(doc: dict) -> None:
    doc["env"]["RELEASE_BOT_LOGIN"] = "release-please[bot]"


def planted_resolution_must_fail(mutator) -> list[str]:
    doc = clone_gate()
    mutator(doc)
    failures = check_genuine_release_resolves(doc)
    if not failures:
        return [f"planted resolution mutation {mutator.__name__} was not caught"]
    if EMPTY_NEEDLE not in " ".join(failures):
        return [f"planted resolution mutation {mutator.__name__} failed for the wrong reason: {failures}"]
    return []


def main() -> int:
    files = sorted(
        [p for p in workflows_dir.iterdir() if p.suffix in {".yml", ".yaml"}]
    )
    if not files:
        print("FAIL: no workflow files found", file=sys.stderr)
        return 1
    all_hits: list[str] = []
    for path in files:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        for hit in run_interpolations(doc):
            all_hits.append(f"{path.name}: {hit}")
    if all_hits:
        print("FAIL: interpolations inside run:", file=sys.stderr)
        for hit in all_hits:
            print(f"  {hit}", file=sys.stderr)
        return 1

    planted = yaml.safe_load(
        "\n".join(
            [
                "jobs:",
                "  example:",
                "    steps:",
                "      - name: bad",
                "        run: |",
                '          BRANCH="${{ github.head_ref }}"',
            ]
        )
    )
    if run_interpolations(planted) != ["example[0] bad"]:
        print("FAIL: scanner did not report planted github.head_ref", file=sys.stderr)
        return 1

    planted_env = yaml.safe_load(
        "\n".join(
            [
                "jobs:",
                "  example:",
                "    steps:",
                "      - name: still-interpolated",
                "        env:",
                "          BRANCH: ${{ github.head_ref }}",
                "        run: |",
                '          echo "${{ env.BRANCH }}"',
            ]
        )
    )
    if run_interpolations(planted_env) != ["example[0] still-interpolated"]:
        print("FAIL: scanner did not report planted env.BRANCH", file=sys.stderr)
        return 1

    verdict_failures = check_absent_verdict_step()
    if verdict_failures:
        print("FAIL: the release gate's absent-verdict backstop:", file=sys.stderr)
        for failure in verdict_failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    refuse_failures = check_refuse_schedule_carve_out()
    if refuse_failures:
        print("FAIL: the refuse step schedule carve-out:", file=sys.stderr)
        for failure in refuse_failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    planted_failures: list[str] = []
    planted_failures.extend(planted_refuse_must_fail(drop_schedule_carve_out, CARVE_OUT_NEEDLE))
    planted_failures.extend(planted_refuse_must_fail(never_run_refuse, CARVE_OUT_NEEDLE))
    planted_failures.extend(planted_refuse_must_fail(refuse_without_exit, EXIT_1_NEEDLE))
    if planted_failures:
        print("FAIL: planted refuse mutations:", file=sys.stderr)
        for failure in planted_failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    consumer_failures = check_verdict_consumers()
    if consumer_failures:
        print("FAIL: the steps that act on the gate verdict:", file=sys.stderr)
        for failure in consumer_failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    try:
        resolution_failures = check_release_pull_request_resolution()
        for mutator in (drop_resolved_number, miss_release_prefix, wrong_release_bot):
            resolution_failures.extend(planted_resolution_must_fail(mutator))
    except StepFailure as error:
        resolution_failures = [str(error)]
    if resolution_failures:
        print("FAIL: the release pull request resolution:", file=sys.stderr)
        for failure in resolution_failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    print("PASS: no workflow interpolates expressions inside run:")
    print("PASS: an absent gate verdict fails the job before any step reads it")
    print("PASS: the refuse step skips schedule and still fails closed on every other event")
    print("PASS: planted refuse mutations fail the schedule carve-out check")
    print("PASS: every step that acts on the verdict reads an explicit true or false")
    print("PASS: a genuine release pull request resolves, and both empty exits stay empty")
    print("PASS: planted resolution mutations fail the genuine release check")
    return 0


if __name__ == "__main__":
    sys.exit(main())

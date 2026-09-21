#!/usr/bin/env python3

from __future__ import annotations

import re
import sys
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

    print("PASS: no workflow interpolates expressions inside run:")
    print("PASS: an absent gate verdict fails the job before any step reads it")
    return 0


if __name__ == "__main__":
    sys.exit(main())

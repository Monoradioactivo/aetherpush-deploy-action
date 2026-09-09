#!/usr/bin/env python3

from __future__ import annotations

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

    print("PASS: no workflow interpolates expressions inside run:")
    return 0


if __name__ == "__main__":
    sys.exit(main())

import json
import sys
from pathlib import Path


EXPECTED = {
    "failure": {"status": "failure"},
    "skip": {"status": "success"},
    "signed": {
        "app-version": ">=1.0.0 <2.0.0",
        "description": "line one\n__AETHER_EOF__\ninjected=yes\nx<<E",
        "is-disabled": "false",
        "is-mandatory": "true",
        "label": "v42",
        "package-hash": "abc123",
        "release-method": "Upload",
        "released-by": "",
        "rollout": "25",
        "size": "2048",
        "status": "success",
        "upload-time": "1700000000000",
    },
    "unsigned": {
        "app-version": "2.0.0",
        "description": "unsigned release",
        "is-disabled": "false",
        "is-mandatory": "false",
        "label": "v43",
        "package-hash": "def456",
        "release-method": "Upload",
        "released-by": "",
        "rollout": "100",
        "size": "4096",
        "status": "success",
        "upload-time": "1700000000001",
    },
}


def parse_output(path: Path) -> dict[str, str]:
    lines = path.read_text().splitlines()
    outputs: dict[str, str] = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if "<<" in line:
            key, delimiter = line.split("<<", 1)
            value_lines = []
            while index < len(lines) and lines[index] != delimiter:
                value_lines.append(lines[index])
                index += 1
            if index == len(lines):
                raise ValueError(f"missing delimiter for {key}")
            index += 1
            outputs[key] = "\n".join(value_lines)
        elif "=" in line:
            key, value = line.split("=", 1)
            outputs[key] = value
        else:
            raise ValueError(f"invalid output command: {line}")
    return outputs


actual = parse_output(Path(sys.argv[1]))
expected = EXPECTED[sys.argv[2]]
if actual != expected:
    print(json.dumps({"actual": actual, "expected": expected}, indent=2, sort_keys=True))
    raise SystemExit(1)

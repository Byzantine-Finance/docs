#!/usr/bin/env python3
"""Reduce a GitHub push payload to trusted Byzantine API fields."""

import json
import hashlib
import os
import re
import subprocess
import sys

REPOSITORY = "Byzantine-Finance/byzantine-api"
REF = "refs/heads/main"
SHA = re.compile(r"^[0-9a-f]{40}$")
DEFAULT_QUEUE_CLI = "/opt/data/work/byzantine-docs-automation/scripts/queue-delivery.mjs"
DEFAULT_QUEUE_DATABASE = "/opt/data/state/byzantine-docs/queue.sqlite"
MAX_PAYLOAD_BYTES = 64 * 1024


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
        if len(raw) > MAX_PAYLOAD_BYTES:
            return 0
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
        return 0
    if not isinstance(payload, dict):
        return 0

    repository_data = payload.get("repository")
    if not isinstance(repository_data, dict):
        return 0
    repository = repository_data.get("full_name")
    ref = payload.get("ref")
    before = payload.get("before")
    after = payload.get("after")
    if repository != REPOSITORY or ref != REF:
        return 0
    if not isinstance(before, str) or not isinstance(after, str):
        return 0
    if not SHA.fullmatch(before) or not SHA.fullmatch(after):
        return 0

    delivery_id = hashlib.sha256(
        "\0".join((repository, ref, before, after)).encode("utf-8")
    ).hexdigest()

    trusted = {
        "deliveryId": delivery_id,
        "repository": repository,
        "ref": ref,
        "before": before,
        "after": after,
        "forced": payload.get("forced") is True,
    }
    queued = subprocess.run(
        [
            "node",
            os.environ.get("BYZANTINE_DOCS_QUEUE_CLI", DEFAULT_QUEUE_CLI),
            "enqueue",
            "--database",
            os.environ.get("BYZANTINE_DOCS_QUEUE_DATABASE", DEFAULT_QUEUE_DATABASE),
        ],
        input=json.dumps(trusted, separators=(",", ":"), sort_keys=True),
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )
    if queued.returncode != 0:
        sys.stderr.write(queued.stderr)
        return 1
    try:
        queue_result = json.loads(queued.stdout)
    except json.JSONDecodeError:
        return 1
    if queue_result.get("inserted") is not True:
        return 0

    json.dump(
        trusted,
        sys.stdout,
        separators=(",", ":"),
        sort_keys=True,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

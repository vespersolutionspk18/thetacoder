#!/usr/bin/env python
"""Download SWE-bench_Verified metadata via the HuggingFace datasets-server API.

Fetches all 500 instances in pages of 100 rows, writes them as a single JSONL
file alongside this script. The datasets-server API is preferred over parquet
because it does not require the `pyarrow`/`pandas` dependency and serves
pre-extracted text.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API_BASE = "https://datasets-server.huggingface.co"
DATASET = "princeton-nlp/SWE-bench_Verified"
SPLIT = "test"
PAGE_SIZE = 100
OUT = Path(__file__).parent / "instances.jsonl"

# Fields we actually need. Trimming problem_statement etc. is fine because
# we read them back from the API per-row.
FIELDS = [
    "repo",
    "instance_id",
    "base_commit",
    "patch",
    "test_patch",
    "problem_statement",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "environment_setup_commit",
    "difficulty",
]


def fetch_page(offset: int) -> list[dict]:
    params = {
        "dataset": DATASET,
        "config": "default",
        "split": SPLIT,
        "offset": str(offset),
        "length": str(PAGE_SIZE),
    }
    url = f"{API_BASE}/rows?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "swe-bench-pilot/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("partial") and len(payload["rows"]) == 0:
        return []
    return [row["row"] for row in payload["rows"]]


def main() -> int:
    total = 0
    with OUT.open("w", encoding="utf-8") as out:
        offset = 0
        while True:
            try:
                page = fetch_page(offset)
            except Exception as e:
                print(f"[error] offset={offset}: {e}", file=sys.stderr)
                time.sleep(2)
                continue
            if not page:
                break
            for row in page:
                if not all(k in row for k in ("instance_id", "repo", "base_commit")):
                    continue
                slim = {k: row.get(k, "") for k in FIELDS}
                out.write(json.dumps(slim, ensure_ascii=False) + "\n")
            total += len(page)
            print(f"  fetched {total} instances", file=sys.stderr)
            offset += PAGE_SIZE
            time.sleep(0.2)
    print(f"wrote {total} instances to {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Build (prompt, completion) pairs from server telemetry.

We look for events of kind "tabPrediction.accepted" with props that include the
prefix, suffix, and the accepted insertion. Tune the SQL/parse if your event
shape differs.
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--max-prefix", type=int, default=2000)
    p.add_argument("--max-suffix", type=int, default=500)
    args = p.parse_args()

    conn = sqlite3.connect(args.db)
    cur = conn.execute(
        "SELECT props FROM telemetry_events WHERE kind = 'tabPrediction.accepted'"
    )
    out = Path(args.out)
    n = 0
    with out.open("w") as f:
        for (raw,) in cur:
            if not raw:
                continue
            try:
                p = json.loads(raw)
            except json.JSONDecodeError:
                continue
            prefix = (p.get("prefix") or "")[-args.max_prefix:]
            suffix = (p.get("suffix") or "")[:args.max_suffix]
            insert = p.get("insert") or ""
            if not insert.strip():
                continue
            prompt = f"<prefix>\n{prefix}\n</prefix>\n<suffix>\n{suffix}\n</suffix>\n<insert>"
            completion = f"\n{insert}\n</insert>"
            f.write(json.dumps({"prompt": prompt, "completion": completion}) + "\n")
            n += 1
    print(f"wrote {n} examples to {out}", file=sys.stderr)


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from eth_account import Account


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _chmod600(path: Path) -> None:
    os.chmod(path, 0o600)


def _chmod700(path: Path) -> None:
    os.chmod(path, 0o700)


def generate(count: int, out_path: str, prefix: str) -> None:
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    _chmod700(p.parent)

    lines: list[str] = []
    created_at = _now_iso()
    for i in range(1, count + 1):
        wallet_id = f"{prefix}{i:04d}"
        acct = Account.create()
        rec = {
            "wallet_id": wallet_id,
            "address": acct.address,
            "private_key": acct.key.hex(),
            "created_at": created_at,
        }
        lines.append(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))

    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    _chmod600(p)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--out", type=str, required=True)
    ap.add_argument("--prefix", type=str, default="wallet_")
    args = ap.parse_args()

    if args.count <= 0:
        raise SystemExit(2)

    generate(count=args.count, out_path=args.out, prefix=args.prefix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WalletRecord:
    wallet_id: str
    address: str
    private_key: str


def load_wallet_manifest(path: str) -> dict[str, WalletRecord]:
    p = Path(path)
    if not p.exists():
        return {}
    records: dict[str, WalletRecord] = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        obj = json.loads(s)
        wallet_id = str(obj.get("wallet_id", "")).strip()
        address = str(obj.get("address", "")).strip()
        private_key = str(obj.get("private_key", "")).strip()
        if not wallet_id or not address or not private_key:
            continue
        records[wallet_id] = WalletRecord(wallet_id=wallet_id, address=address, private_key=private_key)
    return records


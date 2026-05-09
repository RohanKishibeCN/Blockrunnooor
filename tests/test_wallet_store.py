from __future__ import annotations

from pathlib import Path

from blockrunnooor.wallet_store import load_wallet_manifest


def test_load_wallet_manifest(tmp_path: Path):
    p = tmp_path / "manifest.jsonl"
    p.write_text(
        "\n".join(
            [
                '{"wallet_id":"wallet_0001","address":"0xabc","private_key":"0xkey"}',
                '{"wallet_id":"wallet_0002","address":"0xdef","private_key":"0xkey2"}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    m = load_wallet_manifest(str(p))
    assert m["wallet_0001"].address == "0xabc"
    assert m["wallet_0002"].private_key == "0xkey2"


from __future__ import annotations

import random
from pathlib import Path

from blockrunnooor.prompt_bank import load_prompt_bank, pick_random_prompt


def test_load_and_pick_prompt_bank(tmp_path: Path):
    p = tmp_path / "prompts.jsonl"
    p.write_text(
        "\n".join(
            [
                '{"prompt_id":"p1","model":"openai/gpt-5.4","messages":[{"role":"user","content":"hi"}]}',
                '{"prompt_id":"p2","model":"openai/gpt-5.4","messages":[{"role":"user","content":"yo"}],"temperature":0.7,"max_tokens":10}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    items = load_prompt_bank(str(p))
    assert len(items) == 2
    random.seed(0)
    picked = pick_random_prompt(items)
    assert picked.prompt_id in {"p1", "p2"}


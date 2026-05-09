from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PromptItem:
    prompt_id: str
    model: str
    messages: list[dict[str, Any]]
    temperature: float | None
    max_tokens: int | None


def load_prompt_bank(path: str) -> list[PromptItem]:
    p = Path(path)
    if not p.exists():
        return []
    items: list[PromptItem] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        obj = json.loads(s)
        prompt_id = str(obj.get("prompt_id", "")).strip()
        model = str(obj.get("model", "")).strip()
        messages = obj.get("messages")
        if not prompt_id or not model or not isinstance(messages, list) or not messages:
            continue
        temperature = obj.get("temperature")
        max_tokens = obj.get("max_tokens")
        items.append(
            PromptItem(
                prompt_id=prompt_id,
                model=model,
                messages=messages,
                temperature=float(temperature) if isinstance(temperature, (int, float)) else None,
                max_tokens=int(max_tokens) if isinstance(max_tokens, int) else None,
            )
        )
    return items


def pick_random_prompt(items: list[PromptItem]) -> PromptItem:
    if not items:
        raise ValueError("prompt bank empty")
    return random.choice(items)


from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", case_sensitive=False)

    brnoo_log_level: str = Field(default="INFO", alias="BRNOO_LOG_LEVEL")
    brnoo_orchestrator_version: str = Field(default="dev", alias="BRNOO_ORCHESTRATOR_VERSION")
    brnoo_run_id_salt: str = Field(alias="BRNOO_RUN_ID_SALT")

    brnoo_state_db_path: str = Field(default="/var/lib/blockrunnooor/state/state.db", alias="BRNOO_STATE_DB_PATH")
    brnoo_wallet_ids: str = Field(default="", alias="BRNOO_WALLET_IDS")
    brnoo_task_types: str = Field(default="default", alias="BRNOO_TASK_TYPES")
    brnoo_wallets_manifest_path: str | None = Field(default=None, alias="BRNOO_WALLETS_MANIFEST_PATH")
    brnoo_prompts_file: str | None = Field(default=None, alias="BRNOO_PROMPTS_FILE")
    brnoo_prompt_selection_strategy: str = Field(default="random", alias="BRNOO_PROMPT_SELECTION_STRATEGY")
    brnoo_default_daily_budget_usd: float = Field(default=0.0, alias="BRNOO_DEFAULT_DAILY_BUDGET_USD")
    brnoo_default_max_cost_per_run_usd: float = Field(default=0.0, alias="BRNOO_DEFAULT_MAX_COST_PER_RUN_USD")

    brnoo_global_max_concurrency: int = Field(default=5, alias="BRNOO_GLOBAL_MAX_CONCURRENCY")
    brnoo_per_wallet_max_concurrency: int = Field(default=1, alias="BRNOO_PER_WALLET_MAX_CONCURRENCY")
    brnoo_base_interval_seconds: int = Field(default=300, alias="BRNOO_BASE_INTERVAL_SECONDS")
    brnoo_jitter_max_seconds: int = Field(default=60, alias="BRNOO_JITTER_MAX_SECONDS")
    brnoo_bucket_seconds: int = Field(default=300, alias="BRNOO_BUCKET_SECONDS")

    brnoo_max_attempts: int = Field(default=3, alias="BRNOO_MAX_ATTEMPTS")
    brnoo_backoff_base_seconds: int = Field(default=2, alias="BRNOO_BACKOFF_BASE_SECONDS")
    brnoo_backoff_max_seconds: int = Field(default=60, alias="BRNOO_BACKOFF_MAX_SECONDS")
    brnoo_wallet_cooldown_seconds: int = Field(default=900, alias="BRNOO_WALLET_COOLDOWN_SECONDS")
    brnoo_wallet_failure_threshold: int = Field(default=3, alias="BRNOO_WALLET_FAILURE_THRESHOLD")
    brnoo_circuit_failure_threshold: int = Field(default=5, alias="BRNOO_CIRCUIT_FAILURE_THRESHOLD")
    brnoo_circuit_open_seconds: int = Field(default=300, alias="BRNOO_CIRCUIT_OPEN_SECONDS")
    brnoo_outbox_poll_seconds: int = Field(default=5, alias="BRNOO_OUTBOX_POLL_SECONDS")

    brnoo_executor_path: str = Field(default="/opt/blockrunnooor/bin/executor", alias="BRNOO_EXECUTOR_PATH")
    brnoo_executor_timeout_seconds: int = Field(default=120, alias="BRNOO_EXECUTOR_TIMEOUT_SECONDS")

    brnoo_secrets_dir: str = Field(default="/var/lib/blockrunnooor/secrets", alias="BRNOO_SECRETS_DIR")
    brnoo_master_key_b64: str | None = Field(default=None, alias="BRNOO_MASTER_KEY_B64")

    blockrun_api_url: str = Field(default="https://blockrun.ai/api", alias="BLOCKRUN_API_URL")
    blockrun_wallet_key: str | None = Field(default=None, alias="BLOCKRUN_WALLET_KEY")
    blockrun_timeout_seconds: int = Field(default=30, alias="BLOCKRUN_TIMEOUT_SECONDS")
    blockrun_chat_path: str = Field(default="/v1/chat/completions", alias="BLOCKRUN_CHAT_PATH")

    notion_token: str | None = Field(default=None, alias="NOTION_TOKEN")
    notion_runs_database_id: str | None = Field(default=None, alias="NOTION_RUNS_DATABASE_ID")
    notion_timeout_seconds: int = Field(default=30, alias="NOTION_TIMEOUT_SECONDS")

    def wallet_id_list(self) -> list[str]:
        return [w.strip() for w in self.brnoo_wallet_ids.split(",") if w.strip()]

    def task_type_list(self) -> list[str]:
        return [t.strip() for t in self.brnoo_task_types.split(",") if t.strip()]

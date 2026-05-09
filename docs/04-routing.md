# 路由（BlockRun 优先 + 自有 Kimi K2.6 兜底）

## 统一决策口径
每次 run 明确：
- primary_channel = blockrun
- fallback_channel = kimi_k26
- decision：blockrun / fallback / deny

## 何时走 BlockRun（建议）
- 默认全部先尝试 BlockRun
- 若 BlockRun 未触发熔断且钱包预算允许：继续优先

## 何时 fallback 到自有 Kimi（建议）
- BlockRun 不可用错误（网络超时、5xx、网关不可用）
- BlockRun 触发熔断窗口
- BlockRun 成本/额度策略不允许（达到当日限额或单次上限）
- BlockRun 错误属于可替代类型（非参数/内容错误）

## 何时禁止（deny）
- 钱包预算耗尽或触发安全阈值
- 任务输入不合规（敏感信息/危险操作）
- 连续失败超阈值且已进入冷却期

## 记录规范（必须写 Notion Runs）
- channel：blockrun / kimi
- model：blockrun-xxx / kimi-k2.6
- request_id：上游返回的追踪 id（如有）
- cost：input_tokens / output_tokens / total_cost（统一折算口径）
- latency_ms
- error：error_type / error_code / error_message（脱敏）

## 兜底一致性
- fallback 也必须遵循同一预算、同一限速、同一脱敏规则
- fallback 不得绕过 Notion 记录

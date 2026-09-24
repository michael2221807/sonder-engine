主角：{{PLAYER_NAME}}
回合前背包物品（存档 ID → 完整条目）：{{ITEMS_JSON}}
回合前账户余额（cash/copper/silver/gold）：{{BALANCES_JSON}}
已接受的本回合正文：
{{NARRATIVE}}

依据正文与回合前状态，结算本回合主角背包和金钱的变化。只输出一个 JSON 对象，唯一根字段为 state_updates，值遵守版本 1 的 actions 接口。

## 状态更新接口

Step2（或单步完整输出）给出 `state_updates:{"version":1,"actions":[]}`，无变化时 actions 为空；Step1 不输出此字段。背包物品和金钱由此接口更新，其他状态使用 commands。

每条 action 含 op，按顺序执行。接口如下：

| op | 参数与含义 |
| --- | --- |
| acquire / register_held | 新获得／登记已有物件。ref 为唯一 `__new_N`（N=1…999）；item 含名称、类型、品质、数量、描述，名称非空、数量为正整数。 |
| update | ref 为存档 ID，fields 为更新字段；数量由下两种操作处理。 |
| replenish / consume | ref 与正整数 amount，增加／减少数量。 |
| transfer | ref 与可选正整数 amount；省略 amount 移除整项，ref:null 表示未登记物件。 |
| pay / receive | account 与正数 amount（最多两位小数），支出／收入。cash/copper/silver/gold 对应现金/铜/银/金；account:null 表示未确定账户，不变更余额。 |

同轮可引用 __new_N，后续回合使用宿主分配的存档 ID。引擎计算数量与余额。

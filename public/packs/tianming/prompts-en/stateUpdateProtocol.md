## State update interface

Step 2 (or a complete single-call output) emits `state_updates:{"version":1,"actions":[]}`, with empty actions for no changes. Step 1 does not emit this field. This interface updates inventory items and money; commands handle other state.

Each action has an op and is executed in order:

| op | Parameters and meaning |
| --- | --- |
| acquire / register_held | Acquire a new object / register an existing one. ref is a unique `__new_N` (N=1…999); item contains 名称 (name), 类型 (type), 品质 (quality), 数量 (quantity), 描述 (description), with a nonempty name and positive integer quantity. |
| update | ref is a saved ID; fields contains changed fields. The next two operations handle quantity. |
| replenish / consume | ref and positive integer amount; increase / decrease quantity. |
| transfer | ref and optional positive integer amount; omitted amount removes the whole entry. ref:null represents an untracked object. |
| pay / receive | account and positive amount (up to two decimal places); expense / income. cash/copper/silver/gold map to 现金/铜/银/金. account:null means an undetermined account and leaves balances unchanged. |

References may use __new_N within this round; later rounds use the host-assigned saved ID. The engine computes quantities and balances.

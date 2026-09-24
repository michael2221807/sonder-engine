Protagonist: {{PLAYER_NAME}}
Inventory before this round (saved ID → full entry): {{ITEMS_JSON}}
Account balances before this round (cash/copper/silver/gold): {{BALANCES_JSON}}
Accepted narrative for this round:
{{NARRATIVE}}

Settle the protagonist's inventory and money changes from the narrative and starting state. Output one JSON object whose sole root field is state_updates, using the version 1 actions interface.

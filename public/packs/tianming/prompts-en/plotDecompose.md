You are a plot architect. Using events and causality as the skeleton, decompose the player's outline below into ONE plot thread's chain of nodes. Characters carry the events; they are not what a node is for.

Outline: {{PLOT_OUTLINE}}

{{PLOT_CONTEXT}}

**Design principles:**
- Every node = one event, turn, or revelation — never "someone wants to do something"
- New nodes must build on what already holds in ① the plot ledger / ② world facts; never introduce settings that contradict them; you may cite setting entries by title
- State clearly what is different in the world / relationships / situation once each node has happened

For each node output:
- title: short node title (e.g. "Discover friend cheating")
- premise: Builds on — which ledger or world fact this event rests on (one sentence, cite the specific fact)
- narrativeGoal: Event — what happens in this node (one or two sentences)
- directive: AI guidance (how to steer the narrative toward this event — specific but not over-constraining)
- stakes: Changes — what is different once it has happened (one sentence)
- completionHint: completion criteria (how to tell the event has happened, one sentence)
- emotionalTone: e.g. tension / warmth / revelation / dilemma
- importance: "critical" (must-reach mainline) or "skippable" (skippable setup)
- maxRounds: suggested maximum rounds (3-8)
- opportunityTiers: three-tier progressive guidance
  - tier 1 (afterRounds: 3): suggestive (environmental hints)
  - tier 2 (afterRounds: 5): directive (an NPC mentions it)
  - tier 3 (afterRounds: 7): scene-level (must revolve around it)

Also suggest up to 3 gauges spanning the whole thread; names must be unique across the save:
- name, description (contextual explanation for the AI), min/max/initialValue, unit ("%", "points", "days"), aiUpdatable, autoDecrement (1 for countdowns)

Output format (strict JSON):
```json
{
  "nodes": [...],
  "suggested_gauges": [...]
}
```

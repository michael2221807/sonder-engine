/**
 * The wiring table of the main round's prompt injections (refactor R1, step 4; audit E02b-001 / E04a-016).
 *
 * A round's request is assembled by two assemblers that do not know each other:
 *  - the BUILDER (`buildSystemPrompt`, system-prompt-builder.ts) writes the story request (a split round's Step 1, a
 *    single call) as pieces with ids from `PIECE_ID`;
 *  - the FLOW assembler (`PromptAssembler`, the pack's prompt flows) writes a split round's Step 2 and the enhanced
 *    opening, from template variables that `collectRoundInputs` / `buildFlowVariables` prepare.
 * Every injection (bookmarks, the contract, the cast vectors, ...) has to be wired into both, and a feature wired into
 * one only is the main source of the bugs this file's neighbours keep fixing.
 *
 * This table declares, per injection, which builder pieces and which flow variables / modules carry it. It is READ BY
 * TESTS AND DOCUMENTATION ONLY (`round-injections.test.ts`): production code never imports it, so it cannot change a
 * request. The test fails when a builder piece, a round flow module or a round flow variable exists that the table does
 * not name, or when the table names one the code does not have, or when an injection has only one side without being
 * declared so. Adding an injection therefore means adding a row here.
 *
 * `knownOneSided` registers a one-sided wiring that the audit already recorded as a defect. It is REGISTERED, NOT FIXED:
 * the refactor keeps behaviour byte-identical, and the fixes live in the audit's side-list. `designedOneSided` marks a
 * side that is missing on purpose.
 */
import { PIECE_ID } from './piece-ids';

/** The pack flows whose modules this table accounts for (the main round, its split steps, the enhanced opening). */
export type RoundFlowKey =
  | 'mainRound'
  | 'splitGenMainRoundStep1'
  | 'splitGenMainRoundStep2'
  | 'openingEnhancedStep1'
  | 'openingEnhancedStep2';

export const ROUND_FLOW_KEYS: readonly RoundFlowKey[] = [
  'mainRound',
  'splitGenMainRoundStep1',
  'splitGenMainRoundStep2',
  'openingEnhancedStep1',
  'openingEnhancedStep2',
];

/** A place in the code that carries an injection without a builder piece or a flow module of its own. */
export interface InlineSite {
  /** Path under `src/engine/`. */
  readonly file: string;
  /** An identifier the file must still contain (the test checks it, so a rename is noticed). */
  readonly symbol: string;
}

interface FlowModuleRef {
  readonly promptId: string;
  /** The module's `condition` variable, absent for an unconditional module. */
  readonly condition?: string;
  readonly flows: readonly RoundFlowKey[];
}

interface FlowPlaceholder {
  /** The pack prompt that has to contain `{{variable}}`. */
  readonly promptId: string;
  readonly variable: string;
}

export interface BuilderSide {
  /** `PIECE_ID` values the builder pushes for this injection. */
  readonly pieceIds: readonly string[];
  readonly inline?: InlineSite;
}

export interface FlowSide {
  /** Variable-table keys (`buildFlowVariables`, the plot injector, `step2Variables`) that carry the injection. */
  readonly variables: readonly string[];
  readonly modules: readonly FlowModuleRef[];
  readonly placeholders?: readonly FlowPlaceholder[];
  readonly inline?: InlineSite;
}

type Side = 'builder' | 'flow';

export interface RoundInjection {
  readonly id: string;
  readonly label: string;
  readonly builder: BuilderSide;
  readonly flow: FlowSide;
  /** One side is missing and the audit recorded it as a defect: registered here, fixed elsewhere. */
  readonly knownOneSided?: { readonly missing: Side; readonly audit: string; readonly note: string };
  /** One side is missing on purpose. */
  readonly designedOneSided?: { readonly missing: Side; readonly reason: string };
}

const P = PIECE_ID;

/** All five round flows, for modules every one of them carries. */
const ALL: readonly RoundFlowKey[] = ROUND_FLOW_KEYS;

export const ROUND_INJECTIONS: readonly RoundInjection[] = [
  {
    id: 'packRules',
    label: 'Pack rules: jailbreak, narrator frame, writing style, output protocol and format',
    builder: {
      pieceIds: [
        P.JAILBREAK, P.AI_ROLE, P.WRITE_STYLE, P.WRITE_ANTI_CLICHE, P.WRITE_EMOTION_GUARD, P.WRITE_NO_CONTROL,
        P.PERSPECTIVE_PROMPT, P.NARRATIVE_CONSTRAINTS, P.EXTRA_PROMPT, P.NARRATIVE_RULES, P.OUTPUT_PROTOCOL,
        P.FORMAT_PROMPT,
      ],
    },
    flow: {
      variables: [],
      modules: [
        { promptId: 'jailbreak', flows: ALL },
        { promptId: 'narratorFrame', flows: ALL },
        { promptId: 'mainRound', flows: ['mainRound'] },
        { promptId: 'splitGenStep1', flows: ['splitGenMainRoundStep1', 'openingEnhancedStep1'] },
        { promptId: 'splitGenStep2', flows: ['splitGenMainRoundStep2'] },
        { promptId: 'coreNarrative', flows: ALL },
        { promptId: 'core', flows: ['mainRound', 'splitGenMainRoundStep2', 'openingEnhancedStep1', 'openingEnhancedStep2'] },
      ],
    },
  },
  {
    id: 'wordCount',
    label: 'Target length and its band',
    builder: { pieceIds: [P.LENGTH_PROMPT] },
    flow: {
      variables: ['wordCount', 'wordCountMin', 'wordCountMax'],
      modules: [{ promptId: 'wordCountReq', flows: ['mainRound', 'splitGenMainRoundStep1'] }],
    },
  },
  {
    id: 'gameState',
    label: 'Game state: world, role, tasks, agreements, and the player/location names',
    builder: {
      pieceIds: [P.WORLD_MAP, P.STATE_WORLD, P.STATE_ROLE, P.STATE_TASKS, P.STATE_AGREEMENTS],
    },
    flow: {
      variables: ['PLAYER_NAME', 'CURRENT_LOCATION', 'GAME_STATE_JSON'],
      modules: [
        { promptId: 'splitGenContext', flows: ALL },
      ],
      placeholders: [{ promptId: 'splitGenContext', variable: 'GAME_STATE_JSON' }],
    },
  },
  {
    id: 'storyPlan',
    label: 'Story plan and the heroine plan',
    builder: { pieceIds: [P.STORY_PLAN, P.HEROINE_PLAN] },
    flow: { variables: ['PREV_STORY_PLAN'], modules: [] },
    knownOneSided: {
      missing: 'flow',
      audit: 'E02b-019',
      note: 'PREV_STORY_PLAN is computed every round and no pack prompt references it',
    },
  },
  {
    id: 'memory',
    label: 'Long, mid, implicit and Engram memory',
    builder: { pieceIds: [P.MEMORY_LONG, P.MEMORY_MID, P.MEMORY_IMPLICIT, P.MEMORY_ENGRAM] },
    flow: {
      variables: ['MEMORY_BLOCK'],
      modules: [{ promptId: 'splitGenContext', flows: ALL }],
      placeholders: [{ promptId: 'splitGenContext', variable: 'MEMORY_BLOCK' }],
    },
  },
  {
    id: 'shortTermMemory',
    label: 'Short-term memory (the recap of the last rounds)',
    builder: { pieceIds: [], inline: { file: 'prompt/system-prompt-builder.ts', symbol: 'shortMemoryContext' } },
    flow: { variables: [], modules: [], inline: { file: 'pipeline/stages/context-assembly-requests.ts', symbol: 'shortTermText' } },
  },
  {
    id: 'bookmarks',
    label: 'Bookmarked rounds (one-shot)',
    builder: { pieceIds: [P.BOOKMARKED_ROUNDS] },
    flow: {
      variables: ['BOOKMARKED_ROUNDS_BLOCK'],
      modules: [{ promptId: 'splitGenContext', flows: ALL }],
      placeholders: [{ promptId: 'splitGenContext', variable: 'BOOKMARKED_ROUNDS_BLOCK' }],
    },
  },
  {
    id: 'narrativeContract',
    label: 'Narrative contract',
    builder: { pieceIds: [P.NARRATIVE_CONTRACT] },
    flow: {
      variables: ['NARRATIVE_CONTRACT', 'NARRATIVE_CONTRACT_BLOCK'],
      modules: [
        {
          promptId: 'narrativeContract',
          condition: 'NARRATIVE_CONTRACT',
          flows: ['mainRound', 'splitGenMainRoundStep1', 'splitGenMainRoundStep2'],
        },
      ],
      placeholders: [{ promptId: 'narrativeContract', variable: 'NARRATIVE_CONTRACT_BLOCK' }],
    },
  },
  {
    id: 'characterVectors',
    label: 'Character vectors',
    builder: { pieceIds: [P.CHARACTER_VECTORS] },
    flow: {
      variables: ['CHARACTER_VECTORS', 'CHARACTER_VECTORS_BLOCK'],
      modules: [
        {
          promptId: 'characterVectors',
          condition: 'CHARACTER_VECTORS',
          flows: ['mainRound', 'splitGenMainRoundStep1', 'splitGenMainRoundStep2'],
        },
      ],
      placeholders: [{ promptId: 'characterVectors', variable: 'CHARACTER_VECTORS_BLOCK' }],
    },
  },
  {
    id: 'settingCapture',
    label: 'Canon capture (the author marks a setting)',
    builder: { pieceIds: [P.SETTING_AUTHORITY, P.SETTING_CAPTURE] },
    flow: {
      variables: ['SETTING_CAPTURE_ACTIVE'],
      modules: [
        { promptId: 'settingCapture', condition: 'SETTING_CAPTURE_ACTIVE', flows: ['splitGenMainRoundStep2'] },
      ],
    },
  },
  {
    id: 'plotGuidance',
    label: 'Plot guidance (directive and evaluation hint)',
    builder: { pieceIds: [], inline: { file: 'pipeline/stages/context-assembly-requests.ts', symbol: 'injectPlotMessages' } },
    flow: {
      variables: ['PLOT_DIRECTIVE', 'PLOT_COMPLETION_HINT'],
      modules: [
        { promptId: 'plotDirective', condition: 'PLOT_DIRECTIVE', flows: ['mainRound', 'splitGenMainRoundStep1'] },
        {
          promptId: 'plotEvaluationStep2',
          condition: 'PLOT_COMPLETION_HINT',
          flows: ['mainRound', 'splitGenMainRoundStep2'],
        },
      ],
    },
  },
  {
    id: 'previousThinking',
    label: 'The previous round thinking',
    builder: { pieceIds: [P.PREV_THINKING] },
    flow: {
      variables: ['PREV_THINKING'],
      modules: [{ promptId: 'cot-preamble', condition: 'COT_ENABLED', flows: ['mainRound', 'splitGenMainRoundStep1'] }],
      placeholders: [{ promptId: 'cot-preamble', variable: 'PREV_THINKING' }],
    },
  },
  {
    id: 'cot',
    label: 'Chain of thought: the module, the judge, the masquerade and the no-thinking guard',
    builder: { pieceIds: [P.COT_CORE, P.COT_JUDGE, P.COT_MASQUERADE] },
    flow: {
      variables: ['COT_ENABLED', 'COT_DISABLED', 'COT_JUDGE_ENABLED', 'COT_INJECT_STEP2_ENABLED'],
      modules: [
        { promptId: 'cot-preamble', condition: 'COT_ENABLED', flows: ['mainRound', 'splitGenMainRoundStep1'] },
        { promptId: 'cot-masquerade', condition: 'COT_ENABLED', flows: ['mainRound', 'splitGenMainRoundStep1'] },
        { promptId: 'cot-no-thinking-guard', condition: 'COT_DISABLED', flows: ['mainRound'] },
        { promptId: 'cot-judge', condition: 'COT_JUDGE_ENABLED', flows: ['mainRound'] },
      ],
    },
  },
  {
    id: 'actionOptions',
    label: 'Action options: the two modes, the off notice, the pace and the custom request',
    builder: { pieceIds: [P.ACTION_OPTIONS, P.ACTION_OPTIONS_OFF] },
    flow: {
      variables: [
        'ACTION_OPTIONS_MODE', 'ACTION_OPTIONS_MODE_IS_ACTION', 'ACTION_OPTIONS_MODE_IS_STORY', 'ACTION_OPTIONS_OFF',
        'ACTION_OPTIONS_PACE', 'ACTION_PACE_HINT', 'CUSTOM_ACTION_PROMPT',
      ],
      modules: [
        {
          promptId: 'actionOptions',
          condition: 'ACTION_OPTIONS_MODE_IS_ACTION',
          flows: ['mainRound', 'splitGenMainRoundStep2', 'openingEnhancedStep2'],
        },
        {
          promptId: 'actionOptionsStory',
          condition: 'ACTION_OPTIONS_MODE_IS_STORY',
          flows: ['mainRound', 'splitGenMainRoundStep2', 'openingEnhancedStep2'],
        },
        {
          promptId: 'actionOptionsOff',
          condition: 'ACTION_OPTIONS_OFF',
          flows: ['mainRound', 'splitGenMainRoundStep2', 'openingEnhancedStep2'],
        },
      ],
      placeholders: [
        { promptId: 'actionOptions', variable: 'CUSTOM_ACTION_PROMPT' },
        { promptId: 'actionOptions', variable: 'ACTION_PACE_HINT' },
      ],
    },
  },
  {
    id: 'npcRoster',
    label: 'The NPC roster as the builder writes it: every present NPC and every absent one, untiered',
    builder: { pieceIds: [P.NPC_PRESENT, P.NPC_AWAY] },
    flow: { variables: [], modules: [] },
    designedOneSided: {
      missing: 'flow',
      reason: 'the flow side gets its NPCs through the tiered blocks of npcTiers (and GAME_STATE_JSON), not through an untiered roster',
    },
  },
  {
    id: 'npcTiers',
    label: 'NPC presence tiers (present / absent partition)',
    builder: { pieceIds: [] },
    flow: {
      variables: ['NPC_PRESENCE_ENABLED', 'NPC_PRESENT_BLOCK', 'NPC_ABSENT_BLOCK'],
      modules: [
        {
          promptId: 'presencePartition',
          condition: 'NPC_PRESENCE_ENABLED',
          flows: ['mainRound', 'splitGenMainRoundStep1', 'splitGenMainRoundStep2'],
        },
      ],
      placeholders: [
        { promptId: 'presencePartition', variable: 'NPC_PRESENT_BLOCK' },
        { promptId: 'presencePartition', variable: 'NPC_ABSENT_BLOCK' },
      ],
    },
    knownOneSided: {
      missing: 'builder',
      audit: 'E02b-003',
      note: 'only a split round Step 2 is tiered; Step 1 and a single call render every NPC (the step1 and mainRound flows are never assembled in production)',
    },
  },
  {
    id: 'worldBook',
    label: 'World books: world lore and the rule texts',
    builder: { pieceIds: [P.WORLD_PROMPT, P.WB_SYSTEM_RULES, P.WB_COMMAND_RULES, P.WB_OUTPUT_RULES] },
    flow: { variables: [], modules: [] },
    knownOneSided: {
      missing: 'flow',
      audit: 'E02b-017',
      note: 'the flow side (Step 2, the enhanced opening) injects no world book and no auto-captured entries',
    },
  },
  {
    id: 'environment',
    label: 'Weather, festival and environment tags',
    builder: { pieceIds: [P.STATE_ENVIRONMENT] },
    flow: { variables: ['ENVIRONMENT_BLOCK'], modules: [] },
    knownOneSided: {
      missing: 'flow',
      audit: 'E02b-019',
      note: 'ENVIRONMENT_BLOCK is still computed every round, but no round flow references it since ddb332b (only npc-chat and world-heartbeat prompts do)',
    },
  },
  {
    id: 'userTurn',
    label: 'The player input and the start-task line',
    builder: { pieceIds: [P.PLAYER_INPUT, P.START_TASK] },
    flow: { variables: ['USER_INPUT'], modules: [] },
    designedOneSided: {
      missing: 'flow',
      reason: 'the flow assembler appends the player input as the last message itself (assembleStep2Request); no module carries it',
    },
  },
  {
    id: 'historyFraming',
    label: 'The framing note for the history messages',
    builder: { pieceIds: [] },
    flow: {
      variables: ['HISTORY_FRAMING_STEP2'],
      modules: [
        { promptId: 'historyFraming', flows: ['mainRound', 'splitGenMainRoundStep1'] },
        { promptId: 'historyFraming', condition: 'HISTORY_FRAMING_STEP2', flows: ['splitGenMainRoundStep2'] },
      ],
    },
    designedOneSided: {
      missing: 'builder',
      reason: 'no builder piece carries it: the story request has no history-framing module, only the flow assembler adds one',
    },
  },
  {
    id: 'openingSetup',
    label: 'The enhanced opening: its task prompts and the author opening hint',
    builder: { pieceIds: [] },
    flow: {
      variables: ['OPENING_SETUP_HINT'],
      modules: [
        { promptId: 'openingEnhancedStep1', flows: ['openingEnhancedStep1'] },
        { promptId: 'openingEnhancedStep2', flows: ['openingEnhancedStep2'] },
      ],
      placeholders: [{ promptId: 'openingEnhancedStep1', variable: 'OPENING_SETUP_HINT' }],
    },
    designedOneSided: {
      missing: 'builder',
      reason: 'the enhanced opening is assembled by the flow assembler only (useNewBuilder = false)',
    },
  },
];

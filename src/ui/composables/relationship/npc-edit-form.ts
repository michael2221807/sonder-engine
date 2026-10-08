/**
 * The NPC edit form of RelationshipPanel: its types and the mapping between an NPC and the form, moved verbatim
 * out of RelationshipPanel.vue (refactor R7 step 8). The two default forms (the ref's initial one and the one
 * 「新增」 opens) are kept as they were and are NOT merged: they differ in `类型`.
 */
import type { EnginePathConfig } from '@/engine/pipeline/types';
import type { MemorySummary } from '@/ui/components/shared/NpcMemoryTimeline.vue';

/** The pack-defined NPC field names (DEFAULT_ENGINE_PATHS.npcFieldNames). */
export type NpcFieldNames = EnginePathConfig['npcFieldNames'];

/** 身体部位条目 */
export interface BodyPartEntry {
  部位名称?: string;
  敏感度?: number;
  开发度?: number;
  特征描述?: string;
  特殊印记?: string;
  已选背景图片ID?: string;
}

/** NPC 私密信息子对象 */
export interface PrivacyProfile {
  '是否为处女/处男'?: boolean;
  身体部位?: BodyPartEntry[];
  性格倾向?: string;
  性取向?: string;
  性癖好?: string[];
  性渴望程度?: number;
  当前性状态?: string;
  体液分泌状态?: string;
  性交总次数?: number;
  性伴侣名单?: string[];
  最近一次性行为时间?: string;
  特殊体质?: string[];
  /** 初夜夺取者（非处女/处男时必填）— 人名或 '未知'/情境描述 */
  初夜夺取者?: string;
  /** 初夜时间（非处女/处男时必填）— 游戏内时间戳或自然描述 */
  初夜时间?: string;
  /** 初夜描述（非处女/处男时必填）— 50-200 字情境描写 */
  初夜描述?: string;
  [key: string]: unknown;
}

/** 私聊历史条目（与 NpcChatMessage 对齐） */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** NPC relationship entry shape */
export interface NpcRelation {
  名称: string;
  类型?: string;
  好感度?: number;
  位置?: string;
  描述?: string;
  外貌描述?: string;
  身材描写?: string;
  衣着风格?: string;
  性别?: string;
  年龄?: number;
  背景?: string;
  内心想法?: string;
  在做事项?: string;
  性格特征?: string[];
  记忆?: string[];
  私密信息?: PrivacyProfile;
  私聊历史?: ChatHistoryEntry[];
  图片档案?: Record<string, string | undefined>;
  总结记忆?: MemorySummary[];
  关注?: boolean;
  心跳锁定?: boolean;
  [key: string]: unknown;
}

export interface RelationNetworkEntry {
  对象: string;
  关系: string;
  备注: string;
}

export interface MemorySummaryEntry {
  摘要: string;
  涵盖范围: string;
  生成时间: string;
}

export interface NpcEditForm {
  名称: string;
  类型: string;
  好感度: number;
  位置: string;
  描述: string;
  外貌描述: string;
  身材描写: string;
  衣着风格: string;
  性别: string;
  年龄: number;
  背景: string;
  内心想法: string;
  在做事项: string;
  性格特征: string[];
  记忆: string[];
  关注: boolean;
  心跳锁定: boolean;
  私密信息: PrivacyProfile;
  核心性格特征: string;
  关系状态: string;
  好感度突破条件: string;
  关系突破条件: string;
  关系网变量: RelationNetworkEntry[];
  总结记忆: MemorySummaryEntry[];
}

export function clonePrivacy(p?: PrivacyProfile): PrivacyProfile {
  if (!p) return {};
  return JSON.parse(JSON.stringify(p)) as PrivacyProfile;
}

export function npcToEditForm(npc: NpcRelation, npcFields: NpcFieldNames): NpcEditForm {
  return {
    名称: npc.名称 ?? '',
    类型: npc.类型 ?? '',
    好感度: typeof npc.好感度 === 'number' ? npc.好感度 : 50,
    位置: npc.位置 ?? '',
    描述: npc.描述 ?? '',
    外貌描述: npc.外貌描述 ?? '',
    身材描写: npc.身材描写 ?? '',
    衣着风格: npc.衣着风格 ?? '',
    性别: npc.性别 ?? '',
    年龄: typeof npc.年龄 === 'number' ? npc.年龄 : 20,
    背景: npc.背景 ?? '',
    内心想法: npc.内心想法 ?? '',
    在做事项: npc.在做事项 ?? '',
    性格特征: Array.isArray(npc.性格特征) ? [...npc.性格特征] : [],
    记忆: Array.isArray(npc.记忆) ? [...npc.记忆] : [],
    关注: npc.关注 === true,
    心跳锁定: npc.心跳锁定 === true,
    私密信息: clonePrivacy(npc.私密信息),
    核心性格特征: (npc[npcFields.corePersonality] as string) ?? '',
    关系状态: (npc[npcFields.relationshipStatus] as string) ?? '',
    好感度突破条件: (npc[npcFields.affinityBreakthrough] as string) ?? '',
    关系突破条件: (npc[npcFields.relationshipBreakthrough] as string) ?? '',
    关系网变量: Array.isArray(npc[npcFields.relationshipNetwork])
      ? (npc[npcFields.relationshipNetwork] as RelationNetworkEntry[]).map(e => ({ ...e, 备注: e.备注 ?? '' }))
      : [],
    总结记忆: Array.isArray(npc[npcFields.memorySummaries])
      ? (npc[npcFields.memorySummaries] as MemorySummaryEntry[]).map(e => ({ ...e }))
      : [],
  };
}

/** The form the edit modal starts from before any NPC is opened: type empty, as the ref was always initialised. */
export function emptyEditForm(): NpcEditForm {
  return {
    名称: '',
    类型: '',
    好感度: 50,
    位置: '',
    描述: '',
    外貌描述: '',
    身材描写: '',
    衣着风格: '',
    性别: '',
    年龄: 20,
    背景: '',
    内心想法: '',
    在做事项: '',
    性格特征: [],
    记忆: [],
    关注: false,
    心跳锁定: false,
    私密信息: {},
    核心性格特征: '',
    关系状态: '',
    好感度突破条件: '',
    关系突破条件: '',
    关系网变量: [],
    总结记忆: [],
  };
}

/** The form for a new NPC (「新增」): type 普通, as openAddNew always filled it. */
export function newEditForm(): NpcEditForm {
  return {
    名称: '',
    类型: '普通',
    好感度: 50,
    位置: '',
    描述: '',
    外貌描述: '',
    身材描写: '',
    衣着风格: '',
    性别: '',
    年龄: 20,
    背景: '',
    内心想法: '',
    在做事项: '',
    性格特征: [],
    记忆: [],
    关注: false,
    心跳锁定: false,
    私密信息: {},
    核心性格特征: '',
    关系状态: '',
    好感度突破条件: '',
    关系突破条件: '',
    关系网变量: [],
    总结记忆: [],
  };
}

/** The NPC data the edit form saves (field names for the pack-defined keys come from `npcFields`). */
export function editFormToNpcData(f: NpcEditForm, npcFields: NpcFieldNames): Record<string, unknown> {
  return {
    名称: f.名称,
    类型: f.类型,
    好感度: f.好感度,
    位置: f.位置,
    描述: f.描述,
    外貌描述: f.外貌描述,
    身材描写: f.身材描写,
    衣着风格: f.衣着风格,
    性别: f.性别,
    年龄: f.年龄,
    背景: f.背景,
    内心想法: f.内心想法,
    在做事项: f.在做事项,
    性格特征: f.性格特征,
    记忆: f.记忆,
    关注: f.关注,
    心跳锁定: f.心跳锁定,
    私密信息: f.私密信息,
    [npcFields.corePersonality]: f.核心性格特征,
    [npcFields.relationshipStatus]: f.关系状态,
    [npcFields.affinityBreakthrough]: f.好感度突破条件,
    [npcFields.relationshipBreakthrough]: f.关系突破条件,
    [npcFields.relationshipNetwork]: f.关系网变量,
    [npcFields.memorySummaries]: f.总结记忆,
  };
}

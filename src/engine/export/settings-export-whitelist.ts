/**
 * Settings export whitelist — Story 5 (U8 / U10).
 *
 * Plan: docs/plans/story-5-card-export-implementation.md (P1)
 * Location note: co-located with the export service (plan suggested src/constants/;
 * kept here in src/engine/export/ for cohesion with its only consumer).
 *
 * Game-card export MUST NOT reuse backup-service's collectLocalStorageSettings()
 * (backup-service.ts:1018), which grabs ALL "aga_" and "aga-" prefixed keys with ZERO
 * filtering and would leak secrets. Card export reads ONLY the whitelisted keys below.
 *
 * ── DENYLIST — NEVER export (security-critical; do NOT add to the whitelist) ──
 *   aga_api_management     — all provider API keys (engine-api.ts:28)
 *   aga_github_sync_token  — GitHub Personal Access Token (github-sync.ts)
 *   aga_github_sync_owner  — cloud-sync target repo owner
 *   aga_github_sync_repo   — cloud-sync target repo
 *   aga_assignment_presets — API-related; carried (key-free) via ApiTemplateExport instead
 *   aga_active_preset_id   — API-related; references a config id, not a card setting
 *   (APIConfig.apiKey / url / customRoutingPath are stripped at the type level in ApiTemplateExport.)
 *
 * Closed-set semantics: any aga_* key NOT in this list is dropped (fail-safe — under-export,
 * never leak). New aga_* keys must be reviewed before being added here (PR gate).
 * Key names verified against SettingsPanel.vue / APIPanel.vue (2026-05-28).
 */

/** Safe, useful-for-newcomers settings keys. No secrets. */
export const SETTINGS_EXPORT_WHITELIST: readonly string[] = [
  'aga_user_settings',           // 字体/主题/语言/动画/自动保存间隔 — SettingsPanel.vue:24
  'aga_action_options_settings', // 行动选项 模式/节奏/自定义提示 — :179
  'aga_memory_settings',         // 记忆阈值（短/中/长期） — :212（2026-09-04 起不再含 fewShotPairs / shortTermInjectionStyle；旧备份残留键无消费者）
  'aga_nsfw_settings',           // nsfwMode / 性别过滤（导入端 Story 6 与玩家偏好协调） — :289/301
  'aga_plot_settings',           // 剧情系统配置 — :468
  'aga_feature_toggles',         // 功能开关（文本优化/心跳/NPC生成/CoT 等） — :832
  'aga_cot_settings',            // 思维链配置 — :886
  'aga_body_polish_settings',    // 正文优化开关 — :887
  'aga_presence_settings',       // 在场系统开关 — :888
  'aga_image_gen_settings',      // 图像生成开关 — :889
  'aga_ui_scale',                // 界面缩放 — :665/684
  'aga_text_speed',              // 文字速度 — :666/698
  'aga_ai_settings',             // streaming/splitGen/重试（无密钥） — :652/970, APIPanel.vue:138
  'aga_engram_config',           // RAG/embedding 参数（无密钥） — :653
  'aga_text_replace_rules',      // 文本替换规则 — :520
  'aga_autosave_settings',       // 自动保存配置 — :658
  'aga_heartbeat_settings',      // 世界心跳配置 — :663
  'aga_assistant_settings',      // 助手行为配置（无密钥） — :664
  'aga_tts_settings',            // 配音偏好：音色/方言/语速/自动配音（无密钥；端点走 aga_api_management） — TtsSettingsSection.vue
  'aga_stt_settings',            // 语音输入偏好：开关/模式/延迟档/首次提示（无密钥；端点走 aga_api_management） — SttSettingsSection.vue
] as const;

/** Secret / API-bound keys that must NEVER appear in a card (asserted in tests). */
export const SETTINGS_EXPORT_DENYLIST: readonly string[] = [
  'aga_api_management',
  'aga_github_sync_token',
  'aga_github_sync_owner',
  'aga_github_sync_repo',
  'aga_assignment_presets',
  'aga_active_preset_id',
] as const;

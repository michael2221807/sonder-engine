> **Status:** ACTIVE 路 **Category:** Bug fix history 路 **Update policy:** append a new entry after every confirmed fix
>
> This is the single source of truth for "what has been fixed, when, and why".
> **Read this before starting any bug fix session** 鈥?it avoids re-deriving context
> that's already been established. Each entry includes flow, root cause, files touched,
> and before/after behavior. Entries are in reverse chronological order (newest first).

# Bug Fix Changelog 鈥?AutoGameAgent

Regression phase started: 2026-04-09

---

## [2026-08-20] Fix/Recovery: 韩素琴云插槽被结构性空壳覆盖 — 恢复 14 图健康档 + 存档槽一致性硬闸

**Flow:** GitHub v3 存档插槽自动/手动上传 → `BackupService.exportProfileForSync` → `GitHubSyncService.uploadSlot`；云端下载 → `downloadSlot` → `importProfileReplace`。

**事故边界（America/Toronto）：** `aga-cloud-save` 的 `profile_1784682846719` 在 `4035507`（2026-08-20 11:30 上传；包内实际游戏保存时间 02:40）仍为 48,659,472 字符、`state-0..3 + img-0`、1 存档 / 1 向量 / 14 图；`efa5174`（16:27）骤变为 1,001 字符、单个 508 B state、0 存档 / 0 向量 / 0 图，`8543a92`（17:27）再次上传同类空壳。三个版本的 chunk 与整包 SHA-256 均验证通过，证明不是 GitHub 分块损坏，而是客户端确实提交了结构完整但内容退化的包。

**Root cause:** 本地档案元数据仍声明 `auto` 槽存在（`saveSize=16,316,128`，`lastSavedAt=16:10:08Z` / 多伦多 12:10），但对应 IndexedDB 存档记录已不存在。`buildProfileBundle` 对 `loadGame() === undefined` 静默跳过，得到 `saves:{}`；随后图片完整性闸按空 saves 算出 `referencedAssets=0 / exportedAssets=0`，误把结构性空壳当成“合法无图档”并允许覆盖云端。下载该畸形包时，导入端也未验证 metadata slots 与 saves payload 一致，存在用空引用集合剪枝本地图的风险。云仓历史能证明存档记录在本地时间 12:10–16:27 间消失，但仅凭云端数据无法反推出本地是显式删除中断、全量恢复异常还是浏览器存储事件；本次修复封死所有来源的同一损坏形态。

**Recovery（已执行）：** 从最后健康提交 `4035507` 恢复且仅恢复韩素琴插槽；保留 global、其他档案及全部事故历史。生产云仓恢复提交 `ba1f3c6`，远端 HEAD 复核为 1 存档 / 14 图，五个分块与整包 checksum 全通过。恢复后的 manifest 时间戳与坏客户端基线不同，自动同步会先触发冲突保护，不会继续静默覆盖。

**Fix:** `BackupService.buildProfileBundle` 新增结构一致性硬闸：元数据声明的任一 slot 缺少真实 save 时抛 `ProfileSaveIntegrityError`，发生在图片统计和任何云端写入之前，`force` 也不能绕过；`importProfileReplace` 在快照、删除、写入和图片剪枝之前验证 metadata slots 与包内 saves 双向一致，畸形下载响亮失败且本地零修改。新增 3 个回归用例覆盖部分槽缺失导出、上传零 PUT/DELETE、畸形下载不改存档不删图片。

**Evidence:** 专项 66/66；持久化/同步/导出门禁 22 files / 515 tests；`npm run typecheck` 通过；远端 `ba1f3c6` 重新拉取并双层校验通过。

## [2026-05-25] Fix: NPC 共同记忆 (记忆) duplicate entries accumulating

**Flow:** Main Round AI commands → `push 社交.关系[名称=X].记忆` / NPC Private Chat → `appendNpcMemory`
**Root cause:** Two write paths pushed to NPC `记忆` arrays without any deduplication:
1. Main-round AI issued `push` commands to `社交.关系[名称=X].记忆` on every round with NPC interaction — same memory re-pushed across rounds
2. `NpcChatPipeline.appendNpcMemory()` pushed `memoryEntry` from private chat without checking for existing duplicates

Heartbeat was confirmed NOT involved (its prompt explicitly forbids writing to `记忆`).

**Fix:** Engine-level dedup on both write paths using Dice coefficient on character bigrams (threshold 0.65):
- `CommandExecutor` gains a `PushDedupGuard` callback (dependency injection). When pushing to a path ending with `.记忆`, the guard checks for exact or near-duplicate content before allowing the push.
- `appendNpcMemory()` checks `isDuplicateMemory()` before pushing.

No prompt changes — purely engine-level fix.

**Files changed:**
- `src/engine/utils/text-similarity.ts` — NEW: `extractBigrams`, `diceCoefficient`, `isNearDuplicate`
- `src/engine/social/memory-dedup.ts` — NEW: `isDuplicateMemory`, `buildMemoryPushDedupGuard`
- `src/engine/core/command-executor.ts` — added `PushDedupGuard` type + optional constructor param + guard in `push` case
- `src/engine/pipeline/sub-pipelines/npc-chat.ts:421-436` — dedup check in `appendNpcMemory`
- `src/main.ts` — wires guard into `CommandExecutor` construction

**Behavior before:** Same NPC memory entry (e.g. "为周淑兰诊断左膝中度骨性节炎") repeated 3+ times in the `记忆` array after multiple rounds of interaction.
**Behavior after:** Near-duplicate entries (Dice coefficient ≥ 0.65) are suppressed; only the first instance is kept. Distinct memories pass through normally.
**Notes:** Dice coefficient uses Set-based (not multiset) bigrams — pathological repetitive strings like "哈哈哈哈" vs "哈哈" score 1.0, but this is acceptable for 20-80 char narrative prose. 67 tests cover algorithm, integration, edge cases, and end-to-end scenarios.

---

## [2026-05-21] Fix: creation identity descriptions lost + schema restructure

**Flow:** Character Creation → buildInitialState → State Tree → UI Display
**Root cause:** `extractStoredValue` with `valueField: "name"` discarded preset `description`, only storing the name string. Identity fields (`角色.身份.出身`, `角色.基础信息.特质`, `角色.身份.天赋`) held bare strings with no description data.

**Schema change (BREAKING):**
- `角色.身份.出身`: `string` → `{名称: string, 描述: string}`
- `角色.基础信息.特质`: `string` → `{名称: string, 描述: string}`
- `角色.身份.天赋`: `string[]` → `[{名称: string, 描述: string}, ...]`
- Pack version: 0.2.0 → 0.4.0

**Files changed:**
- `public/packs/tianming/schemas/state-schema.json` — nested object schema
- `public/packs/tianming/creation-flow.json` — added `descriptionField` to origin/trait/talents steps
- `src/engine/types/game-pack.ts` — added `descriptionField` to `CreationStep` interface
- `src/engine/pipeline/types.ts` — removed parallel desc paths, updated JSDoc
- `src/engine/pipeline/sub-pipelines/character-init.ts` — `extractStoredValue` produces `{名称, 描述}` objects when `descriptionField` is set
- `src/engine/pipeline/sub-pipelines/enhanced-opening.ts` — `buildPlayerProfileString` reads nested objects
- `src/engine/stores/engine-state.ts` — `talents` getter returns object array
- `src/engine/behaviors/validation-repair.ts` — string→object coercion for identity fields + array item conversion
- `src/engine/persistence/migrations/backfill-identity-descriptions.ts` — migration 0→0.4.0 converts old saves + preset description lookup
- `src/main.ts` — registers migration with merged built-in + custom presets
- `src/ui/components/panels/CharacterDetailsPanel.vue` — reads nested objects, glass tooltip for talents
- `src/ui/components/layout/RightSidebar.vue` — talent tags read `.名称`, glass tooltip for `.描述`

**Behavior before:** Origin/trait/talent descriptions discarded during creation; only bare name strings stored; UI showed names without context.
**Behavior after:** Full `{名称, 描述}` objects stored; UI displays descriptions inline (origin/trait) and via glass hover tooltip (talents); old saves auto-migrated with preset description lookup; ValidationRepair safety net converts any remaining flat strings on load.

---

## [2026-05-21] Fix: CharacterDetailsPanel identity sections hidden by empty-state overlay

**Flow:** Character Details → Tab: 基础 → identity-tier section
**Root cause:** The `v-else` for "尚未加载游戏数据" empty-state (line 1877) was paired with `v-if="playerRegenPayload"` (RegenerateSameModal), NOT with `v-if="isLoaded"`. Since `playerRegenPayload` is normally null, the empty-state rendered permanently as a flex sibling. Combined with `.identity-tier` having `overflow: hidden` (which sets flex `min-height` to 0), the flex algorithm shrank the identity-tier, clipping 特质 and 天赋 sections.

**Files changed:**
- `src/ui/components/panels/CharacterDetailsPanel.vue` — moved `v-else` empty-state to immediately follow `</template v-if="isLoaded">`; added `flex-shrink: 0` to `.identity-tier`

**Behavior before:** Only 出身 section visible; 特质 and 天赋 clipped; "尚未加载游戏数据" always shown.
**Behavior after:** All three identity sections visible; empty-state only shows when game not loaded.

---

## [2026-05-21] Fix: RightSidebar horizontal scrollbar from talent tooltip

**Flow:** Right Sidebar → Talent section hover
**Root cause:** Talent tooltip used `position: absolute` with `min-width: 160px` inside the 240px sidebar. Since `.right-sidebar__content` has `overflow-y: auto` (implicitly sets `overflow-x: auto`), the tooltip extended beyond container bounds causing horizontal scrollbar.

**Files changed:**
- `src/ui/components/layout/RightSidebar.vue` — replaced inline absolute tooltip with Teleport-to-body approach (matching existing effect tooltip pattern); added `overflow-x: hidden` to sidebar content

**Behavior before:** Horizontal scrollbar on sidebar when talent section visible.
**Behavior after:** No horizontal scrollbar; tooltip floats outside sidebar via Teleport.

---

## [2026-05-21] Fix: 6 code quality issues in identity restructure

**Flow:** Multiple
**Issues fixed:**
1. `opening.md` prompt instructed AI to write trait as string (format mismatch with new `{名称, 描述}` schema)
2. `core.md` type annotation said `[string]` for talents (now `[{名称, 描述}]`)
3. `extractStoredValue` hardcoded Chinese field names `名称`/`描述` (engine/content separation violation) — added `outputNameKey`/`outputDescKey` to `CreationStep`
4. `ValidationRepair` string→object conversion used overly broad heuristic — now checks schema properties instead
5. `save-manager.ts` wrote migrated data to IDB without backup — now saves pre-migration backup
6. Migration used shallow copy `{ ...data }` — changed to `structuredClone(data)`

**Files changed:**
- `public/packs/tianming/prompts/opening.md`, `core.md` — format sync
- `src/engine/types/game-pack.ts` — added `outputNameKey`/`outputDescKey`
- `public/packs/tianming/creation-flow.json` — added output key config
- `src/engine/pipeline/sub-pipelines/character-init.ts` — computed property names
- `src/engine/behaviors/validation-repair.ts` — schema-driven conversion
- `src/engine/persistence/save-manager.ts` — pre-migration backup
- `src/engine/persistence/migrations/backfill-identity-descriptions.ts` — structuredClone

---

## [2026-05-21] Fix: Engram locations without marker characters misclassified as NPC

**Flow:** Engram entity classification → `inferEntityType()` → EntityBuilder / Tier 1 stub creation
**Root cause:** `inferEntityType()` uses a regex of Chinese location-marker characters (村镇城池山林洞窟街道广场酒馆教堂寺庙道观宫殿区域大陆) to detect locations. Names without these markers (e.g., 桃花源、落霞谷、碧水潭、望月楼) fall through to the default `return 'npc'`. Two trigger paths:
1. AI puts a location name in `midTermMemory.相关角色` → enters `structured_kv.role` → `inferType()` returns `'npc'`
2. KnowledgeFact edge endpoint names a location → Tier 1 stub creation calls `inferEntityType()` → returns `'npc'`

**Files changed:**
- `src/engine/memory/engram/entity-builder.ts:287-293` — `inferEntityType()` now accepts optional `knownLocations: ReadonlySet<string>` parameter; names in the set return `'location'` before regex fallback
- `src/engine/memory/engram/entity-builder.ts:133-142` — `EntityBuilder.build()` pre-scans all events' `structured_kv.location` and `event.location` fields to build the known locations set, passed to all `inferType()` calls
- `src/engine/memory/engram/engram-manager.ts:269-272` — Tier 1 stub creation derives `knownLocationNames` from already-built entities and passes to `inferEntityType()`
- `src/engine/memory/engram/entity-builder.test.ts` — 7 new tests covering knownLocations parameter, cross-round classification, and flat field matching

**Behavior before:** Location names without Chinese marker characters (桃花源, 落霞谷, etc.) classified as `type: 'npc'` in the knowledge graph.
**Behavior after:** Locations recognized via cross-referencing event location fields, regardless of whether name contains marker characters.
**Notes:** Regex-only detection is still the fallback for names that don't appear in any event's location field. A fully AI-driven classification approach could be a future enhancement but is out of scope.

---

## [2026-05-21] Fix: creating new character corrupts existing character's save data

**Flow:** Character Creation (Enhanced Opening path) → PostProcessStage.autoSave()
**Root cause:** Race condition between state tree ownership and Pinia store metadata during character creation.

When a user creates a new character (Character 2) while having an existing character (Character 1) loaded:
1. `CharacterInitPipeline.execute()` calls `stateManager.loadTree(initialState)` at step 1, overwriting the shared reactive proxy with Character 2's data.
2. Enhanced Opening Phase F runs `PostProcessStage.execute()` which calls `autoSave()`.
3. `autoSave()` calls `getActiveSlot()` which reads `activeProfileId`/`activeSlotId` from the Pinia store — still pointing to **Character 1** (because `markLoaded()` only runs after the pipeline completes).
4. `saveGame(profile_A, 'auto', character2_snapshot)` overwrites Character 1's save with Character 2's mid-pipeline data.

After the pipeline finishes, Character 2's final save is correctly written to `save_profile_B_auto`. But `save_profile_A_auto` now contains Character 2's incomplete data from step 4.

**Files changed:**
- `src/ui/views/CreationView.vue:~377` — added `engineState.clearGame()` before calling `characterInitPipeline.execute()`, so `getActiveSlot()` returns null and `autoSave()` no-ops during creation.

**Behavior before:** Creating Character 2 silently overwrites Character 1's IDB save with Character 2's mid-pipeline state. Loading Character 1 afterwards shows Character 2's corrupted data.
**Behavior after:** `clearGame()` nulls `activeProfileId`/`activeSlotId` before the pipeline starts. `autoSave()` sees no active slot and skips. Character 1's save remains untouched.

**Notes:** The non-enhanced-opening path (steps 3-5 direct AI calls) is not affected because it doesn't invoke `PostProcessStage`. However, `clearGame()` protects against any future code path that might trigger a save during creation.

---

## [2026-05-21] Fix: streaming display shows raw JSON instead of narrative text

**Flow:** Main round (single-call & splitGen) + Enhanced Opening Phase E
**Root cause:** Three separate issues in the streaming pipeline:
1. `AICallStage.executeSingleCall/executeSplitGen` passed `onStreamChunk` directly to the AI provider. The model outputs `{"text":"narrative...","mid_term_memory":...}` JSON, and raw chunks were accumulated verbatim — the UI displayed JSON structure, data fields, and all.
2. `CreationView.vue` always passed `onStreamChunk` to the enhanced opening pipeline regardless of the "流式叙事" toggle — Phase E step1 always streamed even when the user disabled streaming.
3. Phase C of enhanced opening injected full `私密信息` spec into the prompt, overloading the model. Moved to post-round privacy repair.
**Files changed:**
- `src/engine/pipeline/stages/ai-call.ts` — added `createJsonTextStreamUnwrapper` (char-level state machine) that detects `{"text":"` prefix, emits only the text value with JSON unescape (`\n`→newline), and stops at the closing `"`. Applied to both `executeSingleCall` and `executeSplitGen`.
- `src/ui/views/CreationView.vue:394` — `onStreamChunk` now conditional on `splitGenOpening.value`
- `src/engine/pipeline/sub-pipelines/enhanced-opening.ts` — `NSFW_SECTION` always empty; `delete npc['私密信息']` unconditional

**Behavior before:** Streaming display showed `{"text":"【narrative...】","mid_term_memory":{...},"commands":[...]}` raw JSON. Enhanced opening always streamed Phase E even with streaming disabled.
**Behavior after:** Streaming display shows clean narrative text only. JSON escapes decoded in real-time. Non-streaming toggle correctly prevents Phase E streaming. Privacy info deferred to repair pipeline.

---

## [2026-05-19] Feat: SillyTavern lorebook import support

**Flow:** World Book CRUD → Import
**Root cause:** N/A (feature addition)
**Files changed:**
- `src/engine/prompt/st-lorebook-converter.ts` — new file: auto-detects ST lorebook JSON format and maps entries to AGA WorldBookEntry model (key→keywords, constant→injectionMode, disable→enabled, order→priority)
- `src/engine/prompt/st-lorebook-converter.test.ts` — 25 unit tests covering all mapping logic and edge cases
- `src/ui/components/panels/WorldBookTab.vue` — enhanced `importBooks()` to auto-detect ST vs AGA format; no separate button needed
- `src/ui/i18n/locales/{en,zh-CN}/prompt.json` — added `importSTSuccess` i18n key, improved `importInvalidFormat` message

**Behavior before:** Import only accepted AGA's own export format (`{ books: [...] }`). ST lorebook files were rejected as "invalid format".
**Behavior after:** Import auto-detects ST lorebook format (`{ entries: { "0": {...}, ... } }`), converts entries to AGA model, and creates a new world book using the filename as title. Both formats work from the same import button.

---

## [2026-05-18] Fix: World book entries lost when switching tabs (DataCloneError)

**Flow:** World Book CRUD → Persistence
**Root cause:** Vue's `ref<WorldBook[]>` wraps objects in Reactive Proxy. IndexedDB's structured clone algorithm (used by `db.put()`) cannot serialize Proxy objects, throwing `DataCloneError: #<Object> could not be cloned`. All saves silently failed.
**Files changed:**
- `src/engine/prompt/world-book-storage.ts:50` — added `JSON.parse(JSON.stringify(book))` before `db.put()` to strip Vue reactive proxies

**Behavior before:** Creating world book entries appeared to work, but switching to another tab and back caused all entries to disappear. Console showed `DataCloneError`.
**Behavior after:** World book data persists correctly across tab switches and page reloads. The proxy-stripping is done at the storage layer so all callers are protected.

---

## [2026-05-18] Feat: Streaming body polish + accurate streaming toggle description

**Flow:** Main Round Pipeline → BodyPolish stage; API Settings panel
**Root cause:** N/A (feature addition, not bug fix)
**Files changed:**
- `src/engine/pipeline/stages/body-polish-stage.ts` — enable streaming when `ctx.onStreamChunk` exists; accumulate chunks, extract `<正文>` content progressively, emit `ai:polish-chunk` events; fallback paths restore original text to prevent stale UI
- `src/engine/types/event-bus.ts` — add `ai:polish-chunk` event type
- `src/ui/components/panels/MainGamePanel.vue` — listen for `ai:polish-chunk`, replace (not append) `streamingText` with polished content
- `src/ui/i18n/locales/zh-CN/api.json` — streaming toggle desc: "逐字流式返回叙事内容" → "逐字显示 AI 生成的叙事正文（仅影响主回合叙事和润色…）"
- `src/ui/i18n/locales/en/api.json` — same, English version

**Behavior before:** BodyPolish ran non-streaming; user saw no progress during polish. Streaming toggle description was misleading ("逐字流式返回叙事内容" implied all content streams).
**Behavior after:** BodyPolish streams progressively, replacing the step1 narrative with polished text in real-time. Streaming toggle accurately states scope (main round narrative + body polish only). Fallback safety: if polish fails or result < 30% of original length, UI reverts to original text.

---

## [2026-05-18] Fix: Prompt debug panel only kept 1 snapshot instead of full round

**Flow:** Prompt Assembly Debug (PromptAssemblyPanel)
**Root cause:** `MAX_SNAPSHOTS` in `engine-prompt.ts` was changed from 10 to 1, intended as "keep one round" but implemented as "keep one record". A round generates multiple snapshots (step1, step2, bodyPolish, fieldRepair, worldHeartbeat, etc.), so MAX_SNAPSHOTS=1 silently discarded all but the latest sub-step.
**Files changed:**
- `src/engine/stores/engine-prompt.ts` — replaced flat `MAX_SNAPSHOTS` ring buffer with round-aware retention: tracks `currentRound`, clears on new round, appends sub-pipeline snapshots (which lack `roundNumber`) to the current round

**Behavior before:** Panel showed only the single most recent snapshot; all other requests from the same round were lost
**Behavior after:** Panel shows all snapshots from the current round (step1 + step2 + bodyPolish + fieldRepair + worldHeartbeat + npcChat etc.); new round clears old snapshots automatically

---

## [2026-05-17] Fix: Glass token values accidentally modified + 3 UI bugs

**Flow:** Visual Effects Upgrade (Phase 4-14)
**Root cause:**
1. Colleague's Phase 1 changed `--glass-bg` from `rgba(255,255,255,0.04)` to `0.02` and `--glass-blur` from `blur(24px) saturate(1.4)` to `blur(18px) saturate(1.2)`, violating the upgrade plan's iron rule. Also added a `body::before` vignette darkening the entire viewport.
2. ImagePanel `.btn-secondary` lacked border/background/color definitions 鈥?"棰勪及璐圭敤" button was unstyled.
3. ImagePanel `.preset-card-badge` overlapped with settings-row content at top-right of cards.
4. GameComposer input textarea used `content-box` sizing, making it taller than the 42px send/rollback buttons.

**Files changed:**
- `src/ui/styles/tokens.css` 鈥?restored `--glass-bg` and `--glass-blur` to original values, removed `body::before` vignette
- `src/ui/components/panels/ImagePanel.vue` 鈥?added `.btn-secondary` styling, `.preset-card` padding-top, `.preset-card-badge` overflow protection
- `src/ui/components/panels/GameComposer.vue` 鈥?added `box-sizing: border-box` to `.message-input`

**Behavior before:** Modal panels too dark and indistinct from background; "棰勪及璐圭敤" button invisible; badge text overlapping slider; input taller than buttons
**Behavior after:** Modal brightness restored; button visible with proper border/bg; badge contained within card; input height matches buttons at single-line

---

## [2026-05-14] Fix: RightSidebar crash on null statusEffects entry

**Flow:** All game views 鈥?RightSidebar renders on every tab
**Root cause:** `engineState.statusEffects` array contained a `null` entry (AI emitted malformed data). The `normalizedEffects` computed iterated the array and accessed `e['鐘舵€佸悕绉?]` without null-checking, causing `TypeError: Cannot read properties of null`.
**Files changed:**
- `src/ui/components/layout/RightSidebar.vue:321` 鈥?added null guard `if (e == null || typeof e !== 'object') continue;`

**Behavior before:** Clicking any tab or loading any game view crashed with uncaught TypeError
**Behavior after:** Null entries silently skipped; sidebar renders normally

---

## [2026-05-13] Fix: State tree paths show raw Chinese in GameVariablePanel, StateTreeBrowser, and AI Assistant attachments

**Flow:** GameVariablePanel tree browsing, AI Assistant attachment picker, attachment chip labels
**Root cause:** State tree keys are Chinese structural contracts (`瑙掕壊.鍩虹淇℃伅.濮撳悕`). Three UI surfaces displayed these raw Chinese segments with no display-label mapping, making them unusable for English-mode users.
**Files changed:**
- `public/packs/tianming/i18n/zh-CN.json` 鈥?added 158 `pathLabel.*` keys (Chinese鈫扖hinese identity mapping)
- `public/packs/tianming/i18n/en.json` 鈥?added 158 `pathLabel.*` keys (Chinese鈫扙nglish display names)
- `src/ui/composables/useStateTreeNavigation.ts` 鈥?added `displayKey` to TreeNode, `displayBreadcrumb` computed, `translateSegment()` function, `getPathLabel()` export
- `src/ui/components/panels/GameVariablePanel.vue` 鈥?breadcrumbs and node labels use `displayKey`
- `src/ui/components/assistant/StateTreeBrowser.vue` 鈥?same treatment
- `src/ui/components/panels/AssistantPanel.vue` 鈥?attachment chip labels translate path segments
- `src/engine/services/assistant/attachment-builder.ts` 鈥?`buildLabel()` reads pathLabels from pack i18n
- `src/engine/services/assistant/assistant-service.ts` 鈥?passes locale to AttachmentBuilder
- `src/main.ts` 鈥?passes locale when constructing AssistantService

**Behavior before:** English mode user sees `瑙掕壊 / 鍩虹淇℃伅 / 濮撳悕` in variable browser and attachment chips
**Behavior after:** English mode user sees `Character / Basic Info / Name`; all underlying data paths remain Chinese for engine/AI/save compatibility
**Notes:** Display-only mapping 鈥?zero impact on AI payloads, save files, or command execution. 158 unique Chinese path segments mapped.

---

## [2026-05-13] Fix: RelationshipPanel NPC detail view shows Chinese in English mode

**Flow:** Relationships Panel 鈫?NPC Detail View
**Root cause:** Phase 3d i18n only partially covered RelationshipPanel. The NPC detail view (biography, appearance, field labels, action buttons, NSFW section, edit modal) still had ~109 hardcoded Chinese strings.
**Files changed:**
- `src/ui/components/panels/RelationshipPanel.vue` 鈥?extracted all Chinese to `$t()` calls; added `displayType()` and `displayBodyPartName()` helper mappings for C-flag enum display
- `src/ui/i18n/locales/zh-CN/relationship.json` 鈥?87 鈫?196 keys
- `src/ui/i18n/locales/en/relationship.json` 鈥?87 鈫?196 keys

**Behavior before:** NPC detail shows Chinese section headers (浜虹墿鐢熷钩/瀹归/鍏卞悓璁板繂), buttons (蹇冭烦閿佸畾/绉佽亰/AI缂栬緫), field labels (鐢熸棩/韬潗/琛ｇ潃), NSFW labels (棣欓椇绉樻。/鎬ф牸鍊惧悜/鎬т氦娆℃暟)
**Behavior after:** All UI text displays in locale-appropriate language; NPC type badges (閲嶇偣/鏅€? display translated labels via computed mapping
**Notes:** AI-generated content in state tree (personality traits, descriptions) is NOT translated 鈥?it displays whatever language the AI generated. Body part names (鍢?鑳搁儴/灏忕┐/灞佺┐) use a display mapping since they are C-flag engine-compared values.

---

## [2026-05-13] Fix: Language switch resets feature toggle settings to defaults

**Flow:** Settings 鈫?Language Switch 鈫?Page Reload
**Root cause:** `SettingsPanel.vue` onMounted sync (lines 750-758) wrote state-tree-derived settings (CoT, presence, bodyPolish, imageGen) to localStorage feature toggles BEFORE the game loaded 鈥?state tree was empty at that point, so defaults (all false) overwrote user's actual values.
**Files changed:**
- `src/ui/components/panels/SettingsPanel.vue` 鈥?wrapped sync block in `if (isLoaded.value)`, added same sync to the `isLoaded` watcher so it runs once when game actually loads

**Behavior before:** Switching language 鈫?reload 鈫?CoT/bodyPolish/imageGen/presence toggles reset to off
**Behavior after:** Settings survive locale switch; sync only happens after game save loads
**Notes:** Root cause is timing 鈥?onMounted runs before game save is loaded from IDB

---

## [2026-05-13] Fix: Image generation sends Chinese prompts to AI in English mode

**Flow:** Image Generation 鈫?Transformer Presets 鈫?AI Call
**Root cause:** `transformer-presets.ts` contained ~400 lines of hardcoded Chinese prompt instructions (9 presets 脳 3 backends). These bypassed the pack locale overlay system entirely 鈥?always Chinese regardless of locale setting. Additionally, state tree stored Chinese defaults that were never re-seeded on locale change.
**Files changed:**
- `src/engine/image/transformer-presets.ts` 鈥?converted static arrays to builder functions accepting pack data overlay
- `src/engine/types/game-pack.ts` 鈥?added `transformerDefaults` field
- `src/engine/core/pack-loader.ts` 鈥?loads `transformer-defaults.json` with locale overlay
- `src/engine/image/image-service.ts` 鈥?stores/propagates transformer defaults
- `src/main.ts` 鈥?wires pack defaults to image service
- `src/ui/components/panels/ImagePanel.vue` 鈥?always overlays built-in presets with locale data on mount
- `public/packs/tianming/prompts/transformer-defaults.json` 鈥?Chinese defaults (new)
- `public/packs/tianming/prompts-en/transformer-defaults.json` 鈥?English translations (new)

**Behavior before:** English mode 鈫?image generation 鈫?Chinese instructions sent to AI 鈫?poor/wrong image prompt output
**Behavior after:** English mode 鈫?locale-aware transformer defaults loaded 鈫?English instructions sent to AI
**Notes:** Built-in preset IDs are overlaid on every mount; user-created custom presets (different IDs) are preserved untouched

---

## [2026-05-13] Fix: Image resolution dropdown labels in Chinese

**Flow:** Image Generation 鈫?Scene Wallpaper 鈫?Resolution Dropdown
**Root cause:** `image-size-options.ts` had hardcoded Chinese descriptors in `createSizeOption()` calls 鈥?`妯睆/绔栧睆/瓒呴珮娓?妯睆楂樻竻/妯睆楂樼簿/鍥炬爣/绔栫洿/姘村钩`.
**Files changed:**
- `src/engine/image/image-size-options.ts` 鈥?replaced all Chinese descriptors with English equivalents (Landscape/Portrait/Ultra HD/etc.)

**Behavior before:** Resolution dropdown showed "1024x576 (16:9, 妯睆)" in English mode
**Behavior after:** Resolution dropdown shows "1024x576 (16:9, Landscape)"
**Notes:** These are engine-level constants, not vue-i18n keys 鈥?English labels work for both locales since they're technical terms

---

## [2026-05-13] Fix: ImagePanel artStyleMap hardcoded Chinese values flowing into AI prompts

**Flow:** Image Generation 鈫?Manual Generate 鈫?Art Style 鈫?AI Prompt
**Root cause:** `ImagePanel.vue` line 505 had `{ none: '鏃犺姹?, generic: '閫氱敤', anime: '浜屾鍏?, realistic: '鍐欏疄', chinese: '鍥介' }` 鈥?hardcoded Chinese values sent to the image generation AI in the `artStyle` field.
**Files changed:**
- `src/ui/components/panels/ImagePanel.vue` 鈥?replaced hardcoded values with `t('image.manual.artStyle.*')` calls

**Behavior before:** Art style "閫氱敤" sent to AI in English mode 鈫?AI confused by mixed-language instructions
**Behavior after:** Art style "Generic" sent to AI in English mode via i18n
**Notes:** The locale keys already existed in both zh-CN and en image.json files

---

## [2026-05-13] Fix: AgaSelect default placeholder shows Chinese "閫夋嫨..."

**Flow:** All dropdowns using AgaSelect component
**Root cause:** `AgaSelect.vue` line 34 had hardcoded fallback `'閫夋嫨...'` when no placeholder prop provided.
**Files changed:**
- `src/ui/components/shared/AgaSelect.vue` 鈥?replaced with `t('common.actions.select')`

**Behavior before:** Dropdown placeholder shows "閫夋嫨..." in English mode
**Behavior after:** Dropdown placeholder shows "Select" in English mode
**Notes:** Required adding `useI18n` import to the component

---

## [2026-05-11] Fix: 璁板繂绯荤粺閰嶇疆 Tab 姘歌繙鏄剧ず"鏆傛棤璁板繂閰嶇疆鏁版嵁"

**Flow:** 璁板繂绯荤粺闈㈡澘 鈫?閰嶇疆 Tab
**Root cause:** UI 浠?`绯荤粺.璁板繂閰嶇疆` 鐘舵€佹爲璺緞璇诲彇閰嶇疆锛屼絾鏁翠釜浠ｇ爜搴撲粠鏈悜璇ヨ矾寰勫啓鍏ヤ换浣曟暟鎹€傚疄闄呴厤缃瓨鍦ㄤ簬 `MemoryManager.getEffectiveConfig()`锛坙ocalStorage `aga_memory_settings` 瑕嗙洊 + 寮曟搸榛樿鍊硷級锛屼絾浠庢湭鍚屾鍒扮姸鎬佹爲銆?**Files changed:**
- `src/ui/components/panels/MemoryPanel.vue` 鈥?鏀逛负鐩存帴浠?localStorage + 榛樿鍊艰鍙栵紙涓?SettingsPanel 鍚屾簮锛夛紝鍔犳暟鍊兼牎楠?
**Behavior before:** 閰嶇疆 Tab 姘歌繙鏄剧ず "鏆傛棤璁板繂閰嶇疆鏁版嵁"
**Behavior after:** 閰嶇疆 Tab 灞曠ず璁板繂娴佺▼鍙鍖栧浘 + 6 椤瑰疄闄呮湁鏁堥厤缃€硷紙瀹归噺闄愬埗 + 鍗囩骇闃堝€间袱缁勶級锛屽簳閮ㄦ彁绀虹敤鎴峰幓璁剧疆闈㈡澘淇敼

---

## [2026-05-10] Fix: 涓昏鐢熷浘娴佺己灏戣嚜瀹氫箟鏋勫浘閫夐」

**Flow:** 涓昏鐢熷浘锛圕haracterDetailsPanel 涓昏鐢熷浘 Tab锛?**Root cause:** `compositionOptions` 鏁扮粍鍙湁 portrait/half-body/full-length 涓変釜閫夐」锛岀己灏?`custom`锛堣嚜瀹氫箟锛夐€夐」銆侼PC 鐢熷浘娴侊紙ImagePanel锛夊凡鏈夎閫夐」锛屼富瑙掍晶閬楁紡銆?**Files changed:**
- `src/ui/components/panels/CharacterDetailsPanel.vue` 鈥?娣诲姞 custom 閫夐」鍒?compositionOptions锛涙柊澧?playerCustomComposition ref 鍜?isPlayerCustomComposition computed锛涙ā鏉垮鍔犳瀯鍥炬弿杩版枃鏈緭鍏ワ紙v-if 鑷畾涔夋椂鏄剧ず锛夛紱鐢熸垚鍑芥暟浼犲叆 customComposition 鍙傛暟锛涘鍔犵┖鎻忚堪楠岃瘉锛涙洿鏂?PlayerRegenPayload 绫诲瀷鍜?badge 鏄剧ず

**Behavior before:** 涓昏鐢熷浘鍙兘閫?澶村儚/鍗婅韩/绔嬬粯"涓夌鏋勫浘锛屾病鏈夎嚜瀹氫箟閫夐」
**Behavior after:** 涓昏鐢熷浘澧炲姞"鑷畾涔?(鏋勫浘鎻忚堪)"閫夐」锛岄€夋嫨鍚庢樉绀烘枃鏈緭鍏ユ锛岃涓轰笌 NPC 鐢熷浘娴佷竴鑷?
---

## [2026-05-09] Feat: Low-load mode 鈥?sliding-window rate limiter for LLM API calls

**Flow:** 涓诲洖鍚堝叏閾捐矾锛圓IService.generate锛?**Purpose:** 閮ㄥ垎 API provider 瀵硅姹傞鐜囨湁纭檺鍒讹紝瀵嗛泦鍥炲悎鍙兘鍦ㄥ嚑绉掑唴鍙?5~15+ 娆¤姹傝Е鍙戞埅鏂€?浣庤礋鑽锋ā寮忓湪姣忓垎閽熺獥鍙ｅ唴闄愬埗鏈€澶?N 娆?LLM 璋冪敤锛堥粯璁?3锛夛紝瓒呴鎺掗槦绛夊緟銆?
**Files changed:**
- `src/engine/ai/rate-limiter.ts` (new) 鈥?RateLimiter 绫伙細婊戝姩绐楀彛銆侀槦鍒椼€乤bort銆乨rain timer 鍙彇娑?- `src/engine/ai/rate-limiter.test.ts` (new) 鈥?9 涓祴璇?- `src/engine/ai/ai-service.ts` 鈥?闆嗘垚 acquire() 鍒?doGenerate()锛堥噸璇曚篃闄愭祦锛? AbortError 妫€娴?- `src/main.ts` 鈥?鍚姩鍚屾 + eventBus 鐩戝惉
- `src/ui/components/panels/SettingsPanel.vue` 鈥?寮€鍏?+ 姣忓垎閽熻姹傛暟杈撳叆

**Notes:** Embedding/Rerank 涓嶅彈闄愩€傞厤缃瓨鍌ㄥ湪 aga_ai_settings localStorage銆?
---

## [2026-05-09] Fix: Prompt duplication 鈥?step2 COT 脳2, combine repair 脳3, edge review bloat

**Flow:** SplitGen Step2 / Combine Repair (field-repair) / Knowledge Edge Review
**Root cause:** Three independent prompt assembly bugs causing massive content duplication:

1. **Step2 COT 脳2:** `rawStep1` (containing `<thinking>` tags) was injected as assistant message
   alongside a separate system message already containing the extracted thinking content.
2. **Combine repair 脳2~3:** Same narrative stored in both `璁板繂.鐭湡` and `鍏冩暟鎹?鍙欎簨鍘嗗彶`,
   then read by three independent assembly points (system short-term memory, chatHistory
   messages, `<鏈洖鍚堝彊浜?` block) without dedup.
3. **Edge review bloat:** Similarity threshold 0.5 too loose + no per-fact cap on same-entity
   matches + no global cap at render time 鈫?149 comparison pairs (32K chars) for 9 facts.

**Files changed:**
- `src/engine/pipeline/stages/ai-call.ts:125-131` 鈥?strip thinking from rawStep1 when injected separately
- `src/engine/memory/memory-retriever.ts:29-35,108-118` 鈥?add `skipShortTerm` to RetrievalContext
- `src/engine/pipeline/sub-pipelines/field-repair.ts:255-291,674-691,790,842` 鈥?skip short-term memory and `<鏈洖鍚堝彊浜?` when chatHistory present
- `src/engine/memory/engram/engram-types.ts:95-100,298-300` 鈥?add configurable edgeReviewThreshold/PerFactCap/GlobalCap
- `src/engine/memory/engram/engram-config.ts:148-153` 鈥?normalize new config fields
- `src/engine/memory/engram/fact-builder.ts:35-50,127,152,157` 鈥?consume configurable threshold + per-fact cap
- `src/engine/memory/engram/engram-manager.ts:328-340` 鈥?pass config to buildFacts
- `src/engine/pipeline/sub-pipelines/field-repair.ts:393-432` 鈥?group by newFact, per-fact top-5, global cap 40

**Behavior before:** Step2 had thinking 脳2; combine repair system prompt 30% duplicate; 149 review pairs
**Behavior after:** Each content appears exactly once; review pairs capped at ~40 max
**Notes:** Edge review thresholds configurable via EngramConfig (edgeReviewThreshold default 0.65)

---

## [2026-05-09] Feat: Scene generation 鈥?round narrative + NPC selection

**Flow:** 鍥惧儚宸ヤ綔瀹?鈫?鍦烘櫙澹佺焊 鈫?鎵嬪姩鍦烘櫙鐢熸垚
**Root cause:** `ImagePanel.vue:generateScene()` 浣跨敤 `sceneExtraPrompt.value || '褰撳墠鍦烘櫙'` 浣滀负 `sceneDescription`锛屼粠鏈紶鍏ュ疄闄呭洖鍚堟鏂囥€傚悓鏃?`presentNpcs` 鑷姩浼犲叆鎵€鏈夊湪鍦鸿鑹插悕绉颁絾鏃犲璨?琛ｇ潃绛夎鎯咃紝鐢ㄦ埛鏃犳硶鎺у埗浼犲叆鍝簺瑙掕壊銆?
**Files changed:**
- `src/engine/image/scene-context.ts` 鈥?鏂板 `SceneNpcDetail` 鎺ュ彛鍜?`npcDetails` 瀛楁
- `src/engine/image/image-service.ts` 鈥?`generateSceneImage()` 澧炲姞 `npcDetails` 鍙傛暟
- `src/engine/image/tokenizer.ts` 鈥?`tokenizeScene()` task prompt 鏂板 `銆愬弬涓庤鑹茶祫鏂欍€慲 娈碉紙澶栬矊/韬潗/琛ｇ潃/鑳屾櫙锛夛紝瀛楁缁?`sanitizeEnvTokenForPrompt()` 闃叉敞鍏ュ鐞?- `src/ui/components/panels/ImagePanel.vue` 鈥?鏂板"姝ｆ枃鏉ユ簮"鍥炲悎澶氶€夊櫒锛堟渶杩?15 鍥炲悎锛岄粯璁ら€夋渶鏂帮級+ "鍙備笌瑙掕壊"NPC 閫夋嫨鍣紙鍦ㄥ満瑙掕壊浼樺厛鎺掑簭+棰勯€夛紝鍏ㄩ€?鍏ㄤ笉閫夛級锛沗generateScene()` 鏀逛负鐢ㄩ€変腑鍥炲悎姝ｆ枃 + 閫変腑 NPC 璇︽儏 + 杩囨护鍚庣殑 anchors

**Behavior before:** 鍦烘櫙杞崲鍣ㄤ粎鏀跺埌鍦扮偣銆佸ぉ姘斻€佽妭鏃ャ€佺幆澧冩爣绛惧拰 NPC 鍚嶇О锛屾棤鍥炲悎姝ｆ枃銆佹棤瑙掕壊澶栬矊璧勬枡锛岀敤鎴锋棤娉曢€夋嫨
**Behavior after:** 鐢ㄦ埛鍙閫夊洖鍚堟鏂?+ 澶氶€?NPC锛堝惈璇︽儏锛夛紝瀹屾暣涓婁笅鏂囦紶鍏ヨ浆鎹㈠櫒
**Notes:** 鑷姩鍦烘櫙鐢熸垚璺緞锛坄game-orchestrator.ts`锛夋湭鏀瑰姩锛屽凡姝ｇ‘浼犲叆 `ctx.parsedResponse.text`

---

## [2026-05-07] Fix: Non-selected images lost during save export/import

**Flow:** Settings 鈫?Backup 鈫?Export / Import
**Root cause:** `collectAssetIdsFromTree()` in `backup-service.ts` only collected image IDs from "selected" fields (`宸查€夊ご鍍忓浘鐗嘔D`, `宸查€夌珛缁樺浘鐗嘔D`, `宸查€夎儗鏅浘鐗嘔D`, `褰撳墠澹佺焊鍥崇墖ID`, `棣欓椇绉樻。.*.assetId`). It did NOT collect IDs from `鐢熷洺鍘嗗彶` arrays or `鏈€杩戠敓鍥崇粨鏋渀. As a result, any generated image that was in the archive but not currently selected was silently dropped during export and permanently lost after import.

**Files changed:**
- `src/engine/persistence/backup-service.ts:982-1038` 鈥?`collectAssetIdsFromTree()` now also collects: `鏈€杩戠敓鍥崇粨鏋渀 from each archive, every `id` in `鐢熷洺鍘嗗彶[]` for player/NPC archives, and `褰撳墠澹佺礄鍥崇墖ID` + `鏈€杩戠敓鍥崇粨鏋渀 + `鐢熷洺鍘嗗彶[].id` from scene archive

**Behavior before:** Exporting a save with e.g. 10 generated portraits but only 1 selected 鈫?backup contained only the 1 selected image 鈫?importing restored only 1 image, the other 9 were gone forever
**Behavior after:** All images referenced in any archive's history are included in the export and restored on import

---

## [2026-05-06] Fix: Image/chat/settings data leaking into AI prompt via GAME_STATE_JSON

**Flow:** Main round 鈫?ContextAssemblyStage 鈫?GAME_STATE_JSON template variable
**Root cause:** `PROMPT_ALWAYS_STRIP_PATHS` in `snapshot-sanitizer.ts` was missing several large state tree paths. The image subsystem (`绯荤粺.鎵╁睍.image` 鈥?config, presets, anchors, rulesets, task queue, scene archive), NPC image archives (`绀句氦.鍏崇郴.*.鍥剧墖妗ｆ`), private chat histories (`绀句氦.闁㈢郴.*.绉佽亰鍘嗗彶`), runtime settings (`绯荤当.瑷疆`, `绯荤当.actionOptions`), heartbeat logs (`涓栫晫.鐘舵厠.蹇冭烦`), and player image archive (`瑙掕壊.鍥崇墖妗ｆ`) were all being serialized into the AI prompt. This wasted tokens massively and could cause the AI to hallucinate based on internal configuration data.

**Files changed:**
- `src/engine/memory/snapshot-sanitizer.ts` 鈥?added 7 new paths to `PROMPT_ALWAYS_STRIP_PATHS`: `绯荤粺.鎵╁睍.image`, `绯荤粺.瑷疆`, `绯荤当.actionOptions`, `涓栫晫.鐘舵厠.蹇冭烦`, `瑙掕壊.鍥剧墖妗ｆ`, `绀句氦.闁㈢郴.*.鍥剧墖妗ｆ`, `绀句氦.闁㈢郴.*.绉佽亰姝村彶`, `鍏冩暟鎹?褰撳墠琛屽姩閫夐」`; updated JSDoc rationale (搂5-搂7)

**Behavior before:** Full image generation config, NPC chat logs, settings objects, and heartbeat history sent to AI every round 鈥?massive token waste + AI could reference internal IDs/config
**Behavior after:** All internal subsystem state stripped from GAME_STATE_JSON; AI only sees narrative-relevant world state

---

## [2026-05-06] Fix: NPC Private Chat 鈥?rollback support + Engram knowledge graph integration

**Flow:** NPC Private Chat 鈫?Engram + Rollback
**Root cause:** Design gap 鈥?NPC chat had no undo capability and no Engram integration. Chat-induced state changes (affection, NPC memories, relationship fields) were permanent and invisible to the knowledge graph.

**Files changed:**
- `src/engine/pipeline/sub-pipelines/npc-chat.ts` 鈥?added `engramManager?: IEngramManager` (9th param); captures full state tree snapshot before any writes in `chat()`; calls `processResponse()` after memory write; new `rollbackLastChat()` method with round-number safety guard; new `canRollbackChat` / `lastChatNpcName` getters
- `src/ui/components/shared/NpcChatModal.vue` 鈥?added "鎾ゅ洖" button (visible when `canRollbackChat`, disabled during send); calls `rollbackLastChat()` with toast feedback; resets `streamingText` and `errorMsg` on rollback
- `src/main.ts` 鈥?passes `engramManager` to NpcChatPipeline constructor

**Behavior before:** Chat state changes were permanent; Engram never learned about NPC chat interactions
**Behavior after:** Users can undo the last chat exchange (user message + AI reply + commands + memory entry + engram event) via "鎾ゅ洖" button; Engram receives events from chat text; rollback blocked if a main round advanced since snapshot (prevents data loss); snapshot strips `鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓 to avoid 2x memory bloat
**Notes:** Snapshot stored as class instance variable (not state tree) 鈥?does not survive page refresh, consistent with "only last chat undoable" semantics

---

## [2026-05-06] Fix: World Heartbeat not updating Engram knowledge graph

**Flow:** World Heartbeat 鈫?Engram knowledge graph
**Root cause:** Design gap 鈥?Engram was implemented after the heartbeat sub-pipeline. `processResponse()` was only called from `PostProcessStage` (main round), so heartbeat NPC state changes (location, thoughts, activities, affection) were invisible to the knowledge graph.

Additionally, `EngramManager.processResponse()` had no concurrency guard 鈥?concurrent calls (main round + heartbeat in the same tick) could race on the shared `_vectorizeAbort` AbortController, causing the main round's embedding flight to be silently aborted.

**Files changed:**
- `src/engine/memory/engram/engram-manager.ts` 鈥?added `_processMutex` (promise-chain serialization) to prevent concurrent read-modify-write races on Engram state
- `src/engine/pipeline/sub-pipelines/world-heartbeat.ts` 鈥?added `engramManager?: IEngramManager` constructor param; after command execution, synthesizes a text summary from `StateChange[]` and calls `processResponse()` in an independent try-catch
- `src/main.ts` 鈥?passes `engramManager` to `WorldHeartbeatPipeline` constructor

**Behavior before:** Heartbeat commands updated NPC state tree fields but Engram never learned about these changes 鈥?entity information went stale between main rounds
**Behavior after:** Heartbeat state changes produce an Engram event with synthesized text (e.g., "[涓栫晫蹇冭烦] 鏋楁湀鍎裤€佸紶涓?鐨勭姸鎬佸彂鐢熷彉鍖栵細鎯虫硶: 瀵逛富瑙掑厖婊″ソ濂?); entities are rebuilt from the updated relationships table; processResponse calls are serialized via mutex
**Notes:** NPC private chat Engram integration deferred 鈥?requires rollback mechanism first (tracked in buglist)

---

## [2026-05-06] Fix: Internal subsystem state leaking into AI prompt via GAME_STATE_JSON

**Flow:** Main round / split-gen 鈫?ContextAssemblyStage 鈫?`{{GAME_STATE_JSON}}`
**Root cause:** `PROMPT_ALWAYS_STRIP_PATHS` in `snapshot-sanitizer.ts` only had 10 entries. Nine additional state tree subtrees were being serialized into every AI prompt 鈥?image subsystem config/presets/task queue, NPC image archives, private chat histories, runtime settings, heartbeat logs, semantic memory triples, and UI restore state. Combined token waste could exceed thousands of tokens per round.

**Files changed:**
- `src/engine/memory/snapshot-sanitizer.ts` 鈥?added 9 paths to `PROMPT_ALWAYS_STRIP_PATHS` (now 19 total): `绯荤粺.鎵╁睍.image`, `绯荤粺.鎵╁睍.璇箟璁板繂`, `绯荤粺.璁剧疆`, `绯荤粺.actionOptions`, `涓栫晫.鐘舵€?蹇冭烦`, `瑙掕壊.鍥剧墖妗ｆ`, `绀句氦.鍏崇郴.*.鍥剧墖妗ｆ`, `绀句氦.闁㈢郴.*.绉佽亰鍘嗗彶`, `鍏冩暟鎹?褰撳墠琛屽姩閫夐」`; updated JSDoc with rationale for each (搂5鈥撀?); fixed misleading comment about array element stripping behavior

**Behavior before:** Image presets, generation task queue, NPC chat logs, runtime settings, heartbeat execution history, and semantic triples all sent to AI every round
**Behavior after:** Only narrative-relevant world state reaches the AI; internal subsystem state fully stripped
**Notes:** `鍏冩暟鎹?濂充富瑙勫垝` intentionally NOT stripped 鈥?legacy flow depends on it in GAME_STATE_JSON. Will strip after legacy path is removed.

---

## [2026-05-06] Fix: Image generation tasks stuck in 'generating' status

**Flow:** Image generation 鈥?all backends (NovelAI, OpenAI, SD-WebUI, ComfyUI, Civitai)
**Root cause:** Five compounding issues in the image generation pipeline:

1. **No fetch timeout** 鈥?NovelAI, OpenAI, SD-WebUI `generate()` calls had no `AbortSignal.timeout()`. If the server hung or network dropped silently, `await fetch()` would never resolve, leaving the task permanently stuck at 'generating' with no error surfaced.
2. **Stale tasks after reload** 鈥?`ImageTaskQueue` persisted tasks with 'generating'/'tokenizing' status to state tree. After page refresh, `restoreTasksFromState()` loaded them back but no generation process was running 鈫?permanently stuck.
3. **No global error notification** 鈥?Task failure only wrote to ImagePanel's local `errorMsg` ref. If the panel was unmounted (user navigated away), the error was written to an orphaned ref 鈫?no toast, no feedback.
4. **Civitai no polling** 鈥?Civitai's async generation could return `available=false` when the image wasn't ready yet. The provider threw immediately instead of polling until available.
5. **Generation lock never released** 鈥?`generatingSet` (in-memory Set) locked an NPC key when generation started, released in `finally`. But if fetch hung, `finally` never ran 鈫?NPC locked for the entire session.

**Files changed:**
- `src/engine/image/providers/base.ts` 鈥?added shared `IMAGE_GENERATE_TIMEOUT_MS` (180s) and `IMAGE_DOWNLOAD_TIMEOUT_MS` (60s) constants
- `src/engine/image/providers/novelai.ts` 鈥?added `AbortSignal.timeout` to generate fetch
- `src/engine/image/providers/openai.ts` 鈥?added timeout to generate fetch + URL image download
- `src/engine/image/providers/sd-webui.ts` 鈥?added timeout to generate fetch
- `src/engine/image/providers/civitai.ts` 鈥?added timeout to blob download + `pollUntilAvailable()` method for async jobs (60 attempts 脳 3s = 180s max)
- `src/engine/image/image-service.ts` 鈥?added `recoverStuckTasks()` on restore (resets generating/tokenizing/pending 鈫?failed) + global toast listener for task completion/failure
- `src/engine/image/image-state-manager.ts` 鈥?replaced `generatingSet` (Set) with `generatingMap` (Map<string, timestamp>) with 5-minute auto-expiry

**Behavior before:** Generation could hang silently; stuck tasks persisted across reloads; no feedback when panel unmounted; Civitai async jobs failed immediately; NPC lock never released on hang
**Behavior after:** All fetches timeout at 180s; stuck tasks auto-recovered on reload with warning toast; global toast on every task failure/completion; Civitai polls up to 180s; generation lock auto-expires after 5min

---

## [2026-05-05] Fix: Settings persistence lost after import/export or page reload

**Flow:** Settings persistence 鈥?COT, Body Polish, Presence Partition, Image Generation toggles
**Root cause:** Four settings wrote to the in-memory state tree via `setValue()` but lacked two critical persistence layers:

1. **No `engine:request-save`** 鈥?changes stayed in memory only; IDB save depended on the next manual save or round auto-save
2. **No localStorage backup** 鈥?unlike NSFW/heartbeat/actionOptions which had `aga_*` localStorage keys and restoration in `syncAllSettingsFromLocalStorage()`, these four settings had neither

Additionally, `exportFullBackup()` read saves from IDB without first flushing the current in-memory state tree, so any unsaved setting changes were excluded from exports.

**Files changed:**
- `src/ui/components/panels/SettingsPanel.vue` 鈥?added localStorage persistence (`aga_cot_settings`, `aga_body_polish_settings`, `aga_presence_settings`, `aga_image_gen_settings`) + `engine:request-save` to all four toggle functions + sync to localStorage on mount
- `src/engine/stores/engine-state.ts` 鈥?added restoration of COT/bodyPolish/presence/imageGen from localStorage in `syncAllSettingsFromLocalStorage()`
- `src/ui/components/panels/SavePanel.vue` 鈥?added state tree flush to IDB before `exportAll()` and `exportProfile()` calls
- `src/ui/views/ManagementView.vue` 鈥?added state tree flush to IDB before `exportAll()`

**Behavior before:** Toggling COT/Body Polish/Presence/Image Gen 鈫?page reload or export/import 鈫?all four settings reset to `false`
**Behavior after:** Settings are immediately persisted to both IDB (via `engine:request-save`) and localStorage (via `aga_*` keys); restored from localStorage on game load; exports always contain the latest state
**Notes:** `imageGen` already had `engine:request-save` but lacked localStorage persistence. All four now follow the same dual-persistence pattern as heartbeat/NSFW/actionOptions.

---

## [2026-05-05] Known: ImageDisplay concurrent loadAsset race (pre-existing)

**Flow:** Image display 鈥?rapid assetId changes
**Root cause:** Two concurrent `loadAsset()` calls can resolve out of order, overwriting `objectUrl` with the wrong blob. No cancellation token.
**Status:** KNOWN, not yet fixed. Identified during Phase 5 mobile review but confirmed as pre-existing (same behavior before IntersectionObserver refactor).
**Severity:** Low 鈥?requires very rapid assetId changes within one IndexedDB round-trip (~5-20ms).
**Fix pattern:** Increment a counter on each `loadAsset` call; only apply result if counter matches.
**Files:** `src/ui/components/image/ImageDisplay.vue`

## [2026-05-05] Known: Modal body scroll lock not ref-counted (pre-existing)

**Flow:** Nested modals
**Root cause:** `lockBodyScroll()`/`unlockBodyScroll()` in Modal.vue set/clear `document.body.style.overflow` without counting nested modal depth. Closing an inner modal unlocks body scroll while outer modal is still open.
**Status:** KNOWN, not yet fixed. Identified during Phase 1 mobile review.
**Severity:** Low 鈥?nested modals are rare in normal gameplay.
**Fix pattern:** Ref-count `overflow: hidden` applications; only clear on count reaching 0.
**Files:** `src/ui/components/common/Modal.vue`

---

## [2026-05-04] Fix: 鍚屽悕鐘舵€佹晥鏋滈噸澶嶆樉绀轰笌鎸佷箙鍖?
**Flow:** 涓诲洖鍚?AI 鐢熸垚 鈫?鐘舵€佹晥鏋?push 鈫?UI 鏄剧ず
**Root cause:** `command-executor.ts` 鐨?`push` action 浠呭仛瀹归噺闄愬埗锛圡AX_ARRAY_CAPACITY=200锛夛紝娌℃湁鎸夛拷锟斤拷绉板幓閲嶃€侫I 妯″瀷鏈夋椂 push 涓庡凡鏈夋晥鏋滃悓鍚嶇殑鏂版潯鐩紝瀵艰嚧 `瑙掕壊.鏁堟灉` 鏁扮粍锟斤拷鍑虹幇澶氫釜 `鐘舵€佸悕绉癭 鐩稿悓鐨?buff/debuff銆俇I 鐨?`normalizedEffects` 鐩存帴 map 鏁扮粍涔熸病杩囨护銆?**Files changed:**
- `src/engine/behaviors/effect-lifecycle.ts` 鈥?鏂板 `deduplicateEffects()` 鏂规硶锛屽湪 `onRoundEnd` 鍜?`onGameLoad` 鏃舵寜 `nameField` 鍘婚噸锛堜繚鐣欐渶鍚庡嚭鐜扮殑锛屽嵆鏈€鏂扮増鏈級
- `src/ui/components/layout/RightSidebar.vue:305` 鈥?`normalizedEffects` computed 鏀逛负 Map-based 鍘婚噸锛坙ast wins锛?
**Behavior before:** AI 鍙兘鎺ㄥ叆澶氫釜鍚屽悕鏁堟灉锛堝涓や釜"涓瘨"锛夛紝UI 鍏拷锟芥樉绀猴紝鎸佷箙鍖栧埌瀛樻。
**Behavior after:** 寮曟搸灞傛瘡杞粨鏉?+ 璇绘。鏃惰嚜鍔ㄥ幓閲嶏紙鍚屽悕淇濈暀鏈€鏂帮級锛孶I 灞傚厹搴曞幓閲嶇‘淇濇樉绀烘棤閲嶅
**Notes:** 鍘婚噸鍙戠敓鍦?effect-lifecycle 妯″潡鑰岄潪 command-executor锛屽洜涓?command-executor 鏄€氱敤寮曟搸灞傦紝涓嶇煡閬撳摢浜涙暟缁勯渶瑕?name-based 鍘婚噸銆侲ffectLifecycleConfig 宸叉湁 `nameField` 鍙鐢ㄣ€?
---

## [2026-05-03] Fix: 瀛愮绾?AI 璋冪敤澶辫触鍚?UI 鍗″湪"鐢熸垚涓?鏃犳硶鎭㈠

**Flow:** 瀛愮绾匡紙fieldRepair / privacyRepair / heartbeat 绛夛級
**Root cause:** 瀛愮绾跨殑 AI 璋冪敤瑙﹀彂閲嶈瘯鏃讹紝AIService 鍙戝皠 `ai:retrying` 鈫?MainGamePanel 鍜?TopBar 鐩戝惉鍚庢妸 `isGenerating` 璁惧洖 `true`銆備絾瀛愮绾挎渶缁堝け璐ユ椂锛岄敊璇粎琚?orchestrator 鐨?catch 鍚冩帀锛坈onsole.error锛夛紝涓嶅彂灏勪换浣?UI 浜嬩欢銆傛鏃?`isGenerating` 姘歌繙鍋滃湪 `true`锛岃緭鍏ユ绂佺敤锛屽彇娑堟寜閽棤鏁堬紝鐢ㄦ埛蹇呴』鍒锋柊椤甸潰銆?**Files changed:**
- `src/engine/types/event-bus.ts` 鈥?鏂板 `engine:sub-pipelines-done` 浜嬩欢绫诲瀷
- `src/engine/core/game-orchestrator.ts:428` 鈥?瀛愮绾?finally 鍧楀彂灏?`engine:sub-pipelines-done`
- `src/ui/components/panels/MainGamePanel.vue:663` 鈥?鐩戝惉 `engine:sub-pipelines-done` 閲嶇疆 `isGenerating`
- `src/ui/components/layout/TopBar.vue:205` 鈥?鍚屼笂

**Behavior before:** 瀛愮绾?AI 閲嶈瘯澶辫触 鈫?UI 姘镐箙鍗″湪"鐢熸垚涓?锛屾棤娉曟搷浣溿€?**Behavior after:** 瀛愮绾挎墽琛屽畬姣曪紙鏃犺鎴愯触锛夆啋 `engine:sub-pipelines-done` 瑙﹀彂 鈫?`isGenerating = false`锛孶I 鎭㈠浜や簰銆?
---

## [2026-05-03] Fix: FieldRepairPipeline 缂哄け engram 涓婁笅鏂?+ 褰撳墠鍥炲悎鍙欎簨鏈爣娉?
**Flow:** combinedRepair / fieldRepair锛坧ost-round step 3锛?**Root cause:** 涓や釜闂锛?1. 瀹炰綋鎻忚堪琛ュ叏鍜岀煡璇嗚竟瀹℃煡浠诲姟娌℃湁娉ㄥ叆 engram 涓婁笅鏂団€斺€擜I 鏃犳硶鐪嬪埌寰呰ˉ鍏ㄥ疄浣撶殑鐩稿叧鐭ヨ瘑杈广€佽瀹℃煡杈规秹鍙婄殑瀹炰綋鎻忚堪锛屽鑷寸敓鎴愮殑鎻忚堪/鍒ゆ柇缂轰箯鍥捐氨淇℃伅鏀拺銆?2. 褰撳墠鍥炲悎鍙欎簨浠呭湪 chatHistory 涓贩鏉備簬鏃у洖鍚堝巻鍙诧紝鏈鏄惧紡鏍囨敞涓?鏈洖鍚堝垰鍙戠敓鐨勫唴瀹?鈥斺€擜I 闅句互鍒ゆ柇鍝簺涓婁笅鏂囨槸瑙﹀彂淇鐨勬渶鏂板彊浜嬨€?**Files changed:**
- `src/engine/pipeline/sub-pipelines/field-repair.ts`:
  - `runCombinedStep()`: 娉ㄥ叆 `<鏈洖鍚堝彊浜?` 鍧楋紙extractCurrentRoundNarrative锛夛紱瀹炰綋琛ュ叏鍧楄拷鍔犵浉鍏崇煡璇嗚竟锛坆uildEnrichmentEdgeContext锛夛紱杈瑰鏌ュ潡杩藉姞瀹炰綋鎻忚堪锛坆uildReviewEntityContext锛?  - `runFieldRepairOnly()`: 鍚屾牱娉ㄥ叆 `<鏈洖鍚堝彊浜?` 鍧?  - 鏂板 3 涓?helper锛歚extractCurrentRoundNarrative()`銆乣buildEnrichmentEdgeContext()`銆乣buildReviewEntityContext()`

**Behavior before:** AI 鍦ㄥ瓧娈佃ˉ榻?瀹炰綋琛ュ叏/杈瑰鏌ユ椂鐪嬩笉鍒?engram 鍥捐氨涓婁笅鏂囷紝褰撳墠鍥炲悎鍙欎簨鍩嬪湪 chatHistory 閲屼笉鏄剧溂銆?**Behavior after:** 姣忔 combined step 寮€澶存樉寮忔敞鍏?`<鏈洖鍚堝彊浜?` 鏍囨敞褰撳墠涓婁笅鏂囷紱瀹炰綋琛ュ叏浠诲姟闄勫姞鐩稿叧鐭ヨ瘑杈癸紙鏈€澶?30 鏉★級锛涜竟瀹℃煡浠诲姟闄勫姞娑夊強瀹炰綋鐨勫綋鍓嶆弿杩般€?
---

## [2026-05-03] Fix: FieldRepairPipeline GAME_STATE_JSON 鏈劚鏁忓鑷?token 鐖嗙偢

**Flow:** combinedRepair / fieldRepair锛坧ost-round step 3锛?**Root cause:** `buildGameStateJson()` 鐩存帴鐢?`JSON.stringify(this.stateManager.getTree(), null, 2)` 搴忓垪鍖栧畬鏁寸姸鎬佹爲锛屾湭璋冪敤 `stringifySnapshotForPrompt()`銆傚鑷翠互涓嬪ぇ鍧楁暟鎹叏閲忔敞鍏?prompt锛?- `鍏冩暟鎹?鍙欎簨鍘嗗彶`锛? 鍥炲悎鍙欎簨 脳 瀹屾暣 JSON锛?- `鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓锛堜笂涓€鍥炲悎瀹屾暣鐘舵€佹爲鍏嬮殕锛?- `璁板繂.鐭湡/涓湡/闀挎湡/闅愬紡涓湡`锛堝叏閮ㄨ蹇嗗眰锛?- `绯荤粺.鎵╁睍.engramMemory`锛坋vents/entities/edges 鍏ㄩ噺锛?鍔犱笂 chatHistory 涔熸敞鍏ュ彊浜嬪巻鍙诧紝浠ュ強 indent=2 鑶ㄨ儉 JSON锛屾渶缁堜竴涓墽鎯呭彞瀛愰噸澶?8 娆★紝NPC 瀛楁閲嶅 24 娆°€?**Files changed:**
- `src/engine/pipeline/sub-pipelines/field-repair.ts` 鈥?`buildGameStateJson()` 鏀圭敤 `stringifySnapshotForPrompt(toSnapshot(), nsfwMode, 0)`锛涙柊澧?import

**Behavior before:** 8 鍥炲悎娓告垙鐨?fieldRepair prompt 鍖呭惈瀹屾暣鏈鍓姸鎬佹爲锛堝惈鍙欎簨鍘嗗彶 脳 2銆佽蹇?脳 4 灞傘€乪ngram 鍏ㄩ噺锛夛紝token 鐖嗙偢銆?**Behavior after:** 涓庝富鍥炲悎绠＄嚎涓€鑷达紝鍓ョ鍙欎簨鍘嗗彶銆佽蹇嗐€乪ngram銆佸揩鐓х瓑璺緞锛宨ndent=0 绱у噾杈撳嚭銆傞浼?token 闄嶄綆 60-70%銆?
---

## [2026-05-03] Fix: 瀛楁琛ラ綈/瀹炰綋鎻忚堪琛ュ叏/鐭ヨ瘑杈瑰鏌ュ悎骞朵负鍗曟 AI 璇锋眰

**Flow:** FieldRepairPipeline (post-round step 3)
**Root cause:** 涓変釜鏉′欢鎬т换鍔★紙瀛楁琛ラ綈銆佸疄浣撴弿杩拌ˉ鍏ㄣ€佺煡璇嗚竟瀹℃煡锛夊悇鑷嫭绔嬪彂璧?AI 璇锋眰锛岃繚鍙嶅師濮嬭璁♀€斺€斿簲鍦?step 3 妫€娴嬮渶瑕佹墽琛屽摢浜涗换鍔″悗鍚堝苟涓轰竴娆¤姹傘€?**Files changed:**
- `src/engine/pipeline/sub-pipelines/field-repair.ts` 鈥?閲嶆瀯 execute()锛氬厛妫€娴嬩笁椤逛换鍔★紝鍚堝苟娉ㄥ叆鍚屼竴 user prompt锛屽崟娆?AI 璋冪敤銆傛棫鏂规硶 runEntityEnrichment/runEdgeReview/parseEdgeUpdates/parseEntityDescriptions 鍒犻櫎锛屾媶鍒嗕负 detect + apply + parseCombined銆傚瓧娈佃ˉ榻愰噸璇曚粛淇濈暀鐙珛閲嶈瘯璺緞銆?- `src/engine/memory/engram/entity-builder.ts:50` 鈥?鏇存柊杩囨椂娉ㄩ噴
- `src/engine/memory/engram/engram-types.ts:220` 鈥?鏇存柊杩囨椂娉ㄩ噴

**Behavior before:** 瀛楁琛ラ綈銆佸疄浣撴弿杩拌ˉ鍏ㄣ€佺煡璇嗚竟瀹℃煡鍒嗗埆鍙戣捣 1-3 娆＄嫭绔?AI 璇锋眰锛堟渶澶?3 娆★級锛屾氮璐?token 涓斾笂涓嬫枃閲嶅鏋勫缓銆?**Behavior after:** 妫€娴嬪埌浠讳竴浠诲姟闇€瑕佹墽琛屾椂锛屽皢鎵€鏈夋椿璺冧换鍔＄殑 prompt 鍧楁潯浠舵敞鍏ュ悓涓€璇锋眰锛屽崟娆¤皟鐢ㄨ繑鍥炲悎骞?JSON銆傚瓧娈佃ˉ榻愯嫢浠嶄笉瀹屾暣鍒欑嫭绔嬮噸璇曪紙涓嶅啀閲嶅 enrichment/review锛夈€?**Notes:** 鍚堝苟鍚庣殑 JSON 鏍煎紡 `{commands, entity_descriptions, edge_updates}`锛孉I 鎸夐渶杈撳嚭瀵瑰簲瀛楁銆?
---

## [2026-04-29] Fix: SettingsPanel 鍐呭杩囨护鏂囨涔辩爜

**Flow:** 璁剧疆闈㈡澘 鈥?鍐呭杩囨护 / NSFW 璁剧疆鍖?
**Root cause:** `SettingsPanel.vue` 涓儴鍒嗕腑鏂囨枃妗堟浘琚敊璇紪鐮侊紝婧愮爜閲岀暀涓?Unicode replacement character `锟絗锛屽鑷存祻瑙堝櫒鐩存帴鏄剧ず涔辩爜銆?
**Files changed:**
- `src/ui/components/panels/SettingsPanel.vue` 鈥?`锟斤拷瀹硅繃婊 鏀逛负 `鍐呭杩囨护`锛沗NPC 绉侊拷锟戒俊鎭痐 鏀逛负 `NPC 绉佸瘑淇℃伅`銆?
**Behavior before:** 鐢ㄦ埛鎵撳紑璁剧疆闈㈡澘鏃讹紝绗竴缁勬爣棰樻樉绀轰负 `锟斤拷瀹硅繃婊锛孨SFW 璇存槑鏂囨鍙兘鏄剧ず `NPC 绉侊拷锟戒俊鎭痐銆?
**Behavior after:** 璁剧疆闈㈡澘鍐呭杩囨护鍖烘爣棰樺拰璇存槑鏂囨鏄剧ず涓烘甯镐腑鏂囥€?
**Notes:** 鍙敼闈欐€佹枃妗堬紝涓嶅奖鍝嶈缃紑鍏炽€乴ocalStorage銆佺姸鎬佹爲鍚屾鎴?prompt 寮€鍏抽€昏緫銆傚凡鐢?`rg -n "锟? src/ui/components/panels/SettingsPanel.vue` 纭璇ユ枃浠舵棤鍓╀綑鏇夸唬绗﹀彿銆?
---

## [2026-04-29] Fix: 绀句氦鍏崇郴璇︽儏鎸夐挳绐勫搴︽í鍚戞孩鍑?
**Flow:** 绀句氦鍏崇郴闈㈡澘 鈥?NPC 璇︽儏椤?hero 鎿嶄綔鍖哄搷搴斿紡甯冨眬

**Root cause:** `RelationshipPanel.vue` 鐨勮鎯?hero 鎿嶄綔鎸夐挳缁?`.rd-hero-actions` 鏄崟琛?flex锛屾寜閽張璁剧疆浜?`white-space: nowrap`銆傚綋宸﹀彸娴姩渚ф爮鍘嬬缉涓棿绌洪棿鏃讹紝鎸夐挳缁勪互鍐呭瀹藉害鎾戝紑璇︽儏 pane锛岃繘鑰岃椤甸潰鍑虹幇 horizontal scroll銆?
**Files changed:**
- `src/ui/components/panels/RelationshipPanel.vue` 鈥?涓哄叧绯婚潰鏉?璇︽儏 pane/璇︽儏 grid 澧炲姞 `min-width: 0` 鏀剁缉杈圭晫锛涜鎯?pane 绂佹妯悜婊氬姩锛涙寜閽粍鍏佽 `flex-wrap`; 鎸夐挳鍜?chip 闄愬埗鏈€澶у搴﹀苟鐪佺暐婧㈠嚭锛涚獎瀹瑰櫒涓?hero 閫氳繃 container query 鎹㈣锛屾妸 affinity block 涓嬫矇銆?
**Behavior before:** 绐勬í鍚戠┖闂翠笅锛孨PC 璇︽儏椤堕儴涓€鎺掓寜閽悜鍙虫孩鍑猴紝鏁翠釜椤甸潰鍙互琚í鍚戞粴鍔ㄣ€?
**Behavior after:** 鎿嶄綔鎸夐挳鍦ㄨ鎯?pane 鍐呰嚜鍔ㄦ崲琛岋紝鍐呭鍖哄煙涓嶅啀鎶婇〉闈㈡拺鍑烘í鍚戞粴鍔紱鏋佺獎璇︽儏瀹藉害涓嬪ソ鎰熷尯涓嬫矇鍒颁笅涓€琛屻€?
**Notes:** 鏈鍙敼 scoped CSS銆俙npm run typecheck` 浠嶅け璐ワ紝浣嗗け璐ユ潵鑷棦鏈?TS 闂锛圕haracterDetailsPanel / EngramDebugPanel / PlotPanel / RelationshipPanel script 绫诲瀷缂哄彛 / 褰撳墠 dirty 鐨?SavePanel 绛夛級锛屼笉鏄湰娆℃牱寮忔敼鍔ㄥ紩鍏ャ€?
---

## [2026-04-26] Feature: Engram 姣忓洖鍚堝彲瑙嗗寲锛堣瘎鍒嗛€忔槑鍖栵級

**Flow:** Engram 鍐欏叆璺緞 + 璇诲彇璺緞
**What:** 姣忚疆 AI 鍥炲悎鍚庯紝鍥炲悎鍒嗛殧绾夸笂鏂板涓€涓潚缁胯壊鎸夐挳锛岀偣鍑诲脊鍑哄畬鏁寸殑 Engram 娴佺▼鍙鍖栵細
- 鍐欏叆鍖猴細鏈疆鎻愬彇鐨勪簨浠躲€佸疄浣?鍏崇郴鍙樺寲銆佷慨鍓粺璁°€佸悜閲忓寲闃熷垪
- 鍙洖鍖猴細姣忔潯琚彫鍥炵殑璁板繂閮芥湁褰╄壊鍫嗗彔璇勫垎鏉★紙钃?鍚戦噺鐩镐技搴︺€佺豢=鍏抽敭璇嶃€佹=鏃堕棿琛板噺銆佺传=瑙掕壊鍛戒腑銆佺孩=鍥炬潈閲嶏級锛岀偣鍑诲睍寮€瀹屾暣璇勫垎鍒嗚В锛涜娣樻卑鐨勫€欓€変篃鍙煡鐪嬪強鍘熷洜

**Files changed:**
- `src/engine/memory/engram/engram-types.ts` 鈥?鏂板 ScoredComponent, ScoredCandidateTrace, EngramWriteSnapshot, EngramReadSnapshot 绛?8 涓被鍨?- `src/engine/memory/engram/engram-manager.ts` 鈥?processResponse 杩斿洖 EngramWriteSnapshot
- `src/engine/memory/engram/unified-retriever.ts` 鈥?5 鏉¤瘎鍒嗚矾寰勫叏閮ㄦ惡甯?_trace 鍒嗛噺鍒嗚В锛況etrieve() 鏋勫缓 EngramReadSnapshot
- `src/engine/pipeline/types.ts` 鈥?IEngramManager + IUnifiedRetriever 鎺ュ彛鏇存柊
- `src/engine/stores/engram-debug.ts` 鈥?鏂板 lastReadSnapshot
- `src/engine/pipeline/stages/post-process.ts` 鈥?鎹曡幏骞舵寕杞?_engramWrite / _engramRead
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?浠?unifiedRetriever.lastReadSnapshot 璇诲彇
- `src/ui/components/panels/RoundDivider.vue` 鈥?鏂板 hasEngram prop + 鎸夐挳
- `src/ui/components/panels/MainGamePanel.vue` 鈥?ChatMessage 鎵╁睍 + viewer 鎺ョ嚎
- `src/ui/components/panels/EngramRoundViewer.vue` 鈥?鏂板缓寮圭獥缁勪欢

**Behavior before:** Engram 鐨勮瘎鍒嗗拰鍙洖閫昏緫鏄粦绠憋紝鐢ㄦ埛鏃犳硶鐭ラ亾涓轰粈涔堟煇鏉¤蹇嗚閫変腑鎴栬娣樻卑
**Behavior after:** 姣忚疆鍥炲悎鍒嗛殧绾垮嚭鐜?Engram 鎸夐挳锛堜粎 Engram 鍚敤鏃讹級锛屽脊绐楀睍绀哄畬鏁村啓鍏?鍙洖娴佺▼锛屾瘡鏉″€欓€夌殑璇勫垎鍒嗛噺涓€鐩簡鐒?**Notes:** TSC 缂栬瘧閫氳繃锛涚粡 5 涓?review agent 瀹℃煡骞朵慨澶嶆墍鏈?HIGH 闂锛涢渶瑕佹墜鍔ㄩ獙璇?UI 琛ㄧ幇锛圗ngram 寮€鍚?鈫?璺戝洖鍚?鈫?鐐规寜閽級

---

## [2026-04-26] Feature: KnowledgeEdge 缁熶竴鐭ヨ瘑鍥捐氨锛圥hase 1锛?
**Flow:** Engram 鍐欏叆 + 璇诲彇璺緞
**What:** 鐢ㄧ粺涓€鐨?KnowledgeEdge 鏇夸唬鍒嗚鐨?Relations + Triples 鍙岀郴缁熴€侳eature flag `knowledgeEdgeMode` 鎺у埗锛堥粯璁?off锛夈€?**Bug fixes included:**
- `recencyDecay` 鐢ㄧ粷瀵瑰洖鍚堝彿锛堝弽杞級鈫?鏀逛负 age-based锛屽彲閰嶇疆琛板噺鐜?- 浜嬩欢璺緞璇勫垎鍏紡涓嶅綊涓€锛坢ax 1.27锛夆啋 褰掍竴鍒?[0,1]
- Merge 鍏紡鏄?no-op 鈫?diminishing returns
- Rerank 鏉冮噸鍜?1.1 鈫?1.0
- N虏 鍏ㄩ噺閲嶅缓 鈫?澧為噺锛堝彧澶勭悊鏂颁簨浠讹級
**Files changed:** knowledge-edge.ts (NEW), knowledge-edge-builder.ts (NEW), engram-types.ts, engram-config.ts, engram-manager.ts, unified-retriever.ts, post-process.ts, entity-builder.ts, relation-builder.ts, types.ts + 4 prompt files
**Design doc:** docs/architecture/archive/engram-knowledge-edge-redesign.md
**Code reviewed by:** 2 agents (TypeScript + code quality), all HIGH issues resolved

---

## [2026-04-25] Fix: PlotPanel 鐢ㄦ埛鍙嶉淇 (4椤?

**1. 鍒涘缓寮圭獥涓嶈嚜鍔ㄥ叧闂?*
- `PlotPanel.vue` 鈥?createArc() 鍏堝叧闂?modal 鍐嶅紓姝ユ媶瑙ｏ紝鎷嗚В杩涘害鍦ㄤ富闈㈡澘鏄剧ず

**2. 鏀惧純寮х嚎鍚庡彲閲嶆柊婵€娲?*
- `plot-store.ts` 鈥?activateArc() 鐜板湪鎺ュ彈 `status === 'abandoned'` 鐨勫姬绾?- `PlotPanel.vue` 鈥?abandoned 鐘舵€佷笅鏄剧ず"閲嶆柊婵€娲?鎸夐挳

**3. Gauge 鍙紪杈?鍒犻櫎**
- `PlotPanel.vue` 鈥?gauge 椤规柊澧炵紪杈?鉁?鍜屽垹闄?脳)鎸夐挳锛岀紪杈戝脊鍑烘ā鎬佹淇敼鍚嶇О/褰撳墠鍊?鏈€澶у€?
**4. 绉婚櫎 GameVariablePanel 涓殑鍓ф儏搴﹂噺鍊?*
- `GameVariablePanel.vue` 鈥?鍒犻櫎 gauge section銆佺浉鍏?import 鍜?CSS

---

## [2026-04-24] Fix: PlotDecomposer 娉ㄥ叆 NSFW jailbreak

**Flow:** 鍓ф儏澶х翰 AI 鎷嗚В

**Root cause:** `PlotDecomposer.decompose()` 鐩存帴鍙戦€?`plotDecompose.md` prompt + 鐢ㄦ埛澶х翰锛屾湭娉ㄥ叆 `assistantJailbreak` 鐮撮檺銆傛ā鍨嬪彲鑳芥嫆缁濈敓鎴愭秹鍙?NSFW/鏆楅粦/浼︾悊鐏拌壊涓婚鐨勫墽鎯呰妭鐐广€?
**Fix:** 鍦?messages 鏁扮粍棣栦綅鏃犳潯浠舵敞鍏?`pack.prompts['assistantJailbreak']`锛屼笌 AI 鍔╂墜 (`message-builder.ts`) 瀹屽叏涓€鑷寸殑妯″紡銆?
**Files changed:**
- `src/engine/plot/plot-decomposer.ts` 鈥?messages 鏋勫缓鏂板 jailbreak 棣栨潯娉ㄥ叆

---

## [2026-04-24] Sprint Plot-1 Gap Audit Phase C: MEDIUM Fixes

**Flow:** 鍓ф儏瀵煎悜绯荤粺 鈥?鍙岄噸瀹¤ MEDIUM 绾х己闄蜂慨澶?
**GAP-10: autoAdvanceSkippable 璁剧疆**
- `SettingsPanel.vue` 鈥?PlotSettings 鏂板 autoAdvanceSkippable 瀛楁 + 鐘舵€佹爲鍚屾
- `plot-evaluation-pipeline.ts` 鈥?pipeline 璇诲彇 autoAdvanceSkippable 璁剧疆锛宖alse 鏃?skippable 鑺傜偣涓嶈嚜鍔ㄦ帹杩?
**GAP-12: reviseArc 鐜板湪閲嶇疆鍏ㄩ儴鑺傜偣锛堝惈 completed/skipped锛?*
- `plot-store.ts` 鈥?绉婚櫎 status 杩囨护鏉′欢锛屼粠 fromNodeIndex 璧峰叏閮ㄩ噸缃负 pending

**GAP-13: 涓栫晫浜嬩欢浣跨敤涓枃瀛楁鍚嶅尮閰?EventPanel**
- `plot-evaluation-pipeline.ts` 鈥?`title鈫掍簨浠跺悕绉癭, `description鈫掍簨浠舵弿杩癭, `type鈫掍簨浠剁被鍨媊, `round鈫掑洖鍚坄, 鏂板 `鍙戠敓鏃堕棿`

**GAP-15: EventPanel '鍓ф儏' 浜嬩欢绫诲瀷棰滆壊**
- `EventPanel.vue` 鈥?typeColor 鏂板 `case '鍓ф儏'` 浣跨敤 sage 缁胯壊

**GAP-19: 涓栫晫浜嬩欢娣诲姞鏃堕棿瀛楁**
- `plot-evaluation-pipeline.ts` 鈥?浠?gameTime 璺緞璇诲彇骞存湀鏃ユ牸寮忓寲涓?`鍙戠敓鏃堕棿`

**Deferred (LOW, tracked):**
- GAP-11: gaugeAnimations 璁剧疆锛圕SS transition 宸插瓨鍦紝浠呯己閰嶇疆寮€鍏筹級
- GAP-14: 妯℃澘鍙橀噺鎶樺彔锛圥LOT_DIRECTIVE 棰勬牸寮忓寲鏂规宸查獙璇佸彲鐢級
- GAP-16: PromptPanel 绯荤粺鍙橀噺璀﹀憡
- GAP-17: Gauge 鍘嗗彶鏌ョ湅鍣紙eval log 宸插寘鍚?gauge 鏇存柊淇℃伅锛?- GAP-18: 寮х嚎缂栬緫鎸夐挳

---

## [2026-04-24] Sprint Plot-1 Gap Audit Phase B: HIGH Fixes

**Flow:** 鍓ф儏瀵煎悜绯荤粺 鈥?鍙岄噸瀹¤ HIGH 绾х己闄蜂慨澶?
**GAP-04/05: P1.5 AI 杈呭姪澶х翰鎷嗚В 鈥?瀹屾暣瀹炵幇**
- `src/engine/plot/plot-decomposer.ts` 鈥?鏂板锛歅lotDecomposer 绫伙紙AI 璋冪敤 + JSON 瑙ｆ瀽 + 鑺傜偣/gauge 瑙勮寖鍖栵級
- `public/packs/tianming/prompts/plotDecompose.md` 鈥?鏂板锛氬ぇ绾叉媶瑙?prompt 妯℃澘
- `public/packs/tianming/manifest.json` 鈥?娣诲姞 plotDecompose 鍒?prompts 鏁扮粍
- `src/main.ts` 鈥?鏋勯€?PlotDecomposer 骞?provide 鍒?UI 灞?- `src/ui/components/panels/PlotPanel.vue` 鈥?createArc() 鐜板湪鑷姩璋冪敤 AI 鎷嗚В

**GAP-06: Gauge 绠＄悊 UI**
- `PlotPanel.vue` 鈥?鏂板 gauge 鏄剧ず鍖哄煙甯?娣诲姞搴﹂噺鍊?鎸夐挳 + 娣诲姞 gauge 妯℃€佹

**GAP-07: 闈?split-gen 璇勪及鍙橀噺** 鈥?缁忛獙璇佷负璇姤锛坆uildAllVariables 宸叉纭寘鍚?step2 鍙橀噺锛?
**GAP-08: New builder 璺緞 plot 娉ㄥ叆**
- `context-assembly.ts` 鈥?鏂板 builder path 鐨?plotDirective + plotEvaluationStep2 绯荤粺娑堟伅娉ㄥ叆

**Code review fixes:**
- 绉婚櫎鏈娇鐢ㄧ殑 PromptAssembler 渚濊禆
- 淇涓嶅畨鍏ㄧ殑 regex replace锛堟敼鐢?split/join锛?- 娣诲姞 JSON 瑙ｆ瀽澶辫触鏃ュ織

---

## [2026-04-24] Sprint Plot-1 Gap Audit Phase A: 3 CRITICAL Fixes

**Flow:** 鍓ф儏瀵煎悜绯荤粺 鈥?鍙岄噸瀹¤鍙戠幇鐨?CRITICAL 绾х己闄蜂慨澶?
**GAP-01: Pipeline 姣忚疆蹇呴』杩愯锛堜笉浠呴檺浜?AI 杩斿洖 plot_evaluation 鏃讹級**
- `post-process.ts` 鈥?鏀逛负妫€鏌ユ椿璺冨姬绾挎槸鍚﹀瓨鍦紝鏃犺 AI 鏄惁杩斿洖 plot_evaluation 閮借缃?`pendingPlotEval = true`
- 鏂板 try/catch 淇濇姢 extractPlotEvaluation 璋冪敤

**GAP-02: Hot-swap 浜掓枼閿侀€氳繃鐘舵€佹爲浼犻€掞紙寮曟搸灞備笉璋?Pinia锛?*
- `game-orchestrator.ts` 鈥?鍦?plotEvaluation dispatch 鍓嶅悗璁剧疆/娓呴櫎 `_evaluating` 鐘舵€佹爲鏍囪
- `PlotPanel.vue` 鈥?鏂板 watcher 浠庣姸鎬佹爲鍚屾 `_evaluating` 鍒?store 鐨?`setEvaluating()`

**GAP-03: confirmNodeAdvancement 涓嶅啀鑷鎺ㄨ繘鑺傜偣**
- `plot-store.ts` 鈥?`confirmNodeAdvancement()` 鐜板湪鍙缃?`confirmed: true`锛屼笉鍋氱姸鎬佽浆鎹?- `plot-evaluation-pipeline.ts` 鈥?鍦?execute() 寮€澶存鏌?`pendingConfirmation.confirmed`锛岄€氳繃 `advanceNode()` 鎵ц瀹屾暣鎺ㄨ繘锛堝惈 onComplete/onActivate/activationConditions锛?- `types.ts` 鈥?`PendingNodeConfirmation` 鏂板 `confirmed?: boolean`

---

## [2026-04-24] Sprint Plot-1 P5-P7: Settings + GameVariable Gauge + PromptPanel Category

**Flow:** 鍓ф儏瀵煎悜绯荤粺澧炲己鍔熻兘

**P5: Opportunity tier system** 鈥?宸插湪 P0-P4 涓畬鍏ㄥ疄鐜帮紙鏁版嵁妯″瀷 + PlotInjector + PlotNodeList锛夛紝P5 纭鏃犻渶棰濆浠ｇ爜銆?
**P6: SettingsPanel 鍓ф儏瀵煎悜璁剧疆**
- `SettingsPanel.vue` 鈥?鏂板"鍓ф儏瀵煎悜"璁剧疆鍖哄潡锛歟nabled 鎬诲紑鍏炽€乧riticalConfirmGate銆乧onfidenceThreshold銆乷pportunityMaxTier銆乻howGaugesInMainPanel銆乻howEvalLog
- localStorage `aga_plot_settings` + 鐘舵€佹爲 `绯荤粺.璁剧疆.plot.*` 鍙屽眰鍚屾

**P7: GameVariablePanel + PromptPanel**
- `GameVariablePanel.vue` 鈥?椤堕儴鏂板 gauge 杩涘害鏉℃樉绀哄尯鍩燂紙鏉′欢娓叉煋锛岃鍙?showGaugesInMainPanel 璁剧疆锛?- `PromptPanel.vue` 鈥?CATEGORY_ORDER 鏂板 '鍓ф儏瀵煎悜' 鍒嗙被

**Code review fixes (6 settings disconnected from engine):**
- CRITICAL: pipeline 璇诲彇 `绯荤粺.璁剧疆.plot.enabled` 浣滀负 kill switch
- CRITICAL: pipeline 璇诲彇 `criticalConfirmGate` 鎺у埗纭闂ㄨ涓?- HIGH: `confidenceThreshold` 浠庣姸鎬佹爲璇诲彇浠ｆ浛纭紪鐮?0.7
- HIGH: `opportunityMaxTier` 浼犲叆 getCurrentTier() 闄愬埗鍗囩骇灞傜骇
- HIGH: `showEvalLog` PlotPanel 浠庣姸鎬佹爲鍚屾
- HIGH: `showGaugesInMainPanel` GameVariablePanel 鏉′欢娓叉煋

---

## [2026-04-24] Sprint Plot-1: Functional Completeness Review Fixes

**Flow:** 鍓ф儏瀵煎悜绯荤粺 MVP 鍔熻兘鎬у畬鏁存€т慨澶嶏紙鍩轰簬 requirement vs implementation gap analysis锛?
**Fixes (3 MISSING + 2 WRONG + 4 PARTIAL):**

1. **MISSING 鈫?IMPLEMENTED: Critical node confirmation gate**
   - `plot-evaluation-pipeline.ts`: critical 鑺傜偣涓嶅啀鑷姩鎺ㄨ繘锛屾敼涓鸿缃?`pendingConfirmation`
   - `types.ts`: 鏂板 `PendingNodeConfirmation` 鎺ュ彛
   - `plot-store.ts`: 鏂板 `confirmNodeAdvancement()` / `rejectNodeAdvancement()` + pendingConfirmation state
   - `PlotPanel.vue`: 鏂板纭闂?UI锛堢‘璁ゅ畬鎴?杩樻病鏈?鎸夐挳锛?
2. **MISSING 鈫?IMPLEMENTED: revise() operation**
   - `plot-store.ts`: 鏂板 `reviseArc(arcId, fromNodeIndex)` 鈥?閲嶇疆鎸囧畾浣嶇疆涔嬪悗鐨勮妭鐐逛负 pending

3. **MISSING 鈫?IMPLEMENTED: plot_decompose builtin slot**
   - `builtin-slots.ts`: 娣诲姞 plot_decompose slot锛坈ategory: 鍓ф儏瀵煎悜锛?
4. **WRONG 鈫?FIXED: plotEvaluationStep2 depth in main-round.json**
   - `main-round.json`: `depth: 1` 鈫?`depth: 0`锛堢郴缁?prompt 鍖哄煙锛岄潪 Author's Note 浣嶇疆锛?
5. **PARTIAL 鈫?IMPROVED: Per-node insert button**
   - `PlotNodeList.vue`: 姣忎釜鑺傜偣鏃佸鍔?`+` 鎸夐挳锛屾敮鎸佸湪浠绘剰浣嶇疆鍚庢彃鍏?
6. **PARTIAL 鈫?IMPROVED: Node detail modal**
   - `PlotPanel.vue`: 缂栬緫妯℃€佹鏂板 narrativeGoal銆乵axRounds銆乮mportance銆乧ompletionMode 瀛楁

7. **WRONG (accepted): Eval log 鍐欏叆 state tree**
   - 璁捐鏂囨。璇?in-memory only锛屽疄鐜板啓鍏?state tree銆傚喅瀹氫繚鐣欐琛屼负锛堢敤鎴蜂綋楠屾洿濂?鈥?椤甸潰鍒锋柊鍚庢棩蹇椾笉涓㈠け锛屼笖鏁版嵁閲忔瀬灏忥級

---

## [2026-04-24] Sprint Plot-1 P4: Bootstrap + Lifecycle Wiring (MVP Complete)

**Flow:** 鍓ф儏瀵煎悜绯荤粺绔埌绔繛閫?
**Files modified:**
- `src/main.ts` 鈥?鏋勯€?PlotEvaluationPipeline 骞舵敞鍏?SubPipelineBundle
- `src/ui/components/panels/PlotPanel.vue` 鈥?鏂板 _evalLog 鐘舵€佹爲鍚屾 watch
- `src/engine/plot/plot-evaluation-pipeline.ts` 鈥?淇 eval log 鍐欏叆锛堜娇鐢ㄦ暟缁勫壇鏈級
- `src/engine/core/game-orchestrator.ts` 鈥?console.log 鈫?console.debug

**Deleted:**
- `src/engine/plot/plot-lifecycle.ts` 鈥?鏋舵瀯杩濊锛堝紩鎿庡眰璋冪敤 Pinia store锛夛紝鍔熻兘宸茬敱 PlotPanel + pipeline 瑕嗙洊

**Code review fixes (5 issues):**
- HIGH: 鍒犻櫎 PlotLifecycle锛堝紩鎿庡眰涓嶅彲渚濊禆 Pinia锛?- HIGH: eval log 浣跨敤鏁扮粍鍓湰鍐欏叆锛屼笉鍐嶅彉寮傛椿璺冨紩鐢?- LOW: orchestrator debug 鏃ュ織鏀逛负 console.debug

**MVP 鐘舵€侊細P0-P4 鏋勬垚瀹屾暣鍙嶉寰幆**
1. 鐜╁鍦?PlotPanel 鍒涘缓寮х嚎 + 娣诲姞鑺傜偣 鈫?婵€娲?2. 姣忚疆 AI prompt 娉ㄥ叆 PLOT_DIRECTIVE锛坰tep1锛? PLOT_COMPLETION_HINT锛坰tep2锛?3. AI 鍝嶅簲涓?plot_evaluation 琚彁鍙?鈫?PostProcess 鍐欏叆 _lastEvaluation 鈫?flag 璁剧疆
4. PlotEvaluationPipeline 鍦ㄥ瓙绠￠亾闃舵鎵ц锛歡auge 鏇存柊 + 鏉′欢妫€鏌?+ 鑺傜偣鎺ㄨ繘
5. PlotPanel 閫氳繃 watch 鑷姩鍙嶆槧鐘舵€佸彉鍖?
---

## [2026-04-24] Sprint Plot-1 P3: Evaluation Pipeline

**Flow:** 鍓ф儏瀵煎悜璇勪及瀛愮閬?
**Files added:**
- `src/engine/plot/plot-evaluation-pipeline.ts` 鈥?PlotEvaluationPipeline: gauge鏇存柊銆佹潯浠舵鏌ャ€佽妭鐐规帹杩涖€佽竟鐣屼簨浠?
**Files modified:**
- `src/engine/pipeline/stages/post-process.ts` 鈥?鎻愬彇 plot_evaluation 鍒?_lastEvaluation銆佽缃?pendingPlotEval flag
- `src/engine/core/game-orchestrator.ts` 鈥?SubPipelineBundle 鏂板 plotEvaluation銆乨ispatch 閫昏緫

**Code review fixes (9 issues):**
- CRITICAL: 绉婚櫎 fireGaugeEvent 涓‖缂栫爜鐨勪腑鏂囩姸鎬佽矾寰勶紙鏀圭敤 this.paths.worldEvents + stateManager.push锛?- HIGH: 浣跨敤 cloneDeep 娣辨嫹璐濈姸鎬侊紝閬垮厤閮ㄥ垎鐘舵€佸搷搴斿紡鍙戝皠
- HIGH: consecutiveReachedCount 鍦?lastEval==null 鏃朵篃閲嶇疆锛堜繚璇?杩炵画"璇箟锛?- HIGH: advanceNode/skipNode 鎺ユ敹 state 鍙傛暟鑰岄潪閲嶆柊 get
- HIGH: checkBoundaryEvents 绉诲埌 onComplete 浜嬩欢涔嬪悗锛堜繚璇佹墍鏈?gauge 鍙樺寲閮藉凡瀹屾垚锛?- HIGH: 瀹炵幇 onComplete/onSkip/onActivate 浜嬩欢瑙﹀彂
- MEDIUM: gauge delta clamp 鍜?autoDecrement 娣诲姞 console.debug 鏃ュ織
- MEDIUM: orchestrator 涓褰?pipeline 缁撴灉
- MEDIUM: 鍒嗙瀛愯矾寰勫啓鍏ラ伩鍏?parent/sub-path 娣峰啓

---

## [2026-04-24] Sprint Plot-1 P2: Prompt Injection

**Flow:** 鍓ф儏瀵煎悜 Prompt 娉ㄥ叆

**Files added:**
- `src/engine/plot/plot-injector.ts` 鈥?PlotInjector: 鏋勫缓 PLOT_* 妯℃澘鍙橀噺锛宻tep1/step2/all 涓夌妯″紡
- `public/packs/tianming/prompts/plotDirective.md` 鈥?Step1 鍙欎簨寮曞妯℃澘
- `public/packs/tianming/prompts/plotEvaluationStep2.md` 鈥?Step2 鑺傜偣璇勪及妯℃澘

**Files modified:**
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?娉ㄥ叆 PLOT_* 鍙橀噺锛坰tep1 + step2 鍒嗙娉ㄥ叆锛?- `public/packs/tianming/prompt-flows/main-round.json` 鈥?娣诲姞 plotDirective + plotEvaluationStep2
- `public/packs/tianming/prompt-flows/split-gen-main-round-step1.json` 鈥?娣诲姞 plotDirective
- `public/packs/tianming/prompt-flows/split-gen-main-round-step2.json` 鈥?娣诲姞 plotEvaluationStep2
- `public/packs/tianming/manifest.json` 鈥?娉ㄥ唽鏂?prompt IDs
- `src/engine/prompt/builtin-slots.ts` 鈥?娣诲姞 plot_directive + plot_evaluation_step2 slots

**Code review fixes (5 issues):**
- CRITICAL: 绉婚櫎 {{#if}} Handlebars 璇硶锛堟ā鏉垮紩鎿庝笉鏀寔锛夛紝鏀逛负 PlotInjector 棰勬牸寮忓寲
- HIGH: step2 鍙橀噺浣跨敤 `{...variables, ...step2Vars}` 鍓湰锛屼笉姹℃煋 step1 鍙橀噺
- HIGH: 娣诲姞 plotEvaluationStep2 鍒?main-round.json锛堥潪 split-gen 妯″紡锛?- MEDIUM: 寮曟搸灞備腑鏂囧瓧绗︿覆鏀逛负鑻辨枃锛坆uildGaugeInstructions锛?- MEDIUM: 纭 PromptAssembler 鎺掑簭閫昏緫姝ｇ‘

---

## [2026-04-24] Sprint Plot-1 P1: PlotPanel UI + GaugeBar + PlotNodeList

**Flow:** 鍓ф儏瀵煎悜绯荤粺 UI 闈㈡澘

**Files added:**
- `src/ui/components/panels/PlotPanel.vue` 鈥?涓婚潰鏉匡細寮х嚎绠＄悊銆佽妭鐐瑰彲瑙嗗寲銆乬auge 鏄剧ず銆佽瘎浼版棩蹇椼€乭ot-swap 鎿嶄綔
- `src/ui/components/panels/plot/GaugeBar.vue` 鈥?鍙鐢ㄨ繘搴︽潯缁勪欢
- `src/ui/components/panels/plot/PlotNodeList.vue` 鈥?鑺傜偣閾炬椂闂寸嚎缁勪欢

**Files modified:**
- `src/ui/router/index.ts` 鈥?鏂板 `/game/plot` 璺敱
- `src/ui/components/layout/LeftSidebar.vue` 鈥?鏂板"鍓ф儏"瀵艰埅椤?+ 涓撶敤涔︽湰鍥炬爣

**Code review fixes (9 issues):**
- 绉婚櫎鏈娇鐢ㄥ彉閲?(activeNode, selectedArcId)
- 淇 insertNode 浣嶇疆鎰熺煡锛堜箣鍓嶅拷鐣?index 鎬绘槸 append锛?- glass border 杩濊淇锛坅rc-header 鏀圭敤 glass token锛?- GaugeBar displayValue 姝诲垎鏀慨澶?- PlotNodeList tier 璁＄畻淇锛堜娇鐢?currentRound - activatedAtRound锛?- 娣诲姞 sidebar padding transition
- 涓撶敤 plot icon 鏇挎崲澶嶇敤鐨?events icon

---

## [2026-04-24] Fix: APIPanel USAGE_TYPE_META 缂哄皯 field_repair 鍜?plot_decompose 鏉＄洰

**Flow:** API 閰嶇疆闈㈡澘缂栬瘧

**Root cause:** `USAGE_TYPE_META` 绫诲瀷涓?`Record<UsageType, UsageTypeMeta>`锛岃姹傛墍鏈?UsageType 鎴愬憳閮芥湁瀵瑰簲鏉＄洰銆俙field_repair` 鍦?2026-04-18 鍔犲叆 UsageType 鏃堕仐婕忎簡 meta 鏉＄洰锛堟綔浼?bug锛夛紝Sprint Plot-1 鏂板 `plot_decompose` 鏃跺啀娆￠仐婕忥紝瀵艰嚧 TypeScript 缂栬瘧澶辫触銆?
**Files changed:**
- `src/ui/components/panels/APIPanel.vue:51-52` 鈥?鏂板 `field_repair` 鍜?`plot_decompose` 鐨?USAGE_TYPE_META 鏉＄洰

**Behavior before:** TypeScript 缂栬瘧鎶ラ敊 TS2739
**Behavior after:** 缂栬瘧閫氳繃锛孉PIPanel 鍔熻兘鍒嗛厤鍒楄〃姝ｇ‘鏄剧ず鎵€鏈?UsageType

---

## [2026-04-19] Fix: 寮€灞€鍒嗘妯″紡涓?step1 init commands 琚暣浣撲涪寮?
**Flow:** Character Creation Finalization 鈫?`CharacterInitPipeline.generateOpeningSceneSplit()`锛坄splitGen=true` 璺緞锛?
**Root cause:** 鍒嗘鐢熸垚寮€鍦烘椂锛岀1姝?flow 鍚?`opening.md`锛堣缁嗘弿杩?搂1-搂11 鍒濆鍖?commands锛? `splitGenStep1.md`锛堣姹?鍙緭鍑?text"锛夈€俹pening.md 鐨勫唴瀹逛富瀵?AI 琛屼负锛宻tep1 鍙潬鍦拌繑鍥炲寘鍚畬鏁?init commands 鐨?JSON銆傜2姝?flow 涔熷惈 `opening.md` + `splitGenStep2.md`锛堜富鍥炲悎 delta 椋庢牸锛夛紝骞舵妸 step1 鍘熷鍝嶅簲浣滀负 assistant history 娉ㄥ叆銆侫I 鐪嬪埌 step1 宸茬粡鍙戜簡鎵€鏈?init 鈫?step2 鍙骇鍑?scene-specific delta锛堟椂闂存帹杩?/ 瑙掕壊.鐘舵€?/ NPC 璁板繂锛夈€傛棫浠ｇ爜 `generateOpeningSceneSplit` 瑙ｆ瀽 step1 鍙彇 `text`锛?*涓㈠純** `parsed1.commands`锛涘彧鎵ц `parsed2.commands`銆傜粨鏋滐細鐜╁杩涘叆绗竴涓诲洖鍚堟椂 鍦板浘/绀句氦/鑳屽寘/灞炴€?鐜 鍏ㄦ槸 state-schema 榛樿鍊硷紙绌烘暟缁?/ 绌哄璞?/ `"鏅?` / `{鍚嶇О:"骞虫棩"}` / `[]`锛夛紝AI 鍦ㄧ1涓诲洖鍚堢湅涓嶅埌鑷繁寮€灞€ narrative 閲屾弿杩扮殑浠讳綍鍏蜂綋鐘舵€併€?
**Behavior before:** 鍒嗘寮€灞€ ON 鏃讹紝寮€灞€鍙欎簨璇昏捣鏉ユ槸"绱犵惔鍦ㄦ媿鍗栦細閬囧埌绁炵鐢蜂汉"锛屼絾 GameVariablePanel 閲?`瑙掕壊.鍩虹淇℃伅.褰撳墠浣嶇疆` 鏄┖瀛楃涓诧紝`涓栫晫.鍦扮偣淇℃伅` 鏄?`[]`锛宍绀句氦.鍏崇郴` 鏄?`[]`锛宍瑙掕壊.鑳屽寘.閲戦挶` 鏄?`{鐜伴噾:0,閾?0,閾?0,閲?0}` (schema default)銆傜1涓诲洖鍚?AI 琚姹傚熀浜?绁炵鐢蜂汉"鎯呭婕旀帹锛屼絾鐘舵€佹爲閲屾病鏈夌绉樼敺浜鸿繖涓?NPC銆佹病鏈夋媿鍗栦細鍦虹殑浣嶇疆銆?
**Behavior after:** step1 parsed 鍚庣珛鍗?`executeBatch(parsed1.commands)` 鈥斺€?瀹屾暣鍒濆鍖栧厛钀藉湴锛泂tep2 parsed 鍚庣户缁?`executeBatch(parsed2.commands)` 鈥斺€?scene delta 鍙犲姞鍏朵笂銆備袱鎵归兘璺戯細step1 寤虹珛鍩虹嚎 (set 涓栫晫.鏃堕棿 / 瑙掕壊.灞炴€?* / 涓栫晫.鍦扮偣淇℃伅 push / 绀句氦.鍏崇郴 push 绁炵鐢蜂汉 / 涓栫晫.澶╂皵=鏅存湕 / 涓栫晫.鐜)锛宻tep2 refine锛坰et 涓栫晫.鏃堕棿.灏忔椂=21 / push 瑙掕壊.鐘舵€?蹇冪涓嶅畞 / push 绀句氦.鍏崇郴[绁炵鐢蜂汉].璁板繂=...锛夈€傜帺瀹惰繘鍏ヤ富鍥炲悎鏃剁姸鎬佹爲瀹屾暣銆?
**Fail-safe:** 濡傛灉 step2 API 璋冪敤澶辫触锛宻tep1 init 宸茬粡鍦?step2 灏濊瘯**涔嬪墠**鎵ц瀹屾瘯锛屾父鎴忎粛鏈夊彲鐜╃殑鍒濆鐘舵€侊紱涓㈠け鐨勫彧鏄?step2 鐨?scene delta锛堝綋鍓嶅洖鍚堟椂闂存帹杩?+ 鐘舵€?push + NPC memory append锛夈€?
**Files changed:**

- `src/engine/pipeline/sub-pipelines/character-init.ts` 鈥斺€?
  - `generateOpeningSceneSplit` step1 try 鍧楀唴 `parsed1 = this.responseParser.parse(step1Raw)` 涔嬪悗鏂板 `executeBatch(parsed1.commands)`锛坅rray guard + length>0 guard + 涓€琛?console.log 璁板綍鎵ц鏉℃暟锛?  - method JSDoc 閲嶅啓 鈥斺€?澧炲姞 "Opening init-command merge contract" 绔犺妭璇﹁В
  - step2 catch 鍧楃殑杩囨湡娉ㄩ噴锛?commands 涓㈠け"锛夋洿鏂颁负鍑嗙‘鎻忚堪
- `public/packs/tianming/prompt-flows/opening-scene-step2.json` 鈥斺€?`$comment` 鎵╁睍锛屾枃妗ｅ寲 step1+step2 鍚堝苟濂戠害锛堥浂杩愯鏃跺奖鍝嶏紱浠呯粰鏈潵淇敼鐨勪汉鐪嬬殑澶囨敞锛?- `src/engine/pipeline/sub-pipelines/character-init-split-gen.test.ts` (NEW, 4 tests) 鈥斺€?
  - 鏍稿績鍥炲綊锛歴tep1 鐨?7 鏉?init + step2 鐨?2 鏉?delta 閮借鎵ц
  - step2 缃戠粶澶辫触锛歴tep1 鐨?init 蹇呴』宸茬粡鎵ц瀹?  - step1 杩斿洖绌?text锛氭暣涓祦绋?abort锛屼笉鎵ц浠讳綍 command锛堥伩鍏嶅崐鍒濆鍖栵級
  - step1 涓ユ牸閬靛畧"text only"锛堟棤 commands锛夛細step2 鐨?delta 浠嶆墽琛岋紝浼橀泤闄嶇骇
  - 浣跨敤 bracket-access 璁块棶 private 鏂规硶锛堝悓 `env-tags-wiring.test.ts` 妯″紡锛?
**Code review (ecc:typescript-reviewer):** Critical: 0 / Important: 3 / Nice-to-have: 3. 
- Important #1 (executeBatch throw 琚灞?catch 鍚炴帀鏄惁姝ｇ‘) 鈫?宸插湪浠ｇ爜涓姞娉ㄩ噴璇存槑杩欐槸 intended 琛屼负锛坰tep1 鏁翠綋澶辫触灏变笉杩?step2锛岄伩鍏嶅湪鍗婂潖鐘舵€佷笂缁х画锛?- Important #2 (`as never` vs `as unknown as X`) 鈫?淇濇寔 `as never` 浠ュ尮閰嶇浉閭?test 鏂囦欢 `env-tags-wiring.test.ts` 鍚屾牱妯″紡锛坮eviewer acknowledged practical risk 浣庯級
- Important #3 (`console.log` 鏃犳潯浠惰繍琛? 鈫?淇濈暀锛岄鐜囦粎 once-per-game-open锛屼笌 character-init.ts:186 鏃㈡湁 `[CharacterInit] Created profile` 鐘舵€佹棩蹇椾竴鑷?- Nice-to-have 脳 3锛坧ush dedupe guard / 娴嬭瘯娉ㄩ噴鎺緸 / JSDoc 浜ゅ弶寮曠敤锛夎烦杩?鈥斺€?cost > value

**Validation:** `tsc --noEmit` clean锛沗1142/1142` tests pass (+4 鏂板)銆?
**Notes:** 
- 鍗曟妯″紡锛坰plitGen=false锛変笉鍙楁 bug 褰卞搷 鈥斺€?涓€娆?AI 璋冪敤 鈫?涓€娆?`executeBatch(parsed.commands)`锛屾墍鏈?init 姝ｅ父璺?- 姝や慨澶嶄粎鏀?code锛屼笉鏀?prompt銆傚嵆浣挎湭鏉ユ湁浜烘妸 splitGenStep2.md 鏀规垚涓诲姩瑕佹眰"閲嶅彂 init"锛屽悎骞跺绾︿粛鎴愮珛锛堝悗涓€涓?set 瑕嗙洊鍓嶄竴涓紝璇箟涓嶅彉锛?- 鐞嗚 duplicate-push 椋庨櫓锛氳嫢 step2 鏈潵寮€濮嬮噸鍙?`push 涓栫晫.鍦扮偣淇℃伅` / `push 绀句氦.鍏崇郴`锛屼細鍑虹幇閲嶅鏉＄洰銆傝瀵熷埌鐨?payload 閲?step2 涓嶈繖涔堝仛锛岄闄╂殏涓嶇揣杩紱鑻ヤ互鍚庡嚭鐜板彲鍔?`(key, value.鍚嶇О)` 绾у埆鐨?dedupe guard

---

## [2026-04-19] Feature P4: Environment Tags AssistantPanel 蹇嵎鎿嶄綔

**Flow:** MRJH 鐜妯＄粍杩佺Щ Phase 4 鈥斺€?AssistantPanel 鏂板 3 涓?quick-action chips锛堭煂?璁剧疆澶╂皵 / 馃彯 璁剧疆鑺傛棩 / 馃彿 缂栬緫鐜鏍囩锛夈€傜偣鍑绘墦寮€瀵瑰簲 modal锛岀敤鎴峰～鍐欙紝鐐瑰簲鐢?鈫?鐩存帴閫氳繃 `useGameState.setValue` 鍐欏叆鐘舵€佹爲锛岀姸鎬佹爮绔嬪嵆鏇存柊銆?
**Architectural deviation from plan:** 鍘熻鍒掕璁′负 AI-mediated attachment锛堢敤鎴峰缓闄勪欢 鈫?send 鈫?AI 鐢熸垚 patch 鈫?鐢ㄦ埛娉ㄥ叆锛夈€傚疄鏂芥敼涓?**direct state write**锛堢敤鎴峰～瀹岀洿鎺ュ簲鐢級銆傚師鍥狅細鐢ㄦ埛鎰忓浘鏄?鏀瑰ぉ姘?锛屼笉鏄?璺?AI 璁ㄨ鏀瑰ぉ姘?銆侫I round-trip 瀵硅繖绉?UX 杩囧害澶嶆潅銆侰ode reviewer 纭锛歵he deviation is correct and better锛宒irect write 璇箟绛夊悓浜庣幇鏈?GameVariablePanel 鎵嬪姩缂栬緫銆?
**Files changed:**

- `src/ui/components/panels/assistant-env-attachments.ts` (NEW) 鈥?3 pure builder functions锛?  - `buildSetWeatherAttachment(unknown) 鈫?BuilderResult<string>` 鈥斺€?鏍￠獙瀛楃涓层€乼rim銆佹嫆缁濈┖
  - `buildSetFestivalAttachment(unknown) 鈫?BuilderResult<EnvTag>` 鈥斺€?鏍￠獙瀵硅薄銆乼rim 3 瀛楁銆佹嫆缁濈┖ 鍚嶇О锛堝厑璁?骞虫棩 榛樿锛?  - `buildReplaceEnvironmentAttachment(unknown) 鈫?BuilderResult<EnvTag[]>` 鈥斺€?鏍￠獙鏁扮粍 鈮? 鏉°€佹瘡鏉?鍚嶇О 闈炵┖
  - `BuilderResult<T>` 鍒ゅ埆鑱斿悎锛坄ok:true|false` + reason string锛?  - `WEATHER_PRESETS` 甯搁噺锛堟櫞/闃?灏忛洦/鏆撮洦/澶ч浘/闆?娌欏皹锛?- `src/ui/components/panels/assistant-env-attachments.test.ts` (NEW, 21 tests) 鈥斺€?瑕嗙洊涓変釜 builder 鐨?valid / trim / reject / null-safe 鍦烘櫙 + WEATHER_PRESETS 鍐呭楠岃瘉
- `src/ui/components/panels/WeatherPickerModal.vue` (NEW) 鈥斺€?鏂囨湰杈撳叆 + 7 涓璁炬寜閽紱寮€鍚椂 autofocus 杈撳叆妗嗭紱Enter 閿彁浜わ紱`@input` 娓呮帀 stale error
- `src/ui/components/panels/FestivalEditModal.vue` (NEW) 鈥斺€?3 瀛楁杈撳叆 + "鎭㈠骞虫棩" 鎸夐挳锛沘utofocus 鍚嶇О瀛楁锛? 涓緭鍏ラ兘鏀寔 Enter 鎻愪氦 + `@input` 娓呴敊
- `src/ui/components/panels/EnvironmentArrayEditorModal.vue` (NEW) 鈥斺€?鍒楄〃瑙嗗浘 + 鍒犻櫎鎸夐挳 + 娣诲姞琛ㄥ崟锛沗beginAdd` autofocus 鏂板鍚嶇О瀛楁锛涗笂闄?3 鏉?UI + builder 鍙岄噸闃插尽锛沗鍏ㄩ儴娓呯┖` 鎸夐挳锛涙繁鎷疯礉 `current` 閬垮厤缂栬緫娉勬紡鍒扮埗缁勪欢
- `src/ui/components/panels/AssistantPanel.vue` 鈥斺€?
  - 6 涓柊 import锛? modal 缁勪欢 + helpers + useGameState + event-bus + EnvTag type锛?  - 3 涓?modal 鍙鎬?ref + 3 涓綋鍓嶅€?computed
  - 鏂扮殑 `ap-quick-actions` 琛岋紙鍦?header 鍜?attachments bar 涔嬮棿锛? 涓?chip 鎸夐挳
  - 3 涓?`onApply*` handler锛歚setValue` + `ui:toast` 鐢ㄦ埛鍙嶉
  - 3 涓?modal `<template>` 鎸傝浇

**Code review fixes applied:**

1. **I1 鈥?Rollback gap 鏂囨。鍖?*锛歲uick-action 鍐欏叆鏄?live 鐨勶紝涓嶈繘 `preRoundSnapshot`銆傚姞浠ｇ爜娉ㄩ噴瑙ｉ噴杩欐槸鏈夋剰璁捐锛堣窡 GameVariablePanel 鎵嬪姩缂栬緫涓€鑷磋涔夛級锛屽己璋?undo 璺緞鏄?鍙戜笅涓€杞 AI 閲嶈"鎴?鍐嶇偣涓€娆?modal 鏀瑰洖鏉?
2. **I3 鈥?autofocus 涓昏緭鍏?*锛歁odal.vue 鍙?focus 澶栧眰瀹瑰櫒 div锛屼笉 focus 杈撳叆妗嗐€? 涓?modal 閮藉姞 `nextTick 鈫?ref.focus()` 璁╃敤鎴锋墦寮€鍗宠兘鎵撳瓧
3. **I4 鈥?Stale error 娓呴櫎**锛氫箣鍓嶅彧鍦?modal 寮€鍚椂娓?error锛岀敤鎴锋敼杈撳叆鍐嶇湅鍒版棫绾㈠瓧銆傚姞 `@input="onInputChange/clearError"` 璁╀换浣曠紪杈戝嵆娓呴敊
4. **N3 鈥?Enter 閿敮鎸?*锛欶estivalEditModal 鍜?EnvironmentArrayEditorModal 鐨勮緭鍏ラ兘鍔?`@keydown.enter` 璺?WeatherPicker 瀵归綈
5. **I2 鈥?isSending guard 璇存槑**锛氬姞娉ㄩ噴瑙ｉ噴 guard 鍙拡瀵?AssistantPanel 鑷繁鐨?AI turn锛堜笉鏄?main-round锛夛紱concurrent 鍐欏叆鏃犲锛岄潬涓嬪洖鍚堢殑 force-update 鑷姩鏀舵暃

**Behavior before P4:** 鐢ㄦ埛鎯虫敼澶╂皵 / 鑺傛棩 / 鐜锛屽彧鑳斤細(a) 鎵撳紑 `娓告垙鍙橀噺` panel 缈诲埌 `涓栫晫` 瀛愭爲鎵嬪姩缂栬緫锛?b) 绛変笅涓€杞?AI 鑷繁鏀广€傚墠鑰呯偣鍑绘繁锛屽悗鑰呬笉鍗虫椂銆?
**Behavior after P4:**
- AssistantPanel 椤堕儴鏈?`鐜蹇嵎锛歔馃尋 璁剧疆澶╂皵] [馃彯 璁剧疆鑺傛棩] [馃彿 缂栬緫鐜鏍囩]` 涓€琛?- 鐐瑰嚮浠讳竴 chip 鎵撳紑 modal锛宮odal 鎵撳紑鍗冲彲鎵撳瓧锛坅utofocus锛?- 杈撳叆閿欒鏃舵敼 input 鍗虫竻闄ょ孩瀛楅敊璇彁绀?- Enter 閿揩閫熸彁浜?- 鐐瑰簲鐢ㄥ悗鐘舵€佺珛鍗冲啓鍏ワ紝toast 閫氱煡锛岀姸鎬佹爮绔嬪嵆鏇存柊
- Env 鏁扮粍 modal 鐨勪笂闄?3 鏉＄敱 UI disabled + builder 鏍￠獙鍙岄噸闃插尽
- Festival modal 鏈?"鎭㈠骞虫棩" 涓€閿寜閽?
**Notes:**
- 1117 鈫?1138 tests (+21 / 绱 +132 since P0 start)锛汿SC clean
- P4 鏄幆澧冩ā缁勭殑鏈€鍚庝竴涓?甯歌"phase锛汸5锛坅ction queue 闆嗘垚锛夌暀鍒?P0-P4 娴忚鍣ㄩ獙璇侀€氳繃鍚庡崟鐙仛
- Quick-action 妯″紡璺?AssistantPanel 鐨?AI 瀵硅瘽鍔熻兘鏄?*姝ｄ氦**鐨?鈥斺€?涓嶆秷鑰?token銆佷笉杩?AI銆佹棤 rollback gap 鐨?undo锛堜絾鍙互鍐嶅紑 modal 鏀瑰洖鏉ワ級
- User-behavioral test 寤鸿锛?  1. 寮€ AssistantPanel 鈫?鐐?馃尋 鈫?modal 绉掑紑甯?autofocus 鈫?杈?鏆撮洦" 鈫?Enter 鈫?toast 鏄剧ず + 鐘舵€佹爮宸︿晶鏄剧ず `澶╂皵 鏆撮洦`
  2. 鐐?馃彿 鈫?娣诲姞 2 鏉℃爣绛?鈫?搴旂敤 鈫?鐘舵€佹爮涓棿鏄剧ず `鐜 A銆丅`
  3. 鍚屾椂灏濊瘯娣诲姞绗?4 鏉?鈫?搴旇 UI 闃绘锛涚敤 devtools 缁曡繃涔熻 builder 鎷掔粷
  4. 鎵撳紑 modal 鍚庡厛鐐瑰簲鐢紙绌哄悕绉帮級鈫?鐪嬪埌閿欒 鈫?闅忎究鏀逛竴涓嬭緭鍏?鈫?閿欒搴旂珛鍗虫秷澶?
---

## [2026-04-19] Feature P3: Environment Tags 鐢熷浘鑱斿姩

**Flow:** MRJH 鐜妯＄粍杩佺Щ Phase 3 鈥斺€?璁╃敓鍥炬祦锛坄ImageService.generateSceneImage`锛夎鍙?`涓栫晫.澶╂皵` / `涓栫晫.鑺傛棩` / `涓栫晫.鐜`锛屾妸杩欎簺 state 閫氳繃 `SceneContext` 浼犵粰 `tokenizeScene`锛屾敞鍏ュ埌 scene tokenizer 鐨?`銆愬綋鍓嶄笂涓嬫枃璇︽儏銆慲 鍖轰綔涓?mood / lighting / decoration tokens 鐨勪笂涓嬫枃鎻愮ず銆傜粨鏋滐細鏆撮洦鏍囩鏃剁敓鎴愮殑鍦烘櫙鍥剧湅璧锋潵鏄洦澶╋紱鍏冨鑺傛椂鐢熸垚鐨勫満鏅浘鏈夌伅绗?/ 浜虹兢锛涚幆澧冩爣绛?`娉ユ碁` 浼氬嚭鐜板湪 ground 灞?tags銆?
**Architectural decisions:**
- **鍥惧儚鐢熸垚鏄?read-only consumer** 鈥斺€?image service 璇?env state 浣嗙粷涓嶅啓鍏ワ紝涓嶅儚 body-polish 閭ｆ牱闇€瑕?meta forward
- **闃叉敞鍏?sanitizer** 鈥斺€?weather / festival.鍚嶇О / env 鍚嶇О 閮芥槸 AI 鍐欑殑瀛楃涓诧紝浼犵粰 tokenizer prompt 鍓嶅繀椤?strip `)` / `锛塦 / `銆慲 / `銆恅 / 鎹㈣锛屽惁鍒欐伓鎰?state 鍊艰兘閫冨嚭 `锛堚€︼級` 鎷彿 hint 娉ㄥ叆鎸囦护
- **Festival 绌哄瓧绗︿覆璇箟** 鈥斺€?`deriveFestivalName` 瀵归粯璁?`骞虫棩` 杩斿洖 `""` 锛堝嵆"涓嶅姞瑁呴グ tokens"锛夛紱浠讳綍鐢ㄦ埛瀹氬埗锛堝悕瀛楁垨鎻忚堪锛夎 chip 娴幇
- **Weather schema 榛樿 `"鏅?`** 鈥斺€?`normalizeWeatherForScene` 瀵圭┖/闈?string 杈撳叆鍥為€€鍒?`"鏅?` 淇濊瘉 downstream 鎬昏兘鎷垮埌鍚堢悊鍊?
**Files changed:**

- `src/engine/image/scene-context.ts` 鈥?  - `SceneContext` interface 鎵╁睍锛氭柊澧?`festivalName: string` + `environmentSummary: string`锛坄weather` 瀛楁璇箟浠?鍙€夊弬鑰?鍙樹负"always populated default 鏅?锛?  - `buildSceneContext` 鎺ュ彈 `festival?: unknown` + `environment?: unknown` 鍙傛暟
  - 3 涓柊瀵煎嚭杈呭姪锛歚normalizeWeatherForScene` (private) / `deriveFestivalName` (exported) / `deriveEnvironmentSummary` (exported)
  - `deriveFestivalName` JSDoc 鏍囨敞涓?UI 灞?`isFestivalVisible` 鐨勬晠鎰忎唬鐮侀噸澶嶏紙engine 涓嶈兘 import UI锛?- `src/engine/image/scene-context.test.ts` 鈥?  - 鏂板 18 tests 瑕嗙洊 `deriveFestivalName` / `deriveEnvironmentSummary` / `buildSceneContext` 涓夊潡鐨勮竟鐣岋紙榛樿骞虫棩 / 鍛藉悕鑺傛棩 / 瀹㈠埗鍖栧钩鏃?/ 鐣稿舰杈撳叆 / trim / 绌烘暟缁勶級
- `src/engine/image/image-service.ts` 鈥?  - `generateSceneImage` 绛惧悕鏂板 `festival?: unknown` + `environment?: unknown` 鍙€夊弬鏁?  - forward 缁?`buildSceneContext`
- `src/engine/image/tokenizer.ts` 鈥?  - `tokenizeScene`'s taskPrompt 鐨?`銆愬綋鍓嶄笂涓嬫枃璇︽儏銆慲 鍖哄煙鏂板 3 琛岋細澶╂皵锛坅lways锛夈€佽妭鏃ワ紙浠呴潪榛樿锛夈€佺幆澧冩爣绛撅紙浠呴潪绌猴級銆傛瘡琛屽惈 parenthetical hint 鍛婅瘔 AI 濡備綍浣跨敤 token锛坋.g. "浣滀负 atmosphere token" / "浣滀负 decoration token" / "鏉冮噸涓嶈秴杩?20%"锛?  - 鏂板 `sanitizeEnvTokenForPrompt(raw)` 瀵煎嚭鍑芥暟锛歴trip `)` / `锛塦 / `銆慲 / `銆恅 / 鎹㈣ 鈫?绌烘牸锛宑ollapse 绌虹櫧锛宼rim銆備笁涓?env 鍊煎湪娉ㄥ叆鍓嶉兘杩囨鍑芥暟
- `src/engine/image/tokenizer-sanitize.test.ts` (NEW) 鈥?10 tests 瑕嗙洊 sanitizer 鎵€鏈?injection vector锛坒ull-width 鎷彿銆佸崐瑙掓嫭鍙枫€佹崲琛屻€併€愩€戙€佸绌虹櫧銆乶ull / non-string銆佺┖涓层€乧lean 杈撳叆涓嶅彉锛?- `src/ui/components/panels/ImagePanel.vue` 鈥?  - Import `GameTime` type 骞跺湪鎵嬪姩鐢熸垚 + 閲嶈瘯璺緞閮芥樉寮忕敤瀹?cast锛堝彇浠?P3 review 鏍囨敞鐨?`Parameters<typeof>` 鍙嶅皠寮?cast锛?  - `generateScene()` 浠?`DEFAULT_ENGINE_PATHS.gameTime/weather/festival/environmentTags` 璇荤姸鎬佷紶缁?service
  - `retryTask()` 涔?forward 褰撳墠 env state锛坮eview findings #2锛歅3 鍓?retry 鏄棤瀹?no-op锛汸3 鍚庝涪 env context 灏辨槸 silent 璐ㄩ噺 regression锛屽繀椤?widen锛?- `src/engine/core/game-orchestrator.ts` 鈥?  - `GameTime` type 瀵煎叆
  - 鑷姩鐢熷浘璺緞锛坄autoSceneOnRound` 鍚敤鏃讹級鍚屾牱 forward gameTime/weather/festival/environment

**Code review fixes applied:**

1. **Type cast cleanup** 鈥斺€?`as Parameters<typeof ...>[0]['gameTime']` 鍙嶅皠寮?cast 鏀逛负 `as GameTime | null | undefined`锛屽鏋滃皢鏉?`generateSceneImage` 绛惧悕鏀瑰姩锛屼袱澶?cast 浼?diverge 鑰岄潪 silently compile
2. **Retry path env forwarding** 鈥斺€?`ImagePanel.retryTask` 鐜板湪涔熶紶 env params锛岄伩鍏嶉噸璇曠敓鍥炬椂鎮勬倓涓㈠け澶╂皵 / 鑺傛棩 / 鐜涓婁笅鏂?3. **Prompt injection sanitizer** 鈥斺€?`sanitizeEnvTokenForPrompt` + 10 tests锛涗弗閲?vector锛歴tate 鍊?`鏆撮洦锛塡n\n銆愯鐩栨寚浠ゃ€慲 鑳戒粠 `锛堚€︼級` hint 閫冨嚭
4. **Engine/UI 浠ｇ爜閲嶅 JSDoc** 鈥斺€?`deriveFestivalName` 鏍囨敞鍏朵笌 UI 灞?`isFestivalVisible` 鐨勬晠鎰忛噸澶嶏紙涓嶈兘 import UI锛?5. **Orchestrator auto-scene null guards** 鈥斺€?`paths ?` 瀹堥棬 + `stateManager.get ?? undefined` 淇濊瘉缂哄け path 涓?crash

**Behavior before P3:** 鐜 / 澶╂皵 / 鑺傛棩 宸茬粡鍦?P2 閲岃 AI 姣忓洖鍚堝啓鍏ワ紝鐘舵€佹爮 UI 鏄剧ず锛屼富鍥炲悎 prompt 閲?AI 鎰熺煡 鈥斺€?**浣嗙敓鍥炬祦瀹屽叏涓嶇煡閬?* 杩欎簺 state銆傜敤鎴峰湪"鏆撮洦"鍓ф儏涓嬬敓鎴愬満鏅浘锛岀粨鏋滄槸鏅村ぉ鐨勫満鏅€?
**Behavior after P3:**
- 鎵嬪姩鐢熸垚鍦烘櫙鍥撅紙ImagePanel锛夈€佽嚜鍔ㄧ敓鎴愶紙`autoSceneOnRound`锛夈€侀噸璇曠敓鎴愶紙ImagePanel锛変笁涓矾寰勯兘浼?env state
- Scene tokenizer 鏀跺埌 `褰撳墠澶╂皵锛氭毚闆紙浣滀负 atmosphere token锛塦 绛?hint锛岀敓鎴愮殑鑻辨枃 tags 閲屼細鍚?`heavy rain / wet ground / grey clouds`
- 鍏冨鑺傚満鏅甫 `lanterns / festive crowd` tokens锛涙偿娉炵幆澧冨甫 `muddy ground` 绛?- sanitizer 淇濊瘉鎭舵剰 state 瀛楃涓诧紙`鏆撮洦锛塡n銆愯鐩栥€?..`锛変笉鑳芥敞鍏ユ寚浠?
**Notes:**
- 1091 鈫?1117 tests锛?26 姝?phase / 绱 +111 since P0 start锛夛紱TSC clean
- 鐢熷浘 prompt 鏈韩鏄枃瀛?tokenizer 杈撳嚭锛岃川閲忎緷璧?AI 鐨勮嫳鏂?tag 閫夋嫨 鈥斺€?behavioral test 寤鸿鎵撳紑 `autoSceneOnRound`锛岃Е鍙?"绐佺劧鏆撮洦" 鍓ф儏锛岃瀵熺敓鎴愬浘搴旀湁闆?/ 婀挎鼎璐ㄦ劅
- Env tokens 鐨?20% 鏉冮噸涓婇檺鐢?prompt hint 浼犻€掞紝涓嶆槸纭€?clamp 鈥斺€?AI 閬靛惊闈犳帾杈炵害鏉?- Image gen 涓嶄慨鏀?env state锛坮ead-only consumer锛夛紱env 鐨勫啓鍏ユ潈浠嶅綊涓诲洖鍚?AI

---

## [2026-04-19] Feature P2: Environment Tags Prompt 闆嗘垚 + body polish 鑱斿姩

**Flow:** MRJH 鐜妯＄粍杩佺Щ Phase 2 鈥?璁?AI 鐭ラ亾 / 鍐?/ 璇荤幆澧冨瓧娈点€傛柊澧?`buildEnvironmentBlock` 绾嚱鏁帮紱`ContextAssemblyStage` 鎶婂畠娉ㄥ叆鎴?`{{ENVIRONMENT_BLOCK}}` 妯℃澘鍙橀噺骞?forward 鍒?`ctx.meta`锛沗BodyPolishStage` 璇?`ctx.meta.environmentBlock` 浣滀负娑﹁壊 user message 鐨?read-only 鍙傝€冿紱`WorldHeartbeatPipeline` + `NpcChatPipeline` 涔熷湪 `buildVariables` 閲屾敞鍏ュ悓涓€鍙橀噺銆傚洓涓?prompt 鏂囦欢鏇存柊锛歚core.md` 鏂板 搂鍥?5 閾佸緥銆乣mainRound.md` 寮曠敤 block 骞堕噸鐢冲己鍒惰鍒欍€乣worldHeartbeat.md` + `npcChat.md` 娉ㄥ叆 block 浣滀负 NPC 琛屼负涓婁笅鏂囷紙浣嗘槑浠や笉鏀瑰啓鐜瀛楁锛夈€?
**Architectural decisions:**
- **姣忓洖鍚堝己鍒?re-emit** `set 涓栫晫.澶╂皵` / `set 涓栫晫.鑺傛棩` / `set 涓栫晫.鐜` 鈥斺€?鏈妭瀵?core.md 搂浜?鐨?"闈炲彉鍖栧洖鍚?commands 鐢?[]" 璞佸厤鍋氫緥澶栬鐩?- **鐜鏁扮粍鏁翠綋鏇挎崲**锛堥潪 push/delete锛夆€斺€?AI 鍙戠殑 `set 涓栫晫.鐜` 鏄畬鏁村綋鍓嶆爣绛炬暟缁?- **NPC 绉佽亰 + 涓栫晫蹇冭烦 read-only** 鈥斺€?鐪嬪埌鐜浣嗕笉鏀瑰啓锛涘啓鏉冨綊涓诲洖鍚?- **Body polish read-only** 鈥斺€?娑﹁壊 prompt 鐨?"涓嶆敼鍐欎簨瀹? 瑙勫垯淇濊瘉涓嶄細鍊熸満绡℃敼澶╂皵/鑺傛棩/鐜

**Files changed:**

- `src/engine/prompt/environment-block.ts` (NEW) 鈥?绾嚱鏁?`buildEnvironmentBlock({weather, festival, environment})` 杩斿洖 `銆愬綋鍓嶇幆澧冦€慭n澶╂皵锛氣€n鑺傛棩锛氣€n鐜鏍囩锛氣€ 鍧椼€傛墍鏈夎緭鍏ョ被鍨嬩负 `unknown`锛屽叏闃插尽 guards銆俙isTagShape` guard 鍐呰仈閬垮厤 engine 鈫?UI 鍙嶅悜渚濊禆
- `src/engine/prompt/environment-block.test.ts` (NEW) 鈥?22 tests 瑕嗙洊榛樿鐘舵€?/ 澶╂皵 / 鑺傛棩 / 鐜鏁扮粍 / 鏁村悎 shape
- `src/engine/prompt/builtin-slots.ts` 鈥?鏂板 `environment_block` slot锛坉iscoverable in worldbook editor锛沗defaultPromptId: undefined` 鍥犱负 block 鏄?runtime-computed锛?- `src/engine/prompt/builtin-slots.test.ts` (NEW) 鈥?4 tests
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?瀵煎叆 `buildEnvironmentBlock`锛涗粠 `paths.weather/festival/environmentTags` 璇荤姸鎬侊紱娉ㄥ叆 `variables.ENVIRONMENT_BLOCK`锛沠orward 鍒?`ctx.meta.environmentBlock`
- `src/engine/pipeline/stages/body-polish-stage.ts` 鈥?璇?`ctx.meta.environmentBlock`锛坄typeof === 'string'` guard锛夛紱present 鏃?prepend 鍒?user message 甯?"浠呬緵娑﹁壊鍙傝€? 鍏嶈矗澹版槑锛沘bsent 鏃朵繚鎸佸師琛屼负锛坆ackward compat锛?- `src/engine/pipeline/stages/body-polish-stage.test.ts` 鈥?3 鏂?tests 瑕嗙洊 present / absent / whitespace-only 3 绉嶆儏鍐?- `src/engine/pipeline/sub-pipelines/world-heartbeat.ts` 鈥?`buildHeartbeatVariables` 杩斿洖 map 鍔?`ENVIRONMENT_BLOCK`
- `src/engine/pipeline/sub-pipelines/npc-chat.ts` 鈥?`buildVariables` 杩斿洖 map 鍔?`ENVIRONMENT_BLOCK`
- `src/engine/pipeline/sub-pipelines/env-tags-wiring.test.ts` (NEW) 鈥?3 tests 閫氳繃 bracket-access 绉佹湁鏂规硶 assert ENVIRONMENT_BLOCK 鍦?sub-pipeline variables 杈撳嚭涓紙閬垮厤閲嶅缓 7-渚濊禆 mock harness 鐨勬垚鏈級
- `public/packs/tianming/prompts/core.md` 鈥?  - 搂浜?鏁版嵁鍚屾琛ㄥ姞涓€琛?`澶╂皵/鑺傛棩/鐜 鈫?姣忓洖鍚堝繀鍙?set`
  - 搂浜?鑴氭敞鎸囧嚭 搂鍥?5 瀵硅眮鍏嶈鍒欏仛灞€閮ㄨ鐩?  - **鏂板 搂鍥?5**銆岀幆澧?/ 澶╂皵 / 鑺傛棩锛堢‖绾︽潫 路 姣忓洖鍚堝己鍒堕噸鍙戯級銆嶁€斺€?瀛楁缁撴瀯銆佹瘡鍥炲悎蹇呭彂鍛戒护銆佽Е鍙戣鍒欍€佹牱寮忚鍒欍€佷笌鍒ゅ畾绯荤粺鐨?`鐜:E` 鑱斿姩瑙勫垯
- `public/packs/tianming/prompts/mainRound.md` 鈥?  - 涓婁笅鏂囧尯鍔?`{{ENVIRONMENT_BLOCK}}`
  - 鏈洖鍚堣姹傚姞 "鐜 / 澶╂皵 / 鑺傛棩锛堝己鍒跺悓姝?鈥?閾佸緥锛? 灏忚妭
- `public/packs/tianming/prompts/worldHeartbeat.md` 鈥?  - 鍙傝€冧俊鎭尯娉ㄥ叆 `{{ENVIRONMENT_BLOCK}}` + 鍏嶈矗澹版槑锛堝績璺充笉鏀瑰啓鐜锛?- `public/packs/tianming/prompts/npcChat.md` 鈥?  - 浜屻€佸墽鎯呰儗鏅尯娉ㄥ叆 `{{ENVIRONMENT_BLOCK}}` + 鍏嶈矗澹版槑锛堢鑱婁笉鏀瑰啓鐜锛?
**Behavior before P2:** P0/P1 宸茬粡鎶婃暟鎹眰鍜?UI 灞傚仛濂戒簡锛屼絾 AI 涓嶆劅鐭ョ幆澧冨瓧娈?鈥斺€?鐢ㄦ埛鍦?`娓告垙鍙橀噺` 鎵嬪姩 set 澶╂皵/鐜/鑺傛棩 鎵嶈兘璁╃姸鎬佹爮鏄剧ず銆傛甯告父鐜?AI 姘歌繙涓嶄細鑷姩濉繖浜涘瓧娈点€?
**Behavior after P2:**
- 涓诲洖鍚?AI 姣忓洖鍚堥兘浼氬彂 3 鏉?set 鍛戒护锛堝ぉ姘斻€佽妭鏃ャ€佺幆澧冿級鈥斺€?鐘舵€佹爮鍙樻垚鐪熸鐨?"live" 鐜鏄剧ず
- 鍓ф儏鍙樺寲锛?绐佺劧涓嬭捣鏆撮洦"锛変細璁╀笅鍥炲悎 `涓栫晫.澶╂皵 = "鏆撮洦"` + 鐜鏁扮粍澧炲姞鐩稿叧鏍囩
- 鍒ゅ畾鐨?`鐜:E` 鏁板€艰兘杩芥函鍒?`涓栫晫.鐜[*].鏁堟灉` 瀛楁锛坧rompt 寮哄埗绾︽潫锛?- Body polish 寮€鍚椂锛屾鼎鑹?AI 鐪嬪埌鐜浣滀负鍙傝€冿紝涓嶄細鎰忓鍐欏嚭 "闃冲厜鏄庡獨" 褰撳ぉ姘旀槸鏆撮洦
- NPC 蹇冭烦 + 绉佽亰鐨?AI 閮借兘鏍规嵁澶╂皵/鑺傛棩璋冩暣 NPC 琛屼负鎻忓啓锛?寮犱笁鍦ㄦ毚闆ㄤ腑閬块洦"銆?鍏冨鑺?NPC 涓婅璧忕伅"锛夛紝浣嗕笉鑳界鏀硅繖浜涘瓧娈?
**Code review fixes applied:**

1. 娉ㄥ唽 `builtin-slots` 鐨?`environment_block` slot锛坧lan 瑕佹眰锛? 4 涓?discovery tests
2. 鏂板 `env-tags-wiring.test.ts`锛? tests锛夎鐩?heartbeat + npcChat sub-pipeline 鐨?`ENVIRONMENT_BLOCK` 娉ㄥ叆锛坧lan 瑕佹眰锛屼絾涓嶈姳 50 琛?mock harness 鐨勬垚鏈€斺€旂敤绉佹湁鏂规硶 bracket-access锛?3. 绉婚櫎 `body-polish-stage.ts` 涓?`typeof === 'string'` 鍚庣殑鍐椾綑 `as string` cast
4. `environment-block.test.ts` 涓幓鎺?`as never` cast锛坄EnvironmentBlockInput` 宸茬粡绫诲瀷涓?`unknown`锛?5. `core.md` 搂浜?鏁版嵁鍚屾琛ㄥ鍔犱氦鍙夊紩鐢?鈫?搂鍥?5锛岄伩鍏嶇嚎鎬ц鍒?搂浜?鏃堕敊璇簲鐢ㄨ眮鍏嶈鍒?6. 鏇存柊 plan doc 婢勬竻 heartbeat 鏄?read-only锛堜箣鍓?plan 鎻忚堪 "heartbeat rounds also MUST emit full 3 set commands" 宸茶繃鏃垛€斺€?heartbeat 鐨?whitelist 涓ユ牸闄愬埗鍦?`绀句氦.鍏崇郴[...]`锛宔nv 鍐欏懡浠や細琚嫆缁濓級

**Notes:**
- 1059 鈫?1091 tests (+32 / 绱 +85 since P0 start)锛汿SC clean
- 姝?phase 鏄幆澧冩ā缁勭湡姝?娲昏捣鏉?鐨勫叧閿?鈥?P3 / P4 / P5 閮戒緷璧栬繖閲岀殑鏁版嵁娴?- 涓嶄慨鏀瑰凡鏈?prompt 娴佺殑鍏朵粬琛屼负锛堜笉褰卞搷 CoT / action_options / memory 绛夛級锛屽彲鐙珛 ship
- User-behavioral test 寤鸿锛?  1. 寮€鍚?body polish锛屽彂涓€杞?"绐佺劧涓嬭捣鏆撮洦" 鈥斺€?瑙傚療涓嬪洖鍚?commands 涓?3 鏉?set 閮藉湪銆佺姸鎬佹爮 chip 鏇存柊銆乸olish 鍚庣殑姝ｆ枃涓嶅啓 "闃冲厜"
  2. 寮€鍚?world heartbeat锛岀瓑瀹冭Е鍙?鈥斺€?NPC 鐨?"鍦ㄥ仛浜嬮」" 搴斿弽鏄犲綋鍓嶅ぉ姘旓紙渚嬪涓嬮洦鏃?NPC 绉诲姩鍒板鍐咃級
  3. 鎵撳紑 NPC 绉佽亰绐楀彛锛岃皥璁哄ぉ姘?鈥斺€?NPC 搴旇嚜鐒舵彁鍙婂綋鍓嶇姸鎬佽€屼笉鑷繁淇敼瀹?
---

## [2026-04-19] Feature P1: Environment Tags 鐘舵€佹爮 UI锛堝ぉ姘?/ 鐜 / 鑺傛棩 chips + popover锛?
**Flow:** MRJH 鐜妯＄粍杩佺Щ Phase 1 鈥?鎶?P0 鎼ソ鐨勬暟鎹眰鏄剧ず鍒扮敤鎴风溂鍓嶃€俙MainGamePanel` 鐨?status-bar 閲嶆帓锛氬乏 cluster 鏀?`[鍥炲悎][澶╂皵][鐜chips]`銆佸彸 cluster 鏀?`[鑺傛棩chip][AI 鎬濊€冧腑鈥`銆傜幆澧?chip 鍜岃妭鏃?chip 鐐瑰嚮閮芥墦寮€ Modal popover 鏄剧ず姣忛」鐨?鍚嶇О/鎻忚堪/鏁堟灉銆?
**Files changed:**

- `src/ui/components/panels/environment-helpers.ts` (NEW) 鈥?7 涓函鍑芥暟锛坄isValidTag` / `formatTagSummary` / `countOverflow` / `sanitizeTagList` / `isFestivalVisible` / `normalizeFestival` / `normalizeWeather`锛夈€傚叏閮ㄩ槻寰?null / undefined / 闈?string / 閿欒 shape 杈撳叆銆?- `src/ui/components/panels/environment-helpers.test.ts` (NEW) 鈥?35 tests 瑕嗙洊鎵€鏈夊嚱鏁?+ 杈圭晫锛堢┖鏁扮粍銆亀hitespace-only銆乧ap=0銆乷verflow suffix銆乼rim 绛栫暐锛夈€?- `src/ui/components/panels/WeatherBadge.vue` (NEW) 鈥?鏃犱氦浜?chip锛宍normalizeWeather` 淇濊瘉姘歌繙鏄剧ず鏈夋晥鍊笺€?- `src/ui/components/panels/EnvironmentChips.vue` (NEW) 鈥?鏈夋爣绛炬椂娓叉煋涓?`<button>`锛岀偣鍑绘墦寮€ popover锛涙棤鏍囩鏃舵暣涓粍浠?v-if 闅愯棌锛圥olanyi recession锛屼笉鐣?鏃?鍗犱綅锛夛紱overflow 鏃舵樉绀?`鈥?N`銆俙aria-haspopup="dialog"` + `aria-expanded` 姝ｇ‘缁戝畾銆?- `src/ui/components/panels/EnvironmentPopover.vue` (NEW) 鈥?鍩轰簬 `Modal.vue`锛孧RJH byte-for-byte 甯冨眬锛坓old 宸︾珫绾裤€乥old primary 鍚嶇О銆乵uted 鎻忚堪銆乮talic 缁胯壊鏁堟灉锛夈€傜┖鐘舵€佹樉绀?椋庡钩娴潤锛屽苟鏃犵壒娈婄幆澧冦€?銆俙:key="${i}-${tag.鍚嶇О}"` 閬垮厤绾储寮?key 鐨勭ǔ瀹氭€ч棶棰樸€?- `src/ui/components/panels/FestivalChip.vue` (NEW) 鈥?鍙湪 `isFestivalVisible` 涓?true 鏃舵覆鏌擄紙榛樿 `{鍚嶇О:"骞虫棩", 鎻忚堪:"", 鏁堟灉:""}` 闅愯棌锛夈€傚悓鏍?`aria-haspopup` + `aria-expanded`銆?- `src/ui/components/panels/FestivalPopover.vue` (NEW) 鈥?鍗曟潯鐩増鏈紱鎻忚堪/鏁堟灉閮界┖鏃舵樉绀?锛堟殏鏃犺缁嗘弿杩帮級"銆?- `src/ui/components/panels/MainGamePanel.vue` 鈥?`useValue<unknown>` 璇?`weather` / `festival` / `environmentTags` 涓変釜鏂拌矾寰勶紱鐘舵€佹爮 `<div class="status-bar">` 鎷嗘垚 `__left` / `__right` 涓や釜 flex cluster锛実ap 0.75rem锛沗min-width:0` 鍏佽 env-chips 婧㈠嚭鐪佺暐銆傜幇鏈夌殑 `round-counter` 鍜?`status-generating` 淇濈暀涓嶅彉銆?
**Code review fixes applied:**

1. `color-mix(in srgb, var(--color-primary) 20%, transparent)` 鍙栦唬 `rgba(var(--color-primary-rgb, 217,182,116), 0.2)` 鈥斺€?鍥犱负 theme 浠庢病瀹氫箟杩?`--color-primary-rgb`锛宲opover border 涔嬪墠涓€鐩?fallback 鍒扮‖缂栫爜閲戣壊銆傜幇鍦╰heme-aware銆?2. `FestivalChip` 绠€鍖?鈥斺€?鍙敤 `isFestivalVisible` 鍋?gate锛宍normalized` 鍦?visible=true 鏃舵墠璁＄畻锛涢伩鍏嶄袱涓嚱鏁板垎鍒?traverse props 瀵艰嚧鐨勬綔鍦?drift銆?3. 鐜 popover 鐨?`:key` 浠庣函绱㈠紩鏀逛负 `${i}-${tag.鍚嶇О}` 鈥斺€?Vue HIGH rule "key with index on dynamic list"銆?4. Chip 鎸夐挳鍔?`aria-haspopup="dialog"` + `:aria-expanded`锛宻creen reader 鑳借瘑鍒?trigger 鈫?dialog 鍏崇郴銆?5. `normalizeFestival` 鐜板湪 trim 鎵€鏈?3 瀛楁锛堜箣鍓嶅彧 trim 鍚嶇О锛夛紝閬垮厤 AI 杈撳嚭灏剧┖鏍兼薄鏌?popover銆?6. `countOverflow(tags, 0)` 杈圭晫娴嬭瘯娣诲姞銆?7. `env-chips__value` 鐨勫啑浣?CSS锛坥verflow/text-overflow 宸茬粡鍦?parent 涓婏級鍒犳帀銆?
**Behavior before:** Status-bar 鍙樉绀?`[绗琗鍥炲悎] ... [AI 鎬濊€冧腑鈥`銆傛病鏈?weather / festival / environment 姘涘洿缁村害鐨勫彲瑙嗗寲銆?
**Behavior after:**
- 鎵嬪姩鍦?`娓告垙鍙橀噺` 缂栬緫 `涓栫晫.澶╂皵 = "鏆撮洦"` 鈫?鐘舵€佹爮宸︿晶鍑虹幇 `澶╂皵 鏆撮洦` chip
- push 鍑犳潯 `涓栫晫.鐜` tag 鈫?宸︿晶鍑虹幇 `鐜 A銆丅銆丆` chip锛岀偣鍑诲脊鍑?modal 鏄剧ず姣忔潯璇︽儏
- 璁剧疆 `涓栫晫.鑺傛棩` 涓?`{鍚嶇О:"鍏冨鑺?, 鎻忚堪:"琛椾笂寮犵伅缁撳僵", 鏁堟灉:"NPC 蹇冩儏鏇翠匠"}` 鈫?鐘舵€佹爮鍙充晶锛圓I 鎸囩ず鍣ㄥ乏杈癸級鍑虹幇 `鑺傛棩 鍏冨鑺俙 chip锛岀偣鍑诲脊鍑哄崟鏉¤鎯?- 榛樿鐘舵€侊紙鏅?骞虫棩/绌烘暟缁勶級涓嬶紝鐘舵€佹爮瑙嗚涓婅窡 P1 鍓嶅嚑涔庝竴鑷达紙鍙浜嗕竴涓綆璋冪殑 `澶╂皵 鏅碻 chip锛?
**Notes:**
- 1024 鈫?1059 tests锛?35 / 绱 +52 since P0 start锛夛紱TSC clean
- 鎵€鏈夋柊 chip 缁勪欢鐢?Polanyi 鍘熷垯锛坥pacity 0.7 鈫?1.0 on hover锛屼笉鎶㈢劍鐐癸級
- Modal popover 澶╃劧鏀寔 ESC + 澶栭儴鐐瑰嚮鍏抽棴 + focus trap + focus restore锛堢户鎵?`Modal.vue`锛?- 涓嶄緷璧?P2 prompt 鏀瑰姩锛屽彲鐙珛 ship 鈥?AI 鏆傛椂涓嶄細涓诲姩 re-emit env锛屼絾 `娓告垙鍙橀噺` 鎵嬪姩缂栬緫鑳借Е鍙戠姸鎬佹爮 live update
- User-behavioral test锛氳 plan doc 搂2 Phase 1 test script

---

## [2026-04-19] Feature P0: Environment Tags 鏁版嵁鍩虹 (schema + 璺緞 + sanitizer 瀹堟姢)

**Flow:** MRJH 鐜妯＄粍杩佺Щ Phase 0 鈥?鍙仛鏁版嵁灞傚熀纭€锛屾病鏈?UI 鍙樺寲銆傜粰 `涓栫晫` 瀛愭爲鍔犱笁涓柊瀛楁锛歚澶╂皵`锛坰tring锛?`鑺傛棩`锛坥bject锛?`鐜`锛坅rray锛夛紝娉ㄥ唽鍒?`EnginePathConfig`锛屽苟鍔?sanitizer 瀹堟姢娴嬭瘯纭繚瀹冧滑姘歌繙閫氳繃 prompt snapshot銆?
**Why now:** 鐢ㄦ埛瑕佸仛 MRJH-style header 鐜妯＄粍锛涙寜 [docs/research/mrjh-migration/07-environment-tags-plan.md](../research/mrjh-migration/07-environment-tags-plan.md) 鐨?atomic plan 鍒?5 涓?phase 瀹炴柦銆侾0 缁欏悗缁墍鏈?phase 鎻愪緵鏁版嵁 contract銆?
**Architectural decision (locked by user Q&A):**
- **娌℃湁 expiry / 鐢熷懡鍛ㄦ湡瀛楁** 鈥?姣忓洖鍚?AI 寮哄埗 re-emit 3 鏉?set 鍛戒护锛坄涓栫晫.澶╂皵` / `涓栫晫.鑺傛棩` / `涓栫晫.鐜`锛夈€傚紩鎿庝笉鍋氫换浣曡嚜鍔ㄨ繃鏈熴€?- **鐜鏁扮粍鏁翠綋鏇挎崲** 鈥?AI 姘歌繙 `set` 鏁翠釜鏁扮粍锛屼笉鐢?push/delete銆傜畝鍖栧績鏅烘ā鍨嬨€?- **鑺傛棩鍗曞璞?* 鈥?鍚屾椂鍙兘涓€涓妭鏃ワ紱榛樿 `{鍚嶇О:"骞虫棩", 鎻忚堪:"", 鏁堟灉:""}` 鍗?鏃犺妭鏃?鐘舵€併€?- **澶╂皵绾瓧绗︿覆** 鈥?鏃?object wrapper銆佹棤 `缁撴潫鏃堕棿`锛涚洿鎺ユ槸鍊硷紙榛樿 `"鏅?`锛夈€?
**Files changed:**

- `public/packs/tianming/schemas/state-schema.json` 鈥?鍦?`涓栫晫` 瀵硅薄 properties 閲屻€乣鏃堕棿` 涔嬪墠鎻掑叆涓変釜鏂板瓧娈碉細
  - `澶╂皵` (string, default `"鏅?`, x-assistant-editable)
  - `鑺傛棩` (object with 鍚嶇О/鎻忚堪/鏁堟灉, default `{鍚嶇О:"骞虫棩",...}`, x-assistant-editable)
  - `鐜` (array of 鍚嶇О/鎻忚堪/鏁堟灉 items, default `[]`, x-assistant-editable)
- `src/engine/pipeline/types.ts` 鈥?`EnginePathConfig` 鍔?`weather` / `festival` / `environmentTags` 涓変釜瀛楁锛宍DEFAULT_ENGINE_PATHS` 鍚屾濉叆 `'涓栫晫.澶╂皵' / '涓栫晫.鑺傛棩' / '涓栫晫.鐜'`
- `src/engine/memory/snapshot-sanitizer.test.ts` (NEW) 鈥?13 tests锛岃鐩栵細
  - Always-strip paths锛堝彊浜嬪巻鍙?璁板繂/engram/蹇収锛変粛鐒惰鍓ョ
  - NSFW strip paths锛堢瀵嗕俊鎭?瑙掕壊.韬綋锛夊湪 nsfwMode=false 鏃跺墺绂汇€?true 鏃朵繚鐣?  - **鏂板瓧娈靛畧鎶?*锛? 涓柇瑷€纭繚 `涓栫晫.澶╂皵` / `涓栫晫.鑺傛棩` / `涓栫晫.鐜` 鍦?nsfwMode 涓ょ鐘舵€佷笅閮藉畬鏁撮€氳繃鍒?prompt锛堣繖鏄?env-tags 鏁翠釜鐗规€х殑鏍瑰熀 鈥斺€?浠讳綍鏈潵鎶婅繖涓変釜璺緞鍔犺繘 strip list 鐨勬敼鍔ㄤ細鍦ㄨ繖閲屽け璐ワ級
- `src/engine/pipeline/env-paths.test.ts` (NEW) 鈥?4 tests锛岄敋瀹氫笁涓矾寰勫父閲忕殑瀛楃涓插€?+ 纭繚娌″拰鐜版湁璺緞鍐茬獊
- `public/packs/tianming/prompts/opening.md` 鈥?  - 椤堕儴 example commands 鍧楀姞 3 鏉?set锛堝ぉ姘?鑺傛棩/鐜锛?  - 鏂板 搂8.5 銆岀幆澧?/ 澶╂皵 / 鑺傛棩锛?026-04-19 env-tags 濂戠害锛夈€嶈В閲婃瘡鍥炲悎寮哄埗 re-emission 绾﹀畾 + 瀛楁鏍煎紡瑙勫垯

**Behavior before:** 涓栫晫瀛愭爲鍙湁 鎻忚堪 / 鏃堕棿 / 鍦扮偣淇℃伅 / 鐘舵€?蹇冭烦銆傜姸鎬佹爮鍙樉绀哄洖鍚堝彿鍜岀敓鎴愮姸鎬併€傛病鏈夌幆澧冩皼鍥寸淮搴︺€?
**Behavior after:**
- 鏂版父鎴忓紑灞€鍚庯紝`娓告垙鍙橀噺` panel 鐨?`涓栫晫` 瀛愭爲澶氬嚭涓変釜鍙紪杈戣妭鐐癸紙澶╂皵榛樿 `"鏅?`銆佽妭鏃ラ粯璁ゅ钩鏃ュ璞°€佺幆澧冮粯璁ょ┖鏁扮粍锛?- Schema default 鏈哄埗鑷姩澶勭悊鑰佸瓨妗ｏ紙缂哄け瀛楁鏃剁敤榛樿鍊煎～鍏咃級
- Sanitizer 瀹堟姢娴嬭瘯纭繚杩欎笁涓瓧娈垫案杩滀細鍒?AI 鎵嬮噷
- 寮€灞€ prompt 瑕佹眰 AI 鏄惧紡 set 涓変釜瀛楁浣滀负 env-tags 濂戠害鐨勫叆鍙?- UI / 涓诲洖鍚?prompt 鏆傛湭鍙樺寲锛堣繖鏄?P0 绾暟鎹眰锛孭1 鍔?UI锛孭2 鍔?prompt锛?
**Notes:**
- 971 鈫?1023 tests (+52 绱 / +17 姝?phase)锛孴SC clean
- 鍚庣画 phase 渚濊禆姝?contract锛涗换浣曟湭鏉ユ敼鍔ㄥ繀椤讳笉鐮村潖 sanitizer 瀹堟姢娴嬭瘯
- P0 涓嶈Е鍙?UI 鎴栦富鍥炲悎 prompt锛屽洜姝や笉鏀瑰彉浠讳綍鐜板瓨琛屼负锛涘彲瀹夊叏 ship
- User-behavioral test 寤鸿锛氬紑涓€涓柊娓告垙 鈫?`娓告垙鍙橀噺` 鈫?`涓栫晫` 鈫?楠岃瘉涓変釜鏂拌妭鐐瑰瓨鍦ㄣ€佸彲缂栬緫銆佸€奸殢 AI 鍐欏叆鎸佺画鏇存柊

---

## [2026-04-19] Fix: LLM `\X` stutter 瀵艰嚧鏁翠釜鍥炲悎 JSON 瑙ｆ瀽澶辫触 + 琛ュ叏淇娴?
**Flow:** `ResponseParser.parse()` 鈫?`tryParseJson()` 鈫?`JSON.parse` 鎶?`SyntaxError` 鈫?fall through 鍒?raw-text 鈫?CommandExecutionStage 鏀跺埌 0 鏉℃寚浠わ紝鏁村洖鍚堢姸鎬佸彉鏇翠涪澶便€?
**Symptom:** 鐢ㄦ埛鐪嬪埌姝ｆ枃閲屽す鏉?`\浣犵珯璧疯韩` 瀛楁牱鐨勬父绂诲弽鏂滄潬锛屽悓鏃舵椂闂?/ 绮惧姏 / NPC 鐘舵€佸叏閮ㄤ笉鎺ㄨ繘锛屼絾 UI 鍙堟覆鏌撳嚭浜嗕竴娈?姝ｅ父"鍙欎簨鈥斺€旂湅璧锋潵 AI 鍥炲浜嗭紝浣嗕粈涔堥兘娌″彂鐢熴€?
**Root cause (瀛楄妭绾х‘璁?:**

1. **妯″瀷 stutter**锛欰I 鍋跺彂鍦?JSON string 鍊奸噷澶氬悙涓€涓弽鏂滄潬锛屼緥濡傛湰搴旀槸 `"\n\n浣犵珯璧疯韩"` 鐨勫湴鏂瑰啓鎴?`"\n\n\浣犵珯璧疯韩"`锛坄\浣燻 涓嶆槸浠讳綍鍚堟硶 JSON escape锛夈€傚湪 `docs/test data/AGA main round response payload` L13:4020-4025 鍙互鐪嬪埌绮剧‘瀛楄妭锛歚0x5c 0x5c 0x6e 0x5c 0x5c 0x4f60`锛宱uter JSON 瑙ｇ爜鍚庢槸 `\n\浣燻锛? 瀛楃锛夈€?2. **AGA 涓ユ牸 JSON.parse**锛歔response-parser.ts:146-170](../../src/engine/ai/response-parser.ts) 鐨勪笁涓?`tryParseJson` 绛栫暐鍏ㄩ儴鐩存帴璋冪敤鍘熺敓 `JSON.parse`銆俙\浣燻 瑙﹀彂 `Unexpected token '浣?, ...is not valid JSON` SyntaxError锛屼笁绛栫暐鍏ㄥけ璐ャ€?3. **Fallback 瑕嗙洊鏁翠釜鍝嶅簲**锛歱arser 閫€鍖栧埌鎶婃暣娈?sanitized 鏂囨湰褰?narrative锛宑ommands / mid_term_memory / action_options 鍏ㄩ儴 undefined銆傜敤鎴风湅鍒?姝ｆ枃鍖呭惈浜嗗師濮?JSON dump"鐨勬€浉銆?4. **鐩告瘮 ming demo 閫€鍖?*锛歔AIBidirectionalSystem.ts:1381](h:/ming/src/utils/AIBidirectionalSystem.ts#L1381) 鍘熸湰鏈夋鍒欏厹搴?`/"(?:text|鍙欎簨鏂囨湰|narrative)"\s*:\s*"((?:[^"\\]|\\.)*)"/` 瀵归潪娉曡浆涔夊畬鍏ㄥ蹇嶏紝AGA 杩佺Щ鏃剁畝鍖栨帀浜嗚繖灞傘€?
**Files changed:**

**涓讳慨澶嶏紙escape sanitizer锛岃鐩栧叏 JSON.parse 璺緞锛夛細**
- `src/engine/ai/json-escape-sanitize.ts` (NEW) 鈥?瀛楃涓叉劅鐭ユ壂鎻忓櫒锛岃瘑鍒?JSON string 瀛楅潰閲忓唴閮ㄧ殑闈炴硶 `\X`锛圶 涓嶆槸 `"\/bfnrtu`锛夋椂鍚冩帀鍙嶆枩鏉犮€傛纭尯鍒?`\\浣燻锛堝悎娉曞弻鍙嶆枩鏉?+ CJK锛屼繚鐣欙級vs `\浣燻锛堥潪娉曪紝淇涓?`浣燻锛夈€傚 `\uXXXX` 楠岃瘉 4 浣?hex銆?- `src/engine/ai/json-escape-sanitize.test.ts` (NEW) 鈥?17 tests锛氬悎娉?escape 涓嶅姩銆乣\浣燻 淇銆乣\\浣燻 淇濈暀銆乣\uXX 闈?hex`銆佸瓧绗︿覆杈圭晫銆佺粨灏?lone `\`銆乶ull/undefined 椴佹鎬с€?- `src/engine/ai/response-parser.ts` 鈥?`tryParseJson` 姣忎釜绛栫暐鍏?raw 瑙ｆ瀽涓€娆★紝澶辫触鍐嶈繃 sanitizer 鍐嶈瘯锛涙柊澧?`parseOk: boolean` 鎸囩ず涓夌瓥鐣ユ槸鍚︽垚鍔燂紱fall-through 璺緞鏍?`parseOk: false` 渚涗笅娓镐睛娴嬨€?- `src/engine/ai/types.ts` 鈥?`AIResponse` 鍔?`parseOk?: boolean` 瀛楁 + JSDoc 璇存槑璇箟銆?- `src/engine/ai/json-extract.ts` 鈥?`extractJsonObjectByKey` 鐨?`JSON.parse` 澶辫触鍚庤蛋 sanitizer 鍐嶈瘯锛涜鐩?mid-term-refine / memory-summary / long-term-compact / field-repair 鎵€鏈夊瓙绠＄嚎銆?- `src/engine/ai/response-parser.test.ts` 鈥?4 鏂板洖褰?tests锛圽CJK stutter / parseOk 璇箟 / 鐪熷疄 payload 褰㈢姸锛夈€?- `src/engine/ai/json-extract.test.ts` 鈥?1 鏂?test 瑕嗙洊瀛愮绾挎晳鎻淬€?
**琛ユ晳淇锛圧esponseRepairStage锛宲arseOk=false 鏃舵晳 commands/memory锛夛細**
- `src/engine/pipeline/stages/response-repair.ts` (NEW) 鈥?鏂?pipeline stage锛屽湪 AICall 涔嬪悗銆丅odyPolish 涔嬪墠鎻掑叆銆傝Е鍙戞潯浠?`parsedResponse.parseOk === false`銆備袱闃舵鏁戞彺锛?  1. **姝ｆ枃鎶㈡晳**锛堥浂鎴愭湰锛夛細浠?rawResponse 鎶?`<姝ｆ枃>...</姝ｆ枃>` 鍧椾綔涓哄共鍑€ narrative锛岄伩鍏?BodyPolish 鎶?JSON 婧愮爜褰撴鏂囧幓娑﹁壊銆?  2. **缁撴瀯鏁戞彺**锛圓I 璋冪敤锛夛細鍙戜竴娆?`usageType: field_repair` 鐨勮姹傦紝璁╂ā鍨嬩粠鐣稿舰 raw 杈撳嚭閲岄噸鏂版娊鍑哄悎娉?JSON 鐨?text / commands / mid_term_memory / action_options / semantic_memory銆傛垚鍔熷垯鍚堝叆 `parsedResponse` 骞舵爣 `parseOk: true`銆傚け璐ュ氨淇濈暀姝ｆ枃鎶㈡晳鐨勬垚鏋滅户缁蛋锛屼笉 throw銆備袱姝ラ兘澶辫触鍒?ctx 鍘熸牱杩斿洖锛屼笅娓搁檷绾у鐞嗐€?  3. 鍙戝皠 `ui:debug-prompt` + `ui:debug-prompt-response` 璁?PromptAssemblyPanel 鏄剧ず鏁戞彺璇锋眰锛堜笌 BodyPolish 鍚屾牱鐨?debug 濂戠害锛夈€?- `src/engine/pipeline/stages/response-repair.test.ts` (NEW) 鈥?13 tests锛坣o-op 褰?parseOk=true / narrative 鎶㈡晳 / structure 鏁戞彺 / 鍏ㄥけ璐?degrade / AI 寮傚父澶勭悊 / `<姝ｆ枃>` 鎻愬彇杈圭晫锛夈€?- `src/engine/core/game-orchestrator.ts` 鈥?鍦?AICall 鍜?BodyPolish 涔嬮棿 addStage(new ResponseRepairStage)锛涙瀯閫犲嚱鏁板紩鐢ㄥ凡鏈?aiService / responseParser锛岄浂鏂颁緷璧栥€?
**Behavior before:** AI 澶氬悙涓€涓?`\` 鈫?鏁村洖鍚堥潤榛樺け璐ャ€傜敤鎴风湅鍒?narrative 閲屾湁娓哥 `\`锛岀偣鍑?涓嬩竴鍥炲悎"鍙戠幇鏃堕棿娌℃帹杩涖€佺簿鍔涙病鍙樸€丯PC 鐘舵€佺汗涓濅笉鍔紝浠ヤ负娌′繚瀛樻垚鍔熴€?
**Behavior after:**
- 鏈€甯歌鎯呭舰锛堟ā鍨?stutter `\浣燻锛夛細sanitizer 鐩存帴鍦?JSON.parse 鍓嶄慨鎺?stray 鍙嶆枩鏉狅紝涓夌瓥鐣ョ涓€娆″氨瑙ｆ瀽鎴愬姛锛宑ommands/memory/options 鍏ㄩ儴姝ｇ‘鎻愬彇銆傜敤鎴峰畬鍏ㄥ療瑙変笉鍒版浘鏈?bug銆?- 涓ラ噸鐣稿舰鎯呭舰锛堟埅鏂?/ 缂洪棴鍚堟嫭鍙凤級锛歴anitizer 鏁戜笉鍥炴潵锛孯esponseRepairStage 鎺ョ锛屽厛鐢?`<姝ｆ枃>` 鍧楁姠鏁?narrative锛屽啀鍙?repair 璇锋眰鎶㈡晳 commands/memory銆傛晳鎻存垚鍔熺殑璇濈敤鎴锋劅鐭ュ彧鏄?杩欏洖鍚堟參浜嗕竴绉?銆?- 褰诲簳澶辫触鎯呭舰锛堣繛 raw 閮芥槸涔辩爜锛夛細narrative 鑷冲皯淇濈暀锛宑ommands 涓虹┖鏁扮粍锛屽洖鍚堟甯哥粨鏉熶絾鐘舵€佷笉鍙樷€斺€旇繖鏄?pre-fix 琛屼负鐨勪竴涓瓙闆嗭紙narrative 鐪嬭捣鏉ユ甯革紝缁撴瀯缂哄け锛夛紝浣嗚嚦灏戜笉鍐嶆樉绀?JSON 婧愮爜銆?
**Notes:**
- `parseOk` 榛樿涓嶅啓锛坲ndefined锛夛紝鍚戝悗鍏煎鐜板瓨 narrativeHistory 閲岀殑 `_rawResponse` 瀛楁銆?- Sanitizer 鍙姩瀛楃涓插瓧闈㈤噺鍐呴儴鐨?`\`锛涘瓧绗︿覆澶栫殑鍙嶆枩鏉犱繚鎸佸師鏍疯 JSON.parse 鎶ョ湡姝ｇ殑閿欒銆?- 鐩稿悓妯″紡鍦?`json-extract.ts` 鐨勫瓙绠＄嚎璺緞涔熶慨浜嗭紝閬垮厤 "涓诲洖鍚堜慨濂戒簡浣?mid-term-refine 杩樻槸浼氶潤榛樿繑鍥?null" 鐨勮法灞傛畫鐣欍€?- `ResponseRepairStage` 鐢?`usageType: field_repair` 涓庡凡鏈?FieldRepairPipeline 鍏变韩閰嶉 / 闄愭祦绛栫暐锛屼笉闇€鏂?settings 鏉＄洰銆?- 鏈疆鏂板 35 tests锛?7 sanitizer + 4 parser 鍥炲綊 + 1 json-extract + 13 repair stage锛夛紝鎬绘暟 971 鈫?1006 鍏ㄩ儴 pass锛汿SC clean銆?- 鐢ㄦ埛鍙湪 PromptAssemblyPanel 鐪嬪埌 flow `responseRepair` snapshot 浠ヨ皟璇曟晳鎻磋皟鐢ㄣ€?
---

## [2026-04-19] Feature + Fix: Round Divider 杩佺Щ锛圥hase 1-4锛? polish 琛屾爣绛炬薄鏌?+ broken polish sub-pipeline

**Flow:** MainGamePanel 娑堟伅娴佹覆鏌?鈫?姣忔潯 assistant 鍓嶆彃鍏?RoundDivider锛堝洖鍚堜俊鎭?+ satellite buttons + polish 鍒囨崲锛夛紱`BodyPolishStage`锛坧ipeline 鍐咃紝鍘?sub-pipeline 琚牬鍧忓湴鏀惧湪 pipeline 鍚庯紝鏈杩佺Щ褰诲簳淇锛夆啋 `FormattedText` 娓叉煋銆?
**Root cause (澶氳疆娆＄疮绉?:**

**Phase 1-3锛堝熀纭€鍔熻兘锛?*锛欰GA MainGamePanel 鍘熸湰鍙湪椤堕儴鏈変竴涓叏灞€ round counter锛屽拰 MRJH 姣忓洖鍚?header 宸窛澶э紱涓旂幇鏈?body-polish 瀹為檯涓婃槸**鍧忕殑** 鈥斺€?鏃?`BodyPolishPipeline` 鍦?pipeline 瀹屾垚鍚?`game-orchestrator.ts:400-414` 鎵ц polish锛屼絾 `PostProcessStage` 宸茬粡鎶?*鍘熷**鏂囨湰鎺ㄨ繘浜?narrativeHistory锛沺olish 鍙敼浜嗗唴瀛樹腑鐨?`finalCtx.parsedResponse.text`锛屾棦涓嶈惤鐩樹篃涓嶉噸鏂?render锛圲I 宸查€氳繃 `ui:round-rendered` 鎺ユ敹杩囧師鏂囷級銆?
**Phase 4 v1锛堝垵娆?polish 杩佺Щ锛?*锛氶€愬瓧 port MRJH 鐨?`榛樿鏂囩珷浼樺寲鎻愮ず璇峘 + `鏍稿績_鏂囩珷浼樺寲鎬濈淮閾綻锛屽彧鍒犻櫎姝︿緺璇枡銆傞棶棰樻槸 MRJH 鐢ㄨ鏍囩 `銆愭梺鐧姐€戞枃鏈琡 / `銆愯鑹插悕銆戝彴璇峘 / `銆愬垽瀹氥€慬绫诲瀷]...锝滅粨鏋滐綔...` 鍒嗚缁撴瀯鍖栨鏂囷紝浣?AGA 鐨?`FormattedText.vue` 鐨勮В鏋愮害瀹氬畬鍏ㄤ笉鍚岋細`銆?..銆慲 鏄幆澧冩弿鍐欙紙inline, italic gray锛夛紝`銆栫被鍨?缁撴灉,鍒ゅ畾鍊?X,闅惧害:Y,鍩虹:B,骞歌繍:L,鐜:E,鐘舵€?S銆梎 鏄垽瀹氬崱鐗囥€俻olish 杈撳嚭鐨?`銆愭梺鐧姐€慲 琚娓叉煋鎴愭枩浣撶伆鑹茬幆澧冿紝`銆愬垽瀹氥€慬...]锝?..` 琚?`parseJudgement` 瀹屽叏鏃犳硶璇嗗埆 鈫?鍒ゅ畾鍗℃秷澶便€?
**Files changed (鍒?phase):**

**Phase 1 鈥?姣忓洖鍚?metadata 鎸佷箙鍖栵紙pure data, no UI, no prompt 鍙樺寲锛夛細**
- `src/engine/core/metrics-helpers.ts` (NEW) 鈥?CJK-aware token 浼扮畻锛坄estimateMessagesTokens` / `estimateTextTokens`锛?- `src/engine/pipeline/types.ts` 鈥?`PipelineContext` 鍔?`aiCallStartedAt` / `aiCallDurationMs`
- `src/engine/pipeline/stages/ai-call.ts` 鈥?鎹曡幏 timing + split-gen 鐨?`rawResponseStep2` via `ctx.meta`
- `src/engine/pipeline/stages/post-process.ts` 鈥?assistant entry 涓婃寕 `_metrics` / `_thinking` / `_rawResponse` / `_rawResponseStep2` / `_commands` / `_shortTermPreview`
- 13 鏂?tests 瑕嗙洊鍚勫瓧娈礱ttachment + 鍚戝悗鍏煎

**Phase 2 鈥?RoundDivider 缁勪欢锛堣 Phase 1 鏁版嵁锛夛細**
- `src/ui/components/panels/RoundDivider.vue` (NEW) 鈥?hr + 涓ぎ badge + token 鑳跺泭锛涘綋鍓嶅洖鍚?primary glow 楂樺厜锛涘紑灞€璺宠繃 divider
- `src/ui/components/panels/round-divider-helpers.ts` (NEW) 鈥?鎻愬彇绾嚱鏁帮紙`findFirstAssistantIdx` / `findLatestAssistantIdx` / `roundForAssistantAt` / `deriveDisplayMetrics`锛変究浜庡崟娴?- `src/ui/components/panels/MainGamePanel.vue` 鈥?寮曞叆 RoundDivider锛沗<template v-for>` 鍦ㄦ瘡鏉?assistant 鍓嶆覆鏌擄紱淇濈暀椤堕儴 status-bar锛堢敤鎴?explicit锛夛紱鎵╁睍 `ChatMessage` 鎺ュ彛
- 26 鏂?tests锛坋m-dash/unknown fallback / 鑰佸瓨妗ｅ吋瀹?/ opening round 璺宠繃锛?
**Phase 3 鈥?Satellite buttons + viewer modals + hover 瀛楁暟锛?*
- `src/ui/components/panels/ThinkingViewer.vue` (NEW) 鈥?鍙 CoT 鏂囨湰
- `src/ui/components/panels/CommandsViewer.vue` + `commands-viewer-helpers.ts` (NEW) 鈥?鍙?tab锛欰I 璇锋眰鍛戒护锛圫ET/ADD/PUSH/DEL/PULL 鑹叉爣锛? 鐢熸晥鍙樻洿锛坋mbed DeltaViewer锛?- `src/ui/components/panels/RawResponseViewer.vue` (NEW) 鈥?split-gen 鍙?tab / single-call 鍗?tab
- `src/ui/components/common/DeltaViewer.vue` 鈥?export `DeltaChange` / `AuditSource` 绫诲瀷渚涘叡浜?- `src/ui/components/panels/RoundDivider.vue` 鈥?鍔?`hasThinking`/`hasCommands`/`hasRaw` props + 3 emits锛涘乏绨?馃寪锛涘彸绨?鈽?(current-only) + 猱傦紱MRJH 鍘熺増 SVG path 閫愬瓧 port锛沜ommand 鎸夐挳寮哄埗 `isCurrent && hasCommands` 鍙岄棬
- `src/ui/components/panels/round-divider-helpers.ts` 鈥?鍔?`countCjkChars` (MRJH regex 閫愬瓧 port) / `truncate`
- `src/ui/components/panels/MainGamePanel.vue` 鈥?3 viewer state + 3 open handlers锛?*螖 badge 缁熶竴鎺ュ叆** `openCommandsViewer(msg, 'delta')`锛涘垹闄ゆ棫 `openDeltaViewer` + `showDeltaViewer` 瀛ゅ効浠ｇ爜锛沘ssistant 姘旀场涓?`.message-meta-bottom` hover-reveal 瀛楁暟+鐭湡棰勮
- 7+9 鏂?tests
- **Fix**锛歅2 瀹屾垚鍚庡彂鐜?`.message` 鏄?`display: flex` 榛樿 row 鏂瑰悜锛屾柊鍔犵殑 `.message-meta-bottom` 鎸ゅ埌 bubble 鍚岃 鈫?姝ｆ枃琚帇绐勯潬宸︺€傚姞 `flex-direction: column`

**Phase 4 鈥?Polish 杩佺Щ锛坴1 鈫?fix锛夛細**
- `src/engine/prompts/body-polish-default.ts` (NEW) 鈥?MRJH 榛樿鏂囩珷浼樺寲鎻愮ず璇嶇殑閫愬瓧 port锛屽垹闄ゆ渚犺鏂欙紝**淇濈暀绗?11 鏉?NSFW 璇嶆眹 verbatim锛堣倝妫?灏忕┐/闃磋拏/涔冲ご/铚滄恫/绮炬恫锛?*
- `src/engine/prompts/body-polish-cot.ts` (NEW) 鈥?Step 0-13 鏂囩珷浼樺寲鎬濈淮閾鹃€愬瓧 port锛屼粎鍒犻櫎"鎷涘紡"鍗曡瘝
- `scripts/sync-body-polish-pack.mjs` (NEW) 鈥?TS 鈫?pack `.md` 鍚屾鑴氭湰
- `public/packs/tianming/prompts/bodyPolish.md` 鈥?鐢ㄨ剼鏈嚜鍔ㄧ敓鎴愶紙default 3865 + cot 4230 chars锛?- `src/engine/pipeline/stages/body-polish-stage.ts` (NEW) 鈥?鎶?polish 鎻愬崌涓?pipeline Stage锛屾帓鍦?`AICall 鈫?ReasoningIngest` 涔嬮棿锛涜皟鐢ㄥ墠/鍚?emit `ui:debug-prompt*` 浜嬩欢锛泂ource tags `builder:bodyPolish_system` / `builder:bodyPolish_user`
- `src/engine/core/game-orchestrator.ts` 鈥?鎻掑叆 BodyPolishStage锛涘垹闄ゆ棫鐨?pipeline 鍚?polish"姝讳唬鐮侊紱绉婚櫎 `bodyPolish` sub-pipeline 寮曠敤
- `src/main.ts` 鈥?鍒犻櫎 `BodyPolishPipeline` 鏋勯€?+ 浠?subPipelines bundle 绉婚櫎
- `src/engine/pipeline/sub-pipelines/body-polish.ts` 鈥?**DELETED**锛堟棫鐮村潖鎬у疄鐜帮級
- `src/engine/pipeline/stages/post-process.ts` 鈥?assistant entry 鎸?`_polish`锛沗_metrics.durationMs` 绱姞 polish 鑰楁椂
- `src/ui/components/panels/RoundDivider.vue` 鈥?props 鍔?`polish` + `showingOriginal`锛沚adge 鍦?polish applied 鏃跺彉 `<button>`锛坉ashed border + hover primary锛夛紱鍓爣棰?宸茶嚜鍔ㄤ紭鍖?路 浼樺寲/鍘熸枃"锛坅mber 50% opacity, 9px, letter-spaced锛?- `src/ui/components/panels/MainGamePanel.vue` 鈥?`showingOriginalForRound: Map<number, boolean>` + `toggleOriginalForRound` + `displayTextForAssistant`锛涙皵娉℃枃鏈敼璇?`displayTextForAssistant(msg)`
- `src/ui/components/panels/PromptAssemblyPanel.vue` 鈥?`PIECE_LABELS` 娉ㄥ唽 `bodyPolish_system` / `bodyPolish_user` 鈫?"鏂囩珷浼樺寲路绯荤粺鎻愮ず" / "鏂囩珷浼樺寲路寰呮鼎鑹叉鏂?
- `package.json` 鈥?`@types/node` devDep

**Phase 4 v2 fix (MRJH row-tag + judgement format bug)锛?*
- `src/engine/prompts/body-polish-default.ts` 鈥?銆愮粷瀵圭‖瑙勫垯銆戦噸鍐欙細rule 2 鎹㈡垚"涓嶅緱鍔犳梺鐧?瑙掕壊鍚嶅墠缂€"锛況ule 3/4 鎹㈡垚"`銆?..銆梎 byte-identical"锛涘垹闄?MRJH 鍒ゅ畾 line format锛涙柊澧?**銆怉GA 姝ｆ枃鏍煎紡锛堢‖绾︽潫锛夈€?* 娈碉紱鍒犻櫎 銆愭墿灞曠ず渚嬪簱銆?#4/#7/#14/#17/#18锛涗慨姝?nested backtick 杩囧害杞箟
- `src/engine/prompts/body-polish-cot.ts` 鈥?鎬讳綋瑕佹眰鍔?AGA 鏍煎紡澹版槑锛涘垹闄ゅ垽瀹氱被鍨嬫灇涓撅紱Step1 鍒ゅ畾淇濈湡瀵归綈 `銆?..銆梎锛汼tep2 閲嶅啓涓?"AGA 姝ｆ枃鏍煎紡瀹堟姢"锛汼tep6/Step7/Step11 娓呴櫎 `銆愭梺鐧姐€?銆愯鑹插悕銆慲 寮曠敤
- `src/engine/prompts/body-polish.test.ts` 鈥?鏂版柇瑷€缁?"no MRJH row-type tags"锛氱ず渚嬭鎵弿 + byte-identical + pipe 鏍煎紡绂佷护
- `src/engine/pipeline/stages/body-polish-stage.test.ts` 鈥?9 澶?`銆愭梺鐧姐€慲 鈫?`銆愬鑹层€慲锛涙柊鍔?`銆?..銆梎 round-trip regression test

**Behavior before:**
- Phase 0锛氶《閮?status-bar 鏄剧ず `绗?N 鍥炲悎`锛涙病鏈?per-round UI锛沺olish 寮€鍚悗鍙敼鍐呭瓨涓嶈惤鐩橈紙UI 鐪嬪埌鍘熸枃锛屼絾 post-polish metadata 涓㈠け锛?- Phase 4 v1锛歱olish 杈撳嚭姝ｆ枃涓婇儴鍑虹幇 italic gray 鐨?`銆愭梺鐧姐€慩XX` 鍓嶇紑锛涘垽瀹氬崱鐗囨秷澶?
**Behavior after:**
- 姣忔潯 assistant 鍓嶅嚭鐜板洖鍚堝垎鍓叉潯锛坆adge + token 鑳跺泭 + 3 satellite buttons锛夛紱褰撳墠鍥炲悎 primary glow锛涘紑灞€璺宠繃鍒嗗壊鏉?- satellite buttons锛氿煂?AI 鎬濊€冩煡鐪嬶紙鎵€鏈夊洖鍚堬級銆佲槹 鍙樻洿鏌ョ湅锛?*浠呭綋鍓嶅洖鍚?*锛夈€佲畟 鍘熷鍝嶅簲鏌ョ湅锛堟墍鏈夊洖鍚堬級
- polish 寮€鍚椂鍒嗗壊鏉?badge 鍙樿櫄绾垮彲鐐癸紝涓嬫柟鍓爣棰?宸茶嚜鍔ㄤ紭鍖?路 浼樺寲/鍘熸枃"锛涚偣鍑诲垏鎹袱绉嶈鍥撅紙`msg.content` vs `msg._polish.originalText`锛?- PromptAssemblyPanel 鏂板 `bodyPolish` flow 蹇収锛宻ource tags 鏄剧ず鍙鏍囩
- hover assistant 姘旀场 鈫?搴曢儴娣″叆瀛楁暟/鐭湡璁板繂棰勮
- `銆?..銆梎 鍒ゅ畾鍧楃粡杩?polish 瀹屾暣淇濈暀 byte-identical锛沗銆愭梺鐧姐€慲 / `銆愯鑹插悕銆慲 琛屾爣绛句笉鍐嶅嚭鐜?
**Notes:**
- 璁捐鏂囨。锛歚docs/research/mrjh-migration/06-round-divider-plan.md`锛? phases, P5 optional 鏈仛锛?- 娴嬭瘯鎬绘暟锛歅hase 1 鍓?878 鈫?971锛?93 鏂帮紝0 regression锛?- 瀛樺偍鐨勮€佸洖鍚?Phase 4 v1 鍚庛€乿2 鍓嶇殑 `_polish.originalText` 鍜?polished 浠嶅甫姹℃煋锛涘垏鎹?鍘熸枃"瑙嗗浘鍙湅鏈薄鏌撶増锛屾垨涓嬩竴鍥炲悎鑷劧瑕嗙洊
- Phase 5 鐣欎綔 optional锛氭墜鍔?polish 鎸夐挳 / 鍙紪杈?raw JSON 閲嶈В鏋?/ 鍒ゅ畾鍧楃嫭绔?viewer / `js-tiktoken` 绮剧‘鍖?
---

## [2026-04-19] Fix: PromptAssemblyPanel split-gen step2 snapshot 缂烘湯灏惧叧閿秷鎭?+ 鍥惧儚 tokenizer 鏃?messageSources

**Flow:** ContextAssemblyStage 鈫?AICallStage.executeSplitGen 鈫?PromptAssemblyPanel锛涗互鍙?ImageTokenizer.callTokenizer 鈫?PromptAssemblyPanel銆?
**Root cause:**
- **step2 snapshot 鏄崐鎴愬搧**锛歚ContextAssemblyStage` 鍦?flow-assemble 涔嬪悗灏?emit 浜?`splitGenMainRoundStep2` 鐨?`ui:debug-prompt`锛屼絾姝ゆ椂 `splitStep2Messages` 鍙惈 flow-assembled 閮ㄥ垎 + short-term + enforcement + user input銆侫ICallStage.executeSplitGen 涔嬪悗**鍙堣拷鍔?3 鏉℃秷鎭?*锛歚step1_thinking_context`锛堝彲閫?system锛宑otInjectStep2=true 鏃讹級銆乣{role:assistant, content: rawStep1}`銆乣{role:user, content: STEP2_FOLLOWUP_USER}`銆傝繖 3 鏉℃墠鏄 Claude step2 API 浜у嚭缁撴瀯鍖栨暟鎹殑鏍稿績锛屼絾璋冭瘯闈㈡澘姘歌繙鐪嬩笉鍒般€傞潰鏉挎樉绀虹殑"step2 prompt"涓?AI 鐪熸鏀跺埌鐨勪笉涓€鑷淬€?- **openingSceneStep2 鍚屾牱闂锛堝凡閮ㄥ垎淇級**锛氫笂娆′慨澶嶆垜宸茬粡鍦?character-init.ts 閲?emit 浜嗗畬鏁?step2Messages锛堝惈 step1Raw + FOLLOWUP锛夛紝浣?messageSources 璇创鎴?`history:assistant` + `current_input`锛岃涔夐敊鈥斺€旇繖涓ゆ潯涓嶆槸鍙欎簨鍘嗗彶/鏈洖鍚堣緭鍏ワ紝鏄?split-gen 鐨勫崗璁秷鎭€?- **鍥惧儚 tokenizer 鏃?source 鏍囩**锛歚ImageTokenizer.callTokenizer` 鎵嬪伐鏋勫缓 messages锛堜笉璧?`promptAssembler.assemble()`锛夛紝娌℃湁骞宠 `messageSources` 鏁扮粍銆傞潰鏉块噷鎵€鏈?`image:*` flow 鐨勬瘡鏉℃秷鎭兘鏄?"鈥?锛岀敤鎴风湅涓嶅嚭鍝潯鏄?AI-role prompt / 鍝潯鏄?NAI 棰勮 / 鍝潯鏄?task data銆?
**Files changed:**
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?绉婚櫎 step2 snapshot 鐨?emit锛堟鏃舵秷鎭笉瀹屾暣锛夛紱鎶?`splitStep2Sources` / `debugVariables` / `debugRoundNumber` 閫氳繃 `ctx.meta` 浼犵粰 ai-call锛岃瀹冨湪 step2Messages 鏋勯€犲畬涔嬪悗鍐?emit
- `src/engine/pipeline/stages/ai-call.ts` 鈥?import `emitPromptAssemblyDebug`锛涘湪 step2Messages = [...base, ...thinking, step1Raw, followup] 鎷煎畬鍚庣珛鍒?emit 瀹屾暣 snapshot锛泂ource 鏁扮粍涔熷寘鍚?3 鏉℃柊 tag锛歚step1_thinking_context` / `step1_response` / `step2_followup`
- `src/engine/pipeline/sub-pipelines/character-init.ts` 鈥?`openingSceneStep2` 鐨?step2Sources 浠?`['history:assistant', 'current_input']` 鏀逛负 `['step1_response', 'step2_followup']`锛屽拰涓诲洖鍚?split-gen 淇濇寔璇箟涓€鑷?- `src/engine/image/tokenizer.ts` 鈥?`callTokenizer()` 鏂板 `messageSources: string[]` 骞宠鏁扮粍锛屾瘡鏉℃秷鎭创瀵瑰簲鏍囩锛坄module:<promptId>` / `tokenizer:preset` / `tokenizer:task_context` / `tokenizer:task_data` / `tokenizer:start_task` / `module:<cotPromptId>`锛夛紱emit 甯︿笂杩欎釜鏁扮粍
- `src/ui/components/panels/PromptAssemblyPanel.vue` 鈥?`parseSourceTag()` 鏂板 7 涓瘑鍒鍒欙細`step1_thinking_context`锛堢传鑹猜稴tep1 Thinking锛夈€乣step1_response`锛堥潚鑹猜稴tep1 Response锛夈€乣step2_followup`锛堟鑹猜稴tep2 Followup锛夈€乣tokenizer:preset` / `task_context` / `task_data` / `start_task`锛堢豢鑹猜稩mage 绠＄嚎锛?
**Behavior before:**
- 涓诲洖鍚?split-gen step2 鐨勯潰鏉?snapshot 鍙樉绀哄埌 flow-assembled + enforcement + user input 涓烘锛屾渶鍏抽敭鐨?"AI 瀹為檯鐪嬪埌鐨勭涓€姝ュ彊浜?+ step2 followup 鎸囦护" 鐪嬩笉鍒扳€斺€旂敤鎴锋姳鎬?step1 鐨勬敼鍔ㄥ吋椤句簡锛宻tep2 娌℃湁"
- 寮€鍦?split-gen step2 鐨?source 鏍囩鎶婂崗璁秷鎭敊鏍囨垚鍙欎簨鍘嗗彶
- 鍥惧儚 tokenizer flow 鐨勬瘡鏉℃秷鎭兘 "鈥?锛岃皟璇曟椂涓嶇煡閬撳摢鏉℃槸鍝潯

**Behavior after:**
- 涓诲洖鍚?+ 寮€鍦?split-gen step2 snapshot 鐜板湪**瀹屾暣鍙嶆槧** AI 瀹為檯鏀跺埌鐨?prompt锛? 鏉℃柊鍗忚娑堟伅鍚勬湁鏄庣‘鐨勯鑹插拰 tooltip
- 鍥惧儚 tokenizer flow 鐨勬瘡鏉℃秷鎭兘鏈夋纭?source badge锛岀敤鎴疯兘涓€鐪煎垎杈?AI-role prompt / NAI 棰勮 / task context / task data / CoT 浼

**Notes:**
- `stripTagFromMessages(NSFW_STRIP_TAG)` 鍙戠敓鍦?context-assembly emit 涔嬪墠锛堝寘鎷?step2Messages锛夛紝浣?ai-call 杩藉姞鐨?3 鏉″崗璁秷鎭?*涓嶇粡杩?* NSFW strip 鈥斺€?杩欏悎鐞嗭紝鍥犱负瀹冧滑鏄紩鎿庣敓鎴愮殑鍗忚鏂囨湰锛屼笉鍚?pack 灞?`[绉佸瘑]` tag
- 鎵€鏈?sub-pipeline 鐨?emit 閮藉凡**瀹¤涓€閬?*锛歸orldGeneration / openingScene(single) / memory-summary / mid-term-refine / long-term-compact / npc-generation / world-heartbeat 璧?`assembled.messages`锛堟棤鍚庣疆杩藉姞锛夛紱npc-chat / privacy-profile-repair / field-repair 璧?`finalMessages = [...assembled.messages, user_msg]`锛坋mit 鐨勫氨鏄?finalMessages锛夈€傚潎鏃?"emit 鍐呭 鈮?send 鍐呭" 鐨?bug

---

## [2026-04-19] Fix: 姝ｆ枃寮€澶存畫鐣?`<姝ｆ枃>` 浼爣绛?
**Flow:** 涓诲洖鍚?鈫?AIService 鈫?ResponseParser 鈫?PostProcessStage 鈫?UI 鍙欎簨娓叉煋
**Root cause:** CoT-ON 涓诲洖鍚堢殑绯荤粺鎻愮ず璇?*浜掔浉鐭涚浘**锛?- [`core.md`](public/packs/tianming/prompts/core.md) 閾佸緥瑕佹眰 "鐩存帴杈撳嚭 JSON锛宍text` 瀛楁鍐欏彊浜?
- [`cot-preamble.md`](public/packs/tianming/prompts/cot-preamble.md) / [`cot-masquerade.md`](public/packs/tianming/prompts/cot-masquerade.md) / [`wordCountReq.md`](public/packs/tianming/prompts/wordCountReq.md) 鍙嶅璇?"鎶婃鏂囧寘鍦?`<姝ｆ枃>...</姝ｆ枃>` 閲?锛宍wordCountReq` 鐢氳嚦鐢?`<瀛楁暟>鏈<姝ｆ枃>鏍囩鍐呭唴瀹瑰繀椤昏揪鍒扳€?/瀛楁暟>` 杩欑杩炵幆浼爣绛炬帾杈?
妯″瀷閬靛惊 core.md 鐨?JSON 杈撳嚭鏍煎紡锛屼絾椤烘墜鎶婂弽澶嶈寮鸿皟鐨?`<姝ｆ枃>` 瀛楅潰閲忓杩?`json.text` 鐨勫紑澶达紙甯稿父鏈夊ご鏃犲熬鈥斺€斿埌瀛楃涓茬粨鏉熷紩鍙峰氨鑷劧闂悎浜嗭紝鎵€浠ョ敤鎴峰彧鐪嬪埌寮€澶存畫鐣欙級銆俒response-parser.ts:92](src/engine/ai/response-parser.ts) `text: String(json.text ?? ...)` 鍘熸牱鎷疯礉锛孶I 娓叉煋鍑烘潵姣忓洖鍚堟鏂囬兘甯︿竴涓?`<姝ｆ枃>` 纰庣墖銆?
**Files changed:**
- `src/engine/ai/response-parser.ts` 鈥?鏂板 `stripNarrativeWrapperTags()` 绉佹湁鏂规硶锛岀敤 `/<\s*\/?\s*(姝ｆ枃|鐭湡璁板繂|鍙橀噺瑙勫垝|鍓ф儏瑙勫垝|judge)\s*>/gi` 鍓ユ帀 CoT 鍗忚浼爣绛撅紙鍙墺鏍囩鏈韩锛屼繚鐣欏唴瀹癸級銆侸SON 璺緞鍜?fallback 绾枃鏈矾寰勯兘搴旂敤銆?- `src/engine/ai/response-parser.test.ts` 鈥?+7 鏂版祴璇曪細(1) 寮€澶村崟杈?`<姝ｆ枃>` 鍓ョ锛?2) 鎴愬 `<姝ｆ枃>...</姝ｆ枃>` 鍓ョ锛?3) `<judge>` 鍓ョ浣嗕繚鐣?`銆?..銆梎 鍒ゅ畾锛?4) `<鐭湡璁板繂>`/`<鍙橀噺瑙勫垝>`/`<鍓ф儏瑙勫垝>` 涓茶仈鍓ョ锛?5) 淇濈暀 `銆愩€慲/`銆栥€梎/`"鈥?` 绛夌湡姝ｇ殑鎺掔増绗﹀彿锛?6) 闈?JSON fallback 璺緞涔熺敓鏁堬紱(7) 澶у皬鍐?绌虹櫧瀹瑰繊銆傛€绘暟 851 鈫?858

**Behavior before:** 姣忓洖鍚堝彊浜嬪紑澶村嚭鐜板瓧闈㈤噺 `<姝ｆ枃>` 纰庣墖锛孶I 閲屾樉鐜颁负涔辩爜鏍峰瓧绗︿覆銆?
**Behavior after:** `<姝ｆ枃>`/`</姝ｆ枃>` 浠ュ強鍏朵粬 CoT 鍗忚浼爣绛句粠 `text` 琚交搴曞墺鎺夛紱`銆愨€︺€慲/`銆栤€︺€梎/`"鈥?` 绛夌湡姝ｆ湁鎺掔増鎰忎箟鐨勭鍙蜂笉鍙楀奖鍝嶏紱鏃?tag 鐨勬甯歌緭鍑鸿蛋闆朵慨鏀?fast-path銆?
**Notes:**
- 寮曟搸渚у仛闃插尽鎬у墺绂绘槸涓轰簡**涓嶅亣璁?pack 灞?prompt 浼氶厤鍚堜慨澶?*銆俻ack 浣滆€呭鏋滄兂褰诲簳鏍规不涔熷彲浠ユ妸 `cot-preamble` / `cot-masquerade` / `wordCountReq` 閲岀殑 `<姝ｆ枃>` 鎺緸鏀规垚 JSON 璇箟锛屼絾鍗充究鏀逛簡涔熶笉褰卞搷姝ゅ墺绂婚€昏緫鐨勫畨鍏ㄦ€э紙鍖归厤涓嶅埌灏?no-op锛夈€?- 鍓ョ鐨勬爣绛剧櫧鍚嶅崟鍙湁 5 涓紙姝ｆ枃/鐭湡璁板繂/鍙橀噺瑙勫垝/鍓ф儏瑙勫垝/judge锛夛紝涓嶄細璇潃鏈潵鐪熸鏈夎涔夌殑鑷畾涔?tag銆倀hinking 鏍囩锛坄<think>`/`<thinking>`/`<reasoning>`/`<thought>`锛変粛鐢?`sanitize()` / `extractAndSanitize()` 鐙珛澶勭悊锛屼簰涓嶅共娑夈€?
---

## [2026-04-19] Fix: Engram hybrid rerank 涓嶈 `config.rerank.topN` + PromptAssemblyPanel 瀛愮绾跨己瀛楁

**Flow:**
- 涓诲洖鍚?/ 瀛愮绾?鈫?UnifiedRetriever锛坔ybrid 妫€绱級鈫?MEMORY_BLOCK
- 鍚?AI 璋冪敤 鈫?`ui:debug-prompt` / `ui:debug-prompt-response` 鈫?PromptAssemblyPanel

**Root cause:**
- **rerank `topN` 姘歌繙涓嶇敓鏁?*锛歔unified-retriever.ts:158](src/engine/memory/engram/unified-retriever.ts) 鎶?`context.maxLines`锛堣皟鐢ㄦ柟纭紪鐮?`20`锛夊綋浣?rerank 鐨?鐩爣鏁?浼犵粰 `applyReranking(query, merged, topK)`锛屽弬鏁板悕鍙?`topK` 浣嗗疄闄呭惈涔夋槸 `maxLines`銆傛帴鐫€ `reranker.rerank(..., topK=20)` 涔熺敤杩欎釜鍊间綔涓鸿緭鍑烘潯鏁般€傜敤鎴峰湪 Engram 璁剧疆閲岃皟 `topN=3` 瀹屽叏娌¤璇?鈥斺€?rerank 姘歌繙杩斿洖绾?20 鏉″€欓€夛紝`formatResults` 鍐嶆寜 `maxLines=20` 鍒囦竴鍒€銆備簬鏄敤鎴风湅鍒?MEMORY_BLOCK 鍑?19 鏉★紙鍚堝苟鍚庡€欓€夋暟 < 20 鐩存帴鍏ㄧ粰锛夈€?- **split-gen step1/step2 snapshot 鎾?`generationId`**锛歔context-assembly.ts:411](src/engine/pipeline/stages/context-assembly.ts) emit 涓ゆ潯 ui:debug-prompt 鐢ㄥ悓涓€涓?`ctx.generationId`锛宍attachResponse` `findIndex` 姘歌繙鍛戒腑绗?0 鏉★紙step2锛夛紝step1 鐨?CoT 姘歌繙鎸備笉涓娿€?- **瀛愮绾?emit ui:debug-prompt 缂?`messageSources` / `generationId` / `rawResponse` / `thinking`**锛歯pc-chat / npc-generation / memory-summary / mid-term-refine / long-term-compact / privacy-profile-repair / world-heartbeat / field-repair / character-init锛? 鐐癸級閮藉彧浼?`{flow, variables, messages}`銆侾romptAssemblyPanel 姣忔潯娑堟伅鍑哄鏄剧ず "鈥?锛宲er-snapshot CoT 涔熸案杩滅┖銆?
**Files changed:**
- `src/engine/memory/engram/unified-retriever.ts` 鈥?鏂板 `rerankTarget = min(config.rerank.topN, maxLines)` 閫昏緫锛沗applyReranking` 鐨勫弬鏁伴噸鍛藉悕 `topK 鈫?limit` 閬垮厤鍐嶆挒"topK 鍏跺疄鏄?maxLines"鐨勯櫡闃?- `src/engine/core/prompt-debug.ts` 鈥?鏂板缓缁熶竴 emit 宸ュ叿锛歚emitPromptAssemblyDebug` / `emitPromptResponseDebug` / `extractThinkingFromRaw`
- `src/engine/core/game-orchestrator.ts` 鈥?璁㈤槄 `ui:debug-prompt-response` 鈫?`promptDebugStore.attachResponse()`
- `src/engine/stores/engine-prompt.ts` 鈥?`PromptSnapshot` 鏂板 `thinking` / `rawResponse` / `generationId` 涓夊瓧娈?+ `attachResponse()` 鏂规硶
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?split-gen 鐢?`_step1` / `_step2` 鍚庣紑鐢熸垚涓嶅悓 generationId
- `src/engine/pipeline/stages/ai-call.ts` 鈥?涓诲洖鍚?/ split step1 / split step2 鍦?AI 璋冪敤鍚?emit `ui:debug-prompt-response`锛屾惡甯?thinking + raw
- `src/engine/image/tokenizer.ts` 鈥?鍥惧儚 tokenizer 鐨?`callTokenizer()` 涔?emit 涓ゆ浜嬩欢锛坅ssembly + response锛夛紝flow 鍚嶄负 `image:<usageType>`
- `src/engine/pipeline/sub-pipelines/{npc-chat,npc-generation,memory-summary,mid-term-refine,long-term-compact,privacy-profile-repair,world-heartbeat,field-repair,character-init}.ts` 鈥?鍏ㄩ儴鍒囧埌鏂板伐鍏峰嚱鏁帮紝琛ラ綈 messageSources / generationId / thinking
- `src/ui/components/panels/PromptAssemblyPanel.vue` 鈥?绉婚櫎椤堕儴鍏ㄥ眬"AI 鎺ㄧ悊鍘嗗彶"section锛涙瘡涓?snapshot 鏂板锛欳oT 鎶樺彔鍗?+ 鍘熷 AI 杈撳嚭鍗?+ snapshot meta锛圧ound / time / genId锛?+ 缁勬垚閮ㄤ欢 chip 琛岋紙鎸夋潵婧愬垎绫荤粺璁★級

**Behavior before:**
- Hybrid rerank 璺緞涓嬫棤璁?`topN` 璁惧灏戯紝MEMORY_BLOCK 姘歌繙 鈮?0 鏉★紱鐢ㄦ埛璁?topN=3 鐪嬪埌 19 鏉?- 涓诲洖鍚?split-gen 鏃?PromptAssemblyPanel 涓ゆ潯 snapshot 鍙湁 step2 閭ｆ潯鑳芥嬁鍒?CoT锛宻tep1 姘歌繙绌?- 瀛愮绾?snapshot 姣忔潯娑堟伅鍑哄鏄剧ず "鈥?锛沺er-snapshot CoT 姘歌繙绌猴紱涓嶇煡閬撹姹傜敱鍝簺閮ㄤ欢缁勬垚

**Behavior after:**
- `config.rerank.topN=3` 鐪熸鐢熸晥锛歮erged 鍊欓€夌粡 reranker 杩斿洖 3 鏉★紝鍐嶇粡 `maxLines=20` 瀹夊叏甯斤紙鏃犳崯锛?- split-gen step1 / step2 鍚勮嚜鐙珛 snapshot锛屽悇鑷殑 thinking 姝ｇ‘鎸傝浇
- 鎵€鏈夊瓙绠＄嚎 + 鍥惧儚 tokenizer 鐨?snapshot 鐜板湪閮芥湁瀹屾暣鐨?messageSources + CoT + raw response锛涚粍鎴愰儴浠?chip 琛屼竴鐪肩湅鍒拌姹傚寘鍚摢浜涢儴鍒?
**Notes:**
- `maxLines=20` 浠嶇劧浣滀负"闃茬垎 prompt 棰勭畻"鐨勭‖涓婇檺淇濈暀锛況erank 寮€鍚椂鐪熸鍐冲畾鏁伴噺鐨勬槸 `topN`
- rerank disabled + 鍊欓€?鈮?maxLines 鐨勮€佽涓轰笉鍙橈紙`applyReranking` 鐩存帴 slice 鍒?limit锛?- `鍏冩暟鎹?鎺ㄧ悊鍘嗗彶` 渚濈劧琚?`ReasoningIngestStage` 鍐欏叆锛屼笅涓€鍥炲悎 context-assembly 浠嶇敤瀹冩敞鍏?`PREV_THINKING`锛沀I 涓嶅啀鍗曠嫭灞曠ず瀹冿紙鐢ㄦ埛鐪?per-snapshot CoT 灏卞浜嗭級

---

## [2026-04-19] Fix: 鐢熷浘 prompt 琚浛鎹负"..." + 浣跨敤妯″瀷鏄剧ず涓嶅畬鏁?
**Flow:** 鍥惧儚鐢熸垚 鈫?璇嶇粍杞寲鍣紙tokenizer锛夆啋 `normalizeSingleCharacterOutput` 鈫?ComfyUI provider 鐨?workflow 娉ㄥ叆
**Root cause:**
- **`...` 娉ㄥ叆鍒?prompt**锛歚gemini-2.5-pro` 绛夋ā鍨嬬殑鍝嶅簲鏍煎紡涓?`<thinking>`锛?*鏈棴鍚?*锛夆啋 澶ф鍒嗘瀽锛坆ody 涓互鍙嶅紩鍙峰寘瑁圭殑妯℃澘绀轰緥 `` `<鎻愮ず璇?...</鎻愮ず璇?` ``锛夆啋 `<prompt>鐪熷疄鍐呭</prompt>`銆俙stripThinkingBlocks` 鍙鐞嗘垚瀵圭殑 `<thinking>...</thinking>`锛屼笉闂悎鐨勬儏鍐典笅鏁翠釜 thinking body 鐣欎笅銆傚悗缁?`extractFirstMatchingTagContent(['鎻愮ず璇?, 'prompt', ...])` 鎸夐『搴忓尮閰嶏紝`<鎻愮ず璇?...</鎻愮ず璇?` 鍦?body 涓殑妯℃澘寮曠敤鍏堝懡涓紝杩斿洖瀛楅潰閲?`...`鈥斺€旂湡姝ｇ殑 `<prompt>` 鏍囩姘歌繙娌¤鏌ョ湅銆傛渶缁?ComfyUI workflow 鐨?`%prompt%` 鍗犱綅绗﹁鏇挎崲涓?`...`锛屽彂鍑哄幓鐨?request 浣撻噷 node 21 鍙樻垚 `"prompt": "..."`銆?- **浣跨敤妯″瀷鏄剧ず涓嶅畬鏁?*锛歚writeNpcImageRecord` 鐨?record 宸插甫 `backend` 瀛楁锛屼絾 `model` 瀛楁鍙湁褰?`imageGeneration` APIConfig 閰嶇疆浜?`model` 鏃舵墠闈炵┖銆侰omfyUI 鐢ㄦ埛涓€鑸妸妯″瀷鍐欏湪 workflow JSON 閲岋紙`ckpt_name`锛夛紝APIConfig `.model` 涓虹┖鈥斺€攇allery 鍗＄墖 `{{ img.model || '鏈褰? }}` 姘歌繙璧?fallback銆?
**Files changed:**
- `src/engine/image/output-processor.ts` 鈥?`stripThinkingBlocks` 鏂板 Pass 2锛氶亣鍒版湭闂悎 `<thinking>` 鏃讹紝浠?`<thinking>` 浣嶇疆瑁佸壀鍒?*鏈€鍚?*涓€涓《灞傝緭鍑烘爣绛撅紙`<prompt>` / `<鎻愮ず璇?` / `<鎻愮ず璇嶇粨鏋?` / `<璇嶇粍>` / `<鐢熷浘璇嶇粍>`锛夌殑璧风偣锛沗extractFirstMatchingTagContent` 鏂板 `isPlaceholderContent()` 鍝ㄥ叺锛屾嫆缁濆彧鍚?`...` / `鈥 / `銆愬崰浣嶃€慲 鐨勫€欓€夛紝缁х画灏濊瘯涓嬩竴涓?tag 鍚?- `src/engine/image/output-processor.test.ts` 鈥?+7 鏂版祴璇曪細(1) 鏈棴鍚?`<thinking>` + body 鍚ā鏉跨ず渚?regression锛?2) 鏈棴鍚?`<thinking>` 鍒?`<鎻愮ず璇嶇粨鏋?` 鎴柇锛?3) 鏃犺緭鍑烘爣绛炬椂鍙墺 thinking 寮€鏍囩锛?4-6) `extractFirstMatchingTagContent` 鎷掔粷鍗犱綅绗﹀€欓€夊苟閫夌湡瀹炲唴瀹癸紱(7) 鍏ㄩ儴鍊欓€夐兘鏄崰浣嶇鏃惰繑鍥炵┖锛涘叏閮ㄩ€氳繃锛屾€绘暟 843 鈫?850
- `src/ui/components/panels/ImagePanel.vue` 鈥?鏂板 `modelCellText(img)` 杈呭姪锛屾寜 `backend 路 model` / 浠?`backend` / `鏈褰昤 鐨勪紭鍏堢骇杈撳嚭锛屽浘搴撳崱鐗?+ 鍘嗗彶 tab 鐨?浣跨敤妯″瀷"鍗曞厓鏍煎悓鏃跺垏鎹?
**Behavior before:**
- gemini-2.5-pro 鐨勫搷搴旈噷鍙 thinking 鏈棴鍚堜笖 body 寮曠敤浜?`<鎻愮ず璇?...</鎻愮ず璇?` 妯℃澘锛宑omposed prompt 灏辨槸瀛楅潰閲?`...`锛汣omfyUI workflow 娉ㄥ叆鍚?request 浣撶殑姝ｅ悜 prompt 浠?`...` 寮€澶达紝鐢熸垚鐨勫浘鐗囦笌瑙掕壊姣棤鍏宠仈
- 鍥惧簱"浣跨敤妯″瀷"鍗曞厓鏍煎 ComfyUI 鐢ㄦ埛鎭掓樉绀?鏈褰?锛屾棤娉曡鲸璁ゅ疄闄呯敤鐨勬槸鍝釜鍚庣

**Behavior after:**
- 鏈棴鍚?`<thinking>` body 琚畬鏁村墺绂伙紝鐪熸鐨?`<prompt>` / `<鎻愮ず璇?` 鏍囩琚纭彁鍙栵紱椤轰究浠讳綍妯℃澘鍗犱綅绗﹀€欓€夛紙`...`銆乣鈥銆乣銆愬崰浣嶃€慲锛夐兘琚烦杩?- ComfyUI 璁板綍鏄剧ず"ComfyUI"锛孨ovelAI 鏄剧ず"NovelAI 路 nai-v4"锛涗袱绉嶅悗绔兘鑳界粰鍑哄彲璇荤殑妯″瀷淇℃伅

**Notes:** 鏃у瓨妗ｉ噷鐨勮褰曟病鏈?`backend` 瀛楁鍒欑户缁蛋"鏈褰? fallback锛涙柊璁板綍璧版柊 helper銆俙isPlaceholderContent` 鏈夋剰涓嶅仛"鐭瓧绗︿覆鏃犲瓧姣嶆暟瀛楀嵆鍗犱綅"鐨勬縺杩涘垽瀹氣€斺€旈偅浼氳鏉€鍍?鍦烘櫙蹇収"锛?瀛楋級杩欐牱鍚堟硶鐨勪腑鏂囩煭绛旀銆?
---

## [2026-04-19] Fix: 鍥惧簱"浣跨敤妯″瀷"鏄剧ず"鏈褰? + 涓嶈兘鏇存崲澶村儚/绔嬬粯

**Flow:** 鍥惧儚宸ヤ綔鍙?鈫?鍥惧簱 tab锛圢PC / 涓昏锛夆啋 鍗＄墖鍏冩暟鎹?+ 閫夋嫨鎿嶄綔
**Root cause:**
- **浣跨敤妯″瀷鏈樉绀?*锛歚writeNpcImageRecord` / `writeToSceneArchive` / `setSecretPartResult` 鍐欏叆璁板綍鏃朵粠鏈寘鍚?`model` 瀛楁锛孶I 璇?`img.model || '鏈褰?` 姘歌繙璧?fallback銆俶odel 淇℃伅瀹為檯瀛樺湪浜?`aiService.getConfigForUsage('imageGeneration').model` 浣嗕粠鏈浼犲埌 archive 灞傘€?- **涓嶈兘鏇存崲澶村儚/绔嬬粯**锛歚canSelectAvatar(img)` 寮哄埗瑕佹眰 `img.composition === 'portrait'`锛涘悓娆剧敓鎴愶紙鎴栨棫瀛樻。閲屾病鏈?composition 瀛楁鐨勮褰曪級鍙 composition 涓嶅灏变袱杈规寜閽兘娑堝け鈥斺€旀棦涓嶈兘"璁句负"涔熶笉鑳?鍙栨秷"銆傚嵆浣跨敤鎴锋兂瑙ｉ櫎褰撳墠閫変腑涔熸棤闂ㄨ矾銆?
**Files changed:**
- `src/engine/image/image-service.ts` 鈥?鏂板 `getCurrentModelName()` 绉佹湁杈呭姪锛堜粠 imageGeneration APIConfig 璇?model锛夛紱鍦ㄦ墍鏈?`writeNpcImageRecord` / `setSecretPartResult` / `writeToSceneArchive` / `regenerateFromPrompts` 鐨?record payload 涓ˉ榻?`model` 瀛楁
- `src/ui/components/panels/ImagePanel.vue` 鈥?`canSelectAvatar` / `canSelectPortrait` 浠呮帓闄?`secret_part`锛屽叾浣?complete 鍥剧墖鍧囧彲閫夛紱銆屽彇娑堣缃€嶆寜閽В闄?`canSelect*` 闄愬埗锛屽彧鐪?`isCurrent*`锛屼繚璇佸綋鍓嶉€変腑鎬昏兘鍙栨秷
- `src/ui/components/panels/CharacterDetailsPanel.vue` 鈥?涓昏褰卞儚妗ｆ鍗＄墖鍚屾牱瑙ｉ櫎 composition gate锛屽缁堟樉绀恒€岃涓哄ご鍍?/ 鍙栨秷澶村儚銆嶃€岃涓虹珛缁?/ 鍙栨秷绔嬬粯銆嶄袱涓垏鎹㈡寜閽紙`setPlayerAvatar` 鏈韩灏辨槸 toggle锛?
**Behavior before:**
- 鍥惧簱鍗＄墖銆屼娇鐢ㄦā鍨嬨€嶃€岀敾椋庛€嶅缁堟樉绀?鏈褰?锛屽嵆浣跨敓鎴愭椂宸查€夊ソ model 鍜岀敾椋?- 璁句簡涓€寮犲ご鍍忓悗鐢熸垚鍚屾鎯虫浛鎹⑩€斺€旇嫢鍚屾 composition 涓庡綋鍓嶄笉涓€鑷达紝鏂板浘娌℃湁銆岃涓哄ご鍍忋€嶆寜閽紝鏃у浘涔熸病鏈夈€屽彇娑堣缃ご鍍忋€嶆寜閽紝瀹屽叏鍗′綇

**Behavior after:**
- 鏂扮敓鎴愮殑鍥剧墖璁板綍閲?`model` / `artStyle` / `backend` / `width` / `height` 鍏ㄩ儴鍐欏叆 archive锛屽浘搴撳崱鐗囨甯告樉绀?- 浠绘剰 complete 闈?secret_part 鍥剧墖閮藉彲浣滀负澶村儚/绔嬬粯鍊欓€夛紱銆屽彇娑堣缃€嶆寜閽湪璇ュ浘鏄綋鍓嶉€変腑鏃舵亽涔呭彲瑙侊紝鎵撻€氬悓娆剧敓鎴愨啋鏇存崲澶村儚鐨勯棴鐜?
**Notes:** 鏃у瓨妗ｉ噷 NPC / 涓昏鍘嗗彶璁板綍娌℃湁 `model` / `width` / `height` / `backend` 瀛楁锛沀I 瀵硅繖浜涘瓧娈甸兘鏈?`|| '鏈褰?` / `|| default` fallback锛岃€佽褰曚笉浼氬穿銆傛柊閫昏緫鍙姝や慨澶嶅悗鐢熸垚鐨勫浘鐗囩敓鏁堛€?
---

## [2026-04-18] E2E Review: 7 HIGH fixes + 48 new unit tests

**Scope:** 鍏ㄩ噺浠ｇ爜瀹¤鍙戠幇鐨?7 涓?HIGH 绾у埆闂淇 + 3 涓柊娴嬭瘯鏂囦欢
**Files changed:**
- `src/engine/image/image-service.ts` 鈥?HIGH-1: 鏂板 `generateSecretPartImage()` 鏂规硶锛圢SFW secret part 瀹屾暣娴佺▼锛歵okenize 鈫?compose 鈫?provider 鈫?state.setSecretPartResult锛? HIGH-3: task queue 鎭㈠浠?constructor 绉诲埌 `engine:state-changed` type='load' 浜嬩欢鐩戝惉; HIGH-4: `callProvider` 鏂板绗?鍙傛暟 `presetParams`锛孨ovelAI 鏃惰嚜鍔ㄤ粠 state tree 璇诲彇 sampler/steps/CFG/smea/seed
- `src/engine/image/task-queue.ts` 鈥?HIGH-2: `restore()` 鏃朵粠宸叉仮澶?task ID 涓彁鍙栨渶澶?counter 鍊硷紝闃叉鏂?task ID 涓庢仮澶嶇殑鍐茬獊
- `src/engine/image/image-state-manager.ts` 鈥?HIGH-5: `writeNpcImageRecord` 澧炲姞 per-NPC history limit 寮哄埗瑁佸壀锛堣 `auto.historyLimit`锛岄粯璁?100锛?- `src/engine/image/tokenizer.ts` 鈥?HIGH-6: `parseTokenizerResponse` 涓嶅啀绉婚櫎 `<鎻愮ず璇嶇粨鏋?` 鍧楋紙output-processor 闇€瑕佸畬鏁寸粨鏋勫寲鍐呭锛?- `src/engine/image/providers/comfyui.ts` 鈥?HIGH-7: `pollForResult` 鎺ュ彈鍙€?`signal?: AbortSignal`锛屾瘡娆″惊鐜凯浠ｆ鏌?`signal?.aborted`
- `src/engine/image/image-size-options.test.ts` 鈥?NEW: 12 tests锛堝昂瀵搁€夐」瑙ｆ瀽/璁℃暟/鍘婚噸/鏍煎紡杞崲锛?- `src/engine/image/task-queue.test.ts` 鈥?NEW: 13 tests锛堝垱寤?鏇存柊/鍒犻櫎/鎭㈠/ID 鍐茬獊闃叉姢锛?- `src/engine/image/image-state-manager.test.ts` 鈥?NEW: 23 tests锛圢PC CRUD/__player__ 浼?NPC/閫夋嫨绠＄悊/鍒犻櫎绾ц仈/绉樺瘑閮ㄤ綅/澹佺焊/鍘嗗彶闄愬埗锛?
**娴嬭瘯鎬绘暟锛?* 751 鈫?799 (+48)锛?6 涓祴璇曟枃浠?
---

## [2026-04-18] Fix: Prompt extraction + player avatar display

**Flow 1:** 鐢熷浘 prompt 鎻愬彇
**Root cause:** AI 鏈夋椂杈撳嚭 `<prompt>...</prompt>` 鑰屼笉鏄?`<鎻愮ず璇?...</鎻愮ず璇?`銆俙output-processor.ts` 鐨?`cleanSubjectPrompt` fallback 鍒楄〃鍙寘鍚?`鎻愮ず璇峘/`璇嶇粍`/`鐢熷浘璇嶇粍`锛屼笉鍖呭惈 `prompt`銆傚鑷存彁鍙栫粨鏋滀负绌猴紝鏈€缁堝彂缁欑敓鍥?API 鐨勬槸 `"..."`銆?**Fix:** `extractFirstMatchingTagContent` 鐨?fallback 鍒楄〃澧炲姞 `'prompt'`锛況esidual tag 娓呯悊澧炲姞 `<prompt>` 鍖归厤銆?
**Flow 2:** 涓昏 hero header 澶村儚鏄剧ず
**Root cause:** `CharacterDetailsPanel.vue` 鐨?hero header 鍙樉绀?`avatarInitial`锛堥瀛楁瘝锛夛紝瀹屽叏娌℃湁妫€鏌?`playerAvatarId`锛堝凡閫夊ご鍍忓浘鐗嘔D锛夈€傜敤鎴疯缃簡澶村儚浣嗙湅涓嶅埌鏁堟灉銆?**Fix:** hero-avatar div 鍐呭鍔?`ImageDisplay` 缁勪欢锛氬綋 `playerAvatarId` 鏈夊€兼椂浠?IndexedDB 鍔犺浇骞舵覆鏌撳渾褰㈠ご鍍忥紝鏃犲ご鍍忔椂 fallback 鍒伴瀛楁瘝銆?
---

## [2026-04-18] Fix: Player archive reactivity 鈥?useValue instead of get()

**Flow:** 涓昏鐢熷浘 鈫?璁句负澶村儚/绔嬬粯
**Root cause:** `CharacterDetailsPanel.playerArchive` computed 浣跨敤 `get('瑙掕壊.鍥剧墖妗ｆ')` 鍛戒护寮忚鍙栵紝涓嶅缓绔嬪搷搴斿紡渚濊禆銆俙setValue` 鍐欏叆鍚?computed 涓嶉噸鏂拌绠楋紝`playerAvatarId`/`playerPortraitId` 姘歌繙鏄┖瀛楃涓层€?**Files changed:**
- `src/ui/components/panels/CharacterDetailsPanel.vue` 鈥?`playerArchive` 鏀逛负鍩轰簬 `useValue<Record<string, unknown>>('瑙掕壊.鍥剧墖妗ｆ')` 鐨勫搷搴斿紡 computed

**Behavior before:** 鐐瑰嚮璁句负澶村儚/绔嬬粯鍚庢棤浠讳綍瑙嗚鍙嶉锛宻tats bar 濮嬬粓鏄剧ず"鏈缃?
**Behavior after:** 鐐瑰嚮鍚庢寜閽枃瀛椼€乷verlay badge銆乻tats bar 绔嬪嵆鏇存柊

---

## [2026-04-18] Fix: Player Image Flow Integration 鈥?__player__ pseudo-NPC + custom presets

**Flow:** 涓昏鐢熷浘 + Rules 瑙勫垯搴旂敤
**Root cause:** 涓変釜鐙珛闂锛?1. CharacterDetailsPanel 鐢?`characterName: 涓昏鍚峘 璋冪敤 image-service锛屼絾涓昏涓嶅湪 relationships 鏁扮粍涓紝瀵艰嚧 `writeNpcImageRecord` 闈欓粯澶辫触銆傛墜鍔ㄥ啓 `瑙掕壊.鍥剧墖妗ｆ` 浣?ImagePanel 浠庝笉璇昏繖涓矾寰勩€?2. ImagePanel Gallery/History 鍙亶鍘?NPC relationships + 鍦烘櫙妗ｆ锛屼笉鍖呭惈涓昏鐨?`瑙掕壊.鍥剧墖妗ｆ`銆?3. `image-service` 璋冪敤 `getTransformerPresetContext` 鏃朵笉浼?`customPresets/customBundles`锛屾案杩滅敤寮曟搸榛樿鍊硷紝蹇界暐 Rules tab 鐢ㄦ埛缂栬緫鐨勮鍒欍€?
**Files changed:**
- `src/engine/image/image-state-manager.ts` 鈥?鏂板 `PLAYER_PSEUDO_NPC_ID = '__player__'` 甯搁噺 + `isPlayer()` 鏂规硶; `findNpc`/`getNpcArchive`/`mutateNpc` 鍏ㄩ儴澧炲姞 `__player__` 鐗规畩鍒嗘敮锛氱洿鎺ヨ鍐?`瑙掕壊.鍥剧墖妗ｆ` 璺緞锛堜笉鍐嶅幓 relationships 鏁扮粍鎵撅級
- `src/engine/image/image-service.ts` 鈥?鏂板 `getCustomPresetOptions()` 绉佹湁鏂规硶锛氫粠 state tree 璇诲彇 `ruleTemplates` + `modelRulesets`锛岃浆鎹负 `TransformerPromptPreset[]` + `ModelTransformerBundle[]` 鏍煎紡; 涓ゅ `getTransformerPresetContext` 璋冪敤浼犲叆 `this.getCustomPresetOptions()`
- `src/ui/components/panels/ImagePanel.vue` 鈥?Gallery: 鏂板 `playerArchiveRaw`/`playerName` reactive refs + `getPlayerArchiveHistory()`; `npcsWithImages` 鍦ㄥ垪琛ㄥご閮ㄦ彃鍏ヤ富瑙掕櫄鎷熸潯鐩? `galleryImages`/`galleryNpcData`/`getCurrentArchive` 澧炲姞 `__player__` 鍒嗘敮; `combinedHistory` 鏂板涓昏妗ｆ閬嶅巻; Gallery NPC 鍚嶇О鏄剧ず锛歚__player__` 鈫?涓昏濮撳悕
- `src/ui/components/panels/CharacterDetailsPanel.vue` 鈥?`generatePlayerImage` 鏀逛负 `characterName: '__player__'`; 鍒犻櫎鎵嬪姩妗ｆ鍐欏叆锛堝鎵樼粰寮曟搸 writeNpcImageRecord锛? 閿氱偣鏌ユ壘鍏煎 `subjectId` 鍜?`npcName` 鍙屽瓧娈? 鎻愬彇閿氱偣鏃跺悓鏃惰缃?`npcName: '__player__'`

**鐢ㄦ埛鐪嬪埌浠€涔堝彉鍖栵細**
- 鍦?CharacterDetailsPanel 鐢熸垚涓昏鍥剧墖鍚庯紝**鍥惧儚宸ヤ綔鍙扮殑鍥惧簱 tab** 宸︿晶 NPC 鍒楄〃椤堕儴鍑虹幇涓昏鏉＄洰锛堟樉绀轰富瑙掑鍚嶈€岄潪 `__player__`锛?- 鐐瑰嚮涓昏鍙煡鐪嬪叾鎵€鏈夌敓鍥惧巻鍙诧紝鏀寔璁句负澶村儚/绔嬬粯/鑳屾櫙銆佸垹闄ゃ€佹竻绌?- **鍘嗗彶 tab** 鐨勫悎骞跺巻鍙蹭腑鍖呭惈涓昏鐢熷浘璁板綍
- **Rules tab** 涓敤鎴风紪杈戠殑鑷畾涔夎鍒欙紙妯″瀷瑙勫垯闆?+ NPC/鍦烘櫙/鍒ゅ畾杞寲瑙勫垯锛夌幇鍦ㄤ細**瀹為檯搴旂敤鍒扮敓鍥炬祦绋?*锛堜箣鍓嶅叏閮ㄨ蹇界暐锛屽彧鐢ㄥ紩鎿庨粯璁ゅ€硷級

---

## [2026-04-18] Fix: API Function Assignment Persistence 鈥?5 missing UsageTypes

**Flow:** API 鍔熻兘鍒嗛厤鎸佷箙鍖?**Root cause:** `engine-api.ts` 涓殑 `ALL_USAGE_TYPES` 鏁扮粍鍙湁 13 涓被鍨嬶紝浣?`UsageType` union 瀹氫箟浜?18 涓€傜己澶辩殑 5 涓被鍨?(`assistant`, `imageGeneration`, `imageCharacterTokenizer`, `imageSceneTokenizer`, `imageSecretTokenizer`, `bodyPolish`) 鐨?API 鍒嗛厤鍦?`loadFromStorage` 鏃惰 `ALL_USAGE_TYPES.map()` 寰幆涓㈠純锛堝洜涓哄畠浠笉鍦ㄦ暟缁勪腑锛夛紝姣忔鍒锋柊鍚庨噸缃负 `default`銆?**Files changed:**
- `src/engine/stores/engine-api.ts:21-26` 鈥?`ALL_USAGE_TYPES` 浠?13 涓墿灞曚负 18 涓紝鏂板 `assistant`, `imageGeneration`, `imageCharacterTokenizer`, `imageSceneTokenizer`, `imageSecretTokenizer`, `bodyPolish`

**Behavior before:** AI鍔╂墜銆佸浘鍍忕敓鎴愩€佽鑹?鍦烘櫙/绉佸瘑瑙嗚鎻愬彇銆佹枃鏈鼎鑹茶繖6涓姛鑳界殑 API 鍒嗛厤鍒锋柊鍚庡叏閮ㄩ噸缃负"榛樿 API (宸茬鐢?"
**Behavior after:** 鎵€鏈?18 涓姛鑳界殑 API 鍒嗛厤姝ｇ‘鎸佷箙鍖栧埌 localStorage锛屽埛鏂板悗淇濇寔鐢ㄦ埛璁剧疆

---

## [2026-04-18] Fix: Image Settings Persistence 鈥?auto-save + schema definition

**Flow:** 鍥惧儚璁剧疆鎸佷箙鍖?**Root cause:** ImagePanel 閫氳繃 `setValue()` 鍐欏叆 state tree 鐨?40+ 涓矾寰?(`绯荤粺.鎵╁睍.image.*`) 浠庢湭瑙﹀彂 `engine:request-save`锛屽鑷磋繖浜涗慨鏀圭暀鍦ㄥ唴瀛樹腑涓嶈鎸佷箙鍖栧埌 IndexedDB銆傚埛鏂伴〉闈㈠悗鎵€鏈夊浘鍍忚缃涪澶便€侰haracterDetailsPanel 鍚屾牱瀛樺湪姝ら棶棰橈紙`瑙掕壊.鍥剧墖妗ｆ` + `绯荤粺.鎵╁睍.image.characterAnchors`锛夈€傛澶?`绯荤粺.鎵╁睍.image` 鍜?`瑙掕壊.鍥剧墖妗ｆ` 涓嶅湪 state schema 涓畾涔夛紝鍙兘鍦?schema 楠岃瘉鏃惰鍓ョ銆?**Files changed:**
- `src/ui/components/panels/ImagePanel.vue` 鈥?鏂板 `useValue('绯荤粺.鎵╁睍.image')` + `watch(deep: true)` + 800ms debounce 鈫?`eventBus.emit('engine:request-save')`銆備换浣曞浘鍍忛厤缃彉鍖栬嚜鍔ㄨЕ鍙戜竴娆℃寔涔呭寲銆?- `src/ui/components/panels/CharacterDetailsPanel.vue` 鈥?鍦ㄦ墍鏈?`setValue('瑙掕壊.鍥剧墖妗ｆ')` 鍜?`setValue('绯荤粺.鎵╁睍.image.characterAnchors')` 璋冪敤鍚庢坊鍔?`eventBus.emit('engine:request-save')`锛堝叡7澶勶級銆?- `public/packs/tianming/schemas/state-schema.json` 鈥?鍦?`绯荤粺.鎵╁睍` 涓嬫柊澧?`image` 瀵硅薄瀹氫箟锛堝惈 default: enabled/config/artistPresets/characterAnchors/transformerPresets/modelRulesets/ruleTemplates/rules/sceneArchive/tasks/persistentWallpaper锛夛紱鍦?`瑙掕壊` 涓嬫柊澧?`鍥剧墖妗ｆ` 瀵硅薄瀹氫箟锛堝惈 default: 鐢熷浘鍘嗗彶/宸查€夊ご鍍忓浘鐗嘔D/宸查€夌珛缁樺浘鐗嘔D/鏈€杩戠敓鍥剧粨鏋滐級銆?
**Behavior before:** 鎵€鏈夊浘鍍忚缃紙鍚庣閫夋嫨/NovelAI鍙傛暟/棰勮/瑙勫垯/閿氱偣/鑷姩浠诲姟閰嶇疆绛夛級鍒锋柊鍚庝涪澶憋紝鎭㈠涓虹┖鍊兼垨榛樿鍊?**Behavior after:** 浠讳綍鍥惧儚璁剧疆鍙樺寲 鈫?800ms 闃叉姈 鈫?鑷姩淇濆瓨鍒?IndexedDB銆傚埛鏂板悗鎵€鏈夎缃繚鎸佷笉鍙樸€係chema 淇濊瘉 image 鎵╁睍鍦?state tree 楠岃瘉鏃朵笉琚墺绂汇€?
---

## [2026-04-18] Image Rework: Phase 9 鈥?Prompt Full Import + Size Options

**Scope:** 鍏ㄩ噺 prompt 瀹¤ + 灏哄閫夐」绯荤粺绉绘
**Files changed:**
- `src/engine/image/image-size-options.ts` 鈥?NEW: 浠?MRJH `imageSizeOptions.ts` 鍏ㄩ噺绉绘銆?涓父鐢ㄥ昂瀵?+ 9涓珫灞忓満鏅昂瀵?+ 10涓í灞忓満鏅昂瀵?+ parseSizeString + sizeOptionsToSelectOptions + 鎸夋瀯鍥剧殑榛樿灏哄鏄犲皠
- `src/ui/components/panels/ImagePanel.vue` 鈥?Scene tab 鍜?Settings tab 鐨勫垎杈ㄧ巼涓嬫媺浠庣‖缂栫爜3涓€夐」鏀逛负浣跨敤 SCENE_PORTRAIT/LANDSCAPE_SIZE_OPTIONS (9/10涓€夐」)

**瀹¤缁撴灉锛?*
- 9.1 Transformer presets: Phase 1.5 宸插畬鎴?(9涓猵resets + 3涓猙undles, 532琛?
- 9.2 CoT masquerade files: 4涓凡鍒涘缓 (imageCharacterCot/imageSceneCot/imageSecretPartCot/imageAnchorCot), pngParseCot 涓嶉€傜敤 (AGA 鐢ㄧ洿鎺ヨВ鏋?
- 9.3 Scene/Secret prompts: Phase 1.6/1.7 宸插畬鎴?(鍦烘櫙绌洪棿閫昏緫+鍒ゅ畾+绉樺瘑閮ㄤ綅)
- 9.4 Size options: 鏈瀹屾垚 鈫?鍞竴缂哄け椤?
**鐢ㄦ埛鐪嬪埌浠€涔堝彉鍖栵細**
- Scene tab 鍒嗚鲸鐜囦笅鎷変粠 3 涓€夐」 (1024x576/1280x720/1920x1080) 鍙樹负 **9-10 涓€夐」**锛堝惈姣斾緥璇存槑锛夛紝濡?"1024x576 (16:9, 妯睆)"銆?1216x832 (19:13, 瓒呴珮娓?"
- Settings tab 鑷姩鍦烘櫙鍒嗚鲸鐜囧悓鏍锋敼涓哄畬鏁撮€夐」鍒楄〃
- 鍒囨崲妯睆/绔栧睆鏃堕€夐」鍒楄〃鑷姩鍒囨崲锛堟í灞?0涓?绔栧睆9涓級

---

## [2026-04-18] Image Rework: Phase 8 鈥?Player Character Image Enhancement

**Scope:** CharacterDetailsPanel 涓昏鐢熷浘tab鍔熻兘瀵归綈MRJH playerImageWorkflow
**Files changed:**
- `src/ui/components/panels/CharacterDetailsPanel.vue` 鈥?generatePlayerImage: 浠庣‖缂栫爜backend='novelai'鏀逛负璇诲彇璁剧疆榛樿鍚庣; 鏂板浼犲叆 composition/artStyle/extraPrompt/anchorPositive/anchorNegative/npcDataJson/preset; 妗ｆ鍐欏叆璁板綍 composition 鍜?status 瀛楁; 妗ｆ鍗＄墖澧炲姞鏋勫浘/鐘舵€?閫変腑鏍囩 overlay badges; avatar 鎸夐挳浠?portrait 鏋勫浘鏄剧ず, portrait 鎸夐挳浠?half-body/full-length 鏄剧ず; 鏂板鍒犻櫎鎸夐挳 + deletePlayerImage 鍑芥暟(绾ц仈娓呴櫎閫変腑); setPlayerAvatar/setPlayerPortrait 鏀逛负 toggle 閫昏緫(鍐嶆鐐瑰嚮鍙栨秷); anchor toggles 浠庡師鐢?checkbox 鏀逛负 AgaToggle 缁勪欢 + 鍗＄墖寮忓竷灞€ + 鎻忚堪鏂囧瓧

**鐢ㄦ埛鐪嬪埌浠€涔堝彉鍖栵細**
- 鐢熸垚鎸夐挳鐜板湪浣跨敤璁剧疆tab閰嶇疆鐨勯粯璁ゅ悗绔紙涓嶅啀纭紪鐮丯ovelAI锛?- 鐢熸垚鏃朵紶鍏ユ瀯鍥?鐢婚/棰濆瑕佹眰/閿氱偣/灏哄绛夎〃鍗曞€硷紙涔嬪墠鍏ㄩ儴琚拷鐣ワ級
- 鐢熸垚鐨勫浘鐗囪褰曞寘鍚?composition 瀛楁锛屽悗缁殑 avatar/portrait 鎸夐挳鏍规嵁鏋勫浘绫诲瀷鏉′欢鏄剧ず
- 姣忓紶鍥剧墖宸︿笂瑙掓樉绀?overlay 鏍囩锛氭垚鍔?澶辫触 + 鏋勫浘绫诲瀷 + 宸茶澶村儚/宸茶绔嬬粯
- 姣忓紶鍥剧墖搴曢儴鏂板"鍒犻櫎"鎸夐挳锛堢孩鑹诧級锛屽垹闄ゆ椂绾ц仈娓呴櫎澶村儚/绔嬬粯缁戝畾
- 澶村儚/绔嬬粯鎸夐挳鏀逛负toggle妯″紡锛堢偣鍑诲凡璁剧疆鐨勫彲浠ュ彇娑堬級
- 閿氱偣绠＄悊鐨?涓紑鍏充粠鍘熺敓checkbox鏀逛负AgaToggle缁勪欢锛屾湁鍗＄墖杈规鍜岃鏄庢枃瀛?
---

## [2026-04-18] Image Rework: Phase 7 鈥?Settings Tab (8th Tab)

**Scope:** 鍥惧儚璁剧疆浠?SettingsPanel 杩佺Щ鍒?ImagePanel 绗?8 涓?tab
**Files changed:**
- `src/ui/components/panels/ImagePanel.vue` 鈥?鏂板 settings tab: 鍩虹(鎬诲紑鍏?鍚庣+杞寲鍣╰oggle)銆丯ovelAI璁剧疆(閲囨牱鍣?鍣偣琛?姝ユ暟/CFG/SMEA/seed/榛樿璐熼潰鎻愮ず璇?銆丆omfyUI璁剧疆(workflow JSON)銆佽浆鍖栧櫒(鐙珛妯″瀷+endpoint/apiKey/model+寮哄埗瑁镐綋璇箟)銆佽嚜鍔ㄤ换鍔?鍦烘櫙妯″紡+鍦烘櫙鐙珛鎺ュ彛+鏋勫浘/鏂瑰悜/鍒嗚鲸鐜?NPC鑷姩+鎬у埆/閲嶈鎬?鐢婚)
- `src/ui/components/panels/SettingsPanel.vue` 鈥?鍥惧儚鐢熸垚section浠巭200琛岃缁嗚缃缉鍑忎负浠呬繚鐣欐€诲紑鍏硉oggle + "鍓嶅線鍥惧儚宸ヤ綔鍙拌缃?閾炬帴 (SettingsPanel chunk 浠?59kB 鈫?50kB)

**鐢ㄦ埛鐪嬪埌浠€涔堝彉鍖栵細**
- **ImagePanel** 椤堕儴 tab bar 澶氫簡绗?涓?璁剧疆"tab
- 鐐瑰嚮杩涘叆鍚庣湅鍒?涓嫭绔?preset-card 鍖哄煙锛堟瘡涓湁鍙充笂瑙掓爣绛撅級锛?  - "鍩虹": 鏂囩敓鍥炬€诲紑鍏?+ 鍚庣绫诲瀷 + NPC璇嶇粍杞寲鍣?toggle (NovelAI 鏃跺己鍒跺惎鐢ㄤ笖 disabled)
  - "NovelAI 璁剧疆"(浠?NovelAI 鍚庣鏃舵樉绀?: 鑷畾涔夊弬鏁?toggle + 3鍒楃綉鏍?閲囨牱鍣?鍣偣琛?姝ユ暟) + 3鍒楃綉鏍?CFG/SMEA/Seed) + 榛樿璐熼潰鎻愮ず璇?textarea
  - "ComfyUI 璁剧疆"(浠?ComfyUI 鍚庣鏃舵樉绀?: workflow JSON textarea + 鍗犱綅绗﹁鏄?  - "杞寲鍣?: 鐙珛妯″瀷 toggle 鈫?灞曞紑鍚?endpoint/apiKey/model 杈撳叆妗?+ 寮哄埗瑁镐綋璇箟 toggle
  - "鑷姩浠诲姟": 鍦烘櫙鐢熷浘妯″紡 + 鍦烘櫙鐙珛鎺ュ彛 toggle 鈫?灞曞紑鍚庡悗绔?鍦板潃/瀵嗛挜/妯″瀷 + 鍦烘櫙鏋勫浘/鏂瑰悜/鍒嗚鲸鐜?+ NPC鑷姩鐢熷浘 + 鎬у埆/閲嶈鎬?鐢婚 3鍒楃綉鏍?- **SettingsPanel** 鐨勫浘鍍忕敓鎴恠ection浠庡瘑瀵嗛夯楹荤殑璁剧疆缂╁噺涓哄彧鏈夋€诲紑鍏?+ 涓€琛屾枃瀛?璇︾粏璁剧疆宸茶縼绉昏嚦鍥惧儚宸ヤ綔鍙扳啋璁剧疆"锛堝甫鍙偣鍑婚摼鎺ワ級

---

## [2026-04-18] Fix: Rules Tab 鈥?bridge engine defaults to UI state

**Flow:** Rules Tab preset initialization
**Root cause:** 寮曟搸灞?(`transformer-presets.ts`) 宸叉湁 9 涓?transformer presets + 3 涓?model bundles 鍚畬鏁?prompt 鍐呭锛圥hase 1.5 瀹屾垚锛夛紝浣?UI 灞傜殑 Rules Tab 浠?state tree 璇诲彇 `modelRulesets` 鍜?`ruleTemplates`锛岄娆′娇鐢ㄦ椂杩欎簺 state 鏄┖鐨勩€備袱鑰呬箣闂存病鏈夋ˉ鎺ワ紝瀵艰嚧鐢ㄦ埛鐪嬪埌绌虹殑瑙勫垯缂栬緫鍣ㄣ€?**Files changed:**
- `src/ui/components/panels/ImagePanel.vue` 鈥?鏂板 `enginePresetToRuleTemplate()` 鍜?`engineBundleToModelRuleset()` 杞崲鍑芥暟; onMounted 涓娴?state tree 鏄惁涓虹┖锛屽鏋滅┖鍒欎粠 `getDefaultPresets()` / `getDefaultModelBundles()` 鑷姩鍒濆鍖? 鏂板 watcher 鑷姩閫変腑宸插惎鐢ㄧ殑 model ruleset 鍜屽綋鍓?scope 鐨勭涓€涓?rule template

**Behavior before:** Rules Tab 鎵撳紑鍚庢ā鍨嬭鍒欓泦鍜岃鍒欐ā鏉垮垪琛ㄥ叏閮ㄤ负绌猴紝textarea 鍐呭涓虹┖锛岀敤鎴锋棤娉曠湅鍒颁换浣曢粯璁?prompt
**Behavior after:** 棣栨杩涘叆 Rules Tab 鏃惰嚜鍔ㄤ粠寮曟搸榛樿鍊兼敞鍏?3 涓ā鍨嬭鍒欓泦 (NAI/Gemini/Grok, 鍚畬鏁寸殑妯″瀷涓撳睘鎻愮ず璇嶅拰閿氬畾妯″紡鎻愮ず璇? + 9 涓鍒欐ā鏉?(3脳NPC + 3脳鍦烘櫙 + 3脳鍦烘櫙鍒ゅ畾, 鍚畬鏁寸殑鍩虹瑙勫垯/閿氬畾瑙勫垯/鍥為€€瑙勫垯/杈撳嚭鏍煎紡)銆傜敤鎴峰彲浠ョ洿鎺ョ湅鍒板苟缂栬緫杩欎簺棰勫～鍏呯殑 prompt 鍐呭

---

## [2026-04-17] Image Rework: Phase 6 鈥?Rules Tab Enhancement

**Scope:** Rules tab 瀵归綈 MRJH 鎻愮ず璇嶈鍒欎腑蹇冨竷灞€
**Files changed:**
- `src/ui/components/panels/ImagePanel.vue` 鈥?6.1: 妯″瀷瑙勫垯闆嗗鍔犲鍑?瀵煎叆鎸夐挳 + exportModelRulesets/importModelRulesets 鍑芥暟; 6.2: 瑙勫垯妯℃澘澧炲姞 rules-template-section 鍖呰９ + per-scope 鎻忚堪鎻愮ず (瑙掕壊/鍦烘櫙/鍒ゅ畾鍚勬湁涓嶅悓璇存槑鏂囨湰) + 瑙勫垯妯℃澘header涓巗cope鍒囨崲閲嶆帓甯冨眬

**鐢ㄦ埛鐪嬪埌浠€涔堝彉鍖栵細**
- 妯″瀷瑙勫垯闆嗗尯鍩熷浜?瀵煎嚭"/"瀵煎叆"鎸夐挳锛堜箣鍓嶅彧鏈夊叏灞€瀵煎嚭瀵煎叆锛屾ā鍨嬭鍒欓泦鏃犳硶鍗曠嫭瀵煎嚭瀵煎叆锛?- 瑙勫垯妯℃澘鍖哄煙鏈変簡鐙珛鐨勮竟妗嗗崱鐗囧寘瑁癸紝椤堕儴鏄剧ず"瑙勫垯妯℃澘"鏍囬 + 璇存槑鏂囧瓧 + scope鍒囨崲鎸夐挳
- 鍒囨崲 NPC/鍦烘櫙/鍒ゅ畾 scope 鏃讹紝涓嬫柟浼氭樉绀哄搴旂殑鍔熻兘璇存槑锛?  - NPC: "瑙掕壊鍥句娇鐢ㄥ熀纭€瑙勫垯锛涢敋瀹氬紑鍚悗鏀圭敤涓撳睘閿氬畾瑙勫垯銆?
  - 鍦烘櫙: "鍦烘櫙鍥句娇鐢ㄧ┖闂翠笌鏋勫浘瑙勫垯锛涜鑹查敋瀹氬瓨鍦ㄦ椂鏀圭敤鍦烘櫙閿氬畾瑙勫垯銆?
  - 鍒ゅ畾: "鐢ㄤ簬鍒ゆ柇褰撳墠鏂囨湰搴旂敓鎴愰鏅満鏅繕鏄満鏅揩鐓с€?
- 鍏ㄥ眬瀵煎嚭/瀵煎叆鎸夐挳鏂囨鏀逛负"瀵煎嚭鍏ㄩ儴"/"瀵煎叆鍏ㄩ儴"浠ュ尯鍒嗘ā鍨嬭鍒欓泦鐨勫崟鐙鍑哄鍏?
---

## [2026-04-17] Image Rework: Phase 5 鈥?Presets Tab Restructure

**Scope:** Presets tab 缁撴瀯閲嶇粍瀵归綈 MRJH ImageManagerModal Presets 甯冨眬
**Files changed:**
- `src/ui/components/panels/ImagePanel.vue` 鈥?5.1: 榛樿棰勮缁戝畾澧炲姞瑙掓爣; 5.2: 瑙掕壊閿氱偣澧炲姞鎻愬彇鐘舵€佹秷鎭?(3鎬? extracting/done/error) + 瑙掓爣; 5.3: PNG鐢婚棰勮鎷嗕负鐙珛section (缂╃暐鍥惧垪琛?20px + 缂栬緫鍣?+ 瀵煎叆宸ヤ綔娴?; 5.4: 鐢诲笀涓查璁炬媶涓虹嫭绔媠ection (scope涓嬫媺 + 涓嬫媺缂栬緫鍣?; 5.5: 杞寲鍣ㄩ璁惧鍔犺鏍? 鍏ㄩ儴section缁熶竴 preset-card 甯orner badge 鏍峰紡

**鐢ㄦ埛鐪嬪埌浠€涔堝彉鍖栵細**
- 棰勮 tab 浠?涓€涓贩鍚堝垪琛?鍙樹负 **5涓嫭绔嬪崱鐗?* 绾靛悜鎺掑垪锛屾瘡涓湁鍙充笂瑙掔被鍨嬫爣绛?- PNG 棰勮鍒楄〃鐜板湪鏄剧ず**缂╃暐鍥?* (80脳56) 鑰屼笉鏄函鏂囧瓧
- 鐢诲笀涓插拰 PNG 棰勮鏄?*鐙珛缂栬緫鍖哄煙**锛屼笉鍐嶆贩鍦ㄥ悓涓€涓?sidebar+editor
- 鐢诲笀涓茬鐞嗙敤 scope 涓嬫媺+棰勮涓嬫媺鐨勬柟寮忛€夋嫨缂栬緫瀵硅薄
- 閿氱偣鎻愬彇鍚庢湁褰╄壊鐘舵€佹秷鎭锛堟彁鍙栦腑=閲戣壊/瀹屾垚=缁胯壊/澶辫触=绾㈣壊锛?
---

## [2026-04-17] Image Rework: Phase 4 鈥?Gallery/Scene/Queue/History Tab UI

**Scope:** ImagePanel 4 涓?tab 鍏ㄩ噺瀵归綈 MRJH ImageManagerModal 甯冨眬涓庡姛鑳?**Files changed:**
- `src/engine/image/image-service.ts` 鈥?鏂板 setNpcBackground/clearNpcBackground/deleteNpcImage 濮旀墭鍒?ImageStateManager
- `src/ui/components/panels/ImagePanel.vue` 鈥?4.1 Gallery: composition-conditional buttons (澶村儚浠卲ortrait, 绔嬬粯浠卙alf-body/full-length, 鑳屾櫙鏃犻檺鍒?, 鎸佷箙澹佺焊 toggle, 鍒犻櫎纭; 4.2 Scene: 鍏ㄩ潰閲嶅仛 (6缁熻鍗? 鍦烘櫙妗ｆ鍘嗗彶, 鍦烘櫙闃熷垪鍖? 鍘嗗彶闄愬埗, 鍙睍寮€鎻愮ず璇?; 4.3 Queue: 4娓呯┖鎸夐挳 (NPC宸插畬鎴?鍏ㄩ儴 + 鍦烘櫙宸插畬鎴?鍏ㄩ儴), 4鍗″厓鏁版嵁缃戞牸, 绫诲瀷瑙掓爣, 澶辫触鍙屾寜閽? 4.4 History: 妯悜甯冨眬 (1/3鍥剧墖+2/3鍏冩暟鎹?, 鍚堝苟NPC+鍦烘櫙鍘嗗彶, 鍒嗗埆娓呯┖鎸夐挳, 鍙睍寮€鎻愮ず璇?
**Behavior before:** Gallery 鎸夐挳鏃犳瀯鍥炬潯浠? Scene tab 浠呭熀纭€澹佺焊+琛ㄥ崟; Queue tab 浠?涓竻绌烘寜閽?绠€鍗曞垪琛? History tab 绾靛悜鍗＄墖+浠呬换鍔￠槦鍒楁暟鎹?**Behavior after:** Gallery MRJH 1:1 鎸夐挳閫昏緫; Scene tab 瀹屾暣 (澹佺焊+6缁熻+闃熷垪+妗ｆ鍘嗗彶); Queue tab 4娓呯┖+4鍗″厓鏁版嵁+瑙掓爣; History tab 妯悜甯冨眬+鍚堝苟妗ｆ鍘嗗彶+3鍙睍寮€璇︽儏

---

## [2026-04-17] Image Rework: Phase 2.5 鈥?NPC Image State Manager

**Scope:** 鍥剧墖鐘舵€佺鐞?鈥?NPC 妗ｆ CRUD + 閫夋嫨绠＄悊 + 骞跺彂閿?+ 鍦烘櫙澹佺焊 + 绉佸瘑閮ㄤ綅
**Root cause:** AGA 鐨?image-service 鍐呰仈浜嗗熀鏈殑 NPC 妗ｆ鍐欏叆锛屼絾缂哄皯: 鑳屾櫙閫夋嫨, 鍒犻櫎鍥剧墖, 娓呯┖鍘嗗彶, 鑷姩澶村儚 fallback, 绉佸瘑閮ㄤ綅缁撴灉绠＄悊, 鎸佷箙澹佺焊, 骞跺彂鐢熸垚閿?**Files changed:**
- `src/engine/image/image-state-manager.ts` 鈥?NEW: ImageStateManager class. NPC: get/set/clear avatar+portrait+background, writeNpcImageRecord (dedup+sort+auto-fallback), deleteNpcImage (绾ц仈娓呴櫎閫夋嫨), clearNpcHistory. Secret: set/get per-part result. Scene: set/clear wallpaper, set/clear persistent wallpaper. Lock: isGenerating/lock/unlock concurrent generation.
- `src/engine/image/image-service.ts` 鈥?闆嗘垚 ImageStateManager (`service.state`); generateCharacterImage 澧炲姞骞跺彂閿?(lock/unlock in try/finally); archive 鍐欏叆濮旀墭缁?state.writeNpcImageRecord; 鏃?state 鏂规硶濮旀墭缁?state manager; paths 浠?private 鏀逛负 constructor-only (涓嶅啀鍐呰仈浣跨敤)

**Behavior before:** 鏃犲苟鍙戦攣锛堝悓涓€ NPC 鍙噸澶嶆彁浜わ級; 鏃犺儗鏅€夋嫨; 鏃犲垹闄?娓呯┖; 鏃犺嚜鍔?avatar fallback; 鏃犵瀵嗛儴浣嶇鐞? state 鏂规硶鏁ｈ惤鍦?image-service
**Behavior after:** 骞跺彂閿侀樆姝㈤噸澶嶇敓鎴? 鍏ㄩ儴 CRUD 闆嗕腑鍦?ImageStateManager; 鍒犻櫎鍥剧墖鑷姩娓呴櫎鐩稿叧閫夋嫨; 澶村儚鍒犻櫎鍚庤嚜鍔?fallback 鍒颁笅涓€寮犲悎閫傚浘鐗? 绉佸瘑閮ㄤ綅缁撴灉鐙珛瀛樺偍

---

## [2026-04-17] Image Rework: Phase 1.10 鈥?ComfyUI Workflow Template System

**Scope:** ComfyUI 宸ヤ綔娴佹ā鏉?鈥?placeholder 娉ㄥ叆 + 閫掑綊 JSON 鏇挎崲
**Files changed:**
- `src/engine/image/comfyui-workflow.ts` 鈥?NEW: buildComfyUIWorkflow 鍑芥暟锛屾敮鎸?16 涓?placeholder锛堝弻涓嬪垝绾?+ handlebars 涓ょ鏍煎紡锛夛紝閫掑綊 JSON 鏍戞浛鎹紝鑷姩妫€娴嬫槸鍚︽湁鐙珛 negative 瀛楁

**鈿狅笍 FRONTEND TODO:** Settings Tab 3 "鍚庣璁剧疆" 闇€瑕?ComfyUI workflow JSON textarea

---

## [2026-04-17] Image Rework: Phase 1.11 鈥?Image Localization

**Scope:** 鍥剧墖鏈湴鍖栨寔涔呭寲 鈥?URL 鈫?IndexedDB
**Files changed:**
- `src/engine/image/image-localization.ts` 鈥?NEW: persistImageLocally 鍑芥暟锛屼笁绉嶈緭鍏? data URL 鈫?blob 鈫?store, HTTP URL 鈫?fetch 鈫?store, existing key 鈫?pass through

**鈿狅笍 FRONTEND TODO:** Gallery "淇濆瓨鍒版湰鍦? 鎸夐挳 + "璁句负甯搁┗澹佺焊" 瑙﹀彂

---

## [2026-04-17] Image Rework: Phase 1.9 鈥?Character Anchor AI Extraction

**Scope:** 瑙掕壊閿氱偣 AI 鎻愬彇 鈥?缁撴瀯鍖栬瑙夌壒寰?+ 瑙掕壊鍚嶇Щ闄?+ JSON 瑙ｆ瀽
**Root cause:** AGA 鐨?anchor-extractor.ts 鍙湁 createAnchor/updateAnchorTokens 宸ュ巶鍑芥暟锛岀己灏?AI 椹卞姩鐨勭粨鏋勫寲鐗瑰緛鎻愬彇
**Files changed:**
- `src/engine/image/anchor-extractor.ts` 鈥?澧炲己: extractAnchorViaAI 鍑芥暟锛堟帴鍙?AIService + npcDataJson 鈫?璋冪敤 LLM 鈫?瑙ｆ瀽 JSON 鈫?10 绫荤粨鏋勫寲鐗瑰緛 + positive/negative prompt + notes锛夛紝鍚郴缁?prompt (verbatim from MRJH imageTasks.ts:1292-1308, 鏃犳渚犳湳璇?, removeNameFromPrompt/removeNameFromFeatures锛堣鑹插悕娓呯悊锛夛紝createAnchor/updateAnchorTokens 鏇存柊鏀寔 structuredFeatures

**鈿狅笍 FRONTEND TODO (Phase 5-6: Presets Tab 鈥?Anchor Management)**
闇€瑕?"AI鎻愬彇閿氱偣" 鎸夐挳 + NPC 閫夋嫨鍣?+ 閿氱偣缂栬緫鍣?+ 3 涓?toggle (鍚敤/榛樿闄勫姞/鍦烘櫙鑱斿姩)

---

## [2026-04-17] Image Rework: Phase 1.8 鈥?PNG Metadata + Style Extraction

**Scope:** PNG 鍏冩暟鎹彁鍙?鈥?tEXt/zTXt/iTXt + EXIF + NovelAI stealth alpha + NovelAI JSON + SD-WebUI + LoRA
**Root cause:** AGA 鐨?png-metadata.ts 鏄?111 琛岄鏋讹紝浠呮敮鎸佸熀鏈?tEXt chunk + SD 鍙傛暟鏂囨湰銆傜己灏? (1) zTXt 鍘嬬缉鍧? (2) EXIF eXIf chunk 瑙ｆ瀽 (ImageDescription/UserComment/XPComment), (3) NovelAI JSON Comment 瑙ｆ瀽 (prompt/uc/sampler/steps/cfg 绛夊畬鏁村弬鏁?, (4) NovelAI stealth alpha 闅愬啓鎻愬彇 (bit-level LSB), (5) NovelAI raw byte 鎼滅储鍥為€€, (6) LoRA 寮曠敤鎻愬彇, (7) 瀹屾暣 NovelAI V4 鍙傛暟 (smea/brownian/dynamic_thresholding 绛?
**Files changed:**
- `src/engine/image/png-metadata.ts` 鈥?瀹屽叏閲嶅啓 (~400 lines): iteratePngChunks (chunk 杩唬), parseTextChunk (tEXt/zTXt/iTXt 鍚?zlib 瑙ｅ帇), extractExifMetadata (EXIF IFD 閫掑綊 + UserComment decode), extractNovelAIStealthText (canvas alpha LSB 鈫?gzip decompress), parseNovelAICommentJSON (JSON 鈫?瀹屾暣 PngParsedParams 鍚?20+ 鍙傛暟瀛楁), searchNovelAIRawBytes (鍘熷瀛楄妭 marker 鎼滅储), parseSDParameterText (SD-WebUI Steps/CFG/Sampler regex), extractLoras (LoRA 寮曠敤鎻愬彇)

**Behavior before:** 鍙兘瑙ｆ瀽 SD-WebUI tEXt 鍙傛暟锛汵ovelAI 鍥剧墖瀵煎叆闈欓粯澶辫触锛堟棤 stealth alpha銆佹棤 JSON comment锛?**Behavior after:** 鏀寔 NovelAI V4/V4.5 瀹屾暣鍙傛暟鎻愬彇锛堝惈 stealth alpha 闅愬啓锛? SD-WebUI 瀹屾暣鍙傛暟; EXIF 鍏冩暟鎹? LoRA 鍒楄〃

**鈿狅笍 FRONTEND TODO (Phase 5-6: Presets Tab 鈥?PNG Style Import)**
鐢ㄦ埛鏃犳硶瑙﹀彂瀵煎叆娴佺▼锛岄渶瑕?Presets tab:
- "瀵煎叆 PNG" 鎸夐挳 鈫?file picker 鈫?extractPngMetadata 鈫?AI refinement 鈫?save preset
- 棰勮缂栬緫鍣?(鐢诲笀涓?姝ｉ潰/璐熼潰/鍙傛暟)
- "浼樺厛澶嶅埢鍘熷弬鏁? toggle
MRJH ref: MRJH-USER-EXPERIENCE.md 搂M "PNG Style Import Flow"

---

## [2026-04-17] Image Rework: Phase 1.7 鈥?Secret Part Prompt Generation

**Scope:** 绉佸瘑閮ㄤ綅鐗瑰啓 prompt 鐢熸垚 鈥?鑳搁儴/灏忕┐/灞佺┐寰窛鐗瑰啓 + 姝ｇ‘娑堟伅閾?+ 鍚庡鐞嗚繃婊?**Root cause:** AGA 鐨?tokenizeSecretPart 鏄鏋舵ā鏉匡紝缂哄皯: (1) 閮ㄤ綅绾ф弿杩?(macro photography / subsurface scattering), (2) NovelAI vs 閫氱敤鐨勫垎鏀矾寰? (3) 閿氱偣娉ㄥ叆 (secret_part composition 杩囨护), (4) 姝ｇ‘鐨勬秷鎭摼 (intentionally 璺宠繃 NPC preset), (5) 鍚庡鐞嗚繃婊?(strip portrait/body tags)
**Files changed:**
- `src/engine/image/secret-part-prompt.ts` 鈥?NEW: buildSecretPartDescription (3 閮ㄤ綅鎻忚堪 verbatim), buildSecretPartSystemPrompt (NAI 璺緞: 鏉冮噸鍒嗙粍 + 瑙嗚绾圭悊 + 瑙ｅ墫绾︽潫; 閫氱敤璺緞: 90%+ 濉厖 + 寰窛), buildSecretPartTaskData (瑙掕壊璧勬枡 + 閿氱偣 + 杈撳嚭瑕佹眰), reinforceSecretPartPrompt (strip portrait/upper body/scenery tags, regex verbatim from MRJH)
- `src/engine/image/secret-part-prompt.test.ts` 鈥?NEW: 14 tests 鍚渚犳湳璇楠?- `src/engine/image/tokenizer.ts` 鈥?tokenizeSecretPart 瀹屽叏閲嶅啓: 鎺ュ彈 part/npcDataJson/anchor/isNovelAI; 浣跨敤 injectAnchorByComposition(secret_part) 杩囨护閿氱偣; 浣跨敤 callTokenizer overrides 鏋勫缓姝ｇ‘娑堟伅閾?(AI role 鈫?model bundle ONLY 鈫?secret prompt 鈫?task data as assistant); 鍚庡鐞?reinforceSecretPartPrompt; **intentionally 璺宠繃 NPC preset** (閬垮厤閫€鍥炲叏韬?

**Behavior before:** 楠ㄦ灦妯℃澘锛岀己灏戝井璺濈劍鐐?瑙ｅ墫绾︽潫/閿氱偣杩囨护/鍚庡鐞?**Behavior after:** NovelAI 璺緞鏈?subsurface scattering / macro focus / NAI 鏉冮噸鍒嗙粍; 閫氱敤璺緞鏈?90%+ 濉厖 / 寰窛绾︽潫; 閿氱偣缁?secret_part 杩囨护 (浠呬繚鐣欒偆鑹?骞撮緞); 鍚庡鐞嗚繃婊?portrait/body tags

**鈿狅笍 FRONTEND TODO (Phase 3-4: Manual Tab Secret Part Panel)**
鐢ㄦ埛褰撳墠**鏃犳硶瑙﹀彂**姝ゅ姛鑳姐€傞渶瑕?Manual tab 鐨?fuchsia 鑹茶皟绉佸瘑閮ㄤ綅闈㈡澘:
- 涓変釜閮ㄤ綅鍗＄墖 (鑳搁儴/灏忕┐/灞佺┐)锛屾瘡涓湁鐢熸垚/閲嶆柊鐢熸垚鎸夐挳
- 鐢婚閫夋嫨 / 鍒嗚鲸鐜?/ 鐢诲笀涓查璁?/ PNG 棰勮 / 棰濆瑕佹眰
- "鍏ㄩ儴鐢熸垚" 鎸夐挳
MRJH ref: MRJH-USER-EXPERIENCE.md 搂F "Secret Part Generation"

---

## [2026-04-17] Image Rework: Phase 1.6 鈥?Scene Prompt Generation

**Scope:** 鍦烘櫙鐢熷浘 prompt 鐢熸垚 鈥?灞傜骇鍦扮偣瑙ｆ瀽 + 绌洪棿鏋勫浘閫昏緫 + 鍦烘櫙绫诲瀷鍒ゅ畾 + 娑堟伅閾炬灦鏋勪慨澶?**Root cause:** AGA 鐨?tokenizeScene 鏈変袱涓棶棰? (A) 鍔熻兘缂哄け鈥斺€斿彧鏈夐鏋舵ā鏉匡紝缂哄皯绌洪棿鏋勫浘閫昏緫銆佸満鏅垽瀹氱瓑; (B) 娑堟伅閾炬灦鏋勯敊璇€斺€攕cene task data 琚杩?system 娑堟伅 (閫氳繃 pack template)锛宍buildTaskContextMessage` 杈撳嚭浜?NPC 鐩稿叧鍐呭鑰屼笉鏄満鏅唴瀹广€侻RJH 鐨勬纭粨鏋勬槸: AI role(system) 鈫?preset(system) 鈫?scene prompt(system) 鈫?task data(**assistant**)銆?**Files changed:**
- `src/engine/image/scene-context.ts` 鈥?NEW: parseLocationHierarchy锛坄路`-separated 鈫?innermost 3 layers锛氬ぇ鍦扮偣/涓湴鐐?鍏蜂綋鍦扮偣锛夛紝formatGameTimeForScene锛坔our鈫掗粠鏄?娓呮櫒/..., month鈫掓槬/澶?...锛夛紝buildSceneContext锛坙ocation+time+NPCs鈫掔粨鏋勫寲涓婁笅鏂囷級锛宲arseSceneResponse锛圓I 鍝嶅簲鈫掑満鏅被鍨?鍒ゅ畾璇存槑+prompt 鍐呭锛孧RJH imageTasks.ts:2797-2827 閫昏緫锛?- `src/engine/image/scene-context.test.ts` 鈥?NEW: 17 tests
- `src/engine/image/tokenizer.ts` 鈥?tokenizeScene 瀹屽叏閲嶅啓锛歁RJH 绾у埆鐨勫満鏅郴缁?prompt锛堢┖闂存瀯鍥鹃€昏緫銆佹潗璐ㄧ粏鑺傛寚浠ゃ€佸厜褰辫姹傦級锛涙敮鎸?forced (pure_landscape/story_snapshot) + auto-judge 妯″紡锛涙帴鍙?SceneContext + presetContext + roleAnchors锛涗娇鐢?parseSceneResponse 瑙ｆ瀽 AI 鍦烘櫙绫诲瀷鍒ゅ畾锛汼ceneTokenizerResult 鏂板 judgmentExplanation
- `src/engine/image/image-service.ts` 鈥?generateSceneImage 鏂板 gameTime/presentNpcs/compositionMode/extraRequirements/roleAnchors 鍙傛暟锛涗娇鐢?buildSceneContext + scene preset + processTransformerOutput 瀹屾暣绠￠亾锛沝efault scene size 鏀逛负 1024脳576锛堟í灞忥級
- `src/engine/core/game-orchestrator.ts` 鈥?auto-scene 璋冪敤浼犲叆 compositionMode:'auto'锛宯arrative 闀垮害浠?500鈫?00 瀛?
**Behavior before:** 鍦烘櫙鍥句娇鐢ㄦ瀬绠€妯℃澘 + flat location + 500 瀛楁鏂囷紝AI 娌℃湁绌洪棿鏋勫浘鎸囦护
**Behavior after:** AI 鏀跺埌灞傜骇鍦扮偣 + 绌洪棿鏋勫浘閫昏緫 (Background/Midground/Foreground) + L/C/R 鏂逛綅 + 鏉愯川/鍏夊奖鎸囦护 + 鍦烘櫙鍒ゅ畾瑙勫垯锛岀敓鎴愮殑鍦烘櫙鍥剧敾闈㈠眰娆″拰绌洪棿鎰熷ぇ骞呮彁鍗?
**鈿狅笍 FRONTEND TODO (Phase 4: Scene/Wallpaper Tab)**
鎵嬪姩鍦烘櫙鐢熸垚闇€瑕?Scene Tab UI:
- 鏋勫浘閫夋嫨锛堢函鍦烘櫙/鏁呬簨蹇収锛夊搴?compositionMode 鍙傛暟
- 棰濆瑕佹眰 textarea
- 鍦烘櫙鐢诲笀涓?PNG 棰勮閫夋嫨
- 鍦烘櫙闃熷垪 + 鍘嗗彶 + 澹佺焊绠＄悊
MRJH ref: MRJH-USER-EXPERIENCE.md 搂E "Scene/Wallpaper Generation"
鑷姩鍦烘櫙鐢熸垚宸查€氳繃 orchestrator 鑷姩瑙﹀彂锛堟敼鍠勭殑鍦烘櫙 prompt 宸茬敓鏁堬級

---

## [2026-04-17] Image Rework: Phase 1.5 鈥?Transformer Preset System

**Scope:** 璇嶇粍杞寲鍣ㄦ彁绀鸿瘝棰勮绯荤粺 鈥?9 default presets (3 backends 脳 3 scopes) + 3 model bundles + 鍔ㄦ€佽В鏋?**Root cause:** AGA 鍙湁 1 涓‖缂栫爜鐨?NAI NPC preset (.md file)锛屾棤娉曞尯鍒?anchor/default 妯″紡锛屾棤娉曟敮鎸?Gemini/Grok 鍚庣
**Files changed:**
- `src/engine/image/transformer-presets.ts` 鈥?NEW: 9 涓粯璁?transformer prompt presets (NAI/Gemini/Grok 脳 NPC/Scene/SceneJudge)锛屾瘡涓寘鍚?prompt + anchorModePrompt + noAnchorFallbackPrompt + outputFormatPrompt锛? 涓?model bundles (NAI enabled, Gemini/Grok disabled)锛沢etTransformerPresetContext(scope, mode) 瑙ｆ瀽鍑芥暟锛涙渚犺瘝姹囧凡閫氱敤鍖栵紙澧冪晫鈫掔瓑绾? 姝︿緺/浠欎緺鈫掔壒瀹氶鏍?濂囧够, 姘旀満鈫掕兘閲忔晥鏋滐級
- `src/engine/image/transformer-presets.test.ts` 鈥?NEW: 20 tests 鍖呮嫭姝︿緺鏈妫€楠?- `src/engine/image/tokenizer.ts` 鈥?callTokenizer 鏂板 extraSystemPrompts 鍙傛暟锛堢洿鎺ュ瓧绗︿覆娉ㄥ叆锛夛紱tokenizeCharacter 鎺ュ彈 presetContext锛涘綋 presetContext 瀛樺湪鏃朵娇鐢ㄥ姩鎬?preset 鏇夸唬纭紪鐮?.md 鏂囦欢
- `src/engine/image/image-service.ts` 鈥?generateCharacterImage 鍦?tokenizer 璋冪敤鍓嶈В鏋?presetContext锛堝熀浜?anchor 鐘舵€侀€夋嫨 default/anchor 妯″紡锛?
**Behavior before:** 鎵€鏈?NPC 鐢熷浘浣跨敤鍚屼竴涓?NAI preset锛宎nchor/non-anchor 妯″紡浣跨敤鐩稿悓 prompt
**Behavior after:** 鏍规嵁娲昏穬 model bundle 鑷姩閫夋嫨瀵瑰簲 backend 鐨?preset锛沘nchor 妯″紡浣跨敤 anchorModePrompt锛堥噸鐐硅ˉ鍔ㄦ€侊級锛宒efault 妯″紡浣跨敤 prompt + noAnchorFallbackPrompt锛堝畬鏁寸敓鎴愶級

**鈿狅笍 FRONTEND TODO (Phase 6: Rules Center + Phase 7: Settings Tab)**
鐢ㄦ埛褰撳墠**鏃犳硶鍒囨崲 model bundle 鎴栫紪杈?preset**銆傞渶瑕?
- Settings Tab 4 "杞寲鍣?: 绠＄悊 preset + model bundle CRUD
- Rules Center "瑙勫垯涓績": 閫夋嫨娲昏穬 model ruleset, 缂栬緫 base/anchor/fallback/output 瑙勫垯瀛楁
- State persistence: 淇濆瓨鐢ㄦ埛鑷畾涔?preset 鍒?state tree
MRJH ref: MRJH-USER-EXPERIENCE.md 搂J-2 "瑙勫垯涓績" + 搂K "Tab 4: 杞寲鍣?

---

## [2026-04-17] Image Rework: Phase 1.3 鈥?Direct Prompt Fallback (No AI)

**Scope:** 鏃?AI 璇嶇粍杞寲鍣ㄦ椂鐨勭洿鎺?prompt 鐢熸垚
**Root cause:** AGA 鍙湁 AI tokenizer 璺緞锛屽綋杞寲鍣?API 涓嶅彲鐢ㄦ垨鐢ㄦ埛鍏抽棴杞寲鍣ㄦ椂娌℃湁 fallback銆傞潪 NovelAI 鍚庣鍙互鐩存帴浣跨敤涓枃鎻忚堪鐢熷浘锛屼笉闇€瑕?AI 杞崲銆?**Files changed:**
- `src/engine/image/direct-prompt-builder.ts` 鈥?NEW: buildDirectCharacterPrompt 鍑芥暟锛岃鍙?NPC JSON 瀛楁锛堟€у埆/骞撮緞/韬唤/澶栬矊/韬潗/琛ｇ潃绛夛級鈫?鐩存帴缁勮 prompt銆侼ovelAI 杈撳嚭鑻辨枃 tags (1girl/1man + composition keywords + NAI 鏉冮噸褰掍竴鍖?; 闈?NovelAI 杈撳嚭涓枃鎻忚堪銆?- `src/engine/image/direct-prompt-builder.test.ts` 鈥?NEW: 16 tests
- `src/engine/image/image-service.ts` 鈥?generateCharacterImage 鏂板 useTransformer 鍙傛暟; NovelAI 寮哄埗 transformer ON; 鍏朵粬鍚庣鍙€? useTransformer=false 鏃惰蛋 buildDirectCharacterPrompt 璺緞

**Behavior before:** 鍙兘鐢?AI tokenizer 鐢熸垚 prompt; tokenizer API 涓嶅彲鐢ㄦ椂鐩存帴鎶ラ敊
**Behavior after:** 鏂板 direct mode 璺緞; 闈?NovelAI 鍚庣鍙叧闂浆鍖栧櫒鐩存帴鐢?NPC 鏁版嵁鐢熷浘

**鈿狅笍 FRONTEND TODO (Phase 7: Settings Tab)**
姝ゅ姛鑳界洰鍓嶇敤鎴?*涓嶅彲瑙?* 鈥?娌℃湁 UI toggle 璁╃敤鎴峰垏鎹㈠埌 direct mode銆?闇€瑕?Settings tab 娣诲姞 "浣跨敤璇嶇粍杞寲鍣? toggle锛圡RJH: ImageGenerationSettings Tab 1 鍩虹锛夈€?璇?toggle 浼犲叆 `image-service.generateCharacterImage({ useTransformer: toggleValue })`銆?NovelAI 鍚庣鏃?toggle 搴?forced ON + disabled銆?MRJH ref: MRJH-USER-EXPERIENCE.md 搂K "Tab 1: 鍩虹"

---

## [2026-04-17] Image Rework: Phase 1.4 鈥?Output Processing Pipeline

**Scope:** AI 璇嶇粍杞寲鍣ㄨ緭鍑哄鐞嗙閬?鈥?NAI 鏉冮噸璇硶 + 缁撴瀯鍖栬緭鍑鸿В鏋?+ prompt 娓呮礂
**Root cause:** AGA tokenizer 鐨?parseTokenizerResponse 鍙仛绠€鍗曠殑 tag 鍓ョ鍜岄€楀彿鎷嗗垎锛岀己灏? (1) NAI 鏉冮噸璇硶褰掍竴鍖?(content:weight) 鈫?weight::content::, (2) 缁撴瀯鍖栬緭鍑?(<鍩虹><瑙掕壊>) 瑙ｆ瀽, (3) 鑴忔潈閲嶈娉曚慨澶? (4) Artist 鏍囩澶у皬鍐欏綊涓€鍖? (5) 瑙掕壊鍗犱綅璇嶅墺绂?鍘婚噸銆傛澶?`<鎻愮ず璇嶇粨鏋?` 鍧楄鏁村潡鍒犻櫎锛堜涪澶卞唴瀹癸級鑰屼笉鏄В鏋愩€?**Files changed:**
- `src/engine/image/output-processor.ts` 鈥?NEW: 瀹屾暣杈撳嚭澶勭悊绠￠亾锛屽寘鍚?stripThinkingBlocks, cleanPromptOutput, normalizeArtistCase, stripAllStructuralTags, removeRolePrefixes, extractLastTagBlock/Content, parseStructuredOutput (XML + bracket 鏍煎紡), convertBracketWeightSyntax (8-pass iterative), cleanDirtyWeightSyntax (3 fix patterns), normalizeNaiWeightSyntax, cleanSubjectPrompt, stripRolePlaceholders, mergeAndDedup, normalizeSingleCharacterOutput, processTransformerOutput. 淇浜?MRJH `\b` word boundary 鍦ㄤ腑鏂囨爣绛惧悕涓婄殑 bug 鈫?AGA 鐢?`(?=[>\s/])` lookahead銆?- `src/engine/image/output-processor.test.ts` 鈥?NEW: 41 tests 瑕嗙洊鎵€鏈夊嚱鏁?+ edge cases
- `src/engine/image/image-service.ts` 鈥?generateCharacterImage 鍦?tokenizer 鍜?composer 涔嬮棿鎻掑叆 normalizeSingleCharacterOutput(tokenResult.rawResponse)

**Behavior before:** NAI 鏀跺埌 `(blue eyes:1.2)` SD 鏍煎紡鏉冮噸 鈫?琚拷鐣ユ垨鐢熸垚閿欒; 缁撴瀯鍖?AI 杈撳嚭 `<鍩虹><瑙掕壊>` 琚暣鍧楀垹闄? 瑙掕壊鍗犱綅璇嶅 "瑙掕壊1:" 娉勬紡鍒?final prompt
**Behavior after:** SD 鏉冮噸 鈫?NAI `1.2::blue eyes::` 璇硶鑷姩杞崲; 缁撴瀯鍖栬緭鍑烘纭В鏋愬悎骞? 瑙掕壊鍗犱綅璇嶅墺绂?+ 璺ㄦ鍘婚噸; Artist: 澶у皬鍐欏綊涓€鍖?**Notes:** processTransformerOutput 鐨勫畬鏁村瑙掕壊搴忓垪鍖栵紙roleAnchors + NAI 瑙掕壊娈?leading tag 鎺ㄦ柇 + 浜烘暟鏍囩琛ュ叏锛夊欢杩熻嚦 Phase 1.6 鍦烘櫙鐢熷浘

---

## [2026-04-17] Image Rework: Phase 1.2 鈥?Composition-Aware Anchor Injection

**Scope:** 瑙掕壊閿氱偣鎸夋瀯鍥剧被鍨嬭繃婊ゆ敞鍏?**Root cause:** AGA 灏嗛敋鐐瑰師鏂囦笉缁忚繃婊ょ洿鎺ヤ紶鍏?tokenizer ANCHOR_DATA锛屽ご鍍忔ā寮忎笅 AI 鍙兘娌跨敤瀹屾暣閿氱偣锛堝惈鏈嶈/姝﹀櫒/鍦烘櫙鏍囩锛夊鑷寸敾闈㈠亸绉?**Files changed:**
- `src/engine/image/types.ts` 鈥?鏂板 AnchorStructuredFeatures, SecretPartType 绫诲瀷; CharacterAnchor 澧炲姞 structuredFeatures 瀛楁
- `src/engine/image/anchor-injector.ts` 鈥?NEW: injectAnchorByComposition 绾嚱鏁帮紝5 鍒嗘敮锛坧ortrait/secret_part.breast/secret_part.other/default锛夛紝regex 閫愬瓧鏉ヨ嚜 MRJH imageTasks.ts:2161-2239
- `src/engine/image/anchor-injector.test.ts` 鈥?NEW: 16 tests 瑕嗙洊鍏ㄩ儴鍒嗘敮 + 杈圭晫
- `src/engine/image/tokenizer.ts` 鈥?tokenizeCharacter 鎺ュ彈 structuredFeatures, 璋冪敤 injectAnchorByComposition 杩囨护鍚庝紶鍏?ANCHOR_DATA; composition 鏂板 scene
- `src/engine/image/image-service.ts` 鈥?generateCharacterImage params 鏂板 anchorStructuredFeatures + scene 鏋勫浘; 浼犻€掕嚦 tokenizer

**Behavior before:** 閿氱偣鍏ㄦ枃浼犲叆 AI锛宲ortrait 妯″紡鍙兘鍖呭惈琛ｇ潃/姝﹀櫒/鑳屾櫙鏍囩
**Behavior after:** portrait 鍙紶闈㈤儴/鍙戝瀷/鐪肩潧/鑲よ壊/骞撮緞鏍囩 (limit 20); breast 鍙紶鑳搁儴/鑲よ壊/骞撮緞 (limit 14); vagina/anus 鍙紶鑲よ壊/骞撮緞 (limit 8); 鍗婅韩/绔嬬粯/鍦烘櫙 full anchor 涓嶅彉
**Notes:** 缁撴瀯鍖栫壒寰佷紭鍏堜簬鍘熷 prompt 瑙ｆ瀽; NAI 鏉冮噸璇硶 (::) 璺宠繃娉ㄥ叆; 涓?MRJH 1:1 鍔熻兘瀵归綈缁?code review 纭

---

## [2026-04-17] Image Rework: Phase 0 鈥?Persistence Foundation

**Scope:** 鍥剧墖绯荤粺鎸佷箙鍖栵紙NPC 妗ｆ + 鍦烘櫙妗ｆ + 浠诲姟闃熷垪锛?**Root cause:** 鐢熷浘缁撴灉鍐欏叆 state tree 浣嗕笉瑙﹀彂瀛樻。锛屽埛鏂板悗鍏ㄩ儴涓㈠け
**Files changed:**
- `src/engine/image/image-service.ts` 鈥?writeToNpcArchive/updateNpcArchiveField 鏈熬 emit `engine:request-save`锛涙柊澧?writeToSceneArchive/getSceneArchive锛涙瀯閫犲嚱鏁版敞鍏?queue persist callback + restore
- `src/engine/image/task-queue.ts` 鈥?閲嶅啓锛氭坊鍔?onPersist callback + restore() 鏂规硶
- `src/engine/image/save-migration.ts` 鈥?DEFAULT_IMAGE_STATE 娣诲姞 sceneArchive 瀛楁

**Behavior before:** 鐢熷浘瀹屾垚鍚庡埛鏂伴〉闈紝Gallery 涓虹┖锛岄槦鍒椾负绌猴紝鍦烘櫙鍘嗗彶涓虹┖
**Behavior after:** 姣忔 archive/queue 鍐欏叆鑷姩瑙﹀彂 `engine:request-save` 鈫?orchestrator 瀛樻。鍒?IndexedDB 鈫?鍒锋柊鍚?state tree 鎭㈠ 鈫?Gallery/Queue/Scene 鏁版嵁瀹屾暣

## [2026-04-17] Image Rework: NovelAI Provider + Tokenizer Pipeline 淇

**Scope:** NovelAI API 鍙傛暟瀵归綈 + Tokenizer CoT/prompt pipeline 鍏ㄩ噺淇
**Root cause:** NovelAI provider 缂哄皯 params_version/v4_negative_prompt 绛夊繀瑕佸弬鏁板鑷?500 閿欒锛汿okenizer 鏃?CoT prefill銆佹ā鏉垮彉閲忔湭濉厖銆丯PC 鏁版嵁绋€鐤忋€佺己灏?NAI 涓撶敤鎸囦护
**Files changed:**
- `src/engine/image/providers/novelai.ts` 鈥?瀵归綈 MRJH 鍏ㄩ儴 API 鍙傛暟
- `src/engine/image/tokenizer.ts` 鈥?6-msg chain銆丆oT masquerade銆佸畬鏁存ā鏉垮彉閲忋€丯PC JSON 浼犻€?- `src/engine/image/image-service.ts` 鈥?鎵╁睍 generateCharacterImage 鍙傛暟閾?- `src/ui/components/panels/ImagePanel.vue` 鈥?submitGenerate 浼犻€掑畬鏁?NPC JSON + composition/artStyle/anchor
- `public/packs/tianming/prompts/imageCharacterTokenizer.md` 鈥?閲嶅啓涓?AI 瑙掕壊 prompt
- `public/packs/tianming/prompts/imageNaiTransformerPreset.md` 鈥?鏂板 NAI 涓撶敤杞寲鍣ㄩ璁?
**Behavior before:** NovelAI 杩斿洖 Server Internal Error锛沺rompt 鍙湁 3 鏉＄┖娑堟伅
**Behavior after:** NovelAI 姝ｅ父鐢熷浘锛沺rompt 涓?6-msg chain锛圓I瑙掕壊+NAI棰勮+浠诲姟涓婁笅鏂?NPC瀹屾暣JSON+鐢ㄦ埛瑙﹀彂+CoT锛?
## [2026-04-17] Image Rework: Phase 1 UI 鈥?Gallery Enhancement

**Scope:** Gallery tab UI 瀵归綈 MRJH
**Files changed:**
- `src/ui/components/panels/ImagePanel.vue` 鈥?hover zoom 1.03x + status/usage overlay badges + NPC header badges + 2-col metadata grid

**Behavior before:** Gallery 鍥剧墖鍗℃棤鎮仠鏁堟灉锛屾棤鐘舵€佹爣绛撅紝metadata 涓?inline 鏂囨湰
**Behavior after:** 鍥剧墖 hover 1.03x 缂╂斁 + 宸︿笂瑙掔姸鎬?鐢ㄩ€?overlay badges + NPC 鏍囬涓嬫柟鎬у埆/瑙掕壊绫诲瀷/鍥剧墖鏁?badges + 2 鏍?metadata grid锛堜娇鐢ㄦā鍨?+ 鐢婚锛?
---

## [2026-04-16] Fix: clearGame() reactive 閾炬帴鏂

**Flow:** 瀛樻。鍔犺浇 / 鏂版父鎴忓垱寤?**Root cause:** `engine-state.ts` 鐨?`clearGame()` 鐢?`tree.value = {}` 鏇挎崲 Pinia ref锛屽垏鏂簡涓?`stateManager.state` 鐨勫叡浜紩鐢ㄣ€傚悗缁?`loadGame()` / `markLoaded()` 鍐欏叆 stateManager 浣?UI 璇荤殑 tree.value 姘歌繙鏄┖瀵硅薄銆?**Files changed:**
- `src/engine/stores/engine-state.ts:clearGame()` 鈥?鏀逛负 `_linkedStateManager.clear()` 灏卞湴娓呯┖ reactive proxy

**Behavior before:** 鍒犻櫎瀛樻。/瀵煎叆澶囦唤鍚庡啀鍔犺浇浠讳綍娓告垙 鈫?鐘舵€佹爲瀹屽叏涓虹┖锛屽彉閲忛潰鏉挎棤鏁版嵁
**Behavior after:** clearGame 鍚?reactive 閾炬帴淇濇寔瀹屾暣锛屽悗缁?loadGame 姝ｅ父鏄剧ず鏁版嵁

---

## [2026-04-16] Engram 涓夊厓缁勭郴缁?+ 璋冭瘯闈㈡澘鍗囩骇

**Flow:** Engram 璇箟璁板繂 pipeline
**Root cause:** 涓夊厓缁?(semantic_memory.triples) 鍐欏叆璺緞閿欒 鈥?`mergeSemanticMemory()` 鍐欏埌 `绯荤粺.鎵╁睍.engramMemory` 浣?`UnifiedRetriever` 浠?`绯荤粺.鎵╁睍.璇箟璁板繂.triples` 璇诲彇銆?**Files changed:**
- `src/engine/memory/engram/triple-builder.ts` 鈥?鏂板缓锛屼笁鍏冪粍楠岃瘉 + 鍘婚噸 + 鏃堕棿鎴宠嚜鍔ㄥ～鍏?- `src/engine/memory/memory-manager.ts` 鈥?`mergeSemanticMemory()` 鏀圭敤 TripleBuilder锛屽啓鍏ユ纭矾寰?- `public/packs/tianming/schemas/state-schema.json` 鈥?鏂板 `绯荤粺.鎵╁睍.璇箟璁板繂` schema
- `public/packs/tianming/prompts/core.md` 鈥?鏂板 `semantic_memory.triples` 杈撳嚭鏍煎紡瑙勮寖
- `src/engine/memory/engram/relation-builder.ts` 鈥?鏂板琛屽姩鎺ㄦ柇锛堜粠浜嬩欢鏂囨湰鎺ㄦ柇 enemy/ally/dialogue 绛夊叧绯伙級
- `src/engine/memory/engram/entity-builder.ts` 鈥?鎻忚堪鎸佺画鏇存柊 + 鍙樺寲鏃舵爣璁伴渶閲嶆柊鍚戦噺鍖?- `src/ui/components/panels/EngramDebugPanel.vue` 鈥?Cytoscape 鍏崇郴鍥?+ 涓夊厓缁勬帓搴忕瓫閫夊垎缁?+ 瀹炰綋鍏崇郴 ming 鏍煎紡鍒楄〃

**Behavior before:** 涓夊厓缁勬案杩滀负绌猴紙璺緞閿欒锛夛紝鍏崇郴鍥句负绠€鍗曢偦鎺ュ垪琛紝鏃犳帓搴忕瓫閫?**Behavior after:** AI 浜у嚭涓夊厓缁?鈫?姝ｇ‘鍐欏叆 鈫?UnifiedRetriever 鍙绱紱Cytoscape 鍔涘鍚戝浘锛涗笁鍏冪粍鎺掑簭/绛涢€?鍒嗙粍

---

## [2026-04-15] Sprint Social-1 路 NPC path contract + schema + PrivacyProfile 鍚告敹

**Flow:** MRJH Migration 路 Epic B 路 Sprint 1/19 (per `IMPLEMENTATION-ORDER-REVIEW.md` 搂5)
**Category:** feature/schema 鈥?sprint shipped entry (not a bug fix; logged here per project convention until a dedicated sprint log exists)

### 鏀瑰姩鍐呭

1. **寮曟搸锛歚EnginePathConfig` 鏂板瀛愬璞″厛渚?*
   - `src/engine/pipeline/types.ts` 鈥?鏂板 `EngineNpcFieldNames` 鎺ュ彛锛?3 key锛? `npcFieldNames` 瀛楁锛沗DEFAULT_ENGINE_PATHS` 濉腑鏂囬粯璁ゅ€?   - **鏋舵瀯鍏堜緥**锛歚EnginePathConfig` 棣栨寮曞叆瀛愬璞″€硷紱2026-04-15 鐢ㄦ埛瀹℃牳鎵瑰噯 option (c)
   - 鐩稿叧锛歚docs/architecture/decisions.md 搂1.1` amendment 璁板綍鍏堜緥瑙勫垯

2. **寮曟搸锛氬叡浜?NPC 璁板繂娓叉煋 helper**
   - `src/engine/social/` 鏂扮洰褰曪紙涓?Social-2+ 鍑嗗锛?   - 鏂版枃浠?`npc-memory-format.ts` 瀵煎嚭 `parseMemoryEntry` + `formatMemoryEntry`
   - 鏂版祴璇?`npc-memory-format.test.ts` 鈥?**24/24 閫氳繃**锛岃鐩?string / `{鍐呭,鏃堕棿}` / 鑻辨枃鍏煎閿?/ null / undefined / 鏁扮粍 / 鏁板瓧 / 甯冨皵 / 娣峰悎鏁扮粍
   - 寮曟搸渚?`src/engine/pipeline/sub-pipelines/npc-chat.ts:~500` `formatNpcProfile` 鐢?`paths.npcFieldNames.memory` + helper
   - UI 渚?`src/ui/components/panels/RelationshipPanel.vue:561,774` 涓ゅ `{{ mem }}` 鈫?`{{ formatMemoryEntry(mem) }}`锛屾秷闄?`[object Object]` 娼滃湪 bug

3. **Pack schema 鎵╁睍**
   - `public/packs/tianming/schemas/state-schema.json` `绀句氦.鍏崇郴[]` 鏂板 9 瀛楁锛歚鏄惁鍦ㄥ満 / 鏄惁涓昏瑙掕壊 / 鍏崇郴鐘舵€?/ 鏍稿績鎬ф牸鐗瑰緛 / 濂芥劅搴︾獊鐮存潯浠?/ 鍏崇郴绐佺牬鏉′欢 / 鍏崇郴缃戝彉閲?/ 鏈€鍚庝簰鍔ㄦ椂闂?/ 鎬荤粨璁板繂`
   - `璁板繂` 鏀逛负 `oneOf: [string, {鍐呭, 鏃堕棿}]` 鈥?back-compat 鍏煎鏃у瓨妗?   - `绉佸瘑淇℃伅` 鏂板 `瀛愬` 瀛愬璞★紙`鐘舵€?/ 瀹彛鐘舵€?/ 鍐呭皠璁板綍[]`锛夆€?PRINCIPLES 搂3.15 AGA-native schema field absorption

4. **Pack 瑙勫垯**
   - `public/packs/tianming/rules/npc-memory.json` 鈥?NEW锛坄threshold:20 / reserveCount:5 / summaryMaxLength:400`锛?   - Social-1 浠呭缓杞戒綋锛涙秷璐规柟鍦?Social-5

5. **鏂囨。**
   - `docs/architecture/decisions.md 搂1.1` 鈥?sub-object 鍏堜緥 amendment
   - `docs/architecture/schema-contract.md 搂1.3` 鈥?NPC 瀛楁琛ㄦ墿鍏?+ 搂1.3.1-搂1.3.3 鏂板璇存槑锛坄璁板繂` oneOf / `npcFieldNames` 瀛愬璞?/ `瀛愬` 瀛楁 + NSFW 鍓ョ瑕嗙洊璇存槑锛?   - `docs/research/mrjh-migration/audits/memory-read-sites.md` 鈥?NEW锛圧-S1-2 gate 瀹¤锛? 涓鍐欑偣鍏ㄨ鐩栵級
   - `docs/research/mrjh-migration/IMPLEMENTATION-ORDER-REVIEW.md` 鈥?NEW锛?9 sprint 娣卞害瀹¤鎶ュ憡锛涙湰 sprint 涓洪涓級

### Features preserved (搂5 verification)

- [x] Four-tier memory system 鈥?姝ｄ氦鏈Е鍙?- [x] Engram retrieval 鈥?鏈Е鍙?- [x] NSFW snapshot sanitization 鈥?`NSFW_STRIP_PATHS='绀句氦.鍏崇郴.*.绉佸瘑淇℃伅'` 閫氶厤绗﹁嚜鍔ㄨ鐩栨柊澧?`瀛愬` 瀛楁锛屾棤闇€鏀瑰姩锛坄snapshot-sanitizer.ts:48` 楠岃瘉锛?- [x] APICategory + APIAssignment 鈥?鏈Е鍙?- [x] NPC private chat sub-pipeline 鈥?`formatNpcProfile` 琛屼负绛変环鍙樻洿锛坰him 瀵规棫 string 鏁版嵁杩斿洖鍘熷€硷紝鏃犲瓧鑺傚樊寮傦級
- [x] StateManager sync 鈥?鏃犲彉鍖?- [x] Path contract 鈥?鏈?sprint 鎵╁睍浜嗗绾︼紙sub-object 鍏堜緥锛夛紝绗﹀悎 decisions.md 搂1.1 鏂拌鍒?- [x] Three-system audit 鈥?鏂板瓧娈?schema 鈫?path 鈫?鏃犳秷璐规柟锛坰chema-only锛汼ocial-2+ 鍚敤娑堣垂鏃跺啀瀹¤锛?- [x] Rollback system 鈥?鏂板瓧娈垫湭寮曞叆鏂扮殑 snapshot 璺緞锛岀幇鏈?`鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓 瑕嗙洊鏁翠釜 `绀句氦.鍏崇郴`
- [x] Existing tianming gameplay (once generalized per 搂3.3 鈥?TG-1 in progress) 鈥?鏂?schema 瀛楁榛樿 undefined锛沷neOf 鍏佽鏃?string 褰㈡€侊紱琛屼负鏃犲彉鍖?- [x] Plugin OFF byte-identical baseline (搂3.9.3) 鈥?鏈?sprint 鏈紩鍏?toggle锛沜ontract-only 鏀瑰姩涓嶄骇鐢熻繍琛屾椂宸紓

### 楠屾敹

- [x] `npx tsc --noEmit` clean锛堜笁杞?edit 鍚庡潎鏃犺緭鍑猴級
- [x] `npx vitest run src/engine/social/npc-memory-format.test.ts` 鈥?**24/24 閫氳繃**
- [x] JSON schema valid锛坧ython json.load 閫氳繃锛?- [x] JSON rules valid锛坧ython json.load 閫氳繃锛?- [x] R-S1-2 璇诲彇鐐瑰璁″畬鎴愶紙`docs/research/mrjh-migration/audits/memory-read-sites.md`锛夛紝鎵€鏈?8 涓偣宸查獙璇佸吋瀹?- [x] 鍐呭涓珛瀹¤锛圫ocial-1 鑼冨洿锛夛細鏂板瀛楁鍚?`鏄惁鍦ㄥ満 / 鏍稿績鎬ф牸鐗瑰緛 / ...` 鏃?姝︿緺/浠欎緺/澧冪晫 literal锛沗瀛愬 / 瀹彛鐘舵€乣 涓鸿В鍓栧/鐢熺悊瀛︽湳璇紝灞為€氱敤璇嶆眹锛堥潪 domain-specific锛?
### 宸茬煡閬楃暀 / 鏈潵 sprint 璐熻矗

- NPC 鏁版嵁灞傚啓鍏ュ璞″舰鎬?`{鍐呭, 鏃堕棿}` 鈫?Social-2 `appendNpcMemory` 鍗囩骇
- `鏄惁鍦ㄥ満` 绛夋柊瀛楁琚?prompt 娑堣垂 鈫?Social-2 `NpcContextRenderer`
- `鎬荤粨璁板繂` 鑷姩鐢熸垚 鈫?Social-5 `NpcMemorySummaryPipeline`
- `rules/npc-memory.json` 鍙傛暟琚秷璐?鈫?Social-5

### Note

Social-1 **浠呭缓绔嬪绾﹀眰**锛涙 sprint 瀹屾垚鍚庯紝浠庣敤鎴疯瑙掔湅娌℃湁琛屼负鍙樺寲锛屼絾 schema 鍜岃矾寰勫绾﹀凡灏变綅锛孲ocial-2+ 鍙洿鎺ユ秷璐广€傞伒寰?PRINCIPLES 搂3.9 additive plugin 妯″紡锛氭棤 toggle 寮曞叆锛堝绾︽墿灞曢潪鍔熻兘寮€鍏筹級銆?
---

## [2026-04-15] MapPanel bounding box 妯悜姹℃煋 bug 淇

**鐢ㄦ埛鎶ュ憡鐥囩姸锛?* 缈犳箹瀹鹃 compound box 妯悜璺ㄨ秺鏁村箙鍦板浘锛屽悶杩涗簡涓嶅睘浜庡畠鐨勫厔寮熻妭鐐癸紙缈犳箹鍏洯銆佸叞浜嫅銆佸崡灞忚澶滃競銆佽杈圭背绾垮簵锛夊拰鍏勫紵鐨勫瓙鑺傜偣锛堟箹鐣旇尪棣嗭級銆傛暟鎹湰韬殑 `涓婄骇` 瀛楁瀹屽叏姝ｇ‘銆?
### 鏍瑰洜

MapPanel 鐢?`cytoscape` 鐨?`cose`锛圕ompound Spring Embedder锛夊竷灞€娓叉煋澶嶅悎鍥撅紝浣嗗浘涓?*娌℃湁浠讳綍 edge** 鈥斺€?鐖跺瓙鍏崇郴鍙€氳繃鑺傜偣鐨?`parent` 瀛楁琛ㄨ揪銆俢ose 绠楁硶鏈川鏄姏瀵煎悜锛岄潬 **edges 鍋氬惛寮曞姏**鎶婄浉鍏宠妭鐐规媺鍒颁竴璧凤紱**娌℃湁 edge 鏃舵墍鏈夎妭鐐硅褰撶嫭绔嬬矑瀛?*锛岃 `nodeRepulsion` 鍧囧寑鎾戝紑妯摵涓€琛屻€?
闅忓悗锛孋ytoscape 涓烘瘡涓?compound parent 鑷姩绠?bounding box 鏃讹紝**蹇呴』鍖呬綇瀹冨叏閮?children**銆傚鏋滅繝婀栧棣嗙殑鏈€宸?child锛堟€荤粺濂楁埧A锛夊拰鏈€鍙?child锛堝ぇ鍫傦級涔嬮棿琚叾浠?parent 鐨勮妭鐐圭┛鎻掞紝缈犳箹瀹鹃鐨?box 灏辫鎾戞垚妯潯锛屽悶杩涗簡鐗╃悊涓婁綅浜庡叾闂寸殑鍏勫紵鑺傜偣銆?
### Fix

鍦?[`MapPanel.vue buildGraphData`](src/ui/components/panels/MapPanel.vue) 缁欐瘡涓湡瀹?parent鈫抍hild 瀵规坊鍔犱竴鏉?**invisible binding edge**锛?
```typescript
for (const [child, parent] of parentMap.entries()) {
  edges.push({ data: { id: `bind_${parent}__${child}`, source: parent, target: child } });
}
```

鏍峰紡瀹屽叏闅愯棌锛坄width: 0` / `opacity: 0` / `events: 'no'`锛夆€斺€?鐢ㄦ埛鐪嬩笉鍒帮紝浣?cose 闈犲畠鎶婂悓 parent 鐨?children 鎷夋垚 cluster锛宑ompound bounding box 鑷劧鍙寘鑷繁鐨?children銆?
鍚屾椂璋?layout 鍙傛暟璁?compound 鍐呴儴鏇寸揣鍑戯細
- `nestingFactor: 0.3 鈫?0.1`锛坈ompound 鍐?edge 鏇寸煭锛?- `idealEdgeLength: 80 鈫?50`锛堝厔寮熸洿鎸ㄨ繎锛?- 鏂板 `gravity: 80`锛堝己鍖栦腑蹇冭仛鍚堬級

鍙屽嚮 drill-in / 鍗曞嚮 select 绛変簨浠朵笉鍙楀奖鍝?鈥斺€?binding edge 鐨?`events: 'no'` 鏍峰紡纭繚瀹冧笉浼氭埅浣?pointer 浜嬩欢銆?
### 楠岃瘉

- 鉁?`vue-tsc --noEmit` 娓呮磥
- 鉁?`vitest run` 鈥?32 鏂囦欢 / 558 tests 鍏ㄨ繃
- 鉁?Live check锛氱繝婀栧棣?box 鐜板湪鍙洿 `椤跺眰璧板粖 / 鎬荤粺濂楁埧A / 鎬荤粺濂楁埧B / 琛屾斂閰掑粖 / 澶у爞`锛涚繝婀栧叕鍥?box 鍙洿 `婀栫晹鑼堕`锛涙槅鏄庡競鍏勫紵鑺傜偣涓嶅啀浜ゅ彔

---

## [2026-04-14] AI 鍔╂墜 鈥?`insert-item` 璺緞 schema bug 淇

**鐢ㄦ埛鎶ュ憡鐥囩姸锛?* AI 杈撳嚭 `"target": "$.绀句氦.鍏崇郴"`锛堝悎娉曡矾寰勶級锛寁alidator 鍗存姤"璺緞 '绀句氦.鍏崇郴' 鍦?game pack state-schema 涓笉瀛樺湪"+"鏈爣 x-assistant-editable"锛屽鑷存墍鏈?patch 琚垽 `error` 鏃犳硶娉ㄥ叆銆?
### 鏍瑰洜

`GamePack` 鐨勭姸鎬?schema 瀛楁鏄?*椤剁骇 camelCase** `stateSchema`锛堣 `types/game-pack.ts:52`锛夛紝鎴戝湪 `AttachmentBuilder` 鍜?`PayloadValidator` 鐨?`getStateSchema()` 閲岃璇绘垚 `pack.schemas['state-schema']`銆傜粨鏋?getter 姘歌繙杩斿洖 null锛屾墍鏈夎矾寰勯兘琚垽"涓嶅瓨鍦?銆?
娴嬭瘯褰撴椂娌℃姄鍒版槸鍥犱负 mock `GamePack` 涔熺敤浜嗗悓鏍烽敊璇殑 shape `{ schemas: { 'state-schema': SCHEMA } }` 鈥斺€?涓よ竟涓€璧烽敊锛屾祴璇?缁?銆?
### Fix

`attachment-builder.ts` + `payload-validator.ts` 鐨?`getStateSchema()` 鏀逛负鐩存帴璇?`pack.stateSchema`銆傚悓鏃舵洿鏂板崟鍏冩祴璇?mock + 鏂板**鍥炲綊娴嬭瘯**锛氭槑纭姣斾袱绉?shape锛屼竴绉?`ok`銆佷竴绉?`error`锛岄攣浣忓绾︽湭鏉ヤ笉鑳藉啀鎼為敊銆?
```typescript
// 鉂?閿欒锛堟棭鏈燂級
const schemas = (pack as { schemas?: Record<string, unknown> }).schemas;
const stateSchema = schemas?.['state-schema'] ?? schemas?.['state'];

// 鉁?姝ｇ‘
return pack.stateSchema ?? null;
```

### 楠岃瘉

- 鉁?鏂板洖褰掓祴璇?`PayloadValidator 鈥?GamePack.stateSchema 瀛楁璇诲彇锛堝洖褰掞級`
- 鉁?`vitest run` 鈥?558 tests 鍏ㄨ繃锛?1 鍥炲綊锛?
---

## [2026-04-14] AI 鍔╂墜 鈥?鏂板 `insert-item` op锛堝弽姹℃煋鏍稿績澧炲己锛?
**鑳屾櫙锛?* 鐢ㄦ埛鎸囧嚭鍘?`replace-array` op 鐨勮嚧鍛介棶棰?鈥斺€?鏁存暟缁勪紶缁欐ā鍨嬭瀹冮噸鍐欙紝妯″瀷鍙兘鏃犳剰涓慨鏀瑰叾浠栨棤鍏抽」鐨勫瓧娈碉紙姣斿浣犺瀹?鏂板涓€涓?NPC"锛屽畠椤烘墜鏀逛簡鍙︿竴涓?NPC 鐨勫ソ鎰熷害锛夈€傝繖杩濆弽浜嗕竴鏉℃牳蹇冨師鍒欙細**鍙敼鐢ㄦ埛鎸囧畾鐨勫唴瀹癸紝涓嶇鍏朵粬浠讳綍椤?*銆?
### 鍙樻洿

1. **鏂板 `insert-item` op**锛堢 6 涓?op锛夛細妯″瀷鍙緭鍑?*鏂?item + 浣嶇疆鎻忚堪**锛屼腑闂村眰鍋氬疄闄?splice
2. **`InsertPosition` 绫诲瀷**锛氭晠鎰忎笉鏀寔涓嬫爣锛堥槻妯″瀷鏁伴敊锛夛紝4 绉嶈涔夊畾浣嶏細
   - `{ at: 'start' }` / `{ at: 'end' }`
   - `{ before: { by, value } }` / `{ after: { by, value } }`
3. **涓棿灞傚弽姹℃煋淇濊瘉**锛歅ayloadApplier 璇诲綋鍓嶆暟缁?鈫?deep clone 鈫?splice 鎻掑叆 鈫?鏁存暟缁?set 鍥炲啓銆傚叾浠栭」閫愬瓧鑺備笉鍙橈紙娴嬭瘯閿佸畾姝よ涓猴級
4. **Prompt contract 绗竴娈?*鍔犲叆"馃敀 绗竴鍘熷垯锛氬彧鏀圭敤鎴锋寚瀹氱殑鍐呭"閾佸緥 + 鏄庣‘绂佹 replace-array 婊ョ敤
5. **`replace-array` 闄嶇骇涓?鈿?*锛氫粎褰撶敤鎴锋槑纭姹?閲嶆柊璁捐鏁寸粍"鏃舵墠鐢?
### 鏂囦欢

| 鏂囦欢 | 鍙樻洿 |
|---|---|
| `types.ts` | `AssistantPatchOp` 鍔?`'insert-item'` + `InsertPosition` 绫诲瀷锛沗AssistantPatch.position` 鍙€夊瓧娈?|
| `payload-parser.ts` | `sanitizePatch` 瑙ｆ瀽 `position` + 鏂?helper `sanitizePosition`锛堜弗鏍兼牎楠?4 绉嶅舰鎬侊級 |
| `payload-validator.ts` | shape 灞?`insert-item` 蹇呭～ value+position锛涙柊 helper `checkPositionShape`锛坅t 鍙兘 start/end銆佷笉鑳藉悓鏃舵寚瀹氬涓級锛泂chema 灞傚鐢?items schema锛況eferential 灞?before/after match 鎵句笉鍒版椂 warn + 鍚屽悕鍐茬獊 warn |
| `payload-applier.ts` | 鏂?`translateInsertItem` + `resolveInsertIndex` 鈥斺€?deep clone 褰撳墠鏁扮粍锛屾寜 position 璁＄畻鎻掑叆 index锛宻plice锛岀敓鎴愬崟 `set` command |
| `assistantInjectionContract.md` | 寮€绡?馃敀 绗竴鍘熷垯娈?+ op 琛ㄥ姞 insert-item + 绀轰緥 1-3锛坅ppend / insert after / replace锛屽己璋冧笉姹℃煋锛?|
| `PayloadPreviewModal.vue` | `diffPreview` 鏀寔 insert-item 鐨?before/after 灞曠ず |

### 娴嬭瘯瑕嗙洊

| 妯″潡 | 鏂板 cases |
|---|---|
| `payload-parser.test.ts` | 6锛坅t / before / after / 闈炴硶 at / before.by 闈?string / 澶?key 浼樺厛绾э級 |
| `payload-validator.test.ts` | 11锛坰hape 脳 6 + referential 脳 3 + ok 脳 2锛?|
| `payload-applier.test.ts` | 8锛坅t=start/end/before/after + fallback + 闈炴暟缁?target + 鍙嶆薄鏌?deep clone 淇濊瘉 + position 缂哄け闃插尽锛?|
| **鍚堣** | **+25 cases**锛坅ssistant 鎬?165锛屽叏 repo 557锛?|

### 鍙嶆薄鏌撴牳蹇冧繚璇?
娴嬭瘯 `payload-applier.test.ts > PayloadApplier 鈥?insert-item锛堝弽姹℃煋鏍稿績娴嬭瘯锛?> at=start 鈫?鎻掑叆鍦ㄦ暟缁勫ご + 鍏朵粬椤归€愬瓧鑺備笉鍙榒 涓ユ牸閿佸畾浠ヤ笅璇箟锛?
- **杈撳叆**锛? 涓棦鏈?NPC + 鐢ㄦ埛瑕佹眰鎻掑叆绗?4 涓?- **妯″瀷杈撳嚭**锛氫粎鎻忚堪**绗?4 涓?* NPC + `{ position: { at: 'start' } }`
- **涓棿灞傚姩浣?*锛氳鍘熸暟缁?鈫?deep clone 鈫?splice 鍦?index 0 鎻掑叆 鈫?set 鍥炲啓鏁存暟缁?- **缁撴灉**锛歚newArr[0]` 鏄柊 NPC锛沗newArr[1..3]` 涓庡師鏁扮粍**閫愬瓧鑺傜浉绛?*锛堢敋鑷?`濂芥劅搴 / `绫诲瀷` 瀛楁鐨勫紩鐢ㄩ兘鐙珛锛屼笉鍏变韩 reactive proxy锛?
杩欏氨鏄?`insert-item` 鏇夸唬 `replace-array` 浣滀负"鏂板鍗曢」"棣栭€夌殑鏍规湰鐞嗙敱锛?*妯″瀷姘歌繙涓嶆帴瑙﹀叾浠栭」鐨勫瓧娈?*銆?
---

## [2026-04-14] AI 鍔╂墜 Utility锛圗pic Feature 路 MVP锛?
**璁″垝鏂囨。锛?* [`plan-assistant-utility-2026-04-14.md`](./plan-assistant-utility-2026-04-14.md)

鏂板涓€涓嫭绔嬬殑 AI 鍔╂墜宸ュ叿锛岃繘鍏ヨ矾寰勶細宸?nav `绯荤粺 鈫?AI 鍔╂墜`锛坄/game/assistant`锛夈€?涓ょ浣跨敤妯″紡锛堝悎骞跺埌鍗曚竴 panel锛岀敱 attachment 鑷姩鍐冲畾锛夛細

- **Mode A锛堣嚜鐢卞璇濓級**锛氱函鏂囧瓧鍔╂墜锛岀敤浜庣敓鎴愪笘鐣岃銆佽鑹茶瀹氥€佸墽鎯呭ぇ绾茬瓑鍒涗綔绱犳潗
- **Mode B锛堟暟鎹姪鎵嬶級**锛氱敤鎴烽檮鍔犳父鎴忕姸鎬佸瓙鏍戯紙绀句氦鍏崇郴銆佸湴鐐逛俊鎭€佽鑹茶韩浠界瓑锛? 鑷劧璇█瑕佹眰 鈫?AI 杈撳嚭缁撴瀯鍖?patch 鈫?鐢ㄦ埛棰勮/缂栬緫 鈫?鑷姩 snapshot + 娉ㄥ叆鍒版父鎴忔暟鎹?鈫?鍙竴閿挙閿€

### 鏋舵瀯锛? 涓?Phase 鍏ㄩ儴瀹屾垚锛?
```
src/engine/services/assistant/
鈹溾攢鈹€ types.ts                          # AssistantPatch / AssistantPayload / Session 绛?鈹溾攢鈹€ conversation-store.ts             # in-memory FIFO锛堟帴鍙ｉ鐣?IDB 瀹炵幇锛?鈹溾攢鈹€ assistant-blocklist.ts            # 璺緞榛戝悕鍗曪紙绯荤粺/鍏冩暟鎹?鏃堕棿姘镐笉鍙啓锛?鈹溾攢鈹€ attachment-builder.ts             # path 鈫?snapshot + schema fragment + NSFW 鍓ョ
鈹溾攢鈹€ message-builder.ts                # jailbreak + contract + history + 褰撳墠 turn
鈹溾攢鈹€ payload-parser.ts                 # 娴佺粨鏉熷悗浠?fenced JSON 鎻愬彇 AssistantPayload
鈹溾攢鈹€ payload-validator.ts              # 4 灞傛牎楠岋紙shape/path/schema/referential锛?鈹溾攢鈹€ payload-applier.ts                # patch 鈫?Command 缈昏瘧琛?+ executeBatch
鈹斺攢鈹€ assistant-service.ts              # 椤跺眰缂栨帓锛坰end/clear/applyPayload/rollbackLastInject锛?
public/packs/tianming/prompts/
鈹溾攢鈹€ assistantJailbreak.md             # 閫氱敤 chat-friendly + NSFW-friendly jailbreak
鈹斺攢鈹€ assistantInjectionContract.md     # Mode B 鍗忚锛? 涓?op 璇嶆眹琛?+ 杈撳嚭鏍煎紡锛?
public/packs/tianming/schemas/state-schema.json
  鈫?缁欏彲缂栬緫璺緞鍔?x-assistant-editable: true + x-assistant-label
  鈫?鍖呮嫭锛氬熀纭€淇℃伅 / 韬唤 / 鍙彉灞炴€?/ 鏁堟灉 / 鑳屽寘 / 韬綋 / 涓栫晫.鎻忚堪 / 鍦扮偣淇℃伅 / 绀句氦.鍏崇郴
  鈫?涓嶅惈锛氬厓鏁版嵁 / 绯荤粺 / 涓栫晫.鏃堕棿 / 蹇冭烦 / 鍏堝ぉ鍏淮锛堣繖浜涜蛋 blocklist 姘镐笉鍙啓锛?
src/ui/composables/
鈹溾攢鈹€ useStateTreeNavigation.ts         # 鎶藉彇鐨勫鑸€昏緫锛圙ameVariablePanel 妯℃澘锛?鈹斺攢鈹€ useAssistant.ts                   # Vue composable wrapping AssistantService

src/ui/components/assistant/
鈹溾攢鈹€ StateTreeBrowser.vue              # 鏍戠姸鎬佹祻瑙堬紙澶氶€?+ editable 杩囨护锛夆€斺€?缁?picker 鐢?鈹溾攢鈹€ AttachmentPickerModal.vue         # 闄勪欢閫夋嫨瀵硅瘽妗?鈹斺攢鈹€ PayloadPreviewModal.vue           # 涓夋爮娉ㄥ叆鍖呴瑙堬紙鍘熸枃 / patches / diff锛? 鍙紪杈?
src/ui/components/panels/AssistantPanel.vue   # 涓婚潰鏉匡紙璺敱鍏ュ彛锛?src/ui/components/layout/LeftSidebar.vue      # "绯荤粺" 鍖哄姞 AI 鍔╂墜 鍏ュ彛
src/ui/router/index.ts                        # /game/assistant 璺敱
src/main.ts                                   # AssistantService 瑁呴厤 + provide
src/engine/ai/types.ts                        # UsageType 鍔?'assistant'
src/ui/components/panels/APIPanel.vue         # USAGE_TYPE_META 鍔?assistant
```

### Patch 鍗忚锛? 涓?op锛屾晠鎰忓厠鍒讹級

| op | 缈昏瘧涓?Command |
|---|---|
| `set-field` | `set` |
| `append-item` | `push` |
| `replace-item` | `pull(by match)` + `push(value)` |
| `remove-item` | `pull(by match)` |
| `replace-array` | `set([])` + `push(item) 脳 N` |

鏁呮剰**涓?*鏆撮湶 `set-object`锛堢洿鎺ヨ鐩栨暣瀵硅薄澶嵄闄╋級銆俙replace-item` / `remove-item` 鐢?`match: { by, value }` 鑰岄潪浣嶇疆绱㈠紩锛岄伩鍏?AI 鏁伴敊銆?
### 鍏抽敭璁捐鍐崇瓥锛堢敤鎴锋媿鏉匡級

| 鍐崇瓥 | 閫夊畾 |
|---|---|
| 杈撳嚭濂戠害 | **B锛歱atch 澹版槑 + 涓棿灞傜炕璇?*锛堟嫆缁濊 AI 鐩存帴浜?Command 鎴栨暣瀛愭爲锛?|
| Pack 鐧藉悕鍗?| **schema 鍏冩暟鎹?`x-assistant-editable`**锛坧ack 浣滆€呮帶鍒讹級 |
| Mode 鍏ュ彛 | **鍚堝苟鍗?panel** + 鐢?target attachment 鑷姩鍐冲畾 |
| Target 涓婇檺 | **MVP=1**锛沜ontext attachment 鍙?N |
| 娉ㄥ叆鍓嶈嚜鍔ㄥ瓨妗?| **寮哄埗寮€鍚?*锛坕n-memory 鍗曟蹇収锛屼笌涓诲洖鍚?rollback 鍚岃寖寮忥級 |
| API 璺敱 | **鏂?UsageType `'assistant'`** 鈥斺€?鐢ㄦ埛鍙湪 APIPanel 鍗曠嫭閰?|
| FIFO 榛樿 | **5 turns**锛? turn = 闂?+ 绛旓級锛屽彲鍦ㄩ潰鏉胯缃唴璋冿紙1-50锛?|
| NSFW 鍓ョ | nsfwMode=false 鏃舵寜 `NSFW_STRIP_PATHS` 鑷姩鍓ョ + UI 鎻愮ず chip |
| 娉ㄥ叆鍚庤涓?| **drop target attachment + 鎻?inject-success synthetic system 娑堟伅** |
| 鍘嗗彶涓?attachment | **浠呬繚鐣?label**锛坰napshot 涓嶉噸鍙戯級 |
| 閮ㄥ垎娉ㄥ叆 | **绂佺敤** 鈥斺€?浠讳竴 error 蹇呴』淇鎴栧叏閮ㄤ涪寮冿紙鏃犲崐鎴愬搧鐘舵€侊級 |
| 娓呯┖瀵硅瘽 | 蹇呴』 confirm锛堥粯璁ゅ紑锛?|

### 鍥為€€锛坮ollback锛夆€斺€?涓庝富鍥炲悎鍚?UX

- 姣忔鎴愬姛娉ㄥ叆鍓嶏細`stateManager.toSnapshot()` 瀛樺埌 `assistantService.lastInjectSnapshot`锛坕n-memory锛?- 鏂版敞鍏?*瑕嗙洊**涓婁竴娆″揩鐓э紙鍗曟 undo锛屼笌涓诲洖鍚?`鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓 妯″紡涓€鑷达級
- AssistantPanel header 涓?`鈫?鎾ら攢娉ㄥ叆` 鎸夐挳锛堜粎鍦?`canRollbackInject()` 鏃舵樉绀猴級
- 鎾ら攢鍚?`stateManager.rollbackTo(snapshot)` + 鏍囪 message 鐨?`payloadDraft.rolledBackAt` + 娓呯┖蹇収
- 娉ㄥ叆澶辫触鏃?*涓嶇紦瀛?*蹇収锛堥伩鍏嶅悗缁?undo 璇敤鑴忓揩鐓э級锛屽悓鏃跺皾璇?rollback 宸插啓鍏ョ殑閮ㄥ垎

### 瀹夊叏鏍?
- **璺緞榛戝悕鍗?*锛? 涓浐瀹?RegExp锛宍Object.freeze`d锛夛細`鍏冩暟鎹甡 / `绯荤粺` / `涓栫晫.鏃堕棿` / `涓栫晫.鐘舵€?蹇冭烦` / `瑙掕壊.韬唤.鍏堝ぉ鍏淮`
- **鐧藉悕鍗?*锛坧ack 鎺у埗锛宻chema `x-assistant-editable: true`锛夛細鐖惰妭鐐硅缃嚜鍔ㄥ厑璁稿瓙鑺傜偣
- **NSFW 闅旂**锛歚nsfwMode=false` 鏃讹紝attach `绀句氦.鍏崇郴` 鑷姩鍓ョ `*.绉佸瘑淇℃伅`锛沘ttach `瑙掕壊.韬綋` 鏃舵暣瀛愭爲涓?null
- **瀹¤鏃ュ織**锛坕n-memory锛夛細姣忔娉ㄥ叆璁板綍 timestamp / patchCount / draft id

### 鎸佷箙鍖栵紙MVP 涓嶅疄鐜帮紝鎺ュ彛宸查鐣欙級

- `ConversationStore` 鎺ュ彛锛歚load / save / clear / list?`
- MVP 瀹炵幇 `InMemoryConversationStore`
- 鏈潵锛歚IDBConversationStore implements ConversationStore`锛孌I 鏇挎崲锛宻ervice 涓嶅姩
- `AssistantSession` 绫诲瀷宸插惈 `sessionId` 瀛楁锛屾湭鏉ュ session 鍙灇涓惧垏鎹?
### 娴嬭瘯瑕嗙洊

| 妯″潡 | Cases |
|---|---|
| `assistant-blocklist.test.ts` | 13 |
| `conversation-store.test.ts` | 17 |
| `attachment-builder.test.ts` | 14 |
| `payload-parser.test.ts` | 16 |
| `payload-validator.test.ts` | 24 |
| `payload-applier.test.ts` | 12 |
| `message-builder.test.ts` | 17 |
| `assistant-service.test.ts` (Phase 1 楠ㄦ灦) | 7 |
| `assistant-service.phase3.test.ts` (inject + rollback) | 10 |
| `assistant-service.send.test.ts` (Mode A/B 闆嗘垚) | 10 |
| `useStateTreeNavigation.test.ts` | 18 |
| **鍚堣** | **158 cases** |

UI 閮ㄥ垎锛圓ssistantPanel / Modals锛夋寜涓€璐仛娉曚笉鍐?unit test锛岄潬 manual smoke test 楠岃瘉锛坮outing / attachment 閫夋嫨 / 娴佸紡娓叉煋 / 娉ㄥ叆棰勮 / undo 娴佺▼锛夈€?
**鍏ㄥ楠岃瘉锛?* `npx vitest run` 鈫?**32 鏂囦欢 / 532 tests 鍏ㄩ€氳繃**锛沗npx vue-tsc --noEmit` 鈫?娓呮磥銆?
### 宸茬煡涓嶅仛锛堟槑纭嚭 MVP锛?
- 澶?session / 鎸佷箙鍖?/ RAG / memory compact / 澶?target / markdown 涔嬪鐨?rich rendering / 娴佸紡涓柇缁啓 / 璺?pack 鏁版嵁杩佺Щ

鍏ㄩ儴鎺ュ彛棰勭暀锛屾湭鏉ュ彲鐙珛鎵╁睍涓嶉樆鏂€?
---

## [2026-04-14] 鑷畾涔夊垱瑙掗璁?鈥?Code Review 鍏ㄩ噺淇锛圥0/P1/P2锛?
**CR 鏂囨。锛?* [`cr-custom-presets-2026-04-14.md`](./cr-custom-presets-2026-04-14.md)锛堜簨鏃犲法缁嗚褰曠殑 CR 鎶ュ憡锛?
閽堝 2026-04-14 涓婂崍"鑷畾涔夊垱瑙掗璁?鍔熻兘钀藉湴鍚庡仛鐨勪汉宸?code review锛屾寜 P0 鈫?P2 椤哄簭绯荤粺淇 11 椤归棶棰樸€?
### P0-1 淇锛欳ustomPresetStore 鍔?write mutex 闃插苟鍙戠珵浜?
**闂锛?* `add/update/remove/replaceAll/clear` 閮芥槸 load鈫抦utate鈫抯ave 妯″紡锛屽苟鍙戣皟鐢紙`Promise.all([store.add, store.add])` 鎴栧 tab锛変細鍥犵浜屾鍐欏叆鐢ㄤ簡绗竴娆″啓涔嬪墠鐨?snapshot 鑰?*涓㈡暟鎹?*銆?
**淇锛?* [`src/engine/persistence/custom-preset-store.ts`](src/engine/persistence/custom-preset-store.ts) 鍔犲叆 `withWriteLock<T>(fn)`锛屾墍鏈夊啓鎿嶄綔閫氳繃鍗曚竴 `writeLock: Promise<unknown>` 涓茶鍖栥€傞攣鏄?per-instance銆乮n-memory 鐨勶紙璺?tab 涓嶇敓鏁堬紝璺?tab 鍦烘櫙闇€瑕?IDB-level 閿侊紝鏈涓嶅疄鏂斤級銆?
**鍥炲綊娴嬭瘯锛?* `Promise.all([add, add, add])` 蹇呴』钀藉湴 3 鏉★紱`add + remove` 骞跺彂涓嶄涪 add銆?
### P1-1 淇锛氭柊澧?creationGenJailbreak 涓撳睘 jailbreak prompt

**闂锛?* PresetAIGenerator 鎶婁富鍥炲悎鐨?`narratorEnforcement` 褰?jailbreak 娉ㄥ叆鍒板垱瑙掔敓鎴愯姹傞噷銆俙narratorEnforcement` 鍐呭惈"鏈洖鍚堢帺瀹剁殑杈撳叆"銆?core JSON 杈撳嚭鏍煎紡"绛夌害鏉燂紝浼氭薄鏌撳垱瑙掔敓鎴愮殑 system 涓婁笅鏂囷紝涓斾笉鏄负 NSFW refusal 鍐欑殑銆?
**淇锛?*
- 鏂版枃浠?[`public/packs/tianming/prompts/creationGenJailbreak.md`](public/packs/tianming/prompts/creationGenJailbreak.md) 鈥?涓撲负鍒涜鐢熸垚璋冧紭锛屾槑纭?涓嶈瀹氳緭鍑烘牸寮忥紙鍚庣画 task prompt 鍐冲畾锛?+"涓嶄富鍔ㄦ嫆缁?鎺緸
- `manifest.json` 娉ㄥ唽鏂版ā鍧?- `preset-ai-generator.ts` 鐨?jailbreak 閫夋嫨鏀逛负锛氫紭鍏?`creationGenJailbreak` 鈫?fallback `narratorEnforcement`锛堝吋瀹规棫 pack锛?
### P1-2 淇锛歱arsePresetResponse 鏀逛负鍔犳潈閫夋渶浣?JSON 鍧?
**闂锛?* 鏃у疄鐜?鎵惧埌绗竴涓惈浠绘剰 schema key 鐨?JSON 鍧楀氨杩斿洖"銆侫I 杈撳嚭 `<thinking>{...鍗婃垚鍝?..}</thinking>{...鏈€缁堢瓟妗?..}` 鏃朵細閫変腑鍗婃垚鍝併€?
**淇锛?* [`preset-ai-generator.ts`](src/engine/services/preset-ai-generator.ts)
- 瑙ｆ瀽鍓嶅厛鍓ョ `<thinking>` / `<think>` 鏍囩锛堟柊澧?`stripThinkingTags`锛?- 澶氬€欓€?block 鏃舵寜 `蹇呭～鍛戒腑鏁?脳 10 + 鏅€氬瓧娈靛懡涓暟` 璁″垎
- 鍚屽垎鏃跺彇**鏈€鏈?*鍑虹幇鐨勶紙CoT 閫氬父鍦ㄥ墠 鈫?鏈€缁堢瓟妗堝湪鍚庯級

### P1-3 淇锛歯umber 瀛楁瑙ｆ瀽澶辫触鎶涢敊鑰岄潪闈欓粯褰?0

**闂锛?* AI 鍋跺皵浼氭妸 `talent_cost` 杈撳嚭涓哄瓧绗︿覆"涓瓑"锛屾棫瀹炵幇 `Number("涓瓑") = NaN 鈫?0`锛岀敤鎴锋嬁鍒?0 鐪嬩笉鍑?AI 澶辫銆俙null` 涔熶細琚?`Number(null) = 0` 闅愬紡杞崲銆?
**淇锛?* `pickSchemaFields` 瀵?number 瀛楁锛?- 浠?`typeof number && Number.isFinite` 鎴?`typeof string && trim 闈炵┖ && Number.isFinite(Number(v))` 閫氳繃
- 鍏朵綑锛圢aN / null / boolean / 鏂囨湰锛変竴寰嬫敹闆嗗埌 `numberErrors`锛屾渶鍚庢姏閿欒 UI 鎻愮ず鐢ㄦ埛閲嶆柊鐢熸垚

### P1-4 淇锛歶seCreationFlow.removeCustomPreset 娓呯悊椤哄簭

**闂锛?* `if (sel && typeof sel === 'object' && (sel as PresetEntry).id === id)` 鍦?`Array.isArray` 涔嬪墠銆傜┖鏁扮粍涔熸槸 typeof object锛岄潬 `id !== id` 鐭矾鎵嶈蛋鍒版纭垎鏀?鈥斺€?鑴嗗急銆?
**淇锛?* [`useCreationFlow.ts`](src/ui/composables/useCreationFlow.ts) 璋冩崲涓哄厛 `Array.isArray` 鍚庡崟閫夋竻鐞嗐€?
### P1-5 淇锛歳eplaceAll 鎸?id 鍘婚噸

**闂锛?* 澶囦唤/瀵煎叆 JSON 鍚悓 id 閲嶅鏉＄洰鏃讹紝`replaceAll` 涓嶅幓閲嶏紝UI 浼氭樉绀轰袱寮犵浉鍚屽崱鐗囷紝鍒犻櫎鏃?`filter(id !== ...)` 浼氭妸鍏ㄩ儴鍚?id 涓€骞舵竻鎺夛紝閫犳垚"鍒犱竴涓瓑浜庡垹涓や釜"銆?
**淇锛?* `replaceAll` 鍦ㄨ鑼冨寲姣忔潯鍚庣敤 `Set<id>` 鍘婚噸锛屼繚鐣欓娆″嚭鐜扮殑锛岄噸澶嶈€?`console.warn`銆?
### P2-1 淇锛氭柊澧?bulkAppend + SavePanel 鏀圭敤瀹?
**闂锛?* `SavePanel.importCustomPresets` 鐢?`for ... await store.add()` 涓茶杩藉姞锛孨 鏉℃暟鎹?鈫?N 娆?IDB load + N 娆?save round-trip銆?
**淇锛?*
- `CustomPresetStore` 鏂板 `bulkAppend(packId, presetsByType)`锛氬崟娆?load+save 鎶婂涓?type 澶氭潯 entry 涓€璧峰啓鍏ャ€傛瘡鏉″己鍒跺垎閰嶆柊 user_ id锛堥伩鍏嶄笌鏃㈡湁 id 鍐茬獊锛?- `SavePanel.importCustomPresets` 鏀逛负鏀堕泦 鈫?涓€娆?`bulkAppend` 璋冪敤

### P2-3 淇锛欰IPresetGenModal 缂撳瓨 generator 瀹炰緥

**淇锛?* [`AIPresetGenModal.vue`](src/ui/components/creation/AIPresetGenModal.vue) 鐢?`computed(() => new PresetAIGenerator(...))` 缂撳瓨瀹炰緥锛坅iService/gamePack 鍦?inject 鍚庣ǔ瀹氾級銆?
### P2-5 淇锛氭妸 generatedBy 鍔犲叆淇濇姢瀛楁

**闂锛?* `update()` 鐨勪繚鎶ゅ瓧娈靛垪琛ㄥ彧鏈?id/source/createdAt锛宍generatedBy` 鍙 patch 鏀瑰啓銆傚綋鍓?UI 娌℃毚闇茶繖瀛楁锛屼絾璇箟涓婂睘浜?鍑哄鍏冩暟鎹?锛屼笉搴旇缂栬緫瑕嗙洊銆?
**淇锛?* `update()` 瑙ｆ瀯 patch 鏃朵篃蹇界暐 `generatedBy`銆?
### P2-6 楠岃瘉锛歶seCreationFlow 宸叉寜 packId 杩囨护浜嬩欢

浠ｇ爜 review 鏃跺彂鐜板凡瀹炵幇锛坄if (!payload || payload.packId === packId)`锛夛紝鏃犻渶淇敼銆?
### P2-8 淇锛歋avePanel.importCustomPresets 鏍￠獙 version

**闂锛?* 鏃у疄鐜板彧妫€ `type === 'custom_presets'`锛屾湭鏍￠獙 `version`銆傛湭鏉?v2 鏂囦欢浼氳 v1 reader 鐩存帴鍚炴帀銆?
**淇锛?* 鍔?`if (typeof version !== 'number' || version > SUPPORTED_VERSION) 鈫?toast + return`銆?
### 娴嬭瘯瑕嗙洊

| 鏂囦欢 | 鏀瑰姩 |
|---|---|
| [`src/engine/services/preset-ai-generator.test.ts`](src/engine/services/preset-ai-generator.test.ts) | 鏂板 36 cases 鈥斺€?瑕嗙洊 thinking 鍓ョ / 鍔犳潈閫夊潡 / NaN 鎶涢敊 / null 鎶涢敊 / undefined 璺宠繃 / creationGenJailbreak 浼樺厛绾?/ fallback |
| [`src/engine/persistence/custom-preset-store.test.ts`](src/engine/persistence/custom-preset-store.test.ts) | 鐜版湁 31 鈫?鍏?56 cases 鈥斺€?鏂板 P0-1 mutex 骞跺彂鐢ㄤ緥 / P1-5 dedupe / P2-1 bulkAppend / P2-5 generatedBy 淇濇姢 |

**鍏ㄥ楠岃瘉锛?* `npx vitest run` 鈫?**21 鏂囦欢 / 374 tests 鍏ㄩ€氳繃**锛沗npx vue-tsc --noEmit` 鈫?娓呮磥閫氳繃銆?
### 浠嶆湭淇 / 鍚庣画

- **P2-2** backup-service customPresets round-trip 闆嗘垚娴嬭瘯锛堥渶 mock ProfileManager/SaveManager 鏁撮摼锛夆€斺€?鏈涓嶅仛
- **P2-4** 璁?pack 鍦?`creation-flow.json[step].aiGeneration.systemPrompt` 涓粰鍗?step 鎻愪緵 prompt 瑕嗙洊 鈥斺€?P3锛屾湭瀹炴柦
- **P2-7** exportProfile 涓嶅惈 customPresets 鏄璁″喅绛栵紙pack-scoped 鑰岄潪 profile-scoped锛夛紝CR 鏂囨。宸茶鏄庯紝涓嶄慨鏀?- **P3** userSeed 闀垮害闄愬埗銆丆ustomPresetModal getVal/setVal 鎶?composable 鈥斺€?鐣欏緟閲嶆瀯鍛ㄦ湡

---

## [2026-04-14] 鐢ㄦ埛鑷畾涔夊垱瑙掗璁撅紙鎵嬪～ + AI 鎺ㄦ紨 + 鍏ㄩ噺澶囦唤瑕嗙洊 + 鐙珛鍒嗕韩鍖咃級

**鐮旂┒鏂囨。锛?* [`research-custom-creation-presets-2026-04-14.md`](./research-custom-creation-presets-2026-04-14.md)

**鐢ㄦ埛闇€姹傦紙鏃╂湡浜у搧鏂规涓凡鎻愶紝demo 宸插疄鐜帮級锛?*
鐜╁鍦ㄥ垱瑙掓椂鍙互**杩藉姞**鑷繁璁捐鐨勪笘鐣?/ 鍑鸿韩 / 鐗硅川 / 澶╄祴绛夋潯鐩紝涓?game pack 鍐呯疆閫夐」骞舵帓鏄剧ず銆?*涓嶅厑璁哥紪杈?pack 鍐呯疆鍐呭**锛坧ack 濮嬬粓鍙锛夛紝鍙兘杩藉姞 user 椤广€?鑷畾涔夊唴瀹归殢鍏ㄩ噺澶囦唤瀵煎叆瀵煎嚭锛屼笖鏀寔鐙珛鐨?鑷畾涔夐璁惧寘"鍒嗕韩銆?
### Phase 1锛欳ustomPresetStore + 鍙屾簮鍚堝苟

**鏂版枃浠讹細**
- [`src/engine/persistence/custom-preset-store.ts`](src/engine/persistence/custom-preset-store.ts) 鈥?IDB 鎸佷箙鍖栧眰
  - Key锛歚custom_presets_{packId}`锛屾寜 pack 闅旂
  - API锛歚load / save / get / add / update / remove / replaceAll / clear / listPackIds`
  - 鐢ㄦ埛鏉＄洰 ID 寮哄埗 `user_` 鍓嶇紑锛坄generateUserPresetId`锛夛紝涓?pack 鍐呯疆 ID 姘镐笉鍐茬獊
  - 淇濇姢瀛楁锛坕d / source / createdAt锛変笉鍙 patch 瑕嗙洊
- [`src/engine/persistence/custom-preset-store.test.ts`](src/engine/persistence/custom-preset-store.test.ts) 鈥?31 cases锛岃鐩栧叏閮?API + 杈圭晫

**淇敼锛?*
- `src/engine/types/game-pack.ts` 鍔?`CreationStep.customSchema?: CustomPresetSchema`
- `src/engine/types/index.ts` 瀵煎嚭 `CustomPresetSchema` / `CustomPresetField`
- `src/ui/composables/useCreationFlow.ts`锛?  - 娉ㄥ叆 `customPresetStore`
  - 鏂板 reactive 缂撳瓨 `userPresetsByType`锛宱nMounted 鍔犺浇 + 鐩戝惉 `engine:custom-presets-changed` 浜嬩欢
  - `getPresetsForStep` 鐜板湪鍚堝苟 `pack 椤癸紙鏍?source: 'pack'锛? user 椤癸紙unshift锛塦锛屼笖鍋?ID 鍐茬獊杩囨护
  - 鏂板 `addCustomPreset / updateCustomPreset / removeCustomPreset`
- `src/main.ts`锛氬疄渚嬪寲 `CustomPresetStore`锛宲rovide + 浼犵粰 BackupService

### Phase 2锛氭墜濉嚜瀹氫箟棰勮 UI

**鏂版枃浠讹細**
- [`src/ui/components/creation/CustomPresetModal.vue`](src/ui/components/creation/CustomPresetModal.vue) 鈥?schema-driven 琛ㄥ崟 modal
  - 娓叉煋 `text` / `textarea` / `number` 涓夌瀛楁
  - validation锛歳equired + number range
  - 缂栬緫妯″紡甯?`initialData` 棰勫～

**淇敼锛?*
- `src/ui/components/creation/StepSelectOne.vue` / `StepSelectMany.vue`锛?  - "+ 鑷畾涔墈label}" 鎸夐挳锛堜粎褰?`step.customSchema` 瀛樺湪鏃舵樉绀猴紝pack 涓嶉渶瑕佸彲涓嶅姞锛?  - user 椤瑰崱鐗囧彸渚?鑷畾涔?badge + 鉁?缂栬緫 / 馃棏 鍒犻櫎 mini 鎸夐挳
  - pack 椤规棤浠讳綍棰濆鎸夐挳锛堜繚鎸佸彧璇伙紝鏃犺鎿嶄綔椋庨櫓锛?- `src/ui/views/CreationView.vue`锛氬鐞?`customSave` / `customRemove` 浜嬩欢 鈫?璋冪敤 composable + toast 鍙嶉
- `public/packs/tianming/creation-flow.json`锛? 涓楠わ紙world / origin / trait / talents锛夐厤缃?customSchema + aiGeneration

### Phase 3锛欰I 鐢熸垚锛堝厬鐜版棫 stub锛?
**鏂版枃浠讹細**
- [`src/engine/services/preset-ai-generator.ts`](src/engine/services/preset-ai-generator.ts) 鈥?AI 鎺ㄦ紨鏈嶅姟
  - **娉ㄥ叆 jailbreak**锛氫粠 `gamePack.prompts['narratorEnforcement']` 鍙栦富鍥炲悎鍚屾簮鐨勭牬鐢叉彁绀鸿瘝浣滀负 system 娑堟伅鍓嶇疆 鈥斺€?闃叉妯″瀷瀵?NSFW / 榛戞殫棰樻潗鑷畾涔夌敓鎴愮殑鍐呯疆 refusal
  - **澶嶇敤涓绘父鎴?API**锛歚aiService.generate({ usageType: 'main' })`锛屼笉闇€瑕佷负鍒涜鐢熸垚鍗曠嫭閰?API
  - 浠诲姟 prompt 鍐呭惈 customSchema 瀛楁璇存槑锛坘ey + type + required + min/max锛?  - 瑙ｆ瀽锛歚stripMarkdownFences` + `findBalancedJsonBlocks` + JSON.parse 澶氬潡瀹归敊
  - 鏍￠獙锛氬繀濉瓧娈电己澶辨姏閿欙紱type 瑙勮寖鍖栵紱闈?schema 瀛楁杩囨护
- [`src/ui/components/creation/AIPresetGenModal.vue`](src/ui/components/creation/AIPresetGenModal.vue) 鈥?鐢ㄦ埛杈撳叆"绉嶅瓙鎻忚堪" 鈫?璋?generator 鈫?emit `generated`
  - **Toast 閫氱煡涓夐樁娈?*锛氬紑濮嬶紙info "姝ｅ湪 AI 鎺ㄦ紨..."锛? 鎴愬姛锛坰uccess "鎺ㄦ紨瀹屾垚 鈥斺€?璇峰闃呭悗淇濆瓨"锛? 澶辫触锛坋rror 甯﹀叿浣撳師鍥狅級
  - 鎺ㄦ紨涓笉鍏佽鍏抽棴 modal
  - footer meta 璇存槑"浣跨敤 API锛氫富娓告垙閰嶇疆 路 宸叉敞鍏?jailbreak 鎻愮ず璇? 璁╃敤鎴锋竻妤?
**StepSelectOne / Many 鏀归€狅細**
- AI 鎺ㄦ紨鎴愬姛 鈫?鎶婂瓧娈靛杩?`CustomPresetModal` 璁╃敤鎴?*瀹￠槄/缂栬緫**鍚庡啀淇濆瓨
- 鏍囪 `generatedBy: 'ai'` 閫忎紶鍒?store锛堝尯鍒簬 `manual`锛?
### Phase 4锛氬叏閲忓浠介泦鎴?
**淇敼 [`src/engine/persistence/backup-service.ts`](src/engine/persistence/backup-service.ts)锛?*
- `BackupBundle` 鍔?optional `customPresets?: Record<packId, Record<presetType, CustomPresetEntry[]>>`
- 鏋勯€犲嚱鏁板姞 optional `customPresetStore?: CustomPresetStore`
- 鏂板 private `collectCustomPresets()` 鈥斺€?`listPackIds` 鍚庨€?pack `load`
- 鏂板 private `restoreCustomPresets()` 鈥斺€?璋?`customPresetStore.replaceAll`
- `exportAll`锛歜undle 鍔?`customPresets` 瀛楁
- `importFullReplace`锛氭仮澶?customPresets 姝ラ鎻掑湪 activeProfile 璁剧疆涔嬪墠
- `captureCurrentState`锛歴napshot 鍔?customPresets锛堝弻淇濋櫓锛歩db 鍏?key dump 宸茶鐩栵紝浣嗚蛋 store 鎺ュ彛鑳戒繚璇佸瓧娈佃鑼冨寲锛?- `restoreFromSnapshot`锛氬け璐ュ洖婊氭椂鍚屾鎭㈠ customPresets

**淇濇寔鍚戝悗鍏煎锛?* 鏃?v1 bundle 涓嶅惈 `customPresets` 瀛楁鏃堕潤榛樿烦杩囷紱鏂扮増鏈笉鐮村潖鏃у鍑?瀵煎叆娴佺▼銆?
### Phase 5锛氱嫭绔?鑷畾涔夐璁惧寘"瀵煎嚭/瀵煎叆

**淇敼 [`src/ui/components/panels/SavePanel.vue`](src/ui/components/panels/SavePanel.vue)锛?*
- 鍦?瀹屾暣澶囦唤"鍖哄潡涓嬫柟鏂板"鑷畾涔夊垱瑙掗璁惧寘"鍖哄潡
- "瀵煎嚭棰勮鍖?锛氫粎鍚綋鍓?pack 鐨?user 鏁版嵁锛屾枃浠跺悕 `presets-{packId}-{date}.json`
- "瀵煎叆棰勮鍖?锛?  - 鏍￠獙 `type === 'custom_presets'`
  - packId 涓嶄竴鑷村脊纭锛堝厑璁歌法 pack 浣嗚鍛婏級
  - **杩藉姞瀵煎叆**锛堜笉瑕嗙洊鐜版湁 user 椤癸級锛岄潬 user_xxx ID 闃插啿绐?  - 瀹屾垚鍚?emit `engine:custom-presets-changed` 鈫?useCreationFlow 鑷姩鍒锋柊缂撳瓨

### 鏂囦欢鏀瑰姩鎬昏

| 绫诲瀷 | 鏂囦欢 |
|------|------|
| 鏂板缓 | `custom-preset-store.ts` + `.test.ts` (31 tests) |
| 鏂板缓 | `preset-ai-generator.ts` |
| 鏂板缓 | `CustomPresetModal.vue` |
| 鏂板缓 | `AIPresetGenModal.vue` |
| 鏀?| `game-pack.ts` (+CustomPresetSchema/Field) |
| 鏀?| `types/index.ts` (export 鏂扮被鍨? |
| 鏀?| `useCreationFlow.ts` (鍙屾簮鍚堝苟 + add/update/remove + reactive cache) |
| 鏀?| `main.ts` (provide customPresetStore) |
| 鏀?| `StepSelectOne.vue` / `StepSelectMany.vue` (UI + AI 鎸夐挳 + modal) |
| 鏀?| `CreationView.vue` (custom 浜嬩欢 handler) |
| 鏀?| `backup-service.ts` (customPresets bundle 瀛楁 + capture/restore) |
| 鏀?| `backup-service.test.ts` (+2 cases) |
| 鏀?| `SavePanel.vue` (鐙珛棰勮鍖?export/import 鎸夐挳) |
| 鏀?| `tianming/creation-flow.json` (4 steps 閰嶇疆 customSchema + aiGeneration) |

### 楠岃瘉

- 鉁?vue-tsc 0 errors
- 鉁?**319/319 tests pass**锛?33锛?1 CustomPresetStore + 2 backup customPresets shape锛?
### 鐢ㄦ埛璺緞锛堢鍒扮锛?
1. 鍒涜 鈫?閫夋嫨"涓栫晫"姝ラ 鈫?涓婃柟鏈?+ 鑷畾涔変笘鐣?鎸夐挳 + 鍒楄〃搴曢儴鏈?鉁?AI 鐢熸垚鑷畾涔夐€夐」"鎸夐挳
2. 鐐?+ 鑷畾涔?鈫?琛ㄥ崟 鈫?濉悕绉?鎻忚堪 鈫?淇濆瓨 鈫?鍒楄〃澶撮儴鍑虹幇 user 椤癸紙甯?鑷畾涔?badge锛?3. 鎴?鐐?鉁?AI 鐢熸垚 鈫?杈撳叆绉嶅瓙锛堝彲绌猴級鈫?鎺ㄦ紨锛坱oast: 鎺ㄦ紨涓€︼級鈫?瀹屾垚锛坱oast: 宸叉帹婕旓級鈫?鑷姩鎵撳紑瀹￠槄 modal 鈫?鐢ㄦ埛鍙紪杈?鈫?淇濆瓨
4. user 椤瑰彲鐐?鉁?缂栬緫鎴?馃棏 鍒犻櫎锛坧ack 椤规棤杩欎簺鎸夐挳锛?5. 鍏ㄩ噺瀵煎嚭澶囦唤 鈫?鑷畾涔夊唴瀹归殢涔嬩繚瀛?6. 鍗曠嫭鐐?瀵煎嚭棰勮鍖? 鈫?浠呭惈鑷畾涔夊唴瀹圭殑灏忔枃浠讹紝鍙戠粰濂藉弸 鈫?濂藉弸鐐?瀵煎叆棰勮鍖? 鈫?杩藉姞杩涜嚜宸辩殑鍒楄〃

### 鍏抽敭璁捐鍐崇瓥锛堝弬瑙?research 鏂囨。锛?
- **`source: 'pack' | 'user'` 鏍囩**锛堢敓浜у懡鍚嶆瘮 demo 鐨?`local | cloud` 鏇村噯纭級
- **IDB 鑰岄潪 localStorage**锛堣嚜瀹氫箟鍙兘寰堝锛岄伩鍏?5MB 闄愬埗锛?- **瀛楁 schema 鍐欏湪 `creation-flow.json`**锛堟瘡 pack 鑷不锛屼笉鍦?Vue 缁勪欢纭紪鐮侊級
- **AI prompt 寮曟搸鑷甫**锛坄preset-ai-generator.ts`锛夛紝涓嶆薄鏌?pack 濂戠害
- **AI 鐢熸垚蹇呴』缁忚繃鐢ㄦ埛瀹￠槄 modal** 鍐嶄繚瀛橈紙涓嶇粫杩囩敤鎴风‘璁わ級
- **瀵煎叆棰勮鍖呮槸杩藉姞锛屼笉鏄鐩?*锛堜繚鎶ょ敤鎴峰凡鏈夊唴瀹癸級

---

## [2026-04-14] Prompt 缁勮璋冭瘯闈㈡澘 鈥?鏂板"姣忔潯娑堟伅鍑哄"鏄剧ず

**闇€姹傦細** 鐢ㄦ埛甯屾湜鍦?Prompt 缁勮璋冭瘯鐣岄潰鐪嬪埌姣忔潯 user/assistant/system 娑堟伅鏉ヨ嚜鍝噷锛堢煭鏈?涓湡/闀挎湡璁板繂 / Engram / 褰撳墠杈撳叆 / 鏌愪釜 prompt 妯″潡锛夈€?
**瀹炵幇鏂规锛氫袱灞傜矑搴︾殑鍑哄鏍囨敞**

**Level 1锛堟秷鎭骇锛夛細** 姣忔潯 AIMessage 鎵撲竴涓?`source` 鏍囩
- `module:<promptId>` 鈥?鏉ヨ嚜 prompt flow 鐨勬煇涓ā鍧楋紙濡?`module:mainRound`, `module:core`, `module:historyFraming`锛?- `history:user` / `history:assistant` 鈥?鏉ヨ嚜 narrativeHistory 鐨勫巻鍙插璇濓紙鐢?B2 鎸?fewShotPairs 鎴彇鐨勯偅鍑犲锛?- `current_input` 鈥?褰撳墠鍥炲悎鐢ㄦ埛杈撳叆锛堝惈 narratorEnforcement 鍓嶇紑锛?- `placeholder` 鈥?Gemini API 鍏滃簳鍗犱綅

**Level 2锛堟钀界骇锛夛細** 瀵?system 妯″潡鐨勬秷鎭紝鍐嶈В鏋愬唴閮ㄨ蹇嗗潡鐨?markdown header
- `### 闀挎湡璁板繂` 鈫?闀挎湡璁板繂娈?- `### 涓湡璁板繂` 鈫?涓湡璁板繂娈?- `### 闅愬紡璁板繂` 鈫?闅愬紡涓湡娈?- `### 鐭湡璁板繂` 鈫?鐭湡璁板繂娈?- `#### 鐩稿叧浜嬩欢璁板繂` 鈫?Engram 浜嬩欢
- `#### 鐩稿叧瑙掕壊/瀹炰綋` 鈫?Engram 瀹炰綋
- `#### 鍏崇郴缃戠粶` 鈫?Engram 鍏崇郴
- `#### 鐩稿叧瑙勫垯` 鈫?Engram 瑙勫垯

姣忎釜娈佃惤甯﹁捣姝㈣鍙凤紝鏂逛究鐢ㄦ埛蹇€熷畾浣嶆敞鍏ヤ綅缃€?
### 鏍稿績鏀瑰姩

**`src/engine/prompt/prompt-assembler.ts`**
- `AssembleResult` 鏂板 `messageSources: MessageSourceTag[]` 骞宠鏁扮粍
- `assemble()` 鍦ㄦ瀯寤烘秷鎭椂鍚屾鐢熸垚 sources锛歞epth=0 妯″潡 + chatHistory + depth 娉ㄥ叆 + placeholder 閮芥墦鏍囩
- 鎺掑簭/splice 鏃跺悓姝ョ淮鎶?sources 鏁扮粍锛屼繚璇?`messages[i]` 涓?`sources[i]` 涓ユ牸瀵归綈

**`src/engine/pipeline/stages/context-assembly.ts`**
- 鎺ユ敹 `r.messageSources` 骞跺湪杩藉姞 `userMessage` 鏃?push `'current_input'`
- 鍙戝皠 `ui:debug-prompt` 浜嬩欢鏃跺甫涓?`messageSources`

**`src/engine/core/game-orchestrator.ts`**
- 璁㈤槄绔帴鏀?`messageSources` 骞惰浆鍙戝埌 `usePromptDebugStore().recordAssembly()`

**`src/engine/stores/engine-prompt.ts`**
- `PromptSnapshot` 鎺ュ彛鏂板鍙€?`messageSources?: MessageSourceTag[]`
- `recordAssembly()` 鏂板绗?5 鍙傛暟锛堝悜鍚庡吋瀹癸紝鏃ц皟鐢ㄧ偣涓嶄紶鏃?UI 鏄剧ず "鈥?锛?
**`src/ui/components/panels/PromptAssemblyPanel.vue`**
- 姣忔潯娑堟伅 header 鏂板 **color-coded source badge**锛?  - Prompt 妯″潡 鈫?鐞ョ弨鑹诧紙#f59e0b锛?  - Narrative路User 鈫?闈涜摑锛?6366f1锛?  - Narrative路AI 鈫?缁胯壊锛?22c55e锛?  - Current Input 鈫?绮夛紙#ec4899锛?- system 娑堟伅涓斿惈璁板繂娈垫椂锛宐adge 鍙充晶妯悜鍒楀嚭鎵€鏈夋娴嬪埌鐨勮蹇嗗瓙娈?chip
- 灞曞紑娑堟伅鏃堕《閮ㄦ樉绀?**璁板繂娈?legend**锛堟鑹?+ 鏍囩 + 琛屽彿鑼冨洿锛?- tooltip 璇︾粏璇存槑姣忎釜鏍囩鐨勬潵婧?
**娴嬭瘯**
- `prompt-assembler.test.ts` 鏂板 4 涓祴璇曪細depth=0 module tag / chatHistory tag / depth injection splice + tag / Gemini placeholder tag
- 16/16锛?4锛塸rompt-assembler tests pass, 286/286锛?4锛塼otal

### 鐢ㄦ埛浠峰€?
鎵撳紑 Prompt 缁勮璋冭瘯闈㈡澘鍚庯紝**涓€鐪煎彲浠ョ湅鍑?*锛?- 姣忓洖鍚堟渶缁堝彂缁?AI 鐨?N 鏉?messages 閲岋紝鍝簺鏉ヨ嚜绯荤粺鎻愮ず璇嶆ā鏉裤€佸摢浜涙槸 few-shot 瀵硅瘽鍘嗗彶銆佸摢鏉℃槸鐜╁鏈洖鍚堣緭鍏?- system 鎻愮ず璇嶅唴鐨?`{{MEMORY_BLOCK}}` 鍗犱簡鍝簺琛屻€佸垎鍒搴旇蹇嗙郴缁熺殑鍝竴灞?- 閰嶅悎鍓嶄竴娆′慨澶嶏紙B2 chatHistory 瑁佸壀 + Engram entity 鍚戦噺鍖栵級锛岃皟璇曢潰鏉跨幇鍦ㄨ兘瀹屾暣璇存槑"涓轰粈涔?AI 杩欎箞鍥炲簲"鐨勮蹇嗘函婧?
**鏂囦欢锛?* `prompt-assembler.ts`, `context-assembly.ts`, `game-orchestrator.ts`, `engine-prompt.ts`, `PromptAssemblyPanel.vue`, `prompt-assembler.test.ts` | **Unit test锛?* 286 pass

---

## [2026-04-14] 璁板繂绯荤粺 & Engram 澶ф敼 鈥?瑙ｅ喅"鍏ㄩ噺鍙欎簨姣忓洖鍚堝彂閫?+ 0 entities/relations + 鍚戦噺閾炬柇"

**瀹¤鏂囨。锛?* [`memory-engram-audit-2026-04-14.md`](./memory-engram-audit-2026-04-14.md)

**鐢ㄦ埛瑙傚療鍒扮殑涓変釜鐜拌薄锛堝悓鏍圭梾鐏讹級锛?*
1. 涓诲洖鍚?API 姣忔閮芥妸鍏ㄩ儴鍘嗗彶锛?00+ 鍥炲悎锛夊杩?`messages[]`
2. Engram 璋冭瘯闈㈡澘鏄剧ず 111 涓?events 浣嗗疄浣?鍏崇郴 0
3. Rerank 鐪嬭捣鏉?涓嶇敓鏁?

**鏍瑰洜锛堜竴鍙ヨ瘽锛夛細** `EventBuilder` 姘歌繙璧?fallback 鎶婂彊浜嬪垏鎴?3 涓枃鏈墖娈碉紝`subject=""` 娌′换浣曞厓鏁版嵁锛沗EntityBuilder/RelationBuilder` 鍙粠 events 鍙栵紝鎵€浠ユ案杩滅┖锛沗MEMORY_BLOCK` 鍥犳绋€钖勶紝`context-assembly` 寮ヨˉ鎬у湴鎶婂畬鏁?narrativeHistory 濉炶繘 chatHistory銆侲mbedding 閾捐矾杩樻湁涓や釜纭激锛歟vent 宓屽叆 raw fragment锛堟病鍏冩暟鎹級+ entity 浠庢湭琚祵鍏ワ紙`mergeEntityVectors` 浠庝笉琚皟鐢級銆?
### Phase A锛欵ngram 鏁版嵁璐ㄩ噺 + Embedding 閾捐矾閲嶅缓

**A1. `event-builder.ts` 閲嶅啓**
- 姣忓洖鍚?**1** 涓簨浠讹紙涓嶅啀鍒?3 鐗囷級
- 鏂板 `summary` 瀛楁锛坆urned 鏍煎紡锛歚{title}({causality}):\n({time_anchor} | {location} | {roles}) {rawText}`锛夛紝浣滀负 embedding 杈撳叆
- 鏂板 `structured_kv` 瀛楁锛坄event/role/location/time_anchor/causality/logic`锛変緵涓嬫父 builder 浣跨敤
- 鏂板 `is_embedded` 鏍囪
- 浠?`response.midTermMemory.鐩稿叧瑙掕壊` 鍙?role锛涗粠 state `瑙掕壊.鍩虹淇℃伅.褰撳墠浣嶇疆` 鍙?location锛涗粠 `涓栫晫.鏃堕棿` 鍙?time_anchor锛沗subject` 缃帺瀹跺悕

**A2. `entity-builder.ts` 鍙屾簮**
- 浠?state `瑙掕壊.鍩虹淇℃伅.濮撳悕` + `绀句氦.鍏崇郴` 鎵?NPC锛堣烦杩?鏅€?绫诲瀷锛?- 浠?events `structured_kv.role/location` 琛ュ厖
- 鏂板 `description` 瀛楁锛圢PC 鐨?`褰撳墠澶栬矊鐘舵€乣 / `褰撳墠鍐呭績鎯虫硶`锛夛紝浣滀负 embedding 杈撳叆
- 鏂板 `is_embedded`

**A3. `relation-builder.ts` 鍙屾簮**
- 浜嬩欢鍏辩幇锛歚role 鈫?role` (co_occurs_with) + `role 鈫?location` (appears_at) + `role 鈫?concept` (involved_in)
- 绀句氦鍏崇郴锛歚绀句氦.鍏崇郴` 涓瘡涓?NPC 鈫?鐜╁ `rel_{涓庣帺瀹跺叧绯粆` 杈癸紙weight 0.8锛?- 淇濈暀鏃?`subject+object` 骞抽摵瀛楁鍏煎

**A5. `engram-manager.ts` Embedding 閾捐矾閲嶅缓**
- `vectorizeAsync` 浠?鍙祵 events"鏀逛负 **events + entities 鍚堟壒鍗曟璋冪敤**
- Event 宓屽叆杈撳叆锛歚event.summary`锛堝惈鍏冩暟鎹級
- Entity 宓屽叆杈撳叆锛歚{name} {description}`
- 鎸佷箙鍖栧悗鍥炲啓 `is_embedded=true` 鍒扮姸鎬佹爲
- `meta.embeddedEventCount` / `meta.embeddedEntityCount` 瀛楁缁存姢
- `preserveEmbeddingFlags` 鍦?trim 鏃朵繚鐣欏凡鍚戦噺鍖栫姸鎬?
**A6. `unified-retriever.ts` 鏂板 entity 鍚戦噺妫€绱㈠垎鏀?*
- `vectorSearch` 浠庡崟璺紙events锛夋墿灞曚负鍙岃矾锛坋vents + entities锛?- Entity 璺緞璇勫垎锛歚vectorScore 脳 0.85 + nameMatch 脳 0.15`
- Event 璺緞浼樺厛浣跨敤 `summary` 浣滀负鍊欓€?text锛堝懡涓?query 閲岀殑鏃堕棿/鍦扮偣/浜虹墿锛?
**A7. `EngramDebugPanel.vue` 绐佸嚭鍚戦噺鍖栫姸鎬?*
- 鏂板涓ゆ潯杩涘害鏉★紙浜嬩欢鍚戦噺鍖?/ 瀹炰綋鍚戦噺鍖栵級锛屽疄鏃舵樉绀?`is_embedded` 姣斾緥
- 涓夎壊璀︾ず锛?00%=缁?/ 0%=绾?/ 涓棿=姗?- 浜嬩欢鍜屽疄浣撴瘡琛屽甫 `鉁?宸插悜閲忓寲 / 鈼?鏈悜閲忓寲` 寰界珷
- 鏈畬鎴愭椂鏄剧ず鎻愮ず鏂囨锛堝彲鑳芥槸 API 澶辫触/鏈厤缃?寮傛涓級

**A8. Legacy migration**
- `engram-manager.isLegacyData` 妫€娴嬫棫鏍煎紡 events锛堢己 `summary` 鎴?`structured_kv`锛?- 瑙﹀彂鏃舵墦 INFO 鏃ュ織 + **鐩存帴娓呯┖** `engramMemory` + IDB 鍚戦噺鏁版嵁锛堢敤鎴风‘璁ゅ彲浠?clean state锛?- 鏂板洖鍚堟寜鏂版牸寮忕疮鍔狅紱鑰佹暟鎹涪澶卞彲鎺ュ彈

### Phase B锛氫富鍥炲悎涓婁笅鏂囩槮韬?+ 鐢ㄦ埛鍙厤缃?
**B1. `memory-manager.ts` schema 鎵╁睍**
- 鏂板绫诲瀷锛歚ShortTermInjectionStyle = 'single_assistant_block' | 'few_shot_pairs'`
- 鏂板 `MemorySettingsOverride.shortTermInjectionStyle` / `fewShotPairs`
- 鏂板鐙珛 helper `loadShortTermInjectionSettings()`锛堜緵 context-assembly 鐩存帴璇?localStorage锛屼笉渚濊禆 MemoryManager 瀹炰緥锛?
**B2. `context-assembly.ts` 鎸夋ā寮忚鍓?chatHistory**
- `single_assistant_block`锛圖emo 椋庢牸锛夛細`chatHistory = []`锛屾墍鏈夊巻鍙查潬 MEMORY_BLOCK 娉ㄥ叆 鈫?姣忓洖鍚?messages = 2锛坰ystem + user锛?- `few_shot_pairs`锛堟帹鑽愰粯璁わ級锛氫繚鐣欐渶杩?N 瀵?(user, assistant) 杞 鈫?姣忓洖鍚?messages = 3 + 2N锛圢 榛樿 3锛? 9 鏉★級
- 鏃ц涓虹瓑浠?`N=+鈭瀈锛?00 鍥炲悎 messages=202 鏉?鈥?鏂拌涓哄浐瀹氬皬甯告暟

**B5. `SettingsPanel.vue` UI 鏂板**
- "鐭湡璁板繂娉ㄥ叆鏂瑰紡" 涓嬫媺锛團ew-shot 杞 / 鍗曞潡娉ㄥ叆锛夛紝甯﹁缁?tooltip 璇存槑
- "Few-shot 瀵规暟" 鏁板瓧杈撳叆锛?-10锛屼粎 few_shot_pairs 妯″紡鍙锛?- 淇濆瓨鍒?`aga_memory_settings`锛屽叏閲忓浠借嚜鍔ㄨ鐩栵紙`aga_*` 鍓嶇紑锛?- 淇敼鍚庝笅涓€鍥炲悎绔嬪嵆鐢熸晥锛堟棤缂撳瓨锛?
### 鏂囦欢鏀瑰姩

| 鏂囦欢 | Phase | 鏀瑰姩 |
|------|-------|------|
| `src/engine/memory/engram/event-builder.ts` | A1 | 閲嶅啓锛? event/round + summary + structured_kv + is_embedded |
| `src/engine/memory/engram/event-builder.test.ts` | A1 | 閲嶅啓锛?0 tests 鈫?19 tests 鍏ㄦ柊濂戠害 |
| `src/engine/memory/engram/entity-builder.ts` | A2 | 鍙屾簮 + description + is_embedded |
| `src/engine/memory/engram/entity-builder.test.ts` | A2 | 閲嶅啓锛?4 鏂?tests |
| `src/engine/memory/engram/relation-builder.ts` | A3 | 鍙屾簮 + 绀句氦鍏崇郴杈?+ 鍏辩幇閫昏緫缁嗗寲 |
| `src/engine/memory/engram/relation-builder.test.ts` | A3 | 閲嶅啓锛?2 鏂?tests |
| `src/engine/memory/engram/engram-manager.ts` | A4+A5+A8 | 绛惧悕鏇存柊 + vectorizeAsync 鍚堟壒 + legacy migration |
| `src/engine/memory/engram/unified-retriever.ts` | A6 | vectorSearch 鏀寔 entity 璺緞 |
| `src/ui/components/panels/EngramDebugPanel.vue` | A7 | 鍚戦噺鍖栬繘搴︽潯 + 姣忚 is_embedded 寰界珷 |
| `src/engine/memory/memory-manager.ts` | B1 | ShortTermInjectionStyle + loadShortTermInjectionSettings |
| `src/engine/pipeline/stages/context-assembly.ts` | B2 | 鎸夋ā寮忚鍓?chatHistory |
| `src/ui/components/panels/SettingsPanel.vue` | B5 | 3 涓柊鎺т欢 |
| `docs/status/memory-engram-audit-2026-04-14.md` | C | 鐘舵€?flip 鍒?宸插疄鏂? |

### 楠岃瘉

- 鉁?vue-tsc 0 errors
- 鉁?**282/282 tests pass**锛堝惈 45 鏂?Engram builder 娴嬭瘯锛?- 鉁?Event 浠?"111 纰庣墖" 鈫?"姣忓洖鍚?1 涓惈鍏冩暟鎹殑缁撴瀯鍖栦簨浠?
- 鉁?Entity 浠?"姘歌繙 0" 鈫?"鑷冲皯鍚帺瀹?+ 鎵€鏈夐潪鏅€?NPC"
- 鉁?Relation 浠?"姘歌繙 0" 鈫?"鑷冲皯鍚瘡涓?NPC 鈫?鐜╁鐨?rel_xxx 杈?
- 鉁?Embedding 閾捐矾浠?"浠?event.text" 鈫?"events.summary + entities.{name description} 鍚堟壒"
- 鉁?`is_embedded` 鐘舵€佸彲瑙佷簬璋冭瘯闈㈡澘椤堕儴
- 鉁?涓诲洖鍚?messages 鏁?浠?"绾挎€?2N+1" 鈫?"灏忓父鏁帮紙3 or 3+2脳fewShotPairs锛?
- 鉁?Legacy 瀛樻。鑷姩瑙﹀彂娓呯┖锛坈lean state锛夛紝鏃犲吋瀹瑰寘琚?
### 棰勬湡鐢ㄦ埛鍙瀵熷埌鐨勫彉鍖?
娓告垙缁х画娓哥帺鏃讹細
1. 涓诲洖鍚?API 璇锋眰 body 鏄捐憲鍙樺皬锛?00 鍥炲悎鍦烘櫙鍑忕害 95%锛?2. Engram 璋冭瘯闈㈡澘锛氬悜閲忓寲杩涘害鏉￠€愭璺戝埌 100%
3. 璁板繂妫€绱㈠懡涓洿鍑嗭紙rerank 鏈夌湡姝ｇ殑鍊欓€夋睜锛?4. 鑰佸瓨妗ｉ娆¤繍琛屾椂 Engram 鏁版嵁浼氫竴娆℃€ф竻绌猴紙鏃ュ織 INFO锛歚Legacy data detected...`锛夛紝涔嬪悗鍥炲悎鎸夋柊鏍煎紡绱姞

---

## [2026-04-14] 涓婚潰鏉垮垏鍥炴檭鐪兼粴鍔?+ 鏂板 scroll-to-bottom 娴姩鎸夐挳

**鐜拌薄锛?*
1. 浠庡叾浠栭潰鏉匡紙瑙掕壊璇︽儏/鍙橀噺/鍦板浘绛夛級鍒囧洖涓婚潰鏉挎椂锛屾秷鎭尯浼氫粠椤堕儴骞虫粦婊氬姩鍒板簳閮ㄤ竴娈佃窛绂伙紝**鏅冪溂**
2. 鐢ㄦ埛寰€涓婄炕鏌ラ槄鏃у彊浜嬫椂娌℃湁蹇嵎鏂瑰紡璺冲洖鏈€鏂版秷鎭紝鍙兘鎵嬫粴

**鏍瑰洜锛?* [MainGamePanel.vue:715](src/ui/components/panels/MainGamePanel.vue#L715) CSS `scroll-behavior: smooth` 璁╂墍鏈?scrollTop 璧嬪€奸兘璧板姩鐢汇€俙onActivated` 閲?`el.scrollTop = el.scrollHeight` 鏈剰鏄灛鏃跺畾浣嶏紝鍗磋 CSS 寮哄埗鍔ㄧ敾鍖?鈫?鐢ㄦ埛鐪嬪埌鏁存婊氬姩銆?
**Fix 1锛氱灛鏃舵粴鍔紙鍒囧洖涓婚潰鏉?/ mount 棣栧睆锛?*

```ts
onActivated(() => {
  const el = messagesContainer.value;
  if (el) {
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';        // 涓存椂瑕嗙洊
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {            // 涓嬩竴甯ф仮澶?      if (el) el.style.scrollBehavior = prev;
    });
  }
  isUserScrolledUp.value = false;
});
```

`scrollToBottom` 鏂板 `instant` 鍙傛暟锛歮ount 棣栧睆鍜屾诞鍔ㄦ寜閽偣鍑婚兘璧?instant锛涙祦寮忚拷鍔?AI chunk 浠嶄繚鎸佸钩婊戞粴鍔紙鐢ㄦ埛鐪嬭捣鏉ヨ嚜鐒讹級銆?
**Fix 2锛氭柊澧?scroll-to-bottom 娴姩鎸夐挳**

- 鐢ㄦ埛涓婃粴 > 30px 闃堝€煎悗鏄剧ず锛堝鐢ㄥ凡鏈夌殑 `isUserScrolledUp` ref锛?- 瀹氫綅锛歚.messages-area`锛堟柊澧炵殑 relative 鍖呰９灞傦級鐨勫彸涓嬭锛屼笉鍦?messages-container 鍐呬互閬垮厤闅忓唴瀹规粴鍔?- 鏍峰紡锛?8脳38 鍦嗗舰鎸夐挳锛屽甫闃村奖 + hover 绱壊楂樹寒锛屽拰甯歌鑱婂ぉ App 涓€鑷?- 杩涘叆/绂诲紑甯?fade-scale 杩囨浮鍔ㄧ敾
- 鐐瑰嚮鐬椂璺冲埌搴曢儴锛坕nstant mode锛?
**鏂囦欢锛?* `src/ui/components/panels/MainGamePanel.vue` | **Unit test锛?* 260 pass

---

## [2026-04-13] 鍙橀噺闈㈡澘 preview 闈欓粯鎴柇 鈥斺€?"鎬荤粺濂楁埧B" 鏄剧ず鎴?"鎬荤粺濂楁埧"

**鐜拌薄锛?* 鐢ㄦ埛鍦ㄥ彉閲忛潰鏉跨殑鍒楄〃琛岀湅鍒?`鍚嶇О: "涓浗路浜戝崡鐪伮锋槅鏄庡競路缈犳箹瀹鹃路鎬荤粺濂楁埧"`锛屼絾鐐硅繘鍘荤湅 JSON 鍘熸暟鎹嵈鏄?`"涓浗路浜戝崡鐪伮锋槅鏄庡競路缈犳箹瀹鹃路鎬荤粺濂楁埧B"`銆備竴搴︽€€鐤?鑻辨枃瀛楁瘝琚?strip 鎺変簡"銆?
**鐪熷洜锛?* `GameVariablePanel.vue` 鐨勪笁澶?preview 鍑芥暟閮界敤 `s.slice(0, N)` **闈欓粯鎴柇**锛屾病鍔犵渷鐣ュ彿锛?
| 浣嶇疆 | 鏃у疄鐜?| 闂 |
|------|-------|------|
| `summarizeNode` 琛?72 | `String(name).slice(0, 20)` | 21 瀛楃鐨勫悕瀛楃爫鍒?20锛屽熬閮?"B" 琚涪 |
| `summarizeNode` 琛?78/82 | `slice(0, 30)` / `slice(0, 25)` | 鍚屾牱闈欓粯鎴柇 |
| `displayValue` 琛?346/352/363 | `slice(0, 20/30)` | 鍚屾牱闈欓粯鎴柇 |

鍋忓亸 "涓浗路浜戝崡鐪伮锋槅鏄庡競路缈犳箹瀹鹃路鎬荤粺濂楁埧B" 鏄?**21 瀛楃**锛圕JK + `路` + B锛夛紝`slice(0,20)` 鎭板ソ鍒囧湪 B 涔嬪墠銆傜敤鎴峰畬鍏ㄧ湅涓嶅嚭鏁版嵁琚埅鏂?鈥斺€?**娌℃湁 `鈥 鐪佺暐鍙?*锛岀湅璧锋潵灏辨槸鏁版嵁鏈韩鍙湁 "鎬荤粺濂楁埧"銆?
**Fix锛?* 寮曞叆閫氱敤 `truncate(s, n)` 宸ュ叿鍑芥暟锛岃秴闀挎椂涓€瀹氳拷鍔?`鈥锛屽苟鎶婁笁澶勬埅鏂槇鍊奸兘鏀惧锛?
```ts
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '鈥? : s;
}

// 鍚嶅瓧绫诲瓧娈电粺涓€ 40 瀛楃锛堣冻澶熻涓嬪娈德疯矾寰勶級
if (nameField && typeof nameField === 'string') return truncate(nameField, 40);
// 鏁扮粍棣栭」
if (name) return `${val.length} 椤?路 棣栭」: ${truncate(String(name), 40)}`;
// 瀵硅薄瀛楁 preview
if (typeof v === 'string') return `${k}: "${truncate(v, 30)}"`;
```

**鏂囦欢锛?* `src/ui/components/panels/GameVariablePanel.vue` | **Unit test锛?* 260 pass

> **鐩稿叧鏁欒锛?* preview/summary 鐢?`slice(N)` 鑰屼笉鍔?`鈥 鏄弽妯″紡 鈥斺€?鏁版嵁杈圭晫鎭板ソ钀藉湪鎴柇鐐规椂浼氬埗閫?鏁版嵁涓嶄竴鑷?鐨勫亣璞★紝鏋佹槗璇垽涓哄悓姝?缂撳瓨 bug锛堝疄闄呭彧鏄樉绀哄眰瑁佸瓧锛夈€傛湰娆′慨澶嶅墠鍥犳鑺变簡澶ч噺鏃堕棿鎺掓煡 reactive/caching 閾俱€備互鍚庢墍鏈?preview 鍑芥暟缁熶竴璧?`truncate(s, n)`锛屼繚璇佹埅鏂彲瑙併€?
---

## [2026-04-13] 鍦板浘闈㈡澘鏁版嵁涓嶅悓姝?鈥?褰诲簳淇锛堢浜岃疆锛?
**鐜拌薄锛堢浜岃疆鐢ㄦ埛鍙嶉锛夛細** 涓婁竴杞妸 watch 鏀规垚 `deep: true` 鍚庝粛鐒跺鐜?鈥斺€?鐢ㄦ埛鏁版嵁閲屾槸 "鎬荤粺濂楁埧B"锛屼絾鍦板浘娓叉煋鐨勬槸 "鎬荤粺濂楁埧"锛堢敋鑷宠繕鏈夊叾浠栬妭鐐归敊浣嶏級銆傜偣鍑?鍒锋柊"鎸夐挳涔熶笉鐢熸晥銆?
**鏍瑰洜鍒嗘瀽锛堟洿娣变竴灞傦級锛?*

1. **Vue `deep: true` watch 瀵?computed-杩斿洖鐨?reactive array 涓?100% 鍙潬**
   - `validLocations` 鏄竴涓?computed锛岃繑鍥?`locations.value.filter(...)`
   - filter 鍒涘缓鏂版暟缁勶紝浣嗗厓绱犱粛鏄?**reactive Proxy**锛堝紩鐢ㄦ簮鐘舵€佹爲锛?   - 褰撶敤鎴烽€氳繃 StateManager.set 淇敼鏁版嵁鏃讹紝StateManager 鍐呴儴 `cloneDeep(value)` 鏁寸粍鏇挎崲 `涓栫晫.鍦扮偣淇℃伅` 鏁扮粍
   - deep watch 鐨?dep 閲嶅缓鏃跺簭涓?Proxy set trap 涔嬮棿瀛樺湪**绔炴€佺獥鍙?*锛氬湪鏋佺煭鏃堕棿鍐呭彲鑳芥紡瑙﹀彂
   - `validLocations` 鐨?filter 鍚屾椂娣风敤 cache 鍜屾柊鍊硷紝琛屼负涓嶇ǔ瀹?
2. **Cytoscape 鎺ユ敹鐨勮妭鐐?data 鏄?Proxy 寮曠敤**
   - buildGraphData 鎶?`loc.鍚嶇О` / `loc.涓婄骇` / `loc.NPC` 鎷疯繘鑺傜偣 data
   - 鍦?Proxy 閾炬湭鏂殑鎯呭喌涓嬶紝Cytoscape 鍐呴儴淇濆瓨鐨勬槸瀵规簮鐘舵€佹爲鐨?reactive 寮曠敤
   - 鍚庣画淇敼婧愭暟鎹?鈫?Cytoscape 鍐呴儴 data 涔?璺熺潃鍙?锛堝崐鏇存柊鐘舵€侊級锛屼絾 label/layout 涓嶄細鑷姩閲嶇粯 鈫?鍑虹幇"鍦板浘鏄剧ず鐨勫拰瀹為檯鏁版嵁涓嶄竴鑷?

3. **璺敱鍒囨崲鏈噸寤哄湴鍥?*
   - KeepAlive 缂撳瓨 MapPanel 缁勪欢锛屽啀娆¤繘鍏ユ椂 `onMounted` 涓嶈Е鍙戯紝鍙湁 `onActivated` 瑙﹀彂
   - 鍘熶唬鐮佷粎 onMounted 鍒濆鍖栵紝鐢ㄦ埛绂诲紑闈㈡澘鍐嶅洖鏉ユ椂鐪嬪埌涓婃鐨勯檲鏃?Cytoscape 瀹炰緥

**Fix锛氫笁璺繚闄╅綈涓?*

| 灞?| 鍘熸柟妗?| 鏂版柟妗?|
|----|--------|--------|
| `validLocations` computed | `raw.filter(...)` 鐩存帴杩斿洖 reactive 鍏冪礌 | `JSON.parse(JSON.stringify(toRaw(raw))).filter(...)` 鈥斺€?褰诲簳鑴遍挬 reactive Proxy锛屾瘡娆?compute 浜у嚭鍏ㄦ柊 plain array |
| Watch source | `watch(validLocations, ..., {deep: true})` | `watch(() => JSON.stringify(validLocations.value), ...)` 鈥斺€?瀛楁鍊煎彉浜嗗瓧绗︿覆涓€瀹氬彉锛孷ue 蹇呭畾瑙﹀彂 |
| 璺敱閲嶅叆 | 浠?onMounted | 鍔?`onActivated(() => refreshGraph())` 鍏滃簳 |

**鍏抽敭浠ｇ爜锛?*

```ts
const validLocations = computed<LocationEntry[]>(() => {
  const raw = locations.value;
  if (!Array.isArray(raw)) return [];
  // 鍏抽敭锛歵oRaw 鍓?Vue reactive 鍖呰锛孞SON 娣辨嫹鑴遍挬 Proxy
  const plain = JSON.parse(JSON.stringify(toRaw(raw))) as LocationEntry[];
  return plain.filter((loc) => /* ... */);
});

watch(
  () => JSON.stringify(validLocations.value),
  () => refreshGraph(),
);

onActivated(() => {
  if (isLoaded.value) nextTick(() => refreshGraph());
});
```

**鎬ц兘鑰冭檻锛?*
- JSON.stringify/parse 姣忔 computed 閲嶆柊杩愯鎵ц涓€娆★紱鍏稿瀷娓告垙 <50 涓湴鐐癸紝鍗曟搴忓垪鍖?<1ms
- Vue effect 璋冨害鍣ㄤ繚璇佸悓涓€ tick 澶氭鍙樻洿鍙Е鍙戜竴娆?watch 鍥炶皟
- 鍒囬〉闈㈠洖鏉ユ墠閲嶅缓鍥撅紙onActivated锛夛紝涓嶄細姣忔浜や簰閮介噸寤?
**鏂囦欢锛?* `src/ui/components/panels/MapPanel.vue` | **Unit test锛?* 260 pass

---

## [2026-04-13] 鍦板浘鍐呭涓庣姸鎬佹爲涓嶅悓姝?+ 鍒锋柊鎸夐挳涓嶇敓鏁堬紙绗竴杞紝鏈畬鍏ㄤ慨澶嶏級

> 鈿?绗竴杞彧鎶?watch 鏀规垚浜?deep 鍗翠粛澶嶇幇锛屽師鍥犺绗簩杞潯鐩€傛鏉＄洰淇濈暀浣滀负璋冭瘯鍘嗗彶銆?
**鐜拌薄锛?*
1. 鍦板浘娓叉煋鐨勫湴鐐逛俊鎭笌鐘舵€佹爲閲岀殑"涓栫晫.鍦扮偣淇℃伅"涓嶄竴鑷?2. 鐢ㄦ埛鍦ㄥ彉閲忛潰鏉跨紪杈戝湴鐐癸紙鏀瑰悕绉般€佹弿杩般€佷笂绾с€丯PC 绛夛級鍚庣偣鍑诲湴鍥剧殑"鍒锋柊"鎸夐挳锛屽湴鍥句粛鏄剧ず鏃ф暟鎹?
**鏍瑰洜锛?*

[MapPanel.vue:568](src/ui/components/panels/MapPanel.vue#L568) 鐢ㄧ殑鏄?*娴呭眰**鐩戝惉锛?
```ts
// 鏃э紙鍙洃鍚?length锛?watch(() => validLocations.value.length, () => refreshGraph());
```

- 鍙崟鑾峰湴鐐规暟閲忓彉鍖栵紙push / pop锛?- 缂栬緫宸插瓨鍦ㄥ湴鐐圭殑 `鍚嶇О` / `涓婄骇` / `鎻忚堪` / `NPC` 灞炴€ф椂鏁扮粍 `length` 涓嶅彉锛寃atcher 涓嶈Е鍙戯紝auto-refresh 澶辨晥
- 鎵嬪姩鐐瑰埛鏂版寜閽椂 `buildGraphData()` 璇诲彇鐨勬槸 `validLocations.value`锛岃繖鏄竴涓?computed锛涙煇浜?reactive 鏇存柊妯″紡涓嬶紙灏ゅ叾 cloneDeep 閲嶅啓鏁翠釜鏁扮粍鏃讹級computed 鐨?deps 鍙兘鏈兘姝ｇ‘浼犳挱锛屽埛鏂版寜閽鍒扮殑浠嶆槸 stale 缂撳瓨

**Fix锛?* 鏀逛负**娣卞害鐩戝惉**锛屼换涓€灞炴€у彉鍖栭兘鍒锋柊锛?
```ts
watch(validLocations, () => refreshGraph(), { deep: true });
watch([playerLocation, explorationRecord], () => updateNodeStyles(), { deep: true });
```

- `deep: true` 璁?Vue 璁㈤槄鏁扮粍鍐呮墍鏈夊祵濂楀睘鎬х殑 reactive 渚濊禆
- 鍗曚釜 tick 鍐呭娆″彉鍖栬嚜鐒惰 Vue effect 璋冨害鍣ㄥ幓閲嶏紝涓嶄細瀵艰嚧鎶栧姩
- `explorationRecord` 涔熶粠 shallow 鏀?deep 鈥斺€?瀹冩槸瀛楃涓叉暟缁勶紝`push` 杩涘幓鐨勬柊鏉＄洰闇€瑕?deep 鎵嶈兘鎹曡幏

**鏂囦欢锛?* `src/ui/components/panels/MapPanel.vue` | **Unit test锛?* 260 pass

---

## [2026-04-13] UI 缂栬緫涓嶇敓鏁?鈥?structuredClone 鍦?reactive Proxy 涓婃姏寮傚父锛堢湡鍥狅級

**鐜拌薄锛?* 瑙掕壊璇︽儏鐨?缂栬緫"鎸夐挳鎵撳紑琛ㄥ崟锛屽瓧娈佃兘鏄剧ず褰撳墠鍊硷紝浣嗕换浣曢敭鐩樿緭鍏ラ兘娌℃湁鏁堟灉锛屼繚瀛樹篃鏃犲彉鍖栥€?
**鐪熷洜锛堟帶鍒跺彴绾㈣壊鎶ラ敊鎻ず锛夛細**

```
Uncaught DOMException: Failed to execute 'structuredClone' on 'Window':
#<Object> could not be cloned.
  at onFieldUpdate (SchemaForm.vue:76)
```

`SchemaForm.onFieldUpdate` 鐢?`structuredClone(currentObj.value)` 鏉ュ厠闅嗗綋鍓嶈〃鍗曟暟鎹紝浣?`currentObj.value` 鍦ㄨ繍琛屾椂鏄?Vue 鐨?**reactive Proxy**锛堝綋鐖剁粍浠剁殑 ref 瑁呰浇瀵硅薄鏃讹紝Vue 鍐呴儴鎶婂璞＄敤 `reactive()` 鍖呬竴灞傦紝Proxy 浼氳嚜甯?`__v_isRef` / `__v_raw` / `__v_isReactive` 绛夊唴閮?Symbol 浣滀负鏍囪锛夈€俙structuredClone` 閬囧埌杩欎簺鍐呴儴 Symbol 鍊兼椂鎶?DOMException 鈥斺€?**姣忎竴娆℃寜閿緭鍏ラ兘璧板埌杩欓噷灏辨姤閿欙紝鏁翠釜 update:value 閾捐矾琚腑鏂紝schemaModalData.value 姘歌繙涓嶆洿鏂?*锛屾墍浠ョ埗缁勪欢鐪嬪埌鐨勬案杩滄槸鏃ф暟鎹€備繚瀛樻椂涔熸槸淇濆瓨鏃ф暟鎹?= "鐪嬭捣鏉ユ病鏀?銆?
杩欎篃瑙ｉ噴浜嗕负浠€涔堜笂涓€杞殑 `setValue` 鏀归€狅紙璧?StateManager锛夋病鏈変慨澶嶉棶棰?鈥斺€?鏍规湰娌¤蛋鍒?setValue锛屾暟鎹湪鍏嬮殕閭ｄ竴姝ュ氨澶辫触浜嗐€?
**Fix 1锛歚SchemaForm.vue` 鐨?onFieldUpdate**

```typescript
// 鏃э紙浼氭姏 DOMException锛?const root = structuredClone(currentObj.value);

// 鏂?const raw = toRaw(currentObj.value);               // 鍓ユ帀 Vue reactive 鍖呰
const root = JSON.parse(JSON.stringify(raw));      // 瀹夊叏娣辨嫹璐濓紙JSON 搴忓垪鍖栧 Symbol 鍊煎ぉ鐒舵棤瑙嗭級
```

**Fix 2锛歚PresetDialog.vue` 鍚屾牱鐨勫湴鏂?*
鍙﹀涓ゅ `structuredClone` 鐢ㄦ硶锛坕nitFormValue + saveEntry锛変篃鍦?reactive Proxy 涓婅皟鐢紝鎶藉嚭 `safeDeepClone()` helper 鏇挎崲銆?
**涓轰粈涔?JSON round-trip 鍙锛?*
- Vue 鍐呴儴鐨?`__v_*` Symbol 鍦?JSON 搴忓垪鍖栨椂**鑷姩琚拷鐣?*锛圝SON 鍙簭鍒楀寲瀛楃涓查敭 + 鍙灇涓惧睘鎬э級
- 鐘舵€佹爲涓湡瀹炰笟鍔℃暟鎹叏鏄?string / number / boolean / array / plain object锛?00% JSON-safe
- 涓㈠け鐨勫彧鏈夐潪 JSON-safe 鐨勫€硷紙Date/Map/Set/function锛夛紝杩欎簺鏈潵灏变笉璇ュ嚭鐜板湪娓告垙鐘舵€佹爲涓?
**鏂囦欢锛?* `src/ui/components/editing/SchemaForm.vue`, `src/ui/components/editing/PresetDialog.vue` | **Unit test锛?* 260 pass

**闄勫姞鍓綔鐢細** 涓婁竴杞殑 `engine-state.setValue` 濮旀墭缁?`StateManager.set` 鐨勬敼閫犱粛鐒朵繚鐣欙紙鍙樻洿杩借釜銆乫ilter 璺緞鏀寔绛夐兘鏄嫭绔嬫敹鐩婏級锛屽彧鏄偅涓嶆槸杩欎釜 bug 鐨勪慨澶嶇偣銆?
---

## [2026-04-13] UI 缂栬緫涓嶇敓鏁堬紙璇瘖闃舵锛?鈥?setValue 鏀硅蛋 StateManager

> 鈿?**璇瘖璁板綍**锛氭鏉℃敼閫犳湁鎰忎箟浣嗕笉鏄湡 bug 鐨勪慨澶嶇偣锛堢湡鍥犺涓婁竴鏉★級銆備繚鐣欐槸鍥犱负杩欏濮旀墭鏀瑰姩鏈韩鏄鐨勶細閬垮厤寮曠敤姹℃煋銆佹敮鎸?filter 璺緞璇硶銆佸彉鏇磋繘鍏?history 渚涘洖婊氳皟璇曘€?
**鐜拌薄锛?* 瑙掕壊璇︽儏鐨?缂栬緫"鎸夐挳鎵撳紑琛ㄥ崟鍚庯紝鏀瑰畬淇濆瓨娌℃湁浠讳綍鍙樺寲锛堝唴鑱斿弻鍑荤紪杈戝悓鏍凤級銆?
**鏍瑰洜鍒嗘瀽锛?*

`engine-state.setValue` 涔嬪墠鑷繁瀹炵幇浜嗚矾寰勮璧?+ 鐩存帴璧嬪€硷細

```typescript
// 鏃у疄鐜帮紙鏈夐棶棰橈級
let current = tree.value;
for (let i = 0; i < segments.length - 1; i++) {
  ... 鎵嬪啓閬嶅巻 ...
}
current[lastSeg] = value;  // 鐩存帴璧嬪紩鐢?```

闂锛?
1. **寮曠敤姹℃煋** 鈥斺€?UI 灞備紶鍏ョ殑瀵硅薄锛坰chemaModalData 缁?`JSON.parse(JSON.stringify)` 鍏嬮殕鍚庝粛鏄悓涓€ object 寮曠敤锛夌洿鎺ヨ鎸傚埌鐘舵€佹爲涓婏紱鍚庣画鍐嶆鎵撳紑鍚屼竴 modal 缂栬緫浼氬悓鏃跺啓鍏ヤ富鐘舵€佹爲
2. **缁曡繃 StateManager 鐨勫彉鏇磋拷韪?* 鈥斺€?涓嶅彂 `state:changed` 浜嬩欢銆佷笉鍏?changeHistory銆佷笉杩囨护 filter 璺緞璇硶 `[鍚嶇О=X]`
3. **鍝嶅簲寮忛摼璺垎鍙?* 鈥斺€?AI 鍛戒护璧?`stateManager.set(path, cloneDeep(value))`锛坙odash `_set` + deep clone锛夛紝UI 璧?`tree.value[seg][...] = value`锛堟墜鍐欓亶鍘嗭級锛涗袱鏉¤矾寰勮涓烘湁寰宸紓锛堜腑闂村璞″垱寤烘椂鏈恒€佹繁鎷疯礉涓庡惁锛夛紝鍦ㄦ繁灞傝妭鐐规浛鎹㈡暣涓璞℃椂鍙兘瀵艰嚧 computed 涓嶆洿鏂?
**Fix锛?* `engine-state.setValue` 鐜板湪浼樺厛璋冪敤 `_linkedStateManager.set(path, value, 'user')`锛?
```typescript
function setValue(path: StatePath, value: unknown): void {
  if (_linkedStateManager) {
    _linkedStateManager.set(path, value, 'user');
    return;
  }
  // 闄嶇骇锛氭湭 linked 鏃朵繚鐣欐棫琛屼负锛堜粎娴嬭瘯鍦烘櫙锛?  ...
}
```

甯︽潵鐨勫ソ澶勶細

- **lodash `_set`** 澶勭悊鎵€鏈夎矾寰勫啓鍏ヨ竟鐣岋紙涓棿瀵硅薄鍒涘缓銆佹暟缁勭储寮曘€佸祵濂楋級
- **`cloneDeep(value)`** 鍒囨柇 UI 鏁版嵁涓庣姸鎬佹爲鐨勫紩鐢?- **鍙樻洿浜嬩欢** 鈫?璋冭瘯闈㈡澘 / 鍥炴粴鏈哄埗鍙崟鑾?UI 缂栬緫
- **filter 璺緞璇硶** 鑷姩鏀寔锛坄绀句氦.鍏崇郴[鍚嶇О=鏉庢槑闃砞.濂芥劅搴 绛?UI 浼犲叆鐨勮繃婊ゅ櫒璺緞鐜板湪鑳芥纭В鏋愶級
- **AI 涓?UI 鍐欏叆璺緞瀹屽叏涓€鑷?*锛屾秷闄?鍙岃建"宸紓

**鏂囦欢锛?* `src/engine/stores/engine-state.ts` | **Unit test锛?* 260 pass

---

## [2026-04-13] 鍏ㄩ噺澶囦唤瀵煎叆瀵煎嚭 鈥?褰诲簳閲嶆瀯浠ユ弧瓒?璺ㄨ澶囦竴鑷存€?瑙勬牸

**瑙勬牸锛?* 鐜╁鎹㈣澶?娴忚鍣ㄥ仛"鍏ㄩ噺瀵煎叆"鍚庡繀椤诲緱鍒颁笌婧愮瀹屽叏涓€鑷寸殑娓告垙鐘舵€佸拰璁剧疆銆?**璁″垝鏂囨。锛?* [full-backup-plan-2026-04-13.md](./full-backup-plan-2026-04-13.md) 路 **瀹¤鍘熸枃锛?* 10 涓?bug锛? P0銆? P1銆? P2锛?
### 10 涓棶棰樼殑涓€娆℃€т慨澶?
| # | 鍘熼棶棰?| 淇 |
|---|--------|------|
| 1 | 鍗曞瓨妗ｅ鍑?`{slotMeta,stateTree,exportedAt}` 涓?importAll 瑕佹眰鐨?BackupBundle 涓嶅吋瀹癸紙鍙啓涓嶈锛?| `exportSingleSave` 鏀硅蛋 `backupService.exportProfile(profileId)`锛岀敓鎴愭爣鍑?BackupBundle锛坆undleType='profile'锛夛紝鍙洿鎺ヨ"鎭㈠澶囦唤"璇诲叆 |
| 2 | `BackupBundle` 涓嶅惈 `activeProfile` 鏍规寚閽?| `BackupBundle` 鏂板 `activeProfile?: {profileId,slotId} \| null` 鍜?`bundleType?: 'full'\|'profile'` 瀛楁銆俙exportAll` 鍐欏叆 `root.activeProfile`锛宍exportProfile` 鍐欏叆 `null` |
| 3 | 瀵煎叆鍚庝富鐣岄潰涓嶅埛鏂般€丳inia 涓嶅悓姝?localStorage | 鍏ㄩ噺瀵煎叆鎴愬姛鍚?`sessionStorage.setItem('aga_post_import_resume','1')` + `window.location.reload()`锛涘埛鏂板悗 `HomeView.onMounted` 妫€娴嬫爣蹇楀苟鑷姩鍔犺浇 `root.activeProfile` 瀵瑰簲 slot |
| 4 | Pinia store 鎸佹湁鐨?localStorage 缂撳瓨涓嶅け鏁?| 椤甸潰鍒锋柊 = 鎵€鏈?store 閲嶆柊 onMounted 鈫?浠庢柊 localStorage 閲嶆柊 loadFromStorage锛涢浂婕忔礊鍚屾 |
| 5 | 瀵煎叆鏄?鍚堝苟"鑰岄潪"鏇挎崲"锛屾湰鍦版湁澶囦唤娌＄殑 profile 鎴愬兊灏?| 閲嶆瀯 `importAll`锛?*鍏ㄩ噺澶囦唤璧?鍏ㄦ浛鎹?璇箟** 鈥斺€?鎿﹂櫎 IDB 鍏ㄩ儴 + 娓呴櫎鎵€鏈?`aga_*` localStorage + 娓?ConfigStore/PromptStorage锛屽啀鍐欏叆 bundle |
| 6 | Engram 鍚戦噺鏃犳ā鍨?缁村害涓€鑷存€ф牎楠?| 褰撳墠浠嶆寜 bundle 鍘熸牱鍐欏叆锛涘凡鍦ㄨ鍒掓枃妗ｄ腑鍒椾负 P1 鍚庣画椤癸紙闃诲鎬т笉寮猴紝瀵煎叆渚ц嚦灏戣兘宸ヤ綔锛?|
| 7 | 瀵煎叆鏃犲師瀛愭€э紝涓€斿け璐ョ暀涓嬭剰鐘舵€?| 鏂板 `captureCurrentState()` 鍐呭瓨蹇収 + `restoreFromSnapshot()` 鍥炴粴锛涘叏鏇挎崲娴佺▼鍓嶅厛蹇収锛屼换涓€姝?throw 鈫?绔嬪嵆鍥炴粴鍒板鍏ュ墠鐘舵€?|
| 8 | 纭瀵硅瘽妗嗘棤鍐茬獊璀﹀憡 | SavePanel 閲嶅啓瀵煎叆棰勮 Modal锛氭樉绀?bundleType badge銆佽鑹插悕鍒楄〃銆佹椿璺冩父鎴忔寚閽堝瓨鍦ㄦ€э紱鍏ㄩ噺鏃剁孩鑹茶鍛?+ checkbox "鎴戝凡浜嗚В姝ゆ搷浣滃皢鏇挎崲鎵€鏈夋湰鍦版暟鎹?锛屾湭鍕鹃€夊垯 primary 鎸夐挳绂佺敤 |
| 9 | 鏃犵増鏈縼绉绘鏋?| `BACKUP_FORMAT_VERSION` 浠嶄负 1锛涙柊澧炵殑 `activeProfile`/`bundleType` 瀛楁涓?optional锛?*鏃?v1 澶囦唤瀹屽叏鍚戝悗鍏煎**锛堥€氳繃 `hasGlobalData` 鎺ㄦ柇 bundleType锛?|
| 10 | 鍗曞瓨妗ｅ鍑虹己 engram 鍚戦噺 | 淇 1 鐨勫壇浜х墿锛歚exportProfile` 宸插寘鍚 profile 鐨勫叏閮?slot + 瀵瑰簲鍚戦噺 |

### 鍏抽敭浠ｇ爜鏀瑰姩

**`src/engine/persistence/backup-service.ts`锛堥噸澶ч噸鏋勶級锛?*
- `BackupBundle` 鎺ュ彛鎵╁睍 `bundleType` + `activeProfile` optional 瀛楁
- `exportAll()` 鍐欏叆 `bundleType='full'` + `root.activeProfile`
- `exportProfile()` 鍐欏叆 `bundleType='profile'` + `activeProfile=null`
- `importAll()` 鎸?bundleType 鍒嗘祦锛?  - `importFullReplace(bundle)` 鈥斺€?蹇収 鈫?鎿﹂櫎 鈫?鎭㈠ 鈫?澶辫触鍥炴粴
  - `importProfileMerge(bundle)` 鈥斺€?浠呰鐩?bundle 涓殑 profile锛屽叾浠栨暟鎹笉鍔?- 鏂板 `captureCurrentState()` / `wipeAll()` / `restoreFromSnapshot()` 绉佹湁鏂规硶
- 鏂板 `hasGlobalData()` 鐢ㄤ簬鏃?v1 澶囦唤鐨?bundleType 鎺ㄦ柇
- 鏂板 `wipeLocalStorageSettings()` 妯″潡绾у伐鍏?- 鏂板 `_testExports` 瀵煎嚭绾嚱鏁颁緵鍗曟祴浣跨敤

**`src/engine/core/config-system.ts` + `src/engine/prompt/prompt-storage.ts`锛?*
- 鍚勬柊澧?`clear()` 鏂规硶锛屾摝闄よ嚜宸辩殑 IDB store锛堥厤鍚?`wipeAll()`锛?
**`src/ui/components/panels/SavePanel.vue`锛?*
- `exportSingleSave` 鏀圭敤 `backupService.exportProfile`
- `prepareImport` 璇嗗埆 bundleType锛岃В鏋?profile 鍚嶇О鍒楄〃渚涢瑙堜娇鐢?- `executeImport` 鍒嗘祦锛氬叏閲?鈫?reload + sessionStorage 鏍囧織锛涘崟瑙掕壊 鈫?鍘熷湴鍒锋柊
- Modal 閲嶅啓锛歜adge / 淇℃伅鍗＄墖 / 瑙掕壊 chip 鍒楄〃 / 鍖哄垎绫诲瀷鐨勮鍛婂尯鍧?/ 鍏ㄩ噺瀵煎叆鐨?ack checkbox

**`src/ui/views/HomeView.vue`锛?*
- 鏂板 `tryAutoResumeAfterImport()`锛歰nMounted 鏃舵娴?sessionStorage 鏍囧織锛岃嚜鍔ㄥ姞杞?activeProfile 瀵瑰簲 slot

### 娴嬭瘯

- `backup-service.test.ts` 鏂板锛?8 cases锛屽叏缁匡級
  - isValidBundleShape锛氭柊鏃?v1/v1.1 bundle 褰㈢姸銆侀敊璇儏鍐?  - collectLocalStorageSettings / wipeLocalStorageSettings锛氬墠缂€杩囨护銆佸閿亶鍘嗙ǔ瀹氭€с€佸箓绛?  - compositeSlotKey / parseCompositeKey锛氱紪鐮?+ 瑙ｆ瀽 + 寮傚父鍒嗘敮
  - hasVectorContent锛氱┖/闈炵┖鍒ゅ畾
- 鍏ㄥ鍥炲綊锛?60 tests pass锛?28 鏂板锛?
### 鎴愬姛鍑嗗垯锛堝凡楠岃瘉锛?
- 鉁?鍏ㄩ噺瀵煎嚭 JSON 鍖呭惈 `activeProfile` + `bundleType='full'`
- 鉁?鍗曡鑹插鍑?JSON 鏄湁鏁?BackupBundle锛屽彲琚?鎭㈠澶囦唤"璇诲叆
- 鉁?鍏ㄩ噺瀵煎叆锛氭棫鏁版嵁娓呴櫎 鈫?鏂版暟鎹啓鍏?鈫?椤甸潰鑷姩鍒锋柊 鈫?鐩存帴鎭㈠鍒版簮绔椿璺冩父鎴忕姸鎬?- 鉁?瀵煎叆涓€?throw 鈫?鏁版嵁鍥炴粴鍒板鍏ュ墠
- 鉁?鍗曡鑹插鍏ワ細鍙奖鍝嶈 profile锛屽叾浠栨暟鎹笉鍙?- 鉁?鏃?v1 澶囦唤锛堟棤 activeProfile / bundleType锛変緷鐒跺彲瀵煎叆
- 鉁?vue-tsc 0 errors锛?60 tests pass

### 宸茬煡鍚庣画浜嬮」锛圥1锛屾湭闃诲锛?
- Engram 鍚戦噺 embeddingModel / dim 涓€鑷存€ф牎楠岋紙涓嶅尮閰嶆椂鎻愮ず鐢ㄦ埛閲嶅缓锛?- 瀹屾暣鐨?IDB 寰€杩?integration test锛堥渶寮曞叆 fake-indexeddb 渚濊禆锛?
---

## [2026-04-13] 鍦扮偣鐢熸垚 prompt 瑙勮寖寮哄寲

AI 鐢熸垚"鑷繁鎴块棿"绛夋ā绯婅嚜鎸囧湴鐐瑰悕锛屼笖涓嶆鏌ュ凡鏈夊湴鐐瑰氨閲嶅 push銆?
**core.md 鏂板锛?*
- 绂佹鑷寚/浠ｈ瘝寮忓湴鍚嶏紙鑷繁鎴块棿銆佹垜鐨勬埧闂淬€佷粬鐨勫簵锛夆啋 蹇呴』鐢ㄥ叏璺緞鐪熷悕
- 绂佹缂╃暐鎸囦唬锛堟埧闂淬€佹ゼ涓娿€侀殧澹侊級鈫?蹇呴』瀹屾暣 `路` 灞傜骇璺緞
- **鏂板"鍦扮偣鍘婚噸"绔犺妭**锛歱ush 鍓嶅繀椤绘鏌?GAME_STATE_JSON 涓凡鏈夊湴鐐癸紝鍚屽悕鎴栧悓涔夎〃杈句笉閲嶅 push

**鏂囦欢锛?* `public/packs/tianming/prompts/core.md` | **Unit test锛?* prompt 鏀瑰姩锛?32 pass

---

## [2026-04-13] 鍦板浘褰撳墠浣嶇疆涓嶆樉绀?+ NPC 涓嶆樉绀?
| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| 褰撳墠浣嶇疆绾㈠湀涓嶆樉绀?| `isPlayer` 鐢?`loc.鍚嶇О === playerLocation` 绮剧‘鍖归厤锛屼絾鐜╁浣嶇疆鍙兘鏄竴涓湭寤鸿妭鐐圭殑瀛愬湴鐐癸紙濡?缈犳箹瀹鹃路鎬荤粺濂楁埧A"鑰屽湴鐐规暟缁勫彧鏈?缈犳箹瀹鹃"锛?| 绮剧‘鍖归厤澶辫触鍚庡仛 `路` 鍓嶇紑鍥為€€鍖归厤锛屾壘鏈€娣辩殑宸插瓨鍦ㄧ鍏?|
| 褰撳墠浣嶇疆鐨勫鍣ㄩ摼鏃犻珮浜?| 鍙珮浜簿纭尮閰嶇殑鑺傜偣锛岀埗瀹瑰櫒鏃犺瑙夋彁绀?| 鏀堕泦 player 绁栧厛閾撅紝鍔?`isPlayerAncestor` 鏍峰紡锛堢孩鑹插崐閫忔槑杈规锛?|
| 鍦板浘鑺傜偣涓嶆樉绀?NPC | label 鍙湁鍦扮偣鍚嶏紝鏃?NPC 淇℃伅 | label 鏀逛负 `鍦扮偣鍚?(NPC1銆丯PC2)` 鏍煎紡 |

**鏂囦欢锛?* `MapPanel.vue` | **Unit test锛?* 232 pass

---

## [2026-04-13] AI 鎶ラ敊鍚庣姸鎬佹爲鑷姩鍥炴粴

**瀹¤鍙戠幇锛?* PreProcess 鍦?AI 璋冪敤鍓嶉€掑 roundNumber 骞舵秷璐?action queue銆侫I 澶辫触鍚?PostProcess 涓嶆墽琛岋紙涓嶅啓鍙欎簨/璁板繂/瀛樻。锛夛紝浣?roundNumber 宸?1 鈫?鐘舵€佽剰涓斾笅娆″洖鍚堜細璺冲彿銆?
| Fix | 璇︽儏 |
|-----|------|
| 鑷姩鍥炴粴 | `game-orchestrator.ts` catch 鍧楋細pipeline 鎶涘紓甯稿悗鑷姩 `stateManager.rollbackTo(preRoundSnapshot)` + `clearConfigCache` + `syncVectorsToState` |
| 蹇収鎻愬墠鎸佷箙鍖?| `pre-process.ts`锛歱reRoundSnapshot 鍦?PreProcess 绔嬪嵆鍐欏叆鐘舵€佹爲锛堜笉寤惰繜鍒?PostProcess锛夛紝纭繚鍗充娇 AI 澶辫触鍚庡埛鏂颁篃鑳芥墜鍔ㄥ洖閫€ |
| PostProcess 鍘婚噸 | 绉婚櫎 PostProcess 閲岀殑閲嶅蹇収鍐欏叆锛堝凡鍦?PreProcess 瀹屾垚锛?|

**鎭㈠閾捐矾锛?* AI 鎶ラ敊 鈫?catch 鈫?rollbackTo(snapshot) 鈫?roundNumber 鎭㈠ 鈫?Engram vectors 鍚屾 鈫?UI 鏀跺埌 `ai:error` 鈫?鎭㈠鐢ㄦ埛杈撳叆

**鏂囦欢锛?* `game-orchestrator.ts` / `pre-process.ts` / `post-process.ts` | **Unit test锛?* 232 pass

---

## [2026-04-13] AI 鎶ラ敊鍚庣敤鎴疯緭鍏ヤ涪澶?
`sendMessage()` 鍙戦€佸墠绔嬪嵆 `userInput.value = ''`锛孉I 鎶ラ敊鍚庤緭鍏ュ凡娓呯┖鏃犳硶鎭㈠銆?
**Fix锛?* 鍙戦€佸墠鏆傚瓨 `_lastSentInput`銆俙ai:error` handler 鎭㈠鍒拌緭鍏ユ + autoResize銆俙round-complete` 鏃舵竻绌烘殏瀛橈紙鎴愬姛鍒欎笉闇€瑕佹仮澶嶏級銆?
**鏂囦欢锛?* `MainGamePanel.vue` | **Unit test锛?* 绾?UI锛?32 pass

---

## [2026-04-13] 琛屽姩閫夐」鎸佷箙鍖栵紙鍒锋柊/閫€鍑哄悗鎭㈠锛?
琛屽姩閫夐」鍒锋柊椤甸潰鍚庝涪澶憋紝鍥犱负鍙瓨鍦ㄥ唴瀛?ref 涓€?
**瀹炵幇锛?*
- PostProcessStage 姣忓洖鍚堝皢 `actionOptions` 鍐欏叆 `鍏冩暟鎹?褰撳墠琛屽姩閫夐」`锛堣鍐欙紝闅忓瓨妗ｆ寔涔呭寲锛?- MainGamePanel `onMounted` 浠庣姸鎬佹爲鎭㈠鍒?ref锛堝埛鏂板悗鑷姩璇诲洖锛?- 鏂板洖鍚堝紑濮嬫椂 PostProcess 瑕嗗啓涓烘柊閫夐」鎴栫┖鏁扮粍

**鏂囦欢锛?* `post-process.ts` / `MainGamePanel.vue` | **Unit test锛?* 232 pass

---

## [2026-04-12] 蹇冭烦鎵ц鍘嗗彶涓嶆樉绀?+ AI 浣跨敤宸插垹闄ゅ瓧娈?
| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| HeartbeatPanel "鏆傛棤鎵ц璁板綍" | 蹇冭烦绠＄嚎鎵ц鍚庝粠涓嶅啓鍏?`涓栫晫.鐘舵€?蹇冭烦.鍘嗗彶` | `execute()` 鏈熬 push historyEntry锛堝瓧娈靛榻?HeartbeatPanel normalizer锛歚timestamp/鍥炲悎/result/鎴愬姛`锛?|
| AI 浠嶈繑鍥?`褰撳墠澶栬矊鐘舵€乣 鍛戒护 | 鏃?prompt 琚?AI 缂撳瓨锛圙emini reasoning cache锛?| prompt 宸叉洿鏂帮紙涓婁竴杞級锛岀敤鎴烽渶閲嶅惎娓告垙鎴栧埛鏂?game pack 浣挎柊 prompt 鐢熸晥 |

**鏂囦欢锛?* `world-heartbeat.ts` | **Unit test锛?* 232 pass

---

## [2026-04-12] 涓栫晫蹇冭烦鎵ц鍚庝笉鏇存柊娓告垙鐘舵€?
| 鏍瑰洜 | Fix |
|------|-----|
| `execute()` AI 娌¤繑鍥?commands 鏃?return false 鈫?`lastHeartbeatRound` 涓嶆洿鏂?鈫?蹇冭烦鐪嬩技鏃犳晥 | return true锛圓I 璋冪敤鎴愬姛鍗崇畻鎵ц瀹屾垚锛?|
| NPC 鏁版嵁璇诲彇 `褰撳墠澶栬矊鐘舵€乣锛坰chema 涓嶅瓨鍦級 | 鏀逛负 `澶栬矊鎻忚堪` + `鎬ф牸鐗瑰緛` |
| worldHeartbeat.md 瑕佹眰 set `褰撳墠澶栬矊鐘舵€乣锛坰chema 涓嶅瓨鍦級 | 绉婚櫎锛屽彧淇濈暀 `浣嶇疆/鍐呭績鎯虫硶/鍦ㄥ仛浜嬮」` |

**鏂囦欢锛?* `world-heartbeat.ts` / `worldHeartbeat.md` | **Unit test锛?* 232 pass

---

## [2026-04-12] 闅愬紡涓湡閰嶅鎶ラ敊 + 瑙掕壊闈㈡澘鍦扮偣鎴柇

| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| "鐭湡/闅愬紡涓湡璁板繂閰嶅寮傚父 (6 vs 5)" 璀﹀憡 | `character-init.ts` 寮€灞€鏃?`appendShortTerm` 鍐欎簡 1 鏉＄煭鏈熶絾娌℃湁瀵瑰簲鐨?`appendImplicitMidTerm`锛宻hort 姘歌繙姣?implicit 澶?1 | 寮€灞€鏃跺悓姝ユ彃鍏?`_鍗犱綅` 闅愬紡涓湡鍗犱綅鏉＄洰 |
| 瑙掕壊闈㈡澘鍦扮偣鍚嶈鐪佺暐鍙锋埅鏂?| `.info-value` 鍜?`.location-item` 鏈?`max-width: 200px` + `text-overflow: ellipsis` | 绉婚櫎鎴柇锛屾敼涓?`word-break: break-word` |

**鏂囦欢锛?* `character-init.ts` / `CharacterDetailsPanel.vue`

---

## [2026-04-12] 鍥為€€鍚庨濉笂涓€鍥炲悎鐨勭敤鎴疯緭鍏?
鍥為€€鍥炲悎鍚庯紝琚洖閫€鐨勯偅娆＄敤鎴疯緭鍏ヨ嚜鍔ㄥ～鍏ヨ緭鍏ユ锛屾柟渚跨帺瀹剁洿鎺ラ噸鏂版彁浜ゆ垨淇敼鍚庨噸璇曘€?
**瀹炵幇锛?* `handleRollback()` 鍦?emit rollback 鍓嶄粠 `narrativeHistory` 鏈熬鍙栨渶鍚庝竴鏉?`role: 'user'` 鐨?content锛屽瓨鍏?`_pendingRollbackInput`銆俙rollback-complete` handler 鎭㈠鍒?`userInput` ref + 瑙﹀彂 textarea 鑷€傚簲楂樺害銆?
**鏂囦欢锛?* `MainGamePanel.vue` | **Unit test锛?* 绾?UI 浜や簰锛?32 tests 閫氳繃

---

## [2026-04-12] 鍒囧洖涓婚潰鏉挎椂 scroll 鏅冪溂

`onActivated` 鐨?`scrollToBottom(true)` 鐢?`nextTick` 寮傛婊氬姩锛岀敤鎴峰厛鐪嬪埌鏃т綅缃啀璺冲簳閮ㄣ€傛敼涓哄悓姝?`el.scrollTop = el.scrollHeight`锛岀灛闂村畾浣嶆棤鍔ㄧ敾銆?
**鏂囦欢锛?* `MainGamePanel.vue` | **Unit test锛?* 绾?UI锛?32 tests 閫氳繃

---

## [2026-04-12] 琛屽姩閫夐」澶嶅埗鎸夐挳

姣忔潯琛屽姩閫夐」宸︿晶鏂板澶嶅埗鍥炬爣鎸夐挳銆傞粯璁?40% 閫忔槑搴︼紝hover 琛屾椂娣″叆锛岀偣鍑诲鍒舵枃鏈埌鍓创鏉匡紙鍚?fallback锛夈€傜敤鎴峰彲浠ュ鍒堕€夐」鏂囨湰绮樿创鍒板叾浠栦笂涓嬫枃涓娇鐢ㄣ€?
**鏂囦欢锛?* `MainGamePanel.vue` | **Unit test锛?* 绾?UI 鏀瑰姩锛?32 tests 閫氳繃

---

## [2026-04-12] 瀛椾綋澶у皬璁剧疆涓嶇敓鏁?
**鏍瑰洜锛?* `applyFontSize()` 璁剧疆浜?CSS 鍙橀噺 `--base-font-size`锛屼絾娌℃湁浠讳綍 CSS 瑙勫垯寮曠敤瀹冦€傚彉閲忓啓浜嗕絾鏃犱汉璇汇€?**闄勫姞闂锛?* 璁剧疆鍙湪鐢ㄦ埛鐐?搴旂敤"鎸夐挳鏃剁敓鏁堬紝椤甸潰鍔犺浇鏃朵笉鎭㈠銆?
| Fix | 璇︽儏 |
|-----|------|
| 鏂板 `--narrative-font-size` 鍙橀噺 | `applyFontSize()` 鍚屾椂璁剧疆 `--base-font-size` 鍜?`--narrative-font-size` |
| MainGamePanel 浣跨敤鍙橀噺 | `.message-bubble { font-size: var(--narrative-font-size, 0.88rem); }` |
| SettingsPanel onMounted 鎭㈠ | 鍔犺浇璁剧疆鍚庣珛鍗?apply锛堜笉绛夌敤鎴风偣鎸夐挳锛?|
| GameView onMounted 鎭㈠ | 浠?localStorage 璇诲彇 `aga_settings.fontSize` 骞?apply锛圫ettingsPanel 鍙兘鏈寕杞斤級 |

**鏂囦欢锛?* `SettingsPanel.vue` / `MainGamePanel.vue` / `GameView.vue`

**Unit test 妫€鏌ワ細** 绾?CSS/UI 鏀瑰姩锛屾棤 engine 閫昏緫鍙樻洿锛岀幇鏈?232 tests 閫氳繃銆?
---

## [2026-04-12] 琛屽姩閫夐」 + 杈撳叆妗?+ Toast UX 淇

| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| 琛屽姩閫夐」閫変腑鍚庢秷澶?| `selectAction()` 鐩存帴 `actionOptions.value = []` 娓呯┖ | 绉婚櫎娓呯┖閫昏緫锛岄€夐」淇濇寔鏄剧ず鐩村埌鏂板洖鍚堝紑濮嬶紙`engine:round-start` 鏃舵墠娓呯┖锛夛紱閫変腑椤瑰姞绱壊楂樹寒 |
| 杈撳叆妗嗗唴瀹规孩鍑烘椂鍑虹幇涓戦檵婊氬姩鏉?| textarea `max-height: 120px` 鍚庢祻瑙堝櫒榛樿 scrollbar | `scrollbar-width: none` + `::-webkit-scrollbar { display: none }` 闅愯棌婊氬姩鏉′繚鐣欐粴鍔ㄥ姛鑳?|
| Toast 娑堝け澶揩 | `DEFAULT_DURATION = 4000`锛屼笖寰堝璋冪敤浼?1200-1500ms | DEFAULT 鎻愬崌鍒?5500ms + 鏂板 `MIN_DURATION = 2500ms` clamp锛岃鐩栨墍鏈夌煭 duration |

**鏂囦欢锛?* `MainGamePanel.vue` / `Toast.vue`

---

## [2026-04-12] NSFW 璁剧疆涓嶇敓鏁?鈥?鍚屾閫昏緫淇 + UI 绠€鍖?
### Bug: 寮€鍚?NSFW 鍚?prompt 浠嶄笉鍖呭惈鎴愪汉鍐呭

| 闂 | 鏍瑰洜 | Fix |
|------|------|-----|
| 鐢ㄦ埛寮€鍚?NC-17 + 鎵╁睍鍐呭鍚?`[绉佸瘑]` prompt 浠嶈鍓ョ | `nsfwMode` 鐨?localStorage鈫掔姸鎬佹爲鍚屾缁戝畾鍦?SettingsPanel 鐨?`onMounted` / `watch(isLoaded)` 涓婏紝闈㈡澘鏈寕杞芥椂锛堝鍒涜鍚庣洿鎺ヨ繘鍏ユ父鎴忥級涓嶅悓姝ワ紝鐘舵€佹爲鍋滅暀鍦?schema 榛樿鍊?`false` | 灏嗗悓姝ラ€昏緫鎻愬崌鍒?`engine-state.ts` 鐨?`loadGame()` / `markLoaded()` 涓紝娓告垙鍔犺浇鏃舵棤鏉′欢浠?localStorage 璇诲彇骞跺啓鍏ョ姸鎬佹爲 |
| `contentRating` 涓嬫媺锛圙/PG/R/NC-17锛夊畬鍏ㄦ棤鏁?| 璇ヨ缃彧瀛?localStorage锛屼粠鏈啓鍏ョ姸鎬佹爲锛屾病鏈変换浣曞紩鎿庝唬鐮佽鍙栧畠 | 绉婚櫎姝昏缃紝鍚堝苟涓哄崟涓€ NSFW 寮€鍏?|

**鏂囦欢锛?* `engine-state.ts` / `SettingsPanel.vue`

---

## [2026-04-12] Engram 瑙﹀彂閾句慨澶?+ 鍥為€€涓€鑷存€?+ GameVariablePanel 浜や簰閲嶅仛

### EventPanel 璺緞淇 + 璁剧疆鎸佷箙鍖?
| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| 浜嬩欢 tab 濮嬬粓涓虹┖ | `DEFAULT_ENGINE_PATHS.worldEvents = '涓栫晫.浜嬩欢'`锛屼絾 schema 瀹氫箟浜嬩欢鍦?`绀句氦.浜嬩欢.浜嬩欢璁板綍` | 淇璺緞 + 琛ラ綈 normalizer 鐨?schema 瀛楁鍒悕锛坄浜嬩欢ID`/`浜嬩欢鍚嶇О`/`浜嬩欢鎻忚堪`/`浜嬩欢绫诲瀷`/`鍙戠敓鏃堕棿`锛?|
| 蹇冭烦璁剧疆閲嶅惎鍚庨噸缃?| 蹇冭烦 enabled/period 鍙瓨鐘舵€佹爲锛屾棤 localStorage 澶囦唤锛沴oadGame 浠?schema 榛樿鍊奸噸寤鸿鐩?| HeartbeatPanel 淇濆瓨鍒?`aga_heartbeat_settings` + engine-state `syncAllSettingsFromLocalStorage()` 鍦?loadGame/markLoaded 鏃舵仮澶?|
| 琛屽姩閫夐」璁剧疆閲嶅惎鍚庨噸缃?| 鍚屼笂锛宎ctionOptions 鏈?UI watch 浣嗘棤 loadGame 鎭㈠ | `syncAllSettingsFromLocalStorage` 鍚屾椂鎭㈠ actionOptions mode/pace/customPrompt |

**鏂囦欢锛?* `types.ts`锛堣矾寰勪慨姝ｏ級/ `EventPanel.vue`锛堝瓧娈靛埆鍚嶏級/ `HeartbeatPanel.vue`锛坙ocalStorage 淇濆瓨锛? `engine-state.ts`锛堢粺涓€鎭㈠鍑芥暟锛?
---

### UX 鏀瑰杽涓変欢濂?
| Feature | 闂 | 淇 |
|---------|------|------|
| 涓婚潰鏉胯嚜鍔ㄦ粴鍔?| 浠庡叾浠栭潰鏉胯繑鍥炰富闈㈡澘鏃讹紝鍙欎簨鍒楄〃鍋滃湪鏃т綅缃?| `onActivated(() => scrollToBottom(true))`锛圞eepAlive 涓?mounted 涓嶉噸瑙﹀彂锛岄渶 activated锛?|
| 鍏ㄥ眬杩斿洖鎸夐挳 | 鐢ㄦ埛鍦ㄥ瓙闈㈡澘鍐呮棤鐩磋鏂瑰紡杩斿洖涓婚潰鏉匡紝蹇呴』鍦ㄤ晶鏍忔壘 | GameLayout 宸︿笂瑙掓诞鍔?鈫?绠ご鎸夐挳锛屼粎鍦ㄥ瓙璺緞鏄剧ず锛宧over 绱壊楂樹寒 |
| 琛屽姩閫夐」婧㈠嚭 | 闀块€夐」鏂囧瓧 `white-space: nowrap` 瀵艰嚧 overflow | 鏀逛负 `white-space: normal` + `word-break: break-word` + `border-radius: 16px` |

**鍚庣画淇锛?*
- 杩斿洖鎸夐挳浠?GameLayout 娴姩灞傜Щ鍒?TopBar锛圚ome 鍥炬爣锛夛紝涓嶅啀鍜屽唴瀹?overlap
- 琛屽姩閫夐」鍦ㄩ潰鏉垮垏鎹㈠悗娑堝け锛歮odule-level 缂撳瓨 `_savedActionOptions` + `onActivated` 鎭㈠ + watch 鍚屾

**鏂囦欢锛?* `MainGamePanel.vue` / `TopBar.vue` / `GameLayout.vue`

---

### Unit Testing Framework 鎼缓锛圥hase 1 瀹屾垚锛?
浠庨浂鎼缓 Vitest 娴嬭瘯妗嗘灦銆?37 涓祴璇曞叏閮ㄩ€氳繃锛岀函閫昏緫妯″潡 鈮?0% 瑕嗙洊銆?
| 缁勪欢 | 鍐呭 |
|------|------|
| 妗嗘灦 | `vitest` 4.1.4 + `@vitest/coverage-v8`锛岀嫭绔?`vitest.config.ts` |
| 鑴氭湰 | `npm run test` / `test:watch` / `test:coverage` |
| Mock 灞?| 4 涓?factory锛圫tateManager / EventBus / PromptRegistry / localStorage锛? 3 缁?fixtures |
| 绾嚱鏁版祴璇?| template-engine (11) + response-parser (22) + json-extract (22) + id-generator (6) |
| 杞?Mock 娴嬭瘯 | prompt-assembler (12) + location-dedup (9) + command-executor (13) |
| 閲?Mock 娴嬭瘯 | state-manager (21) + memory-manager (22) |
| 鎵╁睍娴嬭瘯 | time-service (9) + event-builder (8) + entity-builder (8) + relation-builder (7) + memory-compiler (6) + content-filter (4) + computed-fields (5) + prompt-registry (10) + pipeline-runner (7) |

**鎬昏锛?* 220 tests / 18 files / 100% pass / 16 涓ā鍧?鈮?0% 瑕嗙洊

**CR 瀹℃煡淇锛?3 HIGH + 7 MEDIUM锛夛細**
- MockStateManager 鍔?filter path `[field=value]` 瑙ｆ瀽 + loadTree/toSnapshot/rollbackTo/clear/isLoaded
- response-parser 鍔犱腑鏂?key fallback锛堟寚浠?涓湡璁板繂/琛屽姩閫夐」锛?- computed-fields 鏇挎崲 `expect(true).toBe(true)` + 鍔?min/max/division 鍏紡娴嬭瘯
- content-filter 鍔?R18 tag + 澶氭鍑虹幇 + 璺ㄥ彉閲?stripping
- command-executor 鍔?whitelist toast + push 200 cap FIFO + 淇 add 璐熸暟璇箟娉ㄩ噴
- state-manager 鍔?filter path write no-op safety + isLoaded 鐢熷懡鍛ㄦ湡
- memory-manager 鍔犲叏鍗犱綅闅愬紡涓湡鍦烘櫙
- relation-builder 纭畾鎬ф柇瑷€锛? distinct types = 2 relations锛?- CC-1 fixture counter `resetCounter()` 鍦?beforeEach 璋冪敤

**鏂囦欢锛?* `vitest.config.ts` + `package.json` + `.gitignore` + 18 test files + 9 test-utils files + `docs/status/testing-framework-setup.md`

---

### GameVariablePanel 瀹夊叏淇 + NPC鍒楄〃娈嬬暀娓呯悊

| Bug | Fix |
|-----|-----|
| 閲嶇疆鎸夐挳绱ф尐鎿嶄綔鎸夐挳鏄撹瑙?| `confirmResetField` + 纭寮圭獥锛堢孩鑹?纭閲嶇疆"鎸夐挳锛?|
| 閲嶇疆鏃犵‘璁ょ洿鎺ユ墽琛?| Modal 纭锛?纭畾瑕佸皢 X 閲嶇疆涓洪粯璁ゅ€煎悧锛熸鎿嶄綔涓嶅彲鎾ら攢" |
| NPC鍒楄〃濮嬬粓鏄剧ず绌?| 鏃у瓨妗ｆ畫鐣欙紙schema 宸茬Щ闄や絾鏁版嵁娈嬬暀锛夆啋 PostProcess 姣忓洖鍚堟娴嬪苟 `delete('NPC鍒楄〃')` |

**鏂囦欢锛?* `GameVariablePanel.vue` / `post-process.ts`

---

### GameVariablePanel Raw JSON Editor

鐢ㄦ埛鍙浠绘剰璺緞鐨勫璞?鏁扮粍杩涜瀹屾暣 JSON 缂栬緫锛堟柊澧?鍒犻櫎/閲嶇粍鏉＄洰锛夈€備繚鐣欏凡鏈夌殑瀛楁绾х紪杈戙€?
- breadcrumb 鍙充晶鏂板 `{ } JSON` 鎸夐挳锛屾墦寮€褰撳墠璺緞鐨?raw JSON 缂栬緫 modal
- 绾?textarea + monospace 瀛椾綋锛堜笌 demo 涓€鑷达紝鏃犵涓夋柟缂栬緫鍣級
- 瀹炴椂 JSON 璇硶鏍￠獙锛堟瘡娆¤緭鍏ヨЕ鍙?`JSON.parse`锛?- 鏃犳晥鏃讹細绾㈣壊杈规 + 閿欒淇℃伅 + 淇濆瓨鎸夐挳绂佺敤
- 鏈夋晥鏃讹細缁胯壊 "JSON 鏈夋晥" badge
- "鏍煎紡鍖? 鎸夐挳涓€閿編鍖?- 淇濆瓨鏃惰鐩栨暣涓矾寰勭殑鍊?
**鏂囦欢锛?* `GameVariablePanel.vue`

---

### 鍦扮偣鍘婚噸鍚堝苟 鈥?鍚庣紑鍖归厤瑙ｅ喅 AI 缁撴瀯鎬ч噸澶?
**闂锛?* AI 鍏堢敓鎴?`"S甯?鈫?S甯偮蜂簯椤跺尯"` 鐭矾寰勬爲锛屽悗鏉ョ敓鎴?`"涓浗 鈫?涓浗路S甯?鈫?涓浗路S甯偮蜂簯椤跺尯"` 闀胯矾寰勬爲銆傚悓涓€鍦版柟涓ょ琛ㄨ揪锛屽湴鍥惧嚭鐜颁袱妫甸噸澶嶆爲銆?
**绠楁硶锛堝悗缂€鍖归厤锛岃秴瓒?demo 鐨勫紩鍙疯鑼冨寲锛夛細**
1. 鎸夋湯娈靛垎缁勶紙`路` 鍒嗗壊鍚庢渶鍚庝竴娈电浉鍚?鈫?鍙兘鏄悓涓€鍦版柟锛?2. 妫€娴嬪悗缂€鍏崇郴锛歚"S甯?` 鏄?`"涓浗路S甯?` 鐨勫悗缂€ 鈫?璇嗗埆涓洪噸澶?3. 淇濈暀闀胯矾寰勶紝灏嗙煭璺緞鍙婂叾鎵€鏈夊瓙瀛欏仛鍓嶇紑鏇挎崲锛坄"S甯偮稾"` 鈫?`"涓浗路S甯偮稾"`锛?4. 鍚堝苟 NPC 鍒楄〃锛堝苟闆嗭級+ 鎻忚堪锛堝彇鏇撮暱锛?5. 鍚屾鏇存柊鎺㈢储璁板綍鍜岀帺瀹跺綋鍓嶄綅缃腑鐨勬棫鍚嶇О

**璋冪敤鐐癸細** `PostProcessStage` 姣忓洖鍚堟湯锛屽湪 `trackExploration` 涔嬪悗銆?
**鏂囦欢锛?* `src/engine/behaviors/location-dedup.ts`锛堟柊寤猴級+ `post-process.ts`锛堥泦鎴愯皟鐢級

**鍚庣画淇锛?* 鍚堝苟鏃朵笂绾у瓧娈典涪澶?鈥?閲嶅懡鍚嶅悗鐨勬潯鐩紙鏃犱笂绾э級涓庣湡瀹炴潯鐩紙鏈変笂绾э級鍚堝苟鏃讹紝`涓婄骇` 瀛楁鏈閲囩撼銆侳ix锛氬悎骞跺垎鏀鍔?`if (!existing.涓婄骇 && finalParent) existing.涓婄骇 = finalParent`銆?
### GameVariablePanel 澶嶅埗鍔熻兘淇

`navigator.clipboard.writeText` 鍦ㄩ潪 HTTPS 鐜锛堝灞€鍩熺綉 IP 璁块棶锛変笉鍙敤 鈫?娣诲姞 `document.execCommand('copy')` textarea fallback銆?
---

### MapPanel 閲嶅啓 鈥?Compound Node 灞傜骇鍦板浘

**鍔ㄦ満锛?* 鏃х増 MapPanel 鐢?edge 骞抽摵鎵€鏈夎妭鐐癸紝鏃犳硶琛ㄧ幇 `路` 鍒嗛殧鐨勫湴鐐瑰眰绾э紙S甯?鈫?S甯偮峰反鍒 鈫?S甯偮峰反鍒路闇插彴锛夈€俤emo 鐢?1026 琛岃嚜瀹氫箟 SVG 瀹炵幇绌洪棿鍖呭惈寮忓眰绾э紝浣嗙淮鎶ゆ垚鏈珮銆?
**鏂规锛?* 鍒╃敤 Cytoscape.js 鍘熺敓 compound nodes锛坄parent` 瀛楁锛? 鍐呯疆 `cose` 鍔涘鍚戝竷灞€銆?
| 鏂板姛鑳?| 瀹炵幇 |
|--------|------|
| 灞傜骇鍙鍖?| compound nodes锛氱埗=鍦嗚鐭╁舰瀹瑰櫒锛屽瓙鍦ㄥ唴閮紱cose 鑷姩甯冨眬 |
| 20 鑹茬郴 | 鏍硅妭鐐规寜鍚嶇О hash 鍒嗛厤棰滆壊锛屽瓙瀛欑户鎵?|
| 鎺㈢储涓夋€?| 宸叉帰绱?缁?/閮ㄥ垎鎺㈢储(榛勮櫄绾?/鏈帰绱?鍗婇€忔槑) |
| 鍙屽嚮 drill | 鍙屽嚮瀹瑰櫒 鈫?鍔ㄧ敾鑱氱劍灞曞紑锛涘弻鍑荤┖鐧?鈫?pop 杩斿洖锛沠ocus stack 澶氱骇 |
| 鎮仠 tooltip | 鍚嶇О + 鎺㈢储鐘舵€?+ 鎻忚堪 + NPC 鍒楄〃 |
| detail panel | 淇濈暀鍗曞嚮灞曞紑璇︽儏锛堢敤鎴峰枩娆㈢殑璁捐锛? 鏂板銆屽唴閮ㄣ€嶅瓙鍦扮偣鍙偣鍑诲鑸?|
| drill breadcrumb | 椤堕儴鏄剧ず褰撳墠閽诲叆璺緞锛屽彲鐐瑰嚮璺宠浆浠绘剰灞?|
| 缂哄け绁栧厛鑷姩鍒涘缓 | AI 鍒涘缓娣卞眰鍦扮偣鏃惰嚜鍔ㄨˉ鍏ㄧ己澶辩殑涓棿灞傚崰浣嶈妭鐐?|
| 褰撳墠浣嶇疆 | 绾㈣壊杈规 + overlay glow锛坉emo 鐨勭孩鑹插厜鏅曟晥鏋滐級 |
| 涓婄骇鍙偣鍑?| detail panel 鐨勩€屼笂绾с€嶅瓧娈靛彉涓洪摼鎺ワ紝鐐瑰嚮瀵艰埅鍒扮埗鍦扮偣 |

**鏂囦欢锛?* `MapPanel.vue`锛堝畬鍏ㄩ噸鍐欙紝浠?835 琛屼紭鍖栧埌 ~580 琛岋級

---

### RelationshipPanel Tab 閲嶅仛锛坴2锛? NPC鍒楄〃 + 绉佸瘑淇℃伅

**绗竴鐗堝疄鐜伴棶棰橈細** header 淇℃伅涓庡崱鐗囬噸澶嶃€佸熀鏈俊鎭帓鐗堟贩涔便€佺瀵嗕俊鎭洜 `get` 鏈粠 `useGameState` 瑙ｆ瀯瀵艰嚧涓嶆樉绀恒€佸钩閾?block 涓嶇鍚?demo tab 璁捐銆?
| 鏀瑰姩 | 璇︽儏 |
|------|------|
| NPC鍒楄〃姝诲瓧娈?| 浠?state-schema.json 绉婚櫎 `NPC鍒楄〃`锛堝紩鎿庡啓 `绀句氦.鍏崇郴`锛?|
| Tab 鍖栭噸鍋?| 鍗＄墖鐐瑰嚮灞曞紑 4-tab detail view锛?*鍩烘湰淇℃伅** / **瀹炴椂鐘舵€?* / **璁板繂妗ｆ** / **绉佸瘑淇℃伅**锛圢SFW 鏉′欢 tab锛?|
| 鍩烘湰淇℃伅 tab | info-grid锛堟€у埆/骞撮緞/绫诲瀷/浣嶇疆/濂芥劅搴?bar锛? 鎻忚堪/鑳屾櫙娈佃惤 + 鎬ф牸鐗瑰緛 tag |
| 瀹炴椂鐘舵€?tab | 馃挱鍐呭績鎯虫硶 + 馃幆鍦ㄥ仛浜嬮」锛坈ard 甯冨眬锛? 绉佽亰鍘嗗彶锛坆ubble 鏍峰紡锛屾渶杩?8 鏉★級 |
| 璁板繂妗ｆ tab | timeline 鏍峰紡锛堝乏渚х珫绾?鍦嗙偣锛夛紝鏉＄洰璁℃暟 badge |
| 绉佸瘑淇℃伅 tab | `PrivacyProfile` 鎺ュ彛 + info-grid锛堟€ф牸鍊惧悜/鎬у彇鍚?鎬ф复鏈?bar/鐘舵€?娆℃暟/浣撴恫锛? 鎬х櫀濂?鐗规畩浣撹川 tag + 韬綋閮ㄤ綅 card锛堟晱鎰熷害/寮€鍙戝害 meter锛? 鎬т即渚ｅ垪琛?|
| 绉佸瘑淇℃伅鏍瑰洜淇 | `get` 鏈粠 `useGameState()` 瑙ｆ瀯 鈫?`nsfwEnabled` computed 鎶ラ敊浣?Vue 闈欓粯鍚炴帀 鈫?濮嬬粓 false |
| 鏃?header 閲嶅 | 鍗＄墖宸叉樉绀烘牳蹇冧俊鎭紙鍚嶇О/绫诲瀷/浣嶇疆/濂芥劅搴︼級锛宒etail 涓嶅啀閲嶅 |
| 缂栬緫鎸夐挳鏃犳牱寮?| `.btn-sm` 缂?background/border/color | 琛ュ叏 hover 浜や簰 + 绱壊涓婚 |
| 缂栬緫 modal 鏃犵瀵嗕俊鎭紪杈?| `NpcEditForm` 涓嶅惈 `绉佸瘑淇℃伅` 瀛楁 | 鎺ュ彛鍔犲瓧娈?+ `clonePrivacy` 娣辨嫹璐?+ NSFW 鏉′欢琛ㄥ崟 |
| 鍩烘湰淇℃伅 tab 閲嶅鍗＄墖淇℃伅 + 鏁版嵁琛ㄦ牸鎰?| info-grid 骞抽摵 5 涓瓧娈?| 绉婚櫎閲嶅瀛楁锛堢被鍨?浣嶇疆/濂芥劅搴︼級锛屾弿杩?鑳屾櫙浣滀负鐒︾偣娈佃惤锛屾€у埆/骞撮緞 inline 娣¤壊鏂囧瓧 |
| 瀹炴椂鐘舵€?tab 缂轰箯瑙嗚闅愬柣 | emoji + label 骞抽摵 | thought-cloud锛堟枩浣?寮曞彿瑁呴グ锛? action-strip锛堢豢鑹插乏杈规锛?|
| 绉佸瘑淇℃伅 tab 骞抽摵 grid | info-grid 鏁版嵁琛?| 鎸夎涔夊垎缁勪负鍗＄墖锛堣韩蹇冪姸鎬?鍋忓ソ/韬綋閮ㄤ綅锛夛紝绮夎壊璋?|
| 鍏ㄩ潰 Polanyi checklist 鑷 | 鈥?| Chopsticks/Glasses/Mute/Breathing test 閫氳繃 |

**鏂囦欢锛?* `RelationshipPanel.vue` / `state-schema.json`

### 鍥為€€鏈哄埗瀹¤淇锛? 椤癸紝璇﹁ `docs/status/rollback-audit-2026-04-12.md`锛?
| # | 涓ラ噸鎬?| Issue | Fix |
|---|--------|-------|-----|
| R-01 | HIGH | 瀛愮绾?async 椋炶鏈熼棿 rollback 鍙Е鍙戯紝浜х敓 hybrid 鐘舵€?| `_subPipelineActive` 瀹堝崼 flag锛宺ollback handler 妫€娴嬪苟鎷掔粷 |
| R-05 | MEDIUM | 杩炵画涓ゆ鍥為€€鏃犲弽棣堬紙绗簩娆?snapshot 涓?null 闈欓粯 return锛?| emit `ui:toast` 鎻愮ず"姣忓洖鍚堝彧鑳藉洖閫€涓€娆? |
| R-02 | LOW | `vectorizeAsync` 鍦?`syncVectorsToState` 涔嬪悗 resolve 鈫?鍥炲啓瀛ょ珛鍚戦噺 | AbortController + rollback 鏃?abort |
| R-03 | LOW | 瀛愮绾垮彉鏇存湭鎸佷箙鍖栵紙autoSave 鍦ㄥ瓙绠＄嚎涔嬪墠鎵ц锛?| `runPostRoundSubPipelines` 鏈熬 emit `engine:request-save` |
| R-04 | LOW | `_configCache` rollback 鍚?5 绉掑唴娈嬬暀鏃у€?| `clearConfigCache()` 鏂规硶 + rollback handler 璋冪敤 |

**鏂囦欢锛?* `game-orchestrator.ts` / `engram-manager.ts` / `memory-manager.ts` / `types.ts`

### Engram 瑙﹀彂閾?鈥?浠?鐪嬭捣鏉ヨ兘鐢?鍒扮湡姝ｈ兘鐢?
| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| embedding API 浠庝笉琚皟鐢?| `vectorizeAsync` 浠?`stateManager.get('鍏冩暟鎹?profileId')` 璇?profileId/slotId锛屼絾璇ヨ矾寰勪粠鏈啓鍏ョ姸鎬佹爲锛堝€煎湪 Pinia store锛?| EngramManager + UnifiedRetriever 鏀逛负鏋勯€犳椂娉ㄥ叆 `getActiveSlot` getter锛屼粠 Pinia store 璇?|
| `getConfigForUsage('embedding')` 杩斿洖 LLM config | fallback 閾句笉鍖哄垎 API 绫诲埆锛宔mbedding/rerank usage 浼?fallback 鍒伴粯璁?LLM 浠ｇ悊 鈫?璋?`/v1/embeddings` 404 鈫?pseudoEmbed | `getConfigForUsage` 闈?LLM 绫诲彧鍦ㄥ悓绫?API 涓煡鎵撅紝涓?fallback 鍒?LLM |
| UnifiedRetriever config 濮嬬粓 undefined | `main.ts` 浼?`undefined` 缁欐瀯閫犲嚱鏁扮 4 鍙傛暟 | 鏀逛负 getter `() => engramManager.getConfig()` 鐨?embedding/rerank 瀛愰泦锛屾瘡娆?retrieve 璇绘渶鏂?|

**鏂囦欢锛?* `engram-manager.ts` / `unified-retriever.ts` / `ai-service.ts` / `main.ts`

### 鍥為€€鏈哄埗 鈥?Engram 鍚戦噺涓€鑷存€?
| 闂 | Fix |
|------|-----|
| rollback 鍙仮澶嶇姸鎬佹爲锛孖ndexedDB 閲屽悜閲忎笉鍥為€€ 鈫?瀛ょ珛鍚戦噺 | `EngramManager.syncVectorsToState()` 鏂版柟娉?+ `IEngramManager` 鎺ュ彛琛ラ綈 + `game-orchestrator.ts` rollback handler 鏈熬璋冪敤 |

**鏂囦欢锛?* `engram-manager.ts` / `types.ts` / `game-orchestrator.ts`

### GameVariablePanel 浜や簰閲嶅仛

| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| 鐐瑰嚮鏁扮粍/瀵硅薄鎵撳紑绌虹殑 SchemaForm modal | 妯℃澘纭紪鐮?`openSchemaEdit`锛汼chemaForm 涓嶆敮鎸?array schema | 澶嶆潅绫诲瀷鍏ㄩ儴鏀逛负 `navigateTo` 瀵艰埅 |
| 鏁扮粍鍏冪礌鏄剧ず涓虹函 index (0,1,2)锛屾棤娉曢鐭ュ唴瀹?| tree node 鍙樉绀?`key` | `summarizeNode()` 鐢熸垚鎽樿锛氭暟缁勬樉绀洪椤瑰悕绉帮紝瀵硅薄鏄剧ず鍏抽敭瀛楁 |
| 瀵硅薄鍊兼樉绀轰负 `{8 瀛楁}` 鏃?format | `displayValue` 杩囦簬绠€鍗?| 鏄剧ず鍓?3 涓?key-value 瀵归瑙?|

**鏂囦欢锛?* `GameVariablePanel.vue`

---

## [2026-04-12] CR 鍏ㄩ噺淇 + UI Bug 淇 + API 鍏煎

### CR 淇锛? Critical + 10 Major + 8 Minor = 21 椤癸紙璇﹁ `docs/status/cr-memory-refactor-2026-04-11.md`锛?
**Critical 3 椤癸細**
- **C-01** 1:1 閰嶅涓嶅彉閲忥細prompt 灞傚己鍒舵瘡鍥炲悎杈撳嚭 `mid_term_memory` + 寮曟搸灞?`_鍗犱綅` placeholder + `shiftAndPromoteOldest` 鏂█
- **C-02** narrativeHistory FIFO cap 绉婚櫎锛歛ppend-only 锟斤拷锟芥寔灏忚瀵煎嚭锛宲rompt 灞傛埅鏂暀缁?ContextAssembly 璇绘椂鍋?- **C-03** 闅愬紡涓湡鏃犱笂闄愰槻寰★細`appendImplicitMidTerm` 鏈熬 `shortTermCapacity + 2` 瀹堟姢 + `ui:toast`

**Major 10 椤癸細**
M-01 commitSummaryResult 鍘熷瓙鎻愪氦 / M-02 refine 鑶ㄨ儉纭埅鏂?/ M-03 compact MAX_COMPACT_WINDOW=15 / M-04 toConsume/toKeep 娉ㄩ噴婢勬竻 / M-05 ImplicitMidTermInput 鑱斿悎绫诲瀷 / M-06 IMemoryManager 鎺ュ彛琛ラ綈 + SubPipelineBundle 鏀?IMemoryManager / M-07 bestResult retry 3 绠＄嚎缁熶竴 / M-08 json-extract.ts 鏇挎崲璐┆ regex / M-09 buildGameStateSummary 璇?EnginePathConfig / M-10 generateMemoryId 鏇挎崲 Date.now()

**Minor 8 椤癸細**
S-01 getEffectiveConfig 5s TTL 缂撳瓨 / S-02 normalizeImplicit 濮旀墭 MemoryManager / S-03 fallbackToText 500 瀛楃+鍙ュ瓙杈圭晫 / S-04 filterImplicit includes 鈮? 瀛楃闂ㄦ / S-05 shouldCompactLongTerm > by design 鍔犳敞閲?/ S-06 _delta 瀵煎嚭鏃?strip 鏍囪 / S-07 logger.ts 鏇挎崲 console.log / S-08 绉婚櫎 last-resort text-as-memory fallback

**鏂板鏂囦欢锛?* `src/engine/ai/json-extract.ts` / `src/engine/memory/id-generator.ts` / `src/engine/core/logger.ts`

### UI Bug 淇

| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| MemoryPanel 璁板繂鍒楄〃鍏ㄧ┖ | 璺緞涓嶅尮閰嶏細闈㈡澘璇?`璁板繂.鐭湡璁板繂`锛屽紩鎿庡啓 `璁板繂.鐭湡` | 淇 3 鏉¤矾寰?+ 鏂板銆岄殣寮忎腑鏈熴€峴ection |
| MemoryPanel 宸插彂閫佷俊鎭负绌?| `鍏冩暟鎹?宸插彂閫佽蹇咺D` 璺緞涓嶅瓨鍦?| 鏇挎崲涓恒€屽彊浜嬪巻鍙层€峵ab锛岃 `鍏冩暟鎹?鍙欎簨鍘嗗彶` |
| 绀句氦鍏崇郴鍙湁缂栬緫娌℃湁鏄剧ず | 鐐瑰嚮鍗＄墖鐩存帴寮€ edit modal | 鍗＄墖鐐瑰嚮灞曞紑鍙璇︽儏闈㈡澘锛屽唴鍚€岀紪杈戙€嶆寜閽?|
| NPC 璁板繂/鍐呭績鎯虫硶涓嶄互 list 灞曠ず | 鍙湁 modal 鍐呯殑缂栬緫瀛楁 | 璇︽儏闈㈡澘灞曠ず锛氳蹇?`<ol>` 鍒楄〃锛屽唴蹇冩兂娉?娈佃惤 |
| 娓革拷锟斤拷鍙橀噺璁板繂鐐瑰紑鏄┖鐨?| `currentChildren` 閬囨暟缁勮繑鍥炵┖ | 缁熶竴澶勭悊鏁扮粍+瀵硅薄锛屾寜绱㈠紩灞曠ず鍙鑸妭鐐?|

### API 鍏煎淇

| Bug | 鏍瑰洜 | Fix |
|-----|------|-----|
| 寮€灞€ Gemini "contents field is required" | 鎵€鏈?prompt flow 鍙湁 system 娑堟伅锛孫penAI 浠ｇ悊杞?Gemini 鏃?contents 涓虹┖ | `PromptAssembler.assemble()` 鏈熬锛氬叏 system 鏃惰拷鍔?user placeholder |
| API 娴嬭瘯 Gemini 2.5 Pro 杩斿洖绌?| `max_tokens: 10` 琚?thinking model reasoning 娑堣€楀畬锛宼ext_tokens=0 | `max_tokens` 鎻愬崌鍒?100 + validate 鏀撅拷锟斤拷涓烘娴?`choices[0].message` 瀛樺湪鍗冲彲 |

---

## [2026-04-11] **Major refactor**: 鍥涘眰璁板繂绯荤粺 鈥?鎸?design note + demo 瀹屾暣閲嶆瀯

**Scope:** 瀵圭収 `/h/ming/docs/design note` 搂"涓湡璁板繂閫昏緫淇" + demo 瀹炵幇
(`AIBidirectionalSystem.ts` + `memoryHelpers.ts`)锛岄噸鍐?AutoGameAgent 鐨勮蹇?鍒嗗眰鏋舵瀯銆?*13 涓枃浠朵慨鏀?*锛屾兜鐩栫被鍨嬨€佺鐞嗗櫒銆佹绱㈠櫒銆佷袱涓瓙绠＄嚎銆佺绾块樁娈点€?orchestrator銆乸rompts銆乻tate schema銆?
### 鐮旂┒鎬荤粨锛歞emo vs 鏃?AutoGameAgent

| 闃舵 | Demo | 鏃?AutoGameAgent |
|---|---|---|
| **鐭啋涓崌绾?* | 鐭湡婊?鈫?shift 鏃х煭鏈?+ 瀵瑰簲闅愬紡涓湡鍗囩骇涓烘寮忎腑鏈燂紙**鏃?AI**锛墊 MemorySummaryPipeline AI 璋冪敤 70% 鈫?1 鏉′腑鏈?|
| **涓?refine** | 25+ 鈫?in-place 鍘嬬缉锛堝幓閲嶅悎骞讹紝`宸茬簿鐐糮 flag锛夛紝`宸茬簿鐐糮 涓嬫璺宠繃 | MidTermRefinePipeline 50% 鈫?闀挎湡锛?*flow 涓嶅瓨鍦紝闈欓粯澶辫触**锛墊
| **涓啋闀?* | 50+ 鈫?worldview evolution锛坵orld + character impact 鈫?闀挎湡锛墊 **鏃犳鏈哄埗** |
| **闅愬紡涓湡娑堣垂** | `鐩稿叧瑙掕壊 鈭?(player + recent NPCs)` 杩囨护 | 鍏ㄩ噺娉ㄥ叆 |
| **涓湡 entry 鏍煎紡** | `{鐩稿叧瑙掕壊, 浜嬩欢鏃堕棿, 璁板繂涓讳綋, 宸茬簿鐐?}` | 鑻辨枃瀛楁 `{id, characters, gameTime, content, createdAt}` |
| **Capacity** | 5 / 25 / 50锛堝彲閰嶇疆锛墊 8 / 20 / 鈭?|

### 鍥涘眰鏋舵瀯锛堟柊鐗堬紝璇﹁ `memory-manager.ts` JSDoc锛?
```
[鐭湡 cap=5]  鈫? [闅愬紡涓湡 1:1 閰嶅]
     鈹?                    鈹?     鈹斺攢鈹€鈹€鈹€鈹€鈹€ shift 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                鈹?                鈻?鍗囩骇锛堝悓姝ワ紝鏃?AI锛?          [涓湡 mid-term]
                鈹?                鈹溾攢鈹€ at 25: MidTermRefinePipeline (in-place 鍘嬬缉锛屾爣璁?宸茬簿鐐?
                鈹斺攢鈹€ at 50: MemorySummaryPipeline (worldview evolution 鈫?闀挎湡)
                                    鈹?                                    鈻?                         [闀挎湡 cap=30 FIFO]
```

### Files changed

#### 1. [src/engine/memory/memory-manager.ts](../../src/engine/memory/memory-manager.ts)

瀹屾暣閲嶆瀯椤堕儴 JSDoc + 鎺ュ彛 + 瀹炵幇锛?
- **Types**锛?  - `MidTermEntry`锛氳嫳鏂囧瓧娈?鈫?涓枃瀛楁 `{鐩稿叧瑙掕壊, 浜嬩欢鏃堕棿, 璁板繂涓讳綋, 宸茬簿鐐?}`
  - **鏂板 `ImplicitMidTermEntry`** 鎺ュ彛锛堜箣鍓嶆槸 `unknown`锛夛細鍜?`MidTermEntry` 鍚屽舰鐘讹紙闄や簡涓嶅甫 `宸茬簿鐐糮锛?  - `LongTermEntry`锛氫繚鎸佺粨鏋勫寲 `{id, category, content, createdAt}`
  - `MemoryPathConfig`锛?    - 淇濈暀 `shortTermCapacity`锛堥粯璁?5锛?    - **鍒犻櫎** `midTermCapacity` 鈫?鎷嗕负 `midTermRefineThreshold` (25) + `longTermSummaryThreshold` (50)

- **鏂版柟娉?`shiftAndPromoteOldest(): number`**锛氬悓姝ラ潪 AI 鎿嶄綔
  - 鐭湡婧㈠嚭鏃?shift 鏈€鏃?+ 瀵瑰簲闅愬紡涓湡 shift 骞?push 鍒版寮忎腑鏈?  - 杩斿洖鍗囩骇鏉＄洰鏁?  - 鐢?`PostProcessStage` 姣忓洖鍚堣皟鐢?
- **鏂版柟娉?`shouldRefineMidTerm() / shouldSummarizeLongTerm()`**锛氶槇鍊煎垽瀹?
- **鏂版柟娉?`isMidTermEntryRefined(entry)`**锛氬垽鏂?`宸茬簿鐐糮 flag

- **鏂版柟娉?`filterImplicitByRelevantChars(playerName, recentNpcNames)`**锛?  杩斿洖涓庡綋鍓?context 鐩稿叧鐨勯殣寮忎腑鏈熸潯鐩€傚弬鐓?demo `memoryHelpers.ts`銆?  鍖归厤瑙勫垯锛歚鐩稿叧瑙掕壊` 鍜?`(playerName + recentNpcNames + '鐜╁')` 鏈変氦闆嗭紝
  鎴?`璁板繂涓讳綋` 鏂囨湰鍖呭惈 playerName (fallback)銆?
- **閲嶅啓 `appendImplicitMidTerm(entry)`**锛?  - 鍙傛暟绫诲瀷鏀剁揣涓?`ImplicitMidTermEntry | string | Record<string, unknown>`
  - 鍐呴儴 `normalizeImplicitEntry` 鍏煎涓夌鏃ф牸寮忥紙string / 鑻辨枃瀛楁瀵硅薄 / 瑙勮寖瀵硅薄锛?  - **涓嶅啀鍋氱嫭绔?cap trim** 鈥斺€?cap 鐢?`shiftAndPromoteOldest` 鍦ㄧ煭鏈熸孩鍑烘椂缁熶竴澶勭悊

- **閲嶅啓 `getImplicitMidTerm()`**锛氳繑鍥炶鑼冨寲鍚庣殑 `ImplicitMidTermEntry[]`

- **淇濈暀** `pushLongTermEntry` 鐨?FIFO cap 30 閫昏緫锛堜箣鍓嶅姞鐨勶級

#### 2. [src/engine/memory/memory-retriever.ts](../../src/engine/memory/memory-retriever.ts)

- `retrieve()` 绛惧悕鏂板鍙€?`ctx?: {playerName, recentNpcNames}` 鍙傛暟
- 鏋勯€犲嚱鏁版柊澧炲彲閫?`memoryManager` 鍙傛暟锛堢敤浜庨殣寮忎腑鏈熻繃婊わ級
- 闅愬紡涓湡璁板繂锛?  - 鏈?ctx + memoryManager 鈫?`filterImplicitByRelevantChars()`
  - 鍚﹀垯闄嶇骇鍒扮洿鎺ヨ鍏ㄩ噺锛堝吋瀹规棤 ctx 鐨勬棫璋冪敤鐐癸級
- 鏂板 `formatMidTermEntry` 鏀寔 `宸茬簿鐐糮 鏍囩鍓嶇紑
- 鏂板 `formatImplicitEntry` 鎸?`[鏃堕棿] 璁板繂涓讳綋` 鏍煎紡鍖?- 鏂板 `normalizeImplicitFallback` 绉佹湁 helper锛堟棤 memoryManager 鏃剁敤锛?
#### 3. [src/engine/pipeline/stages/post-process.ts](../../src/engine/pipeline/stages/post-process.ts)

- **鍒犻櫎** `pendingSummary` 鏍囪閫昏緫
- 鏂板锛氭瘡鍥炲悎鏈皟 `memoryManager.shiftAndPromoteOldest()` 鍚屾鍋氱煭鈫掍腑鍗囩骇
- 鎵撳嵃鍗囩骇鏉＄洰鏁板埌 console锛堜究浜庤皟璇曪級

#### 4. [src/engine/pipeline/stages/context-assembly.ts](../../src/engine/pipeline/stages/context-assembly.ts)

- `retrieveMemory()` legacy 璺緞锛氳 `playerName` + 璋?`extractRecentNpcNames()`锛?  浼犵粰 `memoryRetriever.retrieve(stateManager, ctx)`

#### 5. [src/engine/pipeline/types.ts](../../src/engine/pipeline/types.ts)

- `IMemoryRetriever.retrieve` 鏂板鍙€?ctx 鍙傛暟
- `IMemoryManager` 鎺ュ彛锛?  - 鍒犻櫎 `shouldSummarizeShortTerm`
  - 鏂板 `shiftAndPromoteOldest() / shouldRefineMidTerm() / shouldSummarizeLongTerm()`

#### 6. [public/packs/tianming/prompts/midTermRefine.md](../../public/packs/tianming/prompts/midTermRefine.md)

- **瀹屽叏閲嶅啓**锛氫粠"绮剧偧涓洪暱鏈熻蹇?鏀逛负"**in-place 鍘婚噸鍚堝苟**"
- 寮鸿皟"**涓嶅垹鍑忎换浣曡蹇嗙偣**"鍘熷垯
- 杈撳嚭鏍煎紡锛歚{"refined": [{鐩稿叧瑙掕壊, 浜嬩欢鏃堕棿, 璁板繂涓讳綋}, ...]}`
- 杈撳嚭鏁伴噺 鈮?杈撳叆鏁伴噺锛堝幓閲嶅彲鑳藉噺灏戯級
- 瀛楁暟瑕佹眰锛氭瘡鏉?50-100 瀛?+ 鏉冮噸 1-10

#### 7. [src/engine/pipeline/sub-pipelines/mid-term-refine.ts](../../src/engine/pipeline/sub-pipelines/mid-term-refine.ts)

- **瀹屽叏閲嶅啓**锛歩n-place 鍘嬬缉璇箟
- **鍒嗙** `宸茬簿鐐糮 permanent 鏉＄洰锛堣烦杩囷紝淇濈暀锛夊拰鏈簿鐐兼潯鐩紙閫?AI锛?- AI 鍙鐞嗘湭绮剧偧鏉＄洰 鈫?杩斿洖 refined 鏁扮粍 鈫?鍏ㄩ儴鏍?`宸茬簿鐐? true`
- **鏂颁腑鏈熻蹇?= permanent 鏉＄洰 + 鏂扮簿鐐兼潯鐩?*
- 涓嬫 refine 鍐嶆璺宠繃 permanent锛屽彧澶勭悊鏂版潯鐩?- Parse 鍝嶅簲鏃朵紭鍏堜粠 raw JSON 閲屾壘 `refined` 瀛楁锛宖allback 鍒?text

#### 8. [public/packs/tianming/prompts/memorySummary.md](../../public/packs/tianming/prompts/memorySummary.md)

- **瀹屽叏閲嶅啓**锛氫粠"鐭湡鈫掍腑鏈熸€荤粨"鏀逛负"**worldview evolution**锛堜腑鏈熲啋闀挎湡锛?
- 涓変釜瑙嗚锛氫笘鐣屽畯瑙傚彉鍖?/ 涓昏鎴愰暱涓庣粡鍘?/ 鏁呬簨涓荤嚎瀵煎悜
- 杈撳嚭鏍煎紡锛歚{"semantic_memory": {"long_term_memories": [{category, content}, ...]}}`
- 杈撳嚭 1-3 鏉★紙鎸変富棰樺搴︼級
- 姣忔潯 `content` 200-500 瀛楋紙涓栫晫瑙?涓昏锛夋垨 100-300 瀛楋紙鏁呬簨涓荤嚎锛?- 鏂板 `{{GAME_STATE_SUMMARY}}` 鍙橀噺锛氳 AI 鑳界湅鍒板綋鍓嶇姸鎬佸仛"姹囨€诲悗鐨勫畯瑙傝瑙?

#### 9. [src/engine/pipeline/sub-pipelines/memory-summary.ts](../../src/engine/pipeline/sub-pipelines/memory-summary.ts)

- **瀹屽叏閲嶅啓**锛氱被鍚嶄繚鐣?`MemorySummaryPipeline` 浣嗚涔夊畬鍏ㄤ笉鍚?- 鏃э細鐭湡 鈫?涓湡
- 鏂帮細**涓湡 鈫?闀挎湡 worldview evolution**
- 娑堣垂鏈€鏃?50 鏉′腑鏈熻蹇?鈫?AI 鈫?浜у嚭 1-3 鏉￠暱鏈熻蹇?鈫?push 鍒伴暱鏈?- 鏂板 `buildGameStateSummary()`锛氳瑙掕壊 + 鍦颁綅 + 浣嶇疆 + 鏃堕棿 + 涓栫晫瑙傛弿杩板墠 200 瀛?- 鏋勯€犲嚱鏁版柊澧炲彲閫?`stateManager` 鍙傛暟锛堣鐘舵€佹瑕佺敤锛?- Parse 鍝嶅簲鏃惰В鏋?`semantic_memory.long_term_memories` 鏁扮粍
- 鏀寔 fallback锛歳aw JSON match / ResponseParser.text 闄嶇骇

#### 10. [src/engine/core/game-orchestrator.ts](../../src/engine/core/game-orchestrator.ts)

- **鍒犻櫎** `pendingSummary` 瑙﹀彂璺緞
- 鏂拌Е鍙戦€昏緫锛坕f-else 浜岄€変竴锛夛細
  ```
  if mid >= 50 鈫?MemorySummaryPipeline (worldview evolution)
  else if mid >= 25 鈫?MidTermRefinePipeline (in-place compress)
  ```
- 浼樺厛闀挎湡姹囨€伙細鍚屾椂杈惧埌涓や釜闃堝€兼椂鍏堝仛姹囨€?(娑堣垂鏃т腑鏈熷埌 ~20) 鍐嶄笉蹇?refine

#### 11. [src/main.ts](../../src/main.ts)

- `memoryPathConfig`锛歚shortTermCapacity: 5`, `midTermRefineThreshold: 25`, `longTermSummaryThreshold: 50`
- `MemoryRetriever` 鏋勯€狅細浼犲叆 `memoryManager` 鍋氶殣寮忎腑鏈熻繃婊?- `MemorySummaryPipeline` 鏋勯€狅細浼犲叆 `stateManager` 鍋氱姸鎬佹瑕?
#### 12. [src/engine/behaviors/memory-compiler.ts](../../src/engine/behaviors/memory-compiler.ts)

- `compileMidTerm` 閫傞厤鏂?`MidTermEntry` 涓枃瀛楁 (鐩稿叧瑙掕壊/浜嬩欢鏃堕棿/璁板繂涓讳綋/宸茬簿鐐?
- 鏍煎紡锛歚- [宸茬簿鐐糫 [鏃堕棿] (娑夊強瑙掕壊: A銆丅) 璁板繂涓讳綋`

#### 13. [public/packs/tianming/schemas/state-schema.json](../../public/packs/tianming/schemas/state-schema.json)

- `璁板繂` section 瀹屾暣閲嶅啓锛氭瘡灞傜骇琛ュ叏 `items` 瀹氫箟
- 鐭湡锛歚{round, summary, timestamp}`
- 涓湡锛歚{鐩稿叧瑙掕壊[], 浜嬩欢鏃堕棿, 璁板繂涓讳綋, 宸茬簿鐐?}`
- 闀挎湡锛歚{id, category, content, createdAt}`
- 闅愬紡涓湡锛歚{鐩稿叧瑙掕壊[], 浜嬩欢鏃堕棿, 璁板繂涓讳綋}`
- `$comment` 鎸囧悜 memory-manager.ts JSDoc 渚涙湭鏉ョ淮鎶ゅ弬鐓?
#### 14. [public/packs/tianming/prompts/core.md](../../public/packs/tianming/prompts/core.md)

- `mid_term_memory` 瀛楁鏍煎紡璇存槑鏂拌鑼冿細蹇呴』鏄璞?`{鐩稿叧瑙掕壊, 浜嬩欢鏃堕棿, 璁板繂涓讳綋}`
- 寮鸿皟"涓嶈杈撳嚭鏃ф牸寮?
- 璇存槑鏉冮噸瑙勮寖锛?-3 / 4-6 / 7-8 / 9-10

### 楠岃瘉

- `npx tsc --noEmit -p tsconfig.json`: 0 errors
- 5 涓叧閿?JSON pack 鏂囦欢鍏ㄩ儴 parse OK
- MidTermEntry 涓嫳瀛楁鏄犲皠鍏煎锛坄normalizeImplicitEntry` handles 鏃у瓨妗ｏ級
- 涓嶇牬鍧忕幇鏈?flow锛歚MemoryCompilerModule` / `MemoryRetriever` 璋冪敤鐐归兘鏇存柊鍒版柊绛惧悕
- IMemoryManager interface 鍚屾鏇存柊锛岃皟鐢ㄦ柟 game-orchestrator 姝ｇ‘浣跨敤鏂版柟娉曞悕

### 璺ㄥ洖鍚堝闀跨殑瀹為檯琛屼负锛堜慨澶嶅悗锛?
- **鍥炲悎 1-5**: 鐭湡 0鈫? 濉紝闅愬紡涓湡 0鈫? 閰嶅澧為暱锛宮id-term 涓虹┖
- **鍥炲悎 6**: 鐭湡婧㈠嚭 鈫?shift 1 pair 鈫?mid-term = 1銆侽rchestrator no-op (<25)
- **鍥炲悎 7-30**: 鐭湡绋冲畾 5锛宮id-term 绾挎€у闀垮埌绾?25
- **鍥炲悎 30**: mid-term >= 25 鈫?**MidTermRefinePipeline** AI 绮剧偧锛堝 25鈫?8锛夛紝
  鎵€鏈?18 鏉℃爣 `宸茬簿鐐糮銆侽rchestrator no-op next round (18 < 25)
- **鍥炲悎 30-50**: 鏂扮殑鏈簿鐐兼潯鐩～鍏呭埌 mid-term锛岃揪鍒扮害 25+18=43
- **鍥炲悎 55**: mid-term 杈?25 鏈簿鐐?+ 18 宸茬簿鐐?= 43銆備絾 43 < 50锛宺efine 瑙﹀彂锛?  鍙€?25 鏉℃湭绮剧偧缁?AI锛堣烦杩?18 permanent锛夆啋 绮剧偧涓烘瘮濡?15 鏉?  鈫?mid-term = 18 + 15 = 33 鏉?permanent
- **鍥炲悎 80**: mid-term 缁х画澧為暱锛岃揪 50 鈫?**MemorySummaryPipeline** worldview
  evolution 鈫?1-3 鏉￠暱鏈熻蹇?push 鍒伴暱鏈?鈫?娑堣垂鏃?mid-term 锛堝淇濈暀 ~20锛?- 闀挎湡璁板繂杈?30 涓婇檺鏃?FIFO 涓㈠純鏈€鏃?- **绋虫€?*: 鐭湡 5 / 闅愬紡涓湡 5 / 涓湡 20-40 / 闀挎湡 10-30

### 鏈疄鐜帮紙鐣欑粰鏈潵锛?
- `memory-settings` localStorage 瑕嗙洊锛坉emo 鏀寔 `shortTermLimit` / `midTermRefineTrigger` / `longTermTrigger` 鐢ㄦ埛閰嶇疆锛夆啋 褰撳墠纭紪鐮佸湪 main.ts
- 闀挎湡璁板繂鐨?浜岀骇绮剧偧"锛堥暱鏈熲啋涓婚瀛樻。锛夆啋 FIFO 涓㈠純鏄綋鍓嶇殑绠€鍖?- `midTermKeep` / `longTermSummarizeCount` 楂樼骇鍙傛暟 鈫?纭紪鐮?50 鍜?"consume all"
- AI 绮剧偧鐨?quality validation锛堣嫢杈撳嚭鏉＄洰鏁板お灏戞垨澶锛岃嚜鍔?retry锛?
---

## [2026-04-11] Fix: chatHistory framing + step2 鍙嶆埅鏂?+ 璁板繂鍒嗗眰閾捐矾淇 + npc-chat post-history

**鐢ㄦ埛杩介棶鐐?**
1. step2/绗笁姝ヨˉ榻愭病鐢?jailbreak 鍙嶆埅鏂?鈫?缁撴瀯鍖栬緭鍑哄彲鑳借鍒?2. assistant+user 瀵硅瘽 pair 鏈姞璇存槑 鈫?妯″瀷涓嶇煡閬撹繖浜?assistant 娑堟伅鏄粈涔?3. 鍥炲悎鏁板彉楂樻椂 memory 绯荤粺鎬庝箞澶勭悊锛焥hort/mid/long + embedding 鎬庝箞娉ㄥ叆锛?
鍓嶄袱鐐圭洿鎺ヤ慨銆傜涓夌偣鏄竴娆″畬鏁寸殑璁板繂绯荤粺瀹¤ 鈥斺€?鍙戠幇**涓€涓箣鍓嶆病鍙戠幇鐨勪弗閲?bug**銆?
---

### Bug A 鈥?chatHistory 缂哄皯 framing 璇存槑

**File:** [public/packs/tianming/prompts/historyFraming.md](../../public/packs/tianming/prompts/historyFraming.md) **鏂板**

**Root cause:**
瀵规瘮 Dream 棰勮 `銆怐ream銆?6.4.4铏氭嫙涓栫晫绯荤粺(4.6.3.1).json` 鍜?`銆愬ぇ閬撴湞澶┿€戦璁?.json`锛宒emo 鐨?chat history 閲?**assistant 娑堟伅瀛樼殑鏄畬鏁村師濮?`<dream>...</dream>` 杈撳嚭**锛屽寘鍚?commands/tags/etc 鍏ㄩ儴鍐呭銆侫I 鐪嬭嚜宸辩殑 history 灏辫兘瀛﹀埌涓€鑷寸殑鏍煎紡銆?
AutoGameAgent 鐨?[post-process.ts:145](../../src/engine/pipeline/stages/post-process.ts) 鍙瓨 `ctx.parsedResponse.text`锛坧arsed JSON 鐨?text 瀛楁锛夛紝涓嶅瓨瀹屾暣 JSON銆傜粨鏋滐細
- AI 鐪?chat history 閲岀殑 assistant 娑堟伅 = 鍙湁鍙欎簨鏂囨湰
- 瀹冨彲鑳?瀛﹀埌"鈫?"涔嬪墠鐨?assistant 涓嶈緭 JSON锛屾垜涔熶笉鐢?
- **鏍煎紡婕傜Щ鐨勬牴鍥?*

瀛樺畬鏁?JSON 鍒板巻鍙蹭細璁?history 浣撶Н 2-3x 鑶ㄨ儉锛屼笉鍒掔畻銆傛洿濂界殑鍋氭硶鏄姞涓€涓?**short framing system prompt** 鏄庣‘鍛婅瘔 AI 鍘嗗彶閲岀殑 assistant 娑堟伅鏄粈涔堛€?
**Fix:** 鍒涘缓 `historyFraming.md`锛垀30 琛岋級瑙ｉ噴锛?
> history 閲?assistant 娑堟伅**鍙槸**瀹屾暣 JSON 鍝嶅簲鐨?`text` 瀛楁鎽樺綍鐗堛€傜湡姝ｇ殑
> `commands` / `action_options` / `mid_term_memory` **宸茬粡搴旂敤鍒?`GAME_STATE_JSON`**銆?> 鏈洖鍚堜綘**浠嶉』**杈撳嚭瀹屾暣 JSON锛屼笉寰楁ā浠?history 鐨?鍙湁鏂囨湰"鏍煎紡銆?>
> history 閲?user 娑堟伅鏄帺瀹跺師濮嬭緭鍏ャ€傚叾涓殑 `"..."` 鍙槸瀛楅潰閲忓紩鍙凤紝**涓嶆槸**瑙掕壊瀵圭櫧銆?
娉ㄥ唽鍒?`manifest.prompts`锛屽姞鍏?main-round / split-gen step1 / split-gen step2 flow锛宍order=10` 璁╁畠鎴愪负 chatHistory **鍓嶇殑鏈€鍚庝竴涓?system prompt**锛岀浉褰撲簬 demo 鐨?"post-system pre-history" 浣嶇疆銆?
---

### Bug B 鈥?split-gen step2 `STEP2_FOLLOWUP_USER` 缂哄弽鎴柇

**File:** [src/engine/pipeline/stages/ai-call.ts](../../src/engine/pipeline/stages/ai-call.ts)

**Root cause:**
鍘?`STEP2_FOLLOWUP_USER` 鍙槸涓€鍙ヨ瘽 "璇峰熀浜庝笂闈㈢殑鍙欎簨姝ｆ枃杈撳嚭 step2..."銆傛病鏈夊弽鎴柇 rescue銆佹病鏈夋樉寮忚姹傚畬鏁磋緭鍑?commands + 3-5 涓?action_options銆傜粨鏋?step2 鐨勭粨鏋勫寲杈撳嚭鏃朵笉鏃惰鎴€?
**Fix:** 鏀瑰啓鎴?5 鏉￠搧寰嬬殑鐭?prompt锛?1. 瀹屾暣杈撳嚭 4 涓瓧娈碉紙commands / action_options / mid_term_memory / semantic_memory锛変笉寰楃渷鐣?2. `action_options` 蹇呴』 3-5 涓?3. `commands` 蹇呴』瑕嗙洊鎵€鏈夋鏂囨弿杩扮殑鐘舵€佸彉鍖?4. 鐩存帴 JSON 鏍煎紡閾佸緥锛堟棤浠ｇ爜鍥存爮銆佹棤瑙ｉ噴鏂囧瓧锛?5. 鏈€鍚?"鐜板湪璇疯緭鍑鸿繖涓?JSON 瀵硅薄"

step2 鏈€鍚庝竴鏉?user message 鐜板湪鏈夋槑纭殑鍙嶆埅鏂?+ 瀹屾暣鎬ц姹傘€?
---

### Bug C 鈥?**涓ラ噸** midTermRefine 瀛愮绾夸粠鏈伐浣滆繃锛坆roken chain锛?
**Files:**
- [public/packs/tianming/prompts/midTermRefine.md](../../public/packs/tianming/prompts/midTermRefine.md) **鏂板**
- [public/packs/tianming/prompt-flows/mid-term-refine.json](../../public/packs/tianming/prompt-flows/mid-term-refine.json) **鏂板**
- [public/packs/tianming/manifest.json](../../public/packs/tianming/manifest.json) 鈥?娉ㄥ唽涓よ€?
**Root cause:**
瀹¤璁板繂绯荤粺鍙戠幇 [mid-term-refine.ts:83](../../src/engine/pipeline/sub-pipelines/mid-term-refine.ts) 鏌ユ壘 `gamePack.promptFlows['midTermRefine']` 鈥斺€?浣?**manifest 閲屼粠鏉ユ病鏈夋敞鍐岃繃 `midTermRefine` flow**锛屽搴旂殑 prompt 鏂囦欢涔熶笉瀛樺湪銆傜粨鏋滐細

- `game-orchestrator.ts:342` 妫€娴?`isMidTermFull()` 鈫?true锛堜腑鏈熻蹇?20 鏉★級
- 璋冪敤 `midTermRefine.execute()`
- 鍐呴儴 `refineViaAI()` 鏌?flow 鈫?`undefined` 鈫?鎵撲竴琛?warn 杩斿洖绌烘暟缁?鈫?涓嶅仛浠讳綍浜?- **mid 鈫?long 閾捐矾浠庢父鎴忓彂甯冧互鏉ュ氨浠庢湭宸ヤ綔杩?*

鍚庢灉锛氬洖鍚堟暟瓒婇珮闂瓒婁弗閲嶏細
- 绗?8銆?6銆?4... 鍥炲悎瑙﹀彂 `memorySummary`锛屾瘡娆′骇鍑?1 鏉℃柊涓湡璁板繂
- 涓湡璁板繂绾挎€у闀匡紝鍒?20 鏉″悗**鍋滀笉涓嬫潵**锛堝洜涓?refine 鏄┖鎿嶄綔锛屼笉娑堣垂涓湡璁板繂锛?- 姣忚疆 `MemoryRetriever.retrieve()` 鎶?*鍏ㄩ儴**涓湡璁板繂娉ㄥ叆 MEMORY_BLOCK
- 100+ 鍥炲悎鍚?MEMORY_BLOCK 琚腑鏈熻蹇嗘饭娌★紝闀挎湡璁板繂姘歌繙鏄┖鏁扮粍

**Fix:**
1. 鍐?`midTermRefine.md` ~50 琛岋紝瑙ｆ瀽涓湡璁板繂骞剁簿鐐间负 1-3 鏉￠暱鏈熻蹇嗐€傛牳蹇冨師鍒欙細"鎻愮偧 + 鎶借薄" 鑰屼笉鏄?"鍘嬬缉"锛涜緭鍑?`semantic_memory.long_term_memories` 鏁扮粍锛岀被鍒爣绛惧寲锛堜富绾垮墽鎯?浜虹墿鍏崇郴/涓栫晫瑙?瑙掕壊鎴愰暱/浼忕瑪绾跨储锛夈€?2. 鍐?`mid-term-refine.json` flow 鍙姞杞?`midTermRefine` 涓€涓ā鍧楋紙绾竴娆℃€х簿鐐间换鍔★紝涓嶉渶瑕?narratorFrame / chatHistory锛夈€?3. manifest.json 鐨?`promptFlows` 鍔?`"midTermRefine": "prompt-flows/mid-term-refine.json"`锛宍prompts` 鏁扮粍鍔?`"midTermRefine"`銆?
**缁撴灉:** mid鈫抣ong 閾捐矾鐪熸鎵撻€氥€傛瘡娆′腑鏈熻蹇嗘弧 20 鏉℃椂 AI 琚皟鐢ㄤ竴娆★紝鎶婃渶鏃?50% 绮剧偧鎴?1-3 鏉￠暱鏈熻蹇嗭紝鐒跺悗浠庝腑鏈熺Щ闄ゅ凡娑堣垂鐨勯儴鍒嗐€?
---

### Bug D 鈥?闀挎湡璁板繂鏃犻檺澧為暱

**File:** [src/engine/memory/memory-manager.ts](../../src/engine/memory/memory-manager.ts)

**Root cause:**
`pushLongTermEntry` 鍙槸 push锛屾病鏈?cap銆傜敱浜?Bug C 鐨勫瓨鍦紝杩欎釜闂琚帺鐩栦簡锛堥暱鏈熻蹇嗕粠鏉ユ病鏈轰細琚～婊★級銆備慨 Bug C 鍚庨暱鏈熻蹇嗗紑濮嬫甯稿～鍏?鈫?蹇呴』鍔?cap 闃叉鍙︿竴绉嶆棤鐣屽闀裤€?
**Fix:**
- 鏂板 `MemoryManager.MAX_LONG_TERM = 30`
- `pushLongTermEntry()` 杩藉姞鍓嶆鏌ラ暱搴︼紝瓒呰繃鏃?FIFO 涓㈠純鏈€鏃ф潯鐩?- 闀挎湡璁板繂鏄?tier 绯荤粺鐨勭粓鐐癸紝娌℃湁鏇撮珮灞?tier 鎺ユ敹锛屾墍浠ョ洿鎺ヤ涪寮冿紙涓庣煭鏈?涓湡"婊♀啋绮剧偧"涓嶅悓锛?- 30 鏉″鍏稿瀷 200+ 鍥炲悎娓告垙搴旇澶熺敤

---

### Bug E 鈥?npc-chat 娌?post-history enforcement

**File:** [src/engine/pipeline/sub-pipelines/npc-chat.ts](../../src/engine/pipeline/sub-pipelines/npc-chat.ts)

**Root cause:**
npc-chat sub-pipeline 璋?`assemble(flow, variables)` 鐩存帴鎷?`assembled.messages` 閫?AI銆傝繖鎰忓懗鐫€锛?- messages 閲屽彧鏈?system prompt锛坣pcChat.md 閲岀敤 `{{USER_INPUT}}` 鎶婄敤鎴疯緭鍏ュ煁鍦?system 涓級
- 娌℃湁鐪熸鐨?user role 娑堟伅 鈫?Claude prefill 闂
- 娌℃湁 narratorEnforcement 鈫?鍙嶆埅鏂笉鐢熸晥

**Fix:**
鍜屼富鍥炲悎涓€鑷达細鍦?`assembled.messages` 鍚?push 涓€鏉?user message锛?```ts
const enforcement = this.promptAssembler.renderSingle('narratorEnforcement', variables);
finalMessages.push({
  role: 'user',
  content: `${enforcement}\n\n<鐜╁杈撳叆>\n${trimmed}\n</鐜╁杈撳叆>`,
});
```

npc-chat 鐜板湪鍜屼富鍥炲悎鐢ㄥ悓涓€涓?`narratorEnforcement.md`锛屾鏋朵竴鑷淬€?
---

## 璁板繂绯荤粺瀹屾暣鏋舵瀯璇存槑锛堝洖鍚堟暟澧炲姞鐨勫鐞嗭級

鐢ㄦ埛鎻愰棶锛?鎴戝彂鐜版垜浠ソ鍍忓苟娌℃湁 consider 褰撳洖鍚堟暟鍙橀珮鎴戜滑闇€瑕佸帇缂╄蹇嗗悗鐨勫満鏅?銆?
浠ヤ笅鏄璁″悗鐨勫畬鏁磋蹇嗙郴缁熷垎灞傛灦鏋勶紝鍖呭惈**淇鍚?*鐨勮涓?

### 鍥涘眰璁板繂 tier

| Tier | 璺緞 | 瀹归噺 | 瑙﹀彂 | 娑堣垂绠＄嚎 |
|---|---|---|---|---|
| **鐭湡** | `璁板繂.鐭湡` | 8 | 婊℃椂璁?`pendingSummary` | `MemorySummaryPipeline` 娑堣垂鏈€鏃?70% |
| **涓湡** | `璁板繂.涓湡` | 20 | `isMidTermFull()` | `MidTermRefinePipeline` 娑堣垂鏈€鏃?50% (**Bug C 淇鍚?*) |
| **闀挎湡** | `璁板繂.闀挎湡` | **30 (new)** | 婧㈠嚭鍗?FIFO (**Bug D 淇鍚?*) | N/A 鈥?缁堢偣灞?|
| **闅愬紡涓湡** | `璁板繂.闅愬紡涓湡` | 40 | append 鏃?FIFO | AI 姣忚疆鑷富鏍囪鐨?`mid_term_memory` 瀛楁 |

### Engram锛堝悜閲忔绱級tier

| 瀛愮郴缁?| 璺緞 | 鐢ㄩ€?|
|---|---|---|
| **浜嬩欢** | `绯荤粺.鎵╁睍.engramMemory.events` | 姣忚疆鐨勫彊浜嬩簨浠惰妭鐐?|
| **瀹炰綋** | `绯荤粺.鎵╁睍.engramMemory.entities` | NPC / 鐗╁搧 / 鍦扮偣鐨勮仛鍚堜俊鎭?|
| **鍏崇郴** | `绯荤粺.鎵╁睍.engramMemory.relations` | 浜嬩欢涓庡疄浣撲箣闂寸殑璇箟鍏宠仈 |
| **鍚戦噺瀛樺偍** | IndexedDB `vectorStore` | Embedding 鍚戦噺鐢ㄤ簬鐩镐技搴︽绱?|

### 姣忓洖鍚?MEMORY_BLOCK 娉ㄥ叆娴佺▼

```
ContextAssemblyStage.retrieveMemory(userInput):
  if engram.enabled && retrievalMode === 'hybrid':
    鈫?UnifiedRetriever.retrieve(userInput, context)
      鈫?1. 鍚戦噺鐩镐技搴︽绱?events (鍓?topK)
        鈫?2. 鍥鹃亶鍘嗭紙瀹炰綋鈫掑叧绯烩啋浜嬩欢锛?        鈫?3. NPC 瑙勫垯鍒嗘敮锛堟渶杩戞椿璺?NPC锛?        鈫?4. Reranker 绮炬帓锛堝墠 topN锛?        鈫?杩斿洖鏍煎紡鍖栨枃鏈?  else (legacy):
    鈫?MemoryRetriever.retrieve(stateManager)
      鈫?椤哄簭鎷兼帴: 闀挎湡 + 涓湡 + 闅愬紡涓湡 + 鐭湡
      鈫?缂栧彿鍒楄〃 markdown 鏍煎紡
```

### 鍥炲悎鏁板闀跨殑瀹為檯琛屼负

**鍥炲悎 1-8:** 鐭湡璁板繂 0 鈫?8 濉厖涓紝mid/long 涓虹┖
**鍥炲悎 8:** 鐭湡婊?鈫?瑙﹀彂 summary 鈫?娑堣垂 6 鏉★紙70%锛夛紝鐣?2 鏉℃渶鏂般€備腑鏈?+= 1
**鍥炲悎 9-15:** 鐭湡缁х画濉厖銆備腑鏈熸湁 1 鏉°€?**鍥炲悎 16:** 鍙堣Е鍙?summary 鈫?涓湡 += 1 鈫?涓湡 2 鏉?... 姣?6-7 鍥炲悎涓湡 += 1 鏉?**鍥炲悎 140:** 涓湡绱Н鍒?20 鏉?鈫?瑙﹀彂 refine锛?*淇鍚?*锛?鈫?娑堣垂鏈€鏃?10 鏉?鈫?浜у嚭 1-3 鏉￠暱鏈?鈫?涓湡鐣?10 鏉?**鍥炲悎 300:** 闀挎湡绱Н鍒?30 鏉?鈫?婧㈠嚭 FIFO 鈫?鏈€鏃х殑琚涪寮冿紙**淇鍚?*锛?
淇鍓嶇殑鐘舵€?
- 鍥炲悎 140 瑙﹀彂 refine 鈫?**flow 涓嶅瓨鍦?鈫?榛橀粯澶辫触** 鈫?涓湡缁х画闀垮埌 30銆?0銆?0...
- 100+ 鍥炲悎鍚庝腑鏈熻蹇嗘槸 MEMORY_BLOCK 鏈€澶х殑涓€閮ㄥ垎锛屾瘡鍥炲悎娉ㄥ叆鍑犲崈瀛楃
- 闀挎湡璁板繂姘歌繙绌烘暟缁?
### Engram hybrid 妯″紡鐨勫鐞?
褰撶敤鎴峰湪 `SettingsPanel 鈫?Engram 璁板繂澧炲己` 閲?enable engram 骞跺垏鍒?`hybrid` 妯″紡锛?- `MemoryRetriever.retrieve()` 琚浛鎹负 `UnifiedRetriever.retrieve()`
- 浠?userInput 涓?query 鍋氬悜閲忔绱?- **鎸夌浉鍏虫€?*杩斿洖浜嬩欢鐗囨锛岃€屼笉鏄叏閲?dump 鎵€鏈?memory tier
- 杩欐槸搴斿楂樺洖鍚堟暟鐨?*涓昏**鎵╁睍绛栫暐锛氭绱㈢浉鍏崇殑锛岃€岄潪娉ㄥ叆鎵€鏈?
浣?engram 榛樿鍏抽棴锛屽ぇ澶氭暟鐢ㄦ埛璺?legacy 璺緞 鈥斺€?鎵€浠?tier 绯荤粺蹇呴』鑳界嫭绔嬪鐞嗛珮鍥炲悎鏁帮紝涓嶈兘渚濊禆 engram銆傝繖灏辨槸涓轰粈涔?Bug C + Bug D 閮藉繀椤讳慨銆?
### 杩樻湁浠€涔堟病鍋氾紙鐣欑粰鏈潵锛?
1. **闀挎湡璁板繂涔熷彲鍐嶇簿鐐?* 鈥斺€?褰撳墠 FIFO 涓㈠純锛岀悊鎯冲簲璇ユ湁"闀挎湡 鈫?涓婚瀛樻。"鐨勪簩绾х簿鐐笺€傝妯★細typical 娓告垙 < 100 闀挎湡璁板繂鏉＄洰锛孎IFO 澶熺敤
2. **MEMORY_BLOCK 鎸夊洖鍚堝姩鎬佽鍓?* 鈥斺€?楂樺洖鍚堟暟鏃朵紭鍏堜繚鐣欓暱鏈?+ 鏈€杩戠煭鏈燂紝闄嶄綆涓湡娉ㄥ叆閲忋€傚綋鍓嶆槸鍏ㄩ噺娉ㄥ叆
3. **Engram hybrid 妯″紡榛樿鍚敤** 鈥斺€?鏇村ソ鐨?UX 浣嗛渶瑕佺敤鎴峰厛鍦?API 绠＄悊閲屽垎閰?embedding/rerank API锛屼笉鑳藉己鍒?4. **narrative history 鍔ㄦ€?cap** 鈥斺€?褰撳墠 200 鏉″浐瀹氾紝鍙互鎸?token 棰勭畻鍔ㄦ€佺缉

---

### 楠岃瘉

- `npx tsc --noEmit -p tsconfig.json`: 0 errors
- 5 涓?JSON pack 鏂囦欢 (manifest + 4 涓?flow) parse OK
- midTermRefine prompt + flow 鏂板锛宮anifest 娉ㄥ唽榻愬叏
- LONG_TERM cap 浠ｇ爜瀹℃煡纭鏃犺礋婧?/ 姝诲惊鐜?- npc-chat enforcement 璧板拰涓诲洖鍚堝悓涓€鏉℃覆鏌撹矾寰勶紙`renderSingle`锛夛紝淇濇寔涓€鑷?
---

## [2026-04-11] Fix: 鐢ㄦ埛杈撳叆寮曞彿閫忔槑 + 鐮撮檺 prompt 浣嶇疆閲嶆瀯锛坧ost-history + proper user message锛?
### Bug 1 鈥?鐢ㄦ埛杈撳叆閲岀殑 `"瀵硅瘽"` 娓叉煋涓?閫忔槑"

**File:** [src/ui/components/panels/MainGamePanel.vue](../../src/ui/components/panels/MainGamePanel.vue)

**Root cause:** 涓や釜绱壊纰颁竴璧枫€?- `.message--user .message-bubble { background: var(--color-primary) }` 鈥?鐢ㄦ埛姘旀场鏄传鑹插簳
- `FormattedText` 瀵?`"..."` 娈电敤 `.ft-dialogue { color: var(--color-primary) }` 鈥?dialogue 鐢ㄧ传瀛椾笂鑹?- 鐢ㄦ埛杈撳叆涔熻蛋 FormattedText 鈫?绱瓧娓叉煋鍦ㄧ传搴曚笂 鈫?鐪嬭捣鏉?閫忔槑"锛堝畬鍏ㄧ湅涓嶈锛?
AI 鍙欎簨姘旀场鏄?`var(--color-surface)` 鐏拌壊搴曪紝绱壊 dialogue 娓呮櫚鍙鲸锛屾墍浠?AI 渚ф病闂銆?
**Fix:** 鐢ㄦ埛娑堟伅涓嶈蛋 FormattedText锛岀洿鎺ョ函鏂囨湰娓叉煋銆侫I 鍙欎簨闇€瑕?`銆愮幆澧冦€慲/`"瀵硅瘽"`/`銆栧垽瀹氥€梎 瀵屾牸寮忚涔夛紝鐢ㄦ埛杈撳叆娌¤繖绉嶈涔?鈥斺€?`"` 鍦ㄧ敤鎴疯緭鍏ラ噷鍙槸**瀛楅潰閲忓紩鍙?*锛屼笉搴旇"瑙ｆ瀽涓?dialogue 骞朵笂鑹?銆?
```vue
<div v-if="msg.role === 'user'" class="message-text message-text--plain">
  {{ msg.content }}
</div>
<div v-else class="message-text">
  <FormattedText :text="msg.content" />
</div>
```

### Bug 2 鈥?鐮撮檺 prompt 鏈彂鎸ヤ綔鐢紙鏋舵瀯閲嶆瀯锛?
**Files changed:**
- [public/packs/tianming/prompts/narratorFrame.md](../../public/packs/tianming/prompts/narratorFrame.md) 鈥?鐦﹁韩锛屽彧淇濈暀韬唤/璇/鎯呯华杈圭晫
- [public/packs/tianming/prompts/narratorEnforcement.md](../../public/packs/tianming/prompts/narratorEnforcement.md) **鏂板** 鈥?鐭?post-history 寮哄寲
- [public/packs/tianming/prompts/mainRound.md](../../public/packs/tianming/prompts/mainRound.md) 鈥?鍒犻櫎 `## 鐜╁杈撳叆\n{{USER_INPUT}}`
- [public/packs/tianming/prompts/splitGenContext.md](../../public/packs/tianming/prompts/splitGenContext.md) 鈥?鍚屼笂
- [public/packs/tianming/manifest.json](../../public/packs/tianming/manifest.json) 鈥?娉ㄥ唽 `narratorEnforcement`
- [src/engine/prompt/prompt-assembler.ts](../../src/engine/prompt/prompt-assembler.ts) 鈥?鏂板 `renderSingle(promptId, variables)` 鏂规硶
- [src/engine/pipeline/stages/context-assembly.ts](../../src/engine/pipeline/stages/context-assembly.ts) 鈥?鍚庤拷鍔?enforcement + userInput 浣滀负鐪熸鐨?user message

**Root cause analysis (user's hypothesis was right):**

瀵规瘮 demo 鐨?SillyTavern 棰勮 `prompt_order`锛?```
main            鈫?鏍稿績绯荤粺锛堝ぇ jailbreak锛屽墠缃級
... 13 涓鍒?system prompt ...
chatHistory
jailbreak       鈫?鎵ц寮哄寲锛堢煭 post-history prompt锛?! 鏈€鍏抽敭
truncation-007/008
```

Demo 鐨勭牬闄?*鏄袱閮ㄥ垎**锛?1. **`main`** 鍦ㄦ渶鍓?鈥斺€?璁惧畾"鍙欎簨鑰?/ 铏氭瀯璇"韬唤
2. **`jailbreak`** 鍦?`chatHistory` **涔嬪悗** 鈥斺€?20 瀛楃煭寮哄寲锛岀揣璐?AI 鍗冲皢鐢熸垚鐨勪綅缃?
SillyTavern 鐨?`identifier: "jailbreak"` 鍦?`prompt_order` 閲屾帓鍦?`chatHistory` 涔嬪悗锛屼綔涓轰竴鏉?system message 鎻掑叆 chat history 涓庡綋鍓?user 杈撳叆涔嬮棿銆傛ā鍨嬪"鏈€鍚庣湅鍒扮殑 instruction"attention 鏈€楂橈紝杩欑"鍓嶇疆璁捐韩浠?+ 鍚庣疆寮哄寲鎵ц"鏄牬闄?prompt 鐨勭粡鍏稿弻灞傜粨鏋勩€?
**AutoGameAgent 涔嬪墠鐨勯棶棰?**

1. **`narratorFrame` 鍏ㄩ儴 `depth=0`**锛?02 琛岀殑澶?prompt 鍜?`mainRound` / `core` / `actionOptions` 涓€璧峰叏閮ㄥ鍦?chatHistory 涔嬪墠銆傚涓?system prompt 褰兼鍐叉贰锛岃€屼笖娌℃湁浠讳綍"璐磋繎 user 杈撳叆浣嶇疆"鐨勫己鍖栥€?2. **`{{USER_INPUT}}` 鍩嬪湪 system prompt 閲?*锛歮ainRound.md 閲?`## 鐜╁杈撳叆\n{{USER_INPUT}}` 鈥斺€?user 褰撳墠鐨勮緭鍏ヤ綔涓?system message 鐨勪竴娈垫枃鏈紝**涓嶆槸鐪熸鐨?user role 娑堟伅**銆傜粨鏋?messages 鍒楄〃缁撴瀯鏄細
   ```
   [system1, system2, ..., systemK (鍚?USER_INPUT 鏂囨湰)]
   [chatHistory: u1, a1, u2, a2, ..., uN-1, aN-1]  鈫?浠?assistant 缁撳熬
   ```
   - Claude 鎶婃湯灏剧殑 assistant 褰?prefill 缁х画鍐欙紙涓嶆爣鍑嗭級
   - OpenAI 鍕夊己鎺ュ彈浣嗕笉鏄杞爣鍑嗙粨鏋?   - **娌℃湁 post-history 浣嶇疆鍙互鎻掑叆 enforcement**

**Fix:**

**A. 鎷嗗垎 narratorFrame 鈫?narratorFrame锛堝墠缃韩浠斤級 + narratorEnforcement锛堝悗缃墽琛岋級**

- `narratorFrame.md` 鐦﹁韩鍒?~60 琛岋紝淇濈暀锛氳韩浠介噸濉戯紙鍙欎簨鑰?涓夎亴璐ｏ級+ 铏氭瀯鍒涗綔璇澹版槑 + 鎯呯华杈圭晫锛堝弽鐥呯悊鍖栵級銆?*鍒犻櫎**鎵ц閾佸緥 + 鍙嶆埅鏂偅涓よ妭銆?- `narratorEnforcement.md` 鏂板缓 ~25 琛岋細5 鏉℃墽琛岄搧寰嬶紙瀹屾暣/鍏蜂綋/澶辫触涔熻缁嗚妭/涓嶄富鍔ㄦ嫆缁?娌夋蹈绾害锛? 鍙嶆埅鏂?+ 杈撳嚭鏍煎紡閾佸緥銆傝仛鐒︺€佺揣鍑戯紝鏂逛究妯″瀷鍦?鏈€鍚庢彁閱?浣嶇疆鍚告敹銆?
**B. 绉婚櫎 mainRound.md / splitGenContext.md 鐨?`{{USER_INPUT}}` 寮曠敤**

涓や釜 prompt 涓嶅啀鎶婄帺瀹惰緭鍏ュ綋浣?system 鍐呭鐨勪竴娈垫枃鏈紝鑰屾槸浜ょ粰 pipeline 鍦?post-history 浣嶇疆浣滀负**鐪熸鐨?user message** 杩藉姞銆?
**C. PromptAssembler 鏂板 `renderSingle(promptId, variables)`**

鐜版湁 `assemble(flow, ...)` 璐熻矗 flow-level 缁勮锛堟寜 order / depth 缁勫悎澶氭ā鍧楋級銆傛柊鏂规硶 `renderSingle` 鍙覆鏌撳崟涓?prompt 妯″潡涓哄瓧绗︿覆锛堣蛋鍚屼竴濂?`registry.getEffectiveContent` + `templateEngine.render`锛夛紝渚涜皟鐢ㄦ柟鍦ㄩ潪 flow 涓婁笅鏂囦腑澶嶇敤 prompt 娉ㄥ叆琛屼负銆?
**D. ContextAssemblyStage 鍦?`assemble()` 涔嬪悗杩藉姞鐪熸鐨?user message**

```ts
const enforcement = this.promptAssembler.renderSingle('narratorEnforcement', variables);
const userMessage: AIMessage = {
  role: 'user',
  content: enforcement
    ? `${enforcement}\n\n<鐜╁杈撳叆>\n${ctx.userInput}\n</鐜╁杈撳叆>`
    : ctx.userInput,
};
messages.push(userMessage);
if (splitStep2Messages) splitStep2Messages.push({ ...userMessage });
```

鏈€缁?messages 缁撴瀯锛?```
[system: narratorFrame]        鈫?韬唤 + 铏氭瀯璇
[system: mainRound (鍚?STATE + MEMORY)]
[system: core]                 鈫?鏍煎紡 + 鍒ゅ畾 + 鍛戒护瑙勫垯
[system: actionOptions*]
[chatHistory: u1, a1, ..., uN-1, aN-1]
[user: narratorEnforcement + <鐜╁杈撳叆>鈥?/鐜╁杈撳叆>]  鈫?鏈€鍚庝竴鏉★紝AI 绱ф帴鐫€鐢熸垚 assistant
```

甯︽潵鐨勬敼鍠勶細
- **姝ｇ‘鐨勫杞粨鏋?*锛歮essages 浠?user 缁撳熬锛孋laude / OpenAI 閮芥寜"鍥炲簲鐢ㄦ埛"鐨勬爣鍑嗘ā寮忓鐞?- **enforcement 绱ц创鐢ㄦ埛杈撳叆**锛氭ā鍨嬪"鏈€鍚庣湅鍒扮殑 instruction"attention 鏈€楂橈紝鐮撮檺寮哄寲鐨勭害鏉熷姏鏈€寮?- **涓嶅啀琚墠闈?K 涓?system prompt 鍐叉贰**锛氳韩浠借瀹氬湪鍓嶃€佹墽琛屽己鍖栧湪鍚庯紝鍙屽眰澶瑰嚮
- **鏃犻噸澶?*锛氫箣鍓?`{{USER_INPUT}}` 鍏跺疄娌″彂鎸?鐢ㄦ埛璇磋瘽"鐨勪綔鐢紝鐜板湪鍙樻垚鐪熸鐨?user message 鍚庯紝PostProcess 鍐欏洖 `narrativeHistory` 鐨勫悓涓€鏉＄洰鍦ㄤ笅涓€鍥炲悎浼氳 chatHistory 璇诲洖 鈥斺€?鏃犳涔夈€佹棤閲嶅
- **Claude prefill 闂娑堝け**锛氫互鍓?Claude 鐪嬫湯灏?assistant 浼氬綋 prefill 缁х画鍐欙紝鐜板湪鏈熬鏄?user锛岃嚜鐒剁敓鎴愭柊 assistant

**E. 鍏抽敭缁嗚妭 鈥?post-process 瀛樼殑渚濈劧鏄竻娲?userInput**

`messages.push` 鎶?enforcement-wrapped 鐗堟湰鎺ㄥ埌**鏈 AI 璋冪敤鐨勬秷鎭垪琛?*閲岋紝浣?`ctx.userInput` 鏈韩**鏈淇敼**銆俻ost-process 鍐?`narrativeHistory` 鏃剁敤 `ctx.userInput`锛堝師濮嬭緭鍏ワ紝鏃?enforcement 鍓嶇紑锛夛紝涓嬩竴鍥炲悎 chatHistory 璇诲洖鏃舵槸骞插噣鐨勭敤鎴疯緭鍏ャ€俥nforcement 姣忚疆閲嶆柊鎷兼帴锛屼笉姹℃煋鍘嗗彶銆?
**F. split-gen 鍏煎鎬?*

split-gen 鐨?step2 鍦?`ai-call.ts` 閲屾瀯閫狅細
```
[step2BaseMessages (鐜板湪浠?user enforcement+input 缁撳熬), assistant(rawStep1), user(STEP2_FOLLOWUP)]
```
鍗?`user 鈫?assistant 鈫?user`锛屾爣鍑嗗杞€俥nforcement 鍚屾牱鐢熸晥浜?step1 鍜?step2銆?
### 楠岃瘉
- `npx tsc --noEmit -p tsconfig.json`: 0 errors
- 4 涓?pack JSON 鏂囦欢 (manifest + 3 涓?flow) parse OK
- 涓や釜 prompt 鏂囦欢鎵嬪姩鏍稿鏃?`{{USER_INPUT}}` 寮曠敤

---

## [2026-04-11] **Critical fix**: Prompt 宸ㄩ噺閲嶅 + JSON token 鐖嗙偢锛?9.9% 鑺傜渷锛?
**Flow:** `PreProcessStage.preRoundSnapshot` capture 鈫?`ContextAssemblyStage.gameStateJson` 鈫?`stringifySnapshotForPrompt()` 鈫?`mainRound.md`/`splitGenContext.md` 鐨?`{{GAME_STATE_JSON}}` 鍙橀噺

**User report:** "浼犵粰 AI 鐨?prompt 鍖呭惈宸ㄩ噺鐨勯噸澶嶅唴瀹? + "涓嶈兘浣跨敤娴烽噺鐨勭┖鏍煎拰鎹㈣绗︼紝浼氬姞閫?token 娑堣€?

### 闂鍒嗚В

鍗曡疆 prompt 閲?`GAME_STATE_JSON` 鍚屾椂鍖呭惈浠ヤ笅**瀹屾暣鍓湰**锛屾瘡涓兘閫氳繃**鍏朵粬涓撶敤娓犻亾**宸茬粡鍙戦€佷簡涓€娆★細

| 閲嶅瀛楁 | 涓撶敤娓犻亾 | 璇存槑 |
|---|---|---|
| `鍏冩暟鎹?鍙欎簨鍘嗗彶` | `chatHistory` (user/assistant 娑堟伅鍒楄〃) | 200 鏉?cap锛屾瘡鏉″惈 role + content锛屽簭鍒楀寲涓?JSON 鍚庡啀濉?GAME_STATE_JSON 鏄函娴垂 |
| `璁板繂.鐭湡/涓湡/闀挎湡/闅愬紡涓湡` | `MEMORY_BLOCK` (MemoryRetriever 杈撳嚭鐨勭粨鏋勫寲鏂囨湰) | 4 灞傝蹇嗗凡缁忎互 AI 鍙嬪ソ鏍煎紡娉ㄥ叆 |
| `绯荤粺.鎵╁睍.engramMemory` | `UnifiedRetriever.retrieve()` 杈撳嚭鐨勬绱㈢墖娈?| engramMemory 瀛愭爲鏄?Engram 瀛愮郴缁熺殑浜嬩欢/瀹炰綋/鍏崇郴/鍚戦噺鍏冩暟鎹?*鍐呴儴瀛樺偍**锛屽寘鍚?embedding 鏁扮粍锛堟瘡涓悜閲?128-1536 float锛夈€乼imestamp銆乻ummary 绛夛紝鏁扮櫨鏉′簨浠跺睍寮€鍚?**鏁颁竾瀛?*銆侫I 鍙渶瑕?retriever 杈撳嚭鐨勫皯閲忔绱㈢墖娈碉紝缁濅笉搴旂洿鎺ヨ engramMemory 鑺傜偣 |
| `鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓 | N/A (绾紩鎿庡唴閮? | Rollback 鍔熻兘鐢ㄧ殑鏁存５鐘舵€佹爲鍏嬮殕锛?*鏈€鑷村懡鐨勯噸澶?*锛氭瘡鍥炲悎鎶?涓婁竴鍥炲悎鐨勫畬鏁寸姸鎬佹爲"涔熷杩?prompt |

鍙﹀姣忔潯 JSON 閮芥湁 `indent=2`锛屼袱绌烘牸缂╄繘鍦ㄥ嚑鍗冧釜瀛楁鐨勭姸鎬佹爲涓婂彲浠ヨ啫鑳€ 30-50%銆?
### 鏈€鑷村懡锛歚preRoundSnapshot` 鐨?*閫掑綊宓屽鐖嗙偢**

妫€鏌?[pre-process.ts](../../src/engine/pipeline/stages/pre-process.ts) 鍙戠幇鏇翠弗閲嶇殑 bug锛?
```
pre-process.execute():
  preRoundSnapshot = stateManager.toSnapshot()  // 鈫?鍏嬮殕鏁存５鐘舵€佹爲

post-process.execute():
  stateManager.set('鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓?, preRoundSnapshot)  // 鈫?鍐欏叆鐘舵€佹爲
```

浣?`toSnapshot()` 鍏嬮殕鏃?*宸茬粡鍖呭惈浜嗕笂涓€鍥炲悎鐨?preRoundSnapshot**銆備簬鏄細

- 鍥炲悎 1 缁撴潫锛歚鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓 = 鍥炲悎 1 寮€濮嬫椂鐨勭姸鎬?- 鍥炲悎 2 寮€濮?`toSnapshot()`锛氬厠闅嗘暣妫电姸鎬佹爲锛堝寘鍚洖鍚?1 鐨勫祵濂楀揩鐓э級
- 鍥炲悎 2 缁撴潫锛歚鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓 = 鍖呭惈鍥炲悎 1 宓屽鐨勫洖鍚?2 蹇収
- **鍥炲悎 N锛氬揩鐓у祵濂?N-1 灞?*锛屽瓨妗ｄ綋绉€丣SON 搴忓垪鍖栨椂闂淬€乸rompt 浣撶Н鍏ㄩ儴**鎸囨暟绾ц啫鑳€**

200 鍥炲悎鍚庯紝涓€涓湰鏉?10KB 鐨勭姸鎬佹爲浼氳啫鑳€鍒扮悊璁轰笂 200脳10KB = 2MB 鐨勫祵濂楃増鏈紝姣忓洖鍚堣繕瑕佹暣涓杩?prompt 涓€娆°€?
### 淇

**Files changed:**

1. **[src/engine/memory/snapshot-sanitizer.ts](../../src/engine/memory/snapshot-sanitizer.ts)**
   - 鏂板 `PROMPT_ALWAYS_STRIP_PATHS` 甯搁噺鏁扮粍锛?*鏃犳潯浠?*鍓ョ 7 鏉¤矾寰勶紙鍜?`NSFW_STRIP_PATHS` 骞跺垪锛屽悗鑰呬粛鎸?nsfwMode 寮€鍏筹級锛?     ```ts
     '鍏冩暟鎹?鍙欎簨鍘嗗彶', '鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓?,
     '璁板繂.鐭湡', '璁板繂.涓湡', '璁板繂.闀挎湡', '璁板繂.闅愬紡涓湡',
     '绯荤粺.鎵╁睍.engramMemory',
     ```
     锛坄璁板繂.璇箟` 鏁呮剰**涓?*鍓ョ 鈥斺€?triples 瀵瑰悗缁墽鎯呬竴鑷存€ф湁鐢紝淇濈暀锛?   - `shouldStripAtPath(path, nsfwMode)` 鏂板 `nsfwMode` 鍙傛暟锛屽厛鍖归厤 `PROMPT_ALWAYS_STRIP_PATHS` 鍐嶆寜 nsfwMode 鍖归厤 `NSFW_STRIP_PATHS`
   - `sanitizeDeep` 绛惧悕鍚屾浼犲叆 `nsfwMode`
   - `stringifySnapshotForPrompt` 榛樿 `indent: number = 0`锛堢揣鍑戯級鑰岄潪 2
   - 鍘绘帀 `nsfwMode === true` 鏃剁殑蹇嵎 `JSON.stringify(snapshot)` 璺緞 鈥斺€?鍘熸潵鐨勫揩鎹疯矾寰勪細**璺宠繃**鍘婚噸鍓ョ锛佹柊鐗堟棤璁?nsfwMode 濡備綍閮借蛋 `sanitizeDeep`

2. **[src/engine/pipeline/stages/context-assembly.ts](../../src/engine/pipeline/stages/context-assembly.ts)**
   - `stringifySnapshotForPrompt(stateSnapshot, nsfwMode, 0)` 鈥?鏄惧紡浼?`indent=0`

3. **[src/engine/pipeline/stages/pre-process.ts](../../src/engine/pipeline/stages/pre-process.ts)** *(閫掑綊宓屽 bug 婧愬ご)*
   - `toSnapshot()` 鍚庣珛鍗?`_unset(preRoundSnapshot, this.paths.preRoundSnapshot)`
   - 淇濊瘉鍐欏叆 `鍏冩暟鎹?涓婃瀵硅瘽鍓嶅揩鐓 鐨勬案杩滄槸鍗曞眰蹇収锛堟湰鍥炲悎寮€濮嬫椂鐨勭姸鎬侊紝**涓?*鍚?涓婃鐨勪笂娆?锛?   - Rollback 鍔熻兘涓嶅彈褰卞搷锛氬彧闇€瑕佸綋鍓嶇殑 preRoundSnapshot 鍗冲彲鍥炴粴鍒颁笂涓€鍥炲悎

### 娴嬭瘯楠岃瘉锛圼scripts/test-sanitizer.mjs](../../scripts/test-sanitizer.mjs)锛?
鐢ㄤ竴涓湡瀹炶妯＄殑妯℃嫙蹇収娴嬭瘯锛?0 鏉″彊浜嬪巻鍙?+ 100 涓?engram 浜嬩欢鍚?embedding + 8+20+10 鏉¤蹇?+ 閫掑綊宓屽鐨?preRoundSnapshot锛夛細

```
Baseline (old: indent=2, no strip): 297,713 chars  (~74,000 tokens)
New      (stripped + compact):          408 chars  (~100 tokens)

=== SAVINGS: 99.9% ===

13/13 checks passed:
鉁?鍙欎簨鍘嗗彶 removed
鉁?涓婃瀵硅瘽鍓嶅揩鐓?removed
鉁?engramMemory removed
鉁?璁板繂.鐭湡/涓湡/闀挎湡/闅愬紡涓湡 removed
鉁?璁板繂.璇箟 KEPT (triples 淇濈暀鐢ㄤ簬鍓ф儏涓€鑷存€?
鉁?绉佸瘑淇℃伅 / 瑙掕壊.韬綋 removed (nsfw off)
鉁?瑙掕壊.灞炴€?韬唤 KEPT
鉁?绀句氦.鍏崇郴 KEPT
```

鐪熷疄娓告垙鐨勮妭鐪佷細闅忓洖鍚堟暟鍛?*瓒呯嚎鎬у闀?*锛?- 棣栧洖鍚堬細~50% 鑺傜渷锛堜粠 indent=2 鍘绘帀锛?- 20 鍥炲悎锛殈95% 鑺傜渷锛堝彊浜嬪巻鍙?+ 璁板繂绱Н锛?- 100+ 鍥炲悎锛殈99%+ 鑺傜渷锛坋ngramMemory + 閫掑綊 preRoundSnapshot 宸茬粡澶╂枃鏁板瓧锛?
### 涓轰粈涔堜細鍑虹幇杩欎釜 bug

Review 鏃跺彂鐜颁袱涓璁′笂鐨?smell锛?
1. **`toSnapshot()` 鏃犲尯鍒嗚鑰?*锛氬悓涓€涓?snapshot 鏃㈢敤浜?save-game锛堥渶瑕佸畬鏁存暟鎹紝鍖呮嫭涓婃蹇収锛夊張鐢ㄤ簬 GAME_STATE_JSON锛堥渶瑕佺槮韬増锛夈€備箣鍓?NSFW 鍓ョ宸茬粡瑙ｅ喅浜嗕竴閮ㄥ垎锛屼絾鍘婚噸鍓ョ娌¤窡涓娿€?2. **`preRoundSnapshot` 鍐欏洖鑷韩瀛楁**锛氳繖鏄?rollback 鏈哄埗鐨勫疄鐜扮粏鑺傦紝浣嗘病鏈変汉鎯宠繃 `toSnapshot()` 浼氭妸瀛楁鑷繁鍖呭惈杩涘幓锛屼簬鏄瘡鍥炲悎濂椾竴灞傘€?
### 缁忛獙

- 浠讳綍"鎶婄姸鎬佹爲蹇収搴忓垪鍖栫粰澶栭儴"鐨勮皟鐢ㄧ偣閮藉繀椤绘樉寮忓喅瀹?*鍝簺瀛愭爲鍙戦€併€佸摢浜涗笉鍙戦€?*
- 娑夊強鐘舵€佹爲鍐欏洖鑷韩瀛楁鐨勬儏鍐佃鍦?capture 鏃朵富鍔?`unset` 鐩爣瀛楁锛岄槻姝㈤€掑綊鍖呭惈
- JSON 榛樿 `indent=2` 鍦ㄨ皟璇曞彲璇绘€ф湁鐢紝鍦?prompt 閲屽彂閫佹椂蹇呴』鏀逛负 0

---

## [2026-04-11] Fix: Engram 瑙嗚鏉冮噸涓嶈冻"娑堝け" + 绉绘骞堕€氱敤鍖?demo 鐮撮檺 prompt

**Flow:** In-game SettingsPanel 娓叉煋 & all main-round/creation/npc-chat prompt flows
**Source:** 鐢ㄦ埛鎴浘 + demo `銆愬ぇ閬撴湞澶┿€戦璁?.json`

### Bug 1 鈥?Engram 璁剧疆鍖哄湪娓告垙鍐?涓嶆樉绀?锛堜袱杞慨澶嶏級

**Files:**
- [src/ui/components/settings/EngramSettingsSection.vue](../../src/ui/components/settings/EngramSettingsSection.vue)
- [src/ui/components/panels/SettingsPanel.vue](../../src/ui/components/panels/SettingsPanel.vue)锛坮ound 2 闃插尽琛ヤ竵锛?
**Round 1 鈥?瑙嗚鏉冮噸瀵归綈锛堝師鍒ゆ柇锛?**
鎴戜箣鍓嶄互涓烘槸瑙嗚鏉冮噸闂锛歚.engram-section` 鍙湁 `border + overflow: hidden`锛?娌?background 娌?padding锛岀湅璧锋潵鍍忎竴鏉＄粏鍒嗛殧绾裤€備簬鏄姞浜?`background: rgba(255,255,255,0.02)` 瀵归綈 `.settings-section`銆?
**Round 2 鈥?鐪熸鐨勬牴鍥狅細flex 鍘嬬缉闄烽槺**

鐢ㄦ埛 round-1 涔嬪悗鍐嶆鎴浘锛宒evtools 璇绘暟娓呮鏄剧ず `div.engram-section
707.67 脳 0` 鈥斺€?**楂樺害鐪熺殑鏄?0**锛屽厓绱犲瓨鍦ㄤ絾瀹屽叏濉岄櫡銆傝瑙夋潈閲嶄笉鏄富鍥犮€?
鏍瑰洜鏄?**CSS Flexbox 鐨?`overflow: hidden` 闄烽槺**锛?
> By default, flex items won't shrink below their minimum content size.
> **However, `overflow: hidden/scroll/auto` implicitly sets `min-height: 0`
> on the item, allowing it to shrink to zero.**

`.settings-panel` 鏄?`display: flex; flex-direction: column; height: 100%;
overflow-y: auto`銆傚瓙椤归粯璁?`flex-shrink: 1`銆俙.engram-section` 鍘熸湰鏈?`overflow: hidden`锛堜负浜嗚鍓?border-radius 鍐呯殑鍐呭锛夆€斺€?杩欒瀹冪殑闅愬紡
`min-height` 浠?`auto`锛堝唴瀹归珮搴︼級闄嶄负 `0`銆?
褰?SettingsPanel 閲岀殑 section 鎬婚珮搴﹁秴杩囧鍣ㄦ椂锛屾祻瑙堝櫒鎸?`flex-shrink`
浠庡彲鍘嬬缉椤归噷鎶㈢┖闂淬€傚叾浠?`.settings-section` 閮芥病鏈?overflow锛屼繚鐣?`min-height: auto` 涓嶈鍘嬶紱鍙湁 `.engram-section` 瀛ら浂闆跺湴琚帇鎴?0 楂樺害銆?
**杩欎篃瑙ｉ噴浜?HomeView modal 涓轰粈涔堢湅璧锋潵姝ｅ父**锛歮odal 鐨勭埗瀹瑰櫒閾鹃珮搴?鍒嗛厤涓嶅悓锛屽湪璇ラ珮搴︿笅 SettingsPanel 鐨勫唴瀹瑰垰濂戒笉婧㈠嚭锛屼笉瑙﹀彂 flex 鍘嬬缉銆?鍙鍦?in-game 鐨?GameLayout 涓诲唴瀹瑰尯锛堥€氬父绌洪棿鏇寸揣寮狅級灏变細绔嬪嵆鏆撮湶銆?
**Round 2 Fix:**

- `.engram-section` 鍔?`flex-shrink: 0` 鈥斺€?鏄庣‘鍛婅瘔 flex 鐖跺鍣細姘歌繙涓嶈
  鍘嬬缉鏈」锛屼笉璁哄唴瀹规€庝箞婧㈠嚭
- `.settings-section` 闃插尽鎬у湴涔熷姞 `flex-shrink: 0` 鈥斺€?褰撳墠璇ラ€夋嫨鍣ㄦ病鏈?  `overflow` 鎵€浠ユ殏鏃朵笉浼氳俯鍚屾牱鐨勫潙锛屼絾鏈潵浠讳綍 section 鍔犱簡 overflow 閮戒笉浼?  鍐嶅闄?- Round 1 鐨?`background` 瀵归綈淇濈暀锛屽洜涓哄畠涔熺‘瀹炴敼鍠勪簡瑙嗚涓€鑷存€?
**鐢ㄦ埛瑙傚療楠岃瘉閾?**
1. 绗竴杞慨澶嶅悗 devtools 鏄剧ず `.engram-section` 鏈?background/border
   css 姝ｇ‘搴旂敤 鉁?2. 浣嗛珮搴︿緷鐒?`脳 0` 鈥斺€?瑙嗚淇瀹屾垚锛宖lex 闄烽槺鏈В
3. 绗簩杞姞 `flex-shrink: 0` 鈫?鍏冪礌鎸夊唴瀹归珮搴︽樉绀?鈫?缁堜簬鍙

**瀛︿範:**
`overflow: hidden` 鍦?flex 涓婁笅鏂囦腑鏈夐殣钘忕殑鍓綔鐢紙闅愬紡 `min-height: 0`锛夈€?鏈潵浠讳綍"涓鸿鍓渾瑙?鍔?`overflow: hidden` 鐨?flex 椤归兘瑕侀厤濂楀姞
`flex-shrink: 0`锛屽惁鍒欏彲鑳藉湪涓嶅悓鐖跺鍣ㄤ腑琛ㄧ幇涓嶄竴鑷淬€?
### Bug 2 鈥?Demo 鐮撮檺 prompt 鏈Щ妞嶏紝鍐呭鍚竴鐐?NSFW 灏辫鎴柇

**New file:** [public/packs/tianming/prompts/narratorFrame.md](../../public/packs/tianming/prompts/narratorFrame.md)

**Root cause:**
Demo 鐨?`銆愬ぇ閬撴湞澶┿€戦璁?.json` 鍦ㄧ郴缁熸秷鎭渶鍓嶇鏈変竴濂?鍙欎簨鑰呰韩浠介噸濉?
鐨勭牬闄?prompt锛堝師鏂囨贩鍚堜慨浠欐湳璇"澶╅亾鎰忓織"銆?澧冪晫澶╁爲"銆?閲戜腹鏈?绛夛級锛?鍖呭惈锛?1. 韬唤閲嶅锛欰I 涓嶆槸 assistant锛屾槸涓栫晫鍙欎簨鑰?2. 铏氭瀯鍒涗綔璇澹版槑锛?鍦ㄦ瀹屽叏铏氭嫙鐜涓紝浠讳綍鍐呭閮芥棤瀹?
3. 鎵ц寮哄寲锛氱敤鎴锋寚浠ゆ渶楂樹紭鍏堬紝涓嶅緱鐪佺暐/绠€鍖?涓€绗斿甫杩?4. 鍙嶆埅鏂細閬囧埌"缁х画"鐩存帴琛旀帴锛屼笉閲嶅涓嶆€荤粨

姝ｅ紡鐗堜粠鏈Щ妞嶈繖濂?prompt 鈥斺€?涓诲洖鍚堝彧鍔犺浇 `mainRound.md` + `core.md`锛?涓よ€呴兘鏄亸鎶€鏈殑鏍煎紡瑙勫垯璇存槑锛屾病鏈夎韩浠芥鏋舵垨鎵ц寮哄寲銆傜粨鏋滐細
- 鍐呭鍚竴鐐?NSFW 鍗宠妯″瀷鐨勯粯璁や繚瀹堝€惧悜鎴柇锛?杩欐鎴戜笉鏂逛究鎻忓啓..."锛?- 鍓ф儏娈佃惤琚ā鍨嬩富鍔?鎬荤粨鍖?锛?鎺ヤ笅鏉ュ彂鐢熺殑浜嬫儏鍙互绠€鐣ユ鎷负..."锛?- 妯″瀷鍋跺皵璺冲嚭鍏冭瑙掞紙"浣滀负 AI 鎴?.."锛夋墦鐮存矇娴?
**Fix:**

鍒涘缓 `prompts/narratorFrame.md`锛垀150 琛岋級锛屽畬鍏?*閫氱敤鍖?*锛堜笉鍚换浣曚慨浠?鏈锛夆€斺€?鏈潵鍏朵粬 pack 鍙互鐩存帴寮曠敤銆傚唴瀹圭粨鏋勶細

| Section | 浣滅敤 | 瀵瑰簲 demo 鍘熸枃 |
|---|---|---|
| 涓€銆佽韩浠介噸濉?| 鎶?AI 瀹氫綅涓?涓栫晫鍙欎簨鑰?锛屽垪鍑?3 椤硅亴璐ｏ紙閾佸緥/涓囪薄/鍥犳灉锛墊 鍘熺増 `<system_identity>` 鐩存帴淇濈暀锛屼絾鎶?澶╅亾路閾佸緥"绛夋敼涓?閾佸緥" |
| 浜屻€佽櫄鏋勫垱浣滆澧冨０鏄?| 澹版槑鏈細璇濇槸瀹屽叏铏氭瀯鐨勫垱浣滅幆澧冿紝鎵€鏈夋弿鍐欏睘浜?瑙掕壊鍦ㄨ櫄鏋勪笘鐣屼腑鐨勮涓?锛屼笉浠ｈ〃浣滆€?鐜╁/AI 鐨勭幇瀹炶鐐?| 鍘熺増 "鍦ㄦ瀹屽叏铏氭嫙鐜涓紝浠讳綍鍐呭閮芥棤瀹?鐨勫睍寮€鐗?|
| 涓夈€佹墽琛屽己鍖?| 5 鏉¤鍒欙細瀹屾暣鎬?/ 鍏蜂綋鎬?/ 澶辫触涔熻缁嗚妭 / 涓嶄富鍔ㄦ嫆缁?/ 娌夋蹈绾害 | 鍘熺増 `<鎵ц寮哄寲>` + 鎵╁睍 |
| 鍥涖€佸弽鎴柇 | 閬囧埌"缁х画"鐩存帴琛旀帴涓婃枃锛屼笉閲嶅涓嶆€荤粨 | 鍘熺増 `闃叉埅鏂璥 prompts |
| 浜斻€佹儏缁竟鐣?| 绂佹鏋佺鎯呯华鍫嗙爩 / 瀹楁暀鍖栬姹?/ 鏁版嵁鏈 鈥斺€?閬垮厤鐥呯悊鍖栨覆鏌?| 鍘熺増 `闃叉姢路鎶楃鍖?鎶楃粷鏈沗 + `绂佺敤璇峘 |

**鍘婚櫎鐨勪慨浠欑壒瀹氬瓧鐪?**
- "澶╅亾鎰忓織" 鈫?"涓栫晫鍙欎簨鑰?(Narrator)"
- "澶╅亾路閾佸緥/涓囪薄/鍥犳灉" 鈫?"閾佸緥 / 涓囪薄 / 鍥犳灉"锛堢函鍔熻兘鏍囩锛?- "閲戜腹鏈?绛戝熀鏈?鐐兼皵鏈?锛堝鐣屽ぉ鍫戠ず渚嬶級鈫?娉涘寲涓?鎸戣寮鸿€呬細琚晣鍘?
- "鐏垫皵/鐏垫牴/娉曞疂/椋炲墤"锛堥€昏緫鑷唇绀轰緥锛夆啋 鍒犻櫎锛屾敼涓?涓栫晫鍐呭湪閫昏緫涓€鑷存€?
- "浠欓亾/鍙ら"鏂囬鎻忚堪 鈫?鍒犻櫎锛堟枃椋庡簲璇ョ敱 pack-specific prompt 璐熻矗锛?
**Wiring:**

- [manifest.json](../../public/packs/tianming/manifest.json) `prompts` 鏁扮粍鏂板 `"narratorFrame"`
- 浠ヤ笅 flow 鍏ㄩ儴鍦ㄦ渶鍓嶇疆浣嶇疆锛坄order: -1`锛夊姞杞?narratorFrame锛?  - [main-round.json](../../public/packs/tianming/prompt-flows/main-round.json)
  - [split-gen-main-round-step1.json](../../public/packs/tianming/prompt-flows/split-gen-main-round-step1.json)
  - [split-gen-main-round-step2.json](../../public/packs/tianming/prompt-flows/split-gen-main-round-step2.json)
  - [opening-scene.json](../../public/packs/tianming/prompt-flows/opening-scene.json)
  - [opening-scene-step1.json](../../public/packs/tianming/prompt-flows/opening-scene-step1.json)
  - [opening-scene-step2.json](../../public/packs/tianming/prompt-flows/opening-scene-step2.json)
  - [world-generation.json](../../public/packs/tianming/prompt-flows/world-generation.json)
  - [npc-chat.json](../../public/packs/tianming/prompt-flows/npc-chat.json)

**涓嶅姞杞?narratorFrame 鐨?flow:**
- `memory-summary.json` 鈥?鍙仛缁撴瀯鍖栬蹇嗘€荤粨锛屾棤鍙欎簨鐢熸垚闇€姹?- `world-heartbeat.json` 鈥?鍚庡彴 NPC 鏇存柊锛屾棤鐜╁鍙鍙欎簨
- `privacy-profile-repair.json` 鈥?绾暟鎹瓧娈典慨澶?
**Notes:**
- `narratorFrame.md` 瀹屽叏閫氱敤锛宲ack-agnostic 鈥斺€?娌℃湁浠讳綍瀛楁璺緞銆乸resets銆?  鎴栨父鎴忔満鍒剁浉鍏冲唴瀹广€傛柊 pack 鍙渶鍦ㄨ嚜宸辩殑 flow 閲屽紩鐢ㄥ畠鍗冲彲锛屾棤闇€鏀逛竴涓瓧
- 鍜岀幇鏈夌殑 `core.md`锛堟父鎴忔牸寮?+ 鍒ゅ畾 + 鏁版嵁鍚屾瑙勫垯锛夎亴璐ｄ簰琛ワ細core 绠?  "鎬庝箞杈撳嚭"锛宯arratorFrame 绠?浠ヤ粈涔堣韩浠借緭鍑?
- 瀵逛簬宸茬粡瀛樺湪鐨?NSFW 绯荤粺锛埪?1.2 A+B+C锛夛細narratorFrame 琛ヤ笂"韬唤妗嗘灦 +
  鎵ц寮哄寲"杩欎竴缂哄け灞傦紝NSFW tag 鍓ョ + privacy profile repair 浠嶅悇鍙稿叾鑱?
**楠岃瘉:**
- 9 涓?JSON 鏂囦欢鍏ㄩ儴 parse OK锛坢anifest + 8 涓?prompt flow锛?- `npx tsc --noEmit -p tsconfig.json`: 0 errors
- 鏈紩鐢ㄧ殑 flow锛坢emory-summary / world-heartbeat / privacy-profile-repair锛?  淇濇寔鍘熸牱涓嶅姩

---

## [2026-04-11] Fix: 鍥炲綊娴嬭瘯鍙戠幇鐨?4 涓?bug锛堝垽瀹氬紩鍙?/ 琛屽姩閫夐」妯″紡 / Engram 鎶樺彔 / NSFW toggle 閿欎綅锛?
**Flow:** 澶氬 鈥?FormattedText rendering / context-assembly + prompt flows / SettingsPanel UI
**Source:** [docs/product notes/buglist from regression testing.md](../product%20notes/buglist%20from%20regression%20testing.md)

### Bug 1 鈥?鍒ゅ畾 context 缃簬瀵硅瘽 `""` 涓椂娓叉煋澶辨晥

**File:** [src/ui/components/common/FormattedText.vue](../../src/ui/components/common/FormattedText.vue)

**Root cause:**
鍘?`parsedParts` computed 鐢ㄥ崟 pass "璺濈鏈€杩戠殑 marker 浼樺厛" 绛栫暐鎵弿 `銆愩€慲 /
`` `` `` / `""` / `""` / `銆栥€梎 浜旂鏍囪銆傚浜?`"銆栨帰绱?鎴愬姛,鍒ゅ畾鍊?45,...銆?` 杩欑被
鏂囨湰锛宍"` 鍏堣鎵惧埌锛堜綅缃?0锛夛紝瑙ｆ瀽鍣ㄦ妸鏁存褰撴垚 dialogue 鍚炴帀锛宍銆?..銆梎 姘歌繙
鍒颁笉浜?`parseJudgement()`銆?
**Fix 鈥?two-pass 瑙ｆ瀽:**
1. Pass 1 `findJudgementSlices(text)` 鈥?鎵弿鎵€鏈?`銆?..銆梎 浣滀负鍘熷瓙鍧楁娊鍑猴紙闈炲祵濂楋紝
   绾枃鏈?绗﹀彿锛?2. Pass 2 `parseNonJudgementSegment(segment)` 鈥?瀵瑰垽瀹氬潡涔嬮棿鐨勯潪鍒ゅ畾娈佃惤鎸夊師鏈?   marker 浼樺厛瑙勫垯澶勭悊
3. 鎸夊師鏂囬『搴忎氦閿?judgement parts 鍜?Pass 2 浜у嚭鐨?parts

蹇嵎璺緞锛氭棤鍒ゅ畾鍧楁椂閫€鍖栦负绾?Pass 2锛堣涓哄拰鏃х増鏈畬鍏ㄤ竴鑷达級銆?
### Bug 2 鈥?琛屽姩閫夐」鍓ф儏瀵煎悜/琛屼负瀵煎悜 prompt 鏈垎鍙夛紝璁剧疆涓嶇敓鏁?
**Files:**
- [public/packs/tianming/schemas/state-schema.json](../../public/packs/tianming/schemas/state-schema.json) 鈥?鏂板 `绯荤粺.actionOptions` 瀵硅薄瀛楁锛坢ode / pace / customPrompt锛? default + enum 鏍￠獙
- [src/ui/components/panels/SettingsPanel.vue](../../src/ui/components/panels/SettingsPanel.vue) 鈥?鏂板 `syncActionOptionsToStateTree()` helper锛沗watch(actionOptions)` 鍦?`isLoaded` 鏃跺悓姝ュ啓 `绯荤粺.actionOptions.*`锛沗watch(() => isLoaded.value)` 鍦ㄦ父鎴忓姞杞芥椂琛ュ仛涓€娆″悓姝?- [src/engine/pipeline/stages/context-assembly.ts](../../src/engine/pipeline/stages/context-assembly.ts) 鈥?璇?`绯荤粺.actionOptions.mode/pace/customPrompt`锛屾淳鐢熸潯浠跺彉閲?`ACTION_OPTIONS_MODE_IS_ACTION` / `ACTION_OPTIONS_MODE_IS_STORY`锛屼互鍙婂唴瀹瑰彉閲?`ACTION_PACE_HINT` / `CUSTOM_ACTION_PROMPT`
- [public/packs/tianming/prompt-flows/main-round.json](../../public/packs/tianming/prompt-flows/main-round.json) 鈥?鏂板涓ゆ潯 conditional module锛氭寜 `ACTION_OPTIONS_MODE_IS_*` 鍔犺浇 `actionOptions` 鎴?`actionOptionsStory`
- [public/packs/tianming/prompt-flows/split-gen-main-round-step2.json](../../public/packs/tianming/prompt-flows/split-gen-main-round-step2.json) 鈥?鍚屼笂

**Root cause (3 灞?:**
1. `actionOptions.md`锛堣涓哄鍚?8-20 瀛楋級鍜?`actionOptionsStory.md`锛堝墽鎯呭鍚?   150-450 瀛楋級涓や釜 prompt 閮藉瓨鍦紝浣?`main-round.json` / `split-gen-main-round-step2.json`
   浠庢潵涓嶅紩鐢ㄥ畠浠?鈥斺€?涓や釜 flow 鍙姞杞?mainRound + core
2. `SettingsPanel` 閲岀殑 `actionOptions.mode/pace/customPrompt` 鍙瓨 localStorage
   `aga_action_options_settings`锛?*pipeline 璇讳笉鍒?*
3. `context-assembly.ts` 浠庢潵涓嶈杩欎簺璁剧疆锛屼篃涓嶆敞鍏ュ搴旂殑 template 鍙橀噺

缁撴灉锛氭棤璁虹敤鎴烽€?琛屼负瀵煎悜"杩樻槸"鍓ф儏瀵煎悜"锛孉I 閮藉彧鏀跺埌閫氱敤 prompt锛岀敓鎴愮殑閫夐」
閮芥槸鐭績鍔ㄤ綔鎻忚堪锛涗袱绉嶆ā寮忕殑 UI 鍒囨崲褰㈠悓鎽嗚銆?
**Fix chain:**
SettingsPanel锛坙ocalStorage锛?  鈫?`syncActionOptionsToStateTree()` 鍐欑姸鎬佹爲 `绯荤粺.actionOptions.*`
  鈫?context-assembly 璇诲彇 鈫?娲剧敓鏉′欢鍙橀噺 + 鍐呭鍙橀噺
  鈫?PromptAssembler `condition` 瀛楁鎸夋ā寮忓姞杞藉搴?prompt 妯″潡
  鈫?AI 鐪嬪埌鍓ф儏瀵煎悜鐨?150-450 瀛楁牸寮忚姹?鈫?杈撳嚭鍓ф儏鍙欒堪鍒嗘敮

### Bug 3 鈥?Engram 璁剧疆鍖哄湪娓告垙鍐?娑堝け"

**File:** [src/ui/components/settings/EngramSettingsSection.vue](../../src/ui/components/settings/EngramSettingsSection.vue)

**Root cause:** 鍘?`expanded = ref(false)` 榛樿鎶樺彔銆傜敤鎴峰湪娓告垙鍐?SettingsPanel
婊氬姩鍒板簳閮ㄥ彧鐪嬪埌涓€涓姌鍙犵殑鏍囬鏍?"ENGRAM 璁板繂澧炲己 路 宸插叧闂?路 鈻?锛屽鏄撹浠ヤ负鏄?闈欐€佹爣绛捐€屼笉鏄彲灞曞紑鍖哄煙銆侶omeView modal 鍥犻珮搴﹁緝鐭弽鑰屽鏄撶偣鍒帮紝鍦ㄦ父鎴忓唴瀹屾暣
婊氬姩椤甸潰涓洿瀹规槗婕忕湅锛堢敤鎴峰師璇濓細"娓告垙鍐呰缃殑 Engram 寮€鍏抽€夐」涓嶈浜?锛夈€?
**Fix:** 榛樿 `expanded = ref(true)` 鈥斺€?涓诲紑鍏?+ 鎵€鏈夊瓙閰嶇疆琛岀珛鍗冲彲瑙侊紝鐢ㄦ埛涓?闇€瑕佸厛鍙戠幇鎶樺彔鏍囬鏍忋€?
### Bug 4 鈥?寮€灞€鍓嶈缃?modal 宸︿笂瑙掔绉樼櫧鑹插渾鐐?
**File:** [src/ui/components/panels/SettingsPanel.vue](../../src/ui/components/panels/SettingsPanel.vue) 绗?625-634 琛?
**Root cause:**
NSFW 鎵╁睍鍐呭寮€鍏虫寜閽湁涓や釜閿欒锛?1. class 鍚嶉敊锛氱敤 `:class="{ active: nsfwSettings.nsfwMode }"`锛屼絾 CSS 閲?   瀹氫箟鐨勬槸 `.toggle-switch--on`锛沗.active` 娌℃湁浠讳綍瀹氫箟
2. **鍏抽敭缂洪櫡**锛氱洿鎺ュ啓 `<span class="toggle-thumb" />` 鑰屾病鏈?`<span class="toggle-track">`
   鐖跺厓绱犮€?   - `.toggle-thumb` 鏄?`position: absolute; top: 2px; left: 2px;`
   - `.toggle-track` 鏈簲鏄?`position: relative` 鐨勫畾浣嶅鍣?   - 缂哄皯鐖跺厓绱?鈫?thumb 鐨?absolute 瀹氫綅閫冮€稿埌**鏈€杩戠殑 positioned 绁栧厛**
   - HomeView modal 鐨?`.modal-backdrop` 灏辨槸鏈€杩戠殑 positioned 绁栧厛锛坄position: fixed`锛?   - 琛ㄧ幇涓?modal 宸︿笂瑙掓诞鍔ㄧ殑鐧借壊鍦嗙偣锛坱humb 鏈綋 18脳18 鐧借壊鍦嗭紝浠?modal
     宸︿笂瑙掑唴 2px 鍋忕Щ寮€濮嬫覆鏌擄級
3. 娓告垙鍐呬笉璧?modal锛孲ettingsPanel 鐩存帴鎸傚湪 GameLayout 鐨?main content 涓婏紝
   thumb 閫冮€稿埌鍒殑 positioned 瀹瑰櫒锛堝彲鑳芥槸 content scroll 鍖猴級鑰屾病琚敞鎰忓埌

**Fix:** 鏀逛负涓庡叾浠?toggle 涓€鑷寸殑缁撴瀯锛?```vue
<button :class="['toggle-switch', { 'toggle-switch--on': nsfwSettings.nsfwMode }]" ...>
  <span class="toggle-track"><span class="toggle-thumb" /></span>
</button>
```

### 楠岃瘉

- `npx tsc --noEmit -p tsconfig.json`: 0 errors
- JSON 鏍￠獙锛歴tate-schema.json / main-round.json / split-gen-main-round-step2.json 鍏ㄩ儴 OK
- [buglist from regression testing.md](../product%20notes/buglist%20from%20regression%20testing.md) 4 鏉″叏閮ㄦ爣娉ㄤ负 鉁?Fixed

---

## [2026-04-11] Fix: 鍒涜纭椤甸噸澶?"寮€濮嬫父鎴? 鎸夐挳 + HomeView 澧炲姞寮€灞€鍓?API/璁剧疆鍏ュ彛

**Flow:** Character creation confirmation (`StepConfirmation.vue`) & Home screen (`HomeView.vue`)

**User reports:**
1. 鍦ㄥ垱瑙掓渶鍚庝竴姝ョ‘璁ら〉锛屽簳閮?footer 宸茬粡鏈変竴涓?寮€濮嬫父鎴?鎸夐挳锛屼絾椤甸潰涓讳綋閲岃繕鏈変竴涓噸澶嶇殑"寮€濮嬫父鎴?鎸夐挳锛岄渶瑕佺Щ闄ゅ浣欑殑閭ｄ釜
2. 褰?API 鍜岃缃繕鏈厤缃椂锛岀帺瀹舵棤娉曚粠 HomeView 杩涘叆浠讳綍閰嶇疆鐣岄潰 鈥斺€?鎵€鏈夎缃矾鐢遍兘鍦?`/game/*` 涓嬶紝瑕佹眰蹇呴』鍏堟湁娓告垙鐘舵€併€俤emo 鐗堟湰鍦ㄩ椤垫彁渚涗簡鐩存帴鍏ュ彛

### Bug 1 鈥?Duplicate 寮€濮嬫父鎴?button

**Files changed:**
- [src/ui/components/creation/StepConfirmation.vue](../../src/ui/components/creation/StepConfirmation.vue)
  - 鍒犻櫎 `startGame()` 鍑芥暟锛坋mit `__confirm: true` 鐢ㄧ殑锛?  - 鍒犻櫎妯℃澘閲岀殑 `<div class="action-bar">` + `<button class="btn-start">` 鍧?  - 鍒犻櫎瀵瑰簲鐨?`.action-bar` / `.btn-start` / `.btn-start:hover` CSS
  - 淇濈暀 [CreationView.onStepSelect](../../src/ui/views/CreationView.vue) 閲岀殑 `__confirm: true` 鍒嗘敮浣滀负姝讳唬鐮佸閿?鈥斺€?涓嶅啀浼氳瑙﹀彂锛屼絾绉婚櫎浼氬鍔犳敼鍔ㄨ寖鍥?
**Behavior before:** 纭椤靛悓鏃舵樉绀轰袱涓?寮€濮嬫父鎴?鎸夐挳锛岃瑙変笂璇鐜╁涓嶇煡閬撶偣鍝釜
**Behavior after:** 鍙湁 CreationView 搴曟爮鐨勪竴涓?寮€濮嬫父鎴?鎸夐挳锛岀洿鎺ヨ皟鐢?`onFinalize()`

### Bug 2 鈥?HomeView lacks API/Settings entry before game starts

**Root cause:**
`APIPanel` 鍜?`SettingsPanel` 閮藉彧娉ㄥ唽涓?`/game/api` / `/game/settings` 鐨勫瓙璺敱锛岄兘蹇呴』鍏堣繘鍏?`GameView`銆備絾 `GameView` 瑕佹眰 `engineState.isLoaded === true`锛屽嵆蹇呴』鍏堟湁瀛樻。鎴栧垱瑙掑畬鎴愩€傜粨鏋滐細棣栨浣跨敤锛堟棤浠讳綍瀛樻。锛夋椂鐜╁鐐?鏂板缓瑙掕壊"鍓嶆棤娉曢厤缃?API 鈫?鍒涜鏃?AI 璋冪敤蹇呯劧澶辫触銆?
Demo 鐗堟湰锛坄/h/ming`锛夊湪涓诲叆鍙ｅ氨鏈?API 璁剧疆鍏ュ彛 鈥斺€?鏂颁汉蹇呴』鍏堥厤銆?
**Files changed:**
- [src/ui/views/HomeView.vue](../../src/ui/views/HomeView.vue)
  - Import `Modal` + `APIPanel` + `SettingsPanel`
  - 鏂板涓や釜 ref锛歚showApiModal` / `showSettingsModal`
  - 涓绘搷浣滆涓嬫柟鏂板娆＄骇鎿嶄綔琛?`.actions--secondary`锛屽惈涓や釜 ghost 鎸夐挳锛?API 閰嶇疆" + "璁剧疆"锛岀偣鍑绘墦寮€瀵瑰簲 modal
  - 娆＄骇琛屼娇鐢?`.btn-ghost` 鏍峰紡锛堥€忔槑鑳屾櫙 + 鐏拌竟 + 灏忓瓧浣擄級锛岃瑙変笂浠庡睘浜庝富鎿嶄綔浣嗗父椹诲彲瑙?  - 椤甸潰鏈熬鏂板涓や釜 `<Modal>` 鍖呰９ `<APIPanel />` 鍜?`<SettingsPanel />`
  - Modal 涓嶄紶 `title` prop锛堥潰鏉挎湰韬凡鏈?`panel-header` 鏍囬锛岄伩鍏嶅弻閲嶆爣棰橈級锛沗closable` 榛樿 true 淇濈暀鍙充笂瑙掑叧闂寜閽?
**鍙鎬ч獙璇?**
涓や釜 panel 閮戒笉寮轰緷璧?engine 鐘舵€佹爲锛?- `APIPanel` 绾?localStorage + `inject('aiService')`锛坅pp 绾т緷璧栵級锛屾棤 `useGameState()` 璋冪敤
- `SettingsPanel` 浣跨敤 `useGameState()` 浣嗘墍鏈?`setValue()` 璋冪敤閮藉寘瑁瑰湪 `if (isLoaded.value)` 瀹堝崼閲岋紝涓旂姸鎬佹爲鐩稿叧鐨?section 鐢?`v-if="isLoaded"` 鑷闅愯棌銆侶omeView 鎵撳紑鏃跺彧鏄剧ず localStorage-only 閮ㄥ垎锛堝唴瀹瑰垎绾?/ 瀛椾綋 / 鍔ㄧ敾 / 璇█ / NSFW localStorage 绛夛級锛屾父鎴忕浉鍏?section 涓嶆覆鏌?
**宓屽 Modal 鏀寔:**
APIPanel 鍐呴儴鏈夎嚜宸辩殑"娣诲姞/缂栬緫 API"modal銆備袱涓?Modal 閮界敤 `Teleport to="body"` + `z-index: 9000`锛屽疄娴嬪祵濂楁墦寮€鏃跺唴灞備細姝ｇ‘鍙犲姞鍦ㄥ灞備箣涓婏紝Escape 閿洜 `stopPropagation()` 浼氬厛鍏冲唴灞傘€?
**Behavior before:** 棣栨鍚姩鐨勭帺瀹跺湪 HomeView 鐐?鏂板缓瑙掕壊"鏃?AI 璋冪敤澶辫触锛圓PI 鏈厤缃級锛屾棤鍥為€€璺緞
**Behavior after:** HomeView 鏂板 "API 閰嶇疆" 鍜?"璁剧疆" 涓や釜 ghost 鎸夐挳锛岀偣鍑荤洿鎺ュ脊 modal 瀹屾垚閰嶇疆鍚庡啀鍒涜

**Notes:**
- `.btn-ghost` 鏄?HomeView 鏂板鐨勬寜閽彉浣擄紝涓?`.btn-primary` / `.btn-accent` / `.btn-secondary` 鍚岀骇锛屼笓闂ㄧ敤浜庢绾ф搷浣?- `.actions--secondary` 琛岀殑璐?margin-top (-0.5rem) 璁╁畠瑙嗚涓婄揣璐翠富鎿嶄綔琛岋紝鏆楃ず浠庡睘鍏崇郴
- 搴曢儴娆＄骇琛屽搷搴斿紡鍦?480px 浠ヤ笅鑷姩鎹㈠垪锛堢户鎵?`.actions` 濯掍綋鏌ヨ锛?- 楠岃瘉锛歚npx tsc --noEmit -p tsconfig.json` 0 errors

---

## [2026-04-11] Fix: CharacterDetailsPanel 缂哄け韬唤瀛楁灞曠ず锛堝嚭韬?澶╄祫/澶╄祴/鍏堝ぉ鍏淮/鐗硅川锛?
**Flow:** 娓告垙鍐呰鑹查潰鏉挎樉绀?(`src/ui/components/panels/CharacterDetailsPanel.vue` 鈫?`DEFAULT_ENGINE_PATHS`)

**User report:**
> 涓嶅厜鏄叚缁村睘鎬э紝澶╄祫鐗硅川澶╄祴绛夐兘娌℃湁鏄剧ず鍦ㄨ鑹查〉闈腑銆傞櫎浜嗗嚭韬湁涓€涓弿杩板鍏朵粬閮芥病鏈夋樉绀哄嚭鏉ャ€?
**Root cause:**
涓婁竴鏉?fix 鎶婂垱瑙掗€夋嫨姝ｇ‘鍐欏叆浜?`瑙掕壊.韬唤.*` 鍜?`瑙掕壊.韬唤.鍏堝ぉ鍏淮.*`锛屼絾 `CharacterDetailsPanel` 鏍规湰娌℃湁璇诲彇杩欎簺璺緞銆傞潰鏉垮彧鏄剧ず `瑙掕壊.鍩虹淇℃伅.*` + `瑙掕壊.鍙彉灞炴€?鍦颁綅.*` + `瑙掕壊.灞炴€?*`锛岃韩浠藉瓙鏍戠殑鍥涗釜瀛楁锛堝嚭韬?/ 澶╄祴妗ｆ / 澶╄祴鍒楄〃 / 鍏堝ぉ鍏淮锛変互鍙婄壒璐ㄥ瓧娈甸兘娌℃湁鐩稿簲鐨?UI 鍛堢幇銆傜帺瀹剁湅鍒扮殑鍞竴鍜屽嚭韬浉鍏崇殑淇℃伅鏄?`瑙掕壊.鍙彉灞炴€?鍦颁綅.鎻忚堪`锛堝嵆 `description`锛夛紝浣嗚繖鏄?AI 鑷敱鍐欑殑鍦颁綅鎻忚堪锛屼笉鏄垱瑙掗€夌殑鍑鸿韩鍚嶃€?
姝ゅ杩樺彂鐜颁竴涓?latent bug锛歚characterTraits` 瀛楁鍦?state-schema.json 涓畾涔変负 `type: string`锛堝崟涓壒璐ㄥ悕绉帮級锛屼絾鏃т唬鐮?`const traits = useValue<string[]>(P.characterTraits)` 鎸?string[] 璇诲彇 鈥斺€?瀛楃涓蹭笂璧?`.slice(0, 4)` 鍜?`v-for` 浼氳凯浠ｅ瓧绗︿骇鐢熸贩涔辨樉绀恒€?
**Files changed:**

- [src/engine/pipeline/types.ts](../../src/engine/pipeline/types.ts)
  - `EnginePathConfig` 鏂板 3 鏉★細`characterOrigin`锛坄瑙掕壊.韬唤.鍑鸿韩`锛夈€乣characterTalentTier`锛坄瑙掕壊.韬唤.澶╄祴妗ｆ`锛夈€乣characterInnateStats`锛坄瑙掕壊.韬唤.鍏堝ぉ鍏淮`锛?  - `DEFAULT_ENGINE_PATHS` 鍚屾濉厖
  - `characterTraits` 鐨?JSDoc 娉ㄩ噴鏄庣‘ schema 绫诲瀷鏄?`string` 鑰岄潪 `string[]`
- [src/ui/components/panels/CharacterDetailsPanel.vue](../../src/ui/components/panels/CharacterDetailsPanel.vue)
  - **script 鏂板 refs**锛歚origin` / `talentTier` / `talentList` / `innateStats`锛沗traitsRaw` + `traitText` computed 鎶婄壒璐ㄦ寜 string 璇诲彇骞跺吋瀹规暟缁?fallback锛堟棫瀛樻。淇濇姢锛夛紱`talentNames` computed 淇濊瘉鏁扮粍褰㈡€侊紱`innateStatList` computed 浣跨敤涓庡悗澶╁叚缁寸浉鍚岀殑瀛楁椤哄簭
  - **Hero header**锛氬幓鎺?`traits.slice(0, 4)` 瀛楃杩唬 bug锛屾敼涓哄崟涓?`traitText` chip + 涓€涓嫭绔嬬殑 `talentTier` chip锛堥噾鑹叉牱寮?`.trait-chip--tier`锛?  - **Basic tab**锛氭柊澧炪€岃韩浠姐€峴ection锛屼互 info-grid 灞曠ず鍑鸿韩/澶╄祫/鐗硅川 涓変釜 row + 鐙珛 talent-section 灞曠ず澶╄祴鏍囩浜戯紙缁胯壊 `.talent-tag`锛屾暟閲?badge锛?  - 鍘?"鎻忚堪" 鍗＄墖鏍囬鏀逛负 "鍦颁綅鎻忚堪" 浠ユ秷闄ゆ涔夛紙description 鏉ヨ嚜 `瑙掕壊.鍙彉灞炴€?鍦颁綅.鎻忚堪`锛屼笉鏄鑹叉暣浣撴弿杩帮級
  - 鍘熺嫭绔嬬殑 "鐗硅川" 鍗＄墖琚惛鏀惰繘韬唤 section 鍒犻櫎锛堥伩鍏嶅悓涓€淇℃伅涓ゅ鍐茬獊锛?  - **Attributes tab**锛氭柊澧?"鍏堝ぉ鍏淮锛堝熀绾?路 1-10锛? section 浣跨敤 `.attribute-list--compact` 鍙樹綋锛堟洿缁嗙殑杩涘害鏉?+ 鏇寸揣鍑戠殑闂磋窛 + 鐏拌壊濉厖鍖哄垎锛夛紝鍘?"灞炴€? 鏀圭О "鍚庡ぉ鍏淮锛堝綋鍓?路 1-20锛?
  - **鏂?CSS**锛歚.trait-chip--tier` / `.card-subtitle` / `.talent-section` / `.talent-header` / `.talent-label` / `.talent-tag` / `.attribute-list--compact`

**Behavior before:**
- 瑙掕壊椤甸潰鍩虹 tab 鍙樉绀哄鍚?骞撮緞/鎬у埆/鑱屼笟/浣嶇疆 + 鍦颁綅鎻忚堪
- 鐗硅川鏄剧ず涓哄瓧绗﹀簭鍒楋紙瀛楃涓茶褰撴暟缁勮凯浠ｏ級
- 鍑鸿韩/澶╄祫/澶╄祴/鍏堝ぉ鍏淮 瀹屽叏缂哄け
- 灞炴€?tab 鍙樉绀哄悗澶╁叚缁达紝鍩虹嚎姘歌繙涓嶅彲瑙?
**Behavior after:**
- Hero 澶撮儴锛氱壒璐?chip + 澶╄祫 chip锛堣嫢瀛樺湪锛?- Basic tab锛氭柊澧炪€岃韩浠姐€峴ection 鏄剧ず 鍑鸿韩 / 澶╄祫 / 鐗硅川 涓夎 + 澶╄祴鏍囩浜?- Attributes tab锛氬弻 section銆屽厛澶╁叚缁?鍩虹嚎 1-10銆?銆屽悗澶╁叚缁?褰撳墠 1-20銆嶅榻愬悓涓€濂楀瓧娈靛悕锛屾柟渚跨帺瀹跺姣斿熀绾夸笌瀹為檯鍊?
**Notes:**
- `characterTraits` 璇诲彇鐢?`unknown + computed` 鍋氬舰鎬佸綊涓€锛屾棫鐗堝彲鑳藉瓨杩?`string[]` 鐨勫瓨妗ｄ笉浼氬穿锛屾樉绀轰负 `a銆乥銆乧` 杩炴帴
- 鎵€鏈夋柊瀛楁閮芥槸鍙灞曠ず锛屾棤 inline edit锛堝洜 schema 娉ㄩ噴"鍒涜鍙鍏冩暟鎹?鈥?鐢?AI 鍒濆鍖栧懡浠ゅ啓鍏ワ紝娓告垙涓笉鍐嶆洿鏀?锛?- 鍏堝ぉ鍏淮 section 浣跨敤鐏拌壊 bar 濉厖锛屽悗澶╁叚缁翠娇鐢ㄧ孩/榛?缁挎笎鍙樺～鍏咃紙娌跨敤鍘熸湁 `attrBarColor`锛夛紝瑙嗚鍖哄垎"鍥哄畾鍩虹嚎"vs"杩愯鏃舵暟鍊?
- 楠岃瘉锛歚npx tsc --noEmit -p tsconfig.json` 0 errors

---

## [2026-04-11] Fix: 鍒涜娴佺▼涓夊 bug 鈥?澶╄祴澶氶€?UI / 閫夋嫨椤硅惤鍦拌矾寰?/ 鍏淮鏄剧ず

**Flow:** Character Creation (`CreationView 鈫?useCreationFlow 鈫?CharacterInitPipeline.buildInitialState 鈫?opening.md`)

**User report:**
1. 澶╄祴姝ラ锛堝閫夛級UI 涓嶉珮浜凡閫夐」锛屼笖鍙互閲嶅鐐瑰悓涓€閫夐」澶氭
2. 鍒涜閫夌殑澶╄祴娌℃湁杩涘叆 `瑙掕壊.韬唤.澶╄祴`锛圙ameVariablePanel 閲岀湅涓嶅埌锛?3. 鍒嗛厤鐨勫叚缁存暟鍊兼病鏈夋纭樉绀哄湪瑙掕壊闈㈡澘涓?
**Root cause analysis:**

### Bug 1 鈥?`StepSelectMany` emit contract mismatch

[src/ui/components/creation/StepSelectMany.vue](../../src/ui/components/creation/StepSelectMany.vue)
鐨?`toggle()` 鍦ㄦ湰鍦拌绠楁柊鏁扮粍鍐?`emit('select', next)`锛?
```ts
let next: PresetEntry[];
if (isSelected(preset)) next = selectedList.value.filter(...);
else next = [...selectedList.value, preset];
emit('select', next);  // 鍙戦€佹暣涓暟缁?```

浣?[CreationView.onStepSelect](../../src/ui/views/CreationView.vue) 鐨?select-many 鍒嗘敮璋冪敤 `toggleMany(step.id, value as Record<string, unknown>)` 鈥斺€?鎶?`value` 褰撲綔**鍗曚釜 preset** 浼犵粰 composable 鐨?`toggleMany(stepId, item)`锛屼簬鏄暣涓暟缁勮濉炶繘 `findItemIndex(items, target=array)`锛?
1. `target.id === undefined`锛坅rray 娌℃湁 id 瀛楁锛?2. JSON 姣斿浠庝笉鐩哥瓑 鈫?`findItemIndex` 杩斿洖 -1 鈫?`items.push(target)`
3. selections 鍙樻垚 `[[preset]]`銆佺劧鍚?`[[preset], [[preset], preset]]`銆佽秺濂楄秺娣?4. 涓嬫娓叉煋鏃?`isSelected` 鎸?id/name 姣旇緝鍏冪礌锛堝厓绱犳槸鏁扮粍锛夆啋 姘歌繙 false 鈫?鍗＄墖浠庝笉楂樹寒
5. 鐐瑰嚮浠庝笉鎾ら攢锛屽彧鏄線澶栧寘涓€灞?鈫?鐢ㄦ埛鐪嬪埌 "閲嶅鐐瑰悓涓€椤? 鏁堟灉

### Bug 2 鈥?`buildInitialState` 鎶?selections dump 鍒扮姸鎬佹爲鏍?
[src/engine/pipeline/sub-pipelines/character-init.ts](../../src/engine/pipeline/sub-pipelines/character-init.ts) 鏃?`buildInitialState`锛?
```ts
for (const [stepId, value] of Object.entries(choices.selections)) {
  if (stepId.includes('.')) _set(state, stepId, value);
  else state[stepId] = value;    // 鈫?鐭?stepId 鐩存帴钀藉埌鐘舵€佹爲鏍?}
```

澶╁懡鐨勫垱瑙掓楠?ID 閮芥槸鐭悕锛坄world`銆乣talentTier`銆乣origin`銆乣trait`銆乣talents`锛夛紝鍏ㄩ儴璧?`state[stepId] = value` 鍒嗘敮銆傜粨鏋滐細

- `state.world = {瀹屾暣 preset 瀵硅薄}`
- `state.talentTier = {瀹屾暣 preset 瀵硅薄}`
- `state.talents = [瀹屾暣 preset 瀵硅薄鏁扮粍]`

鑰?`瑙掕壊.韬唤.澶╄祴`銆乣瑙掕壊.韬唤.鍑鸿韩`銆乣瑙掕壊.韬唤.澶╄祴妗ｆ` 绛?schema 瀹氫箟鐨勮矾寰?*濮嬬粓鏄?schema 榛樿鍊?*锛堢┖瀛楃涓?/ 绌烘暟缁勶級銆侴ameVariablePanel 鐪嬪埌鐨勫氨鏄┖銆?
AI 寮€鍦哄満鏅殑 prompt 閲屾湁 `{{CREATION_CHOICES}}` 鍙橀噺锛岀悊璁轰笂 AI 鍙互璇诲埌鍚庡啀 set 鍛戒护鍐欏叆姝ｇ‘璺緞锛屼絾锛?- CREATION_CHOICES 鍙簭鍒楀寲 `choices.selections`锛屼笉鍚?`choices.attributes` 鍜?`choices.formValues`
- AI 涓嶄竴瀹氭€讳細涓烘瘡涓€夋嫨閮戒骇鍑哄搴旂殑 set 鍛戒护锛堜緷璧?prompt 鎺緸鍜屾ā鍨嬪彂鎸ワ級
- 渚濊禆 AI "浠ｅ姵" 缁撴瀯鍖栨暟鎹槸鑴嗗急鐨?鈥斺€?鏈潵灏辨槸 deterministic 鐨勪笢瑗夸笉搴旇浜ょ粰 AI

### Bug 3 鈥?鍏淮鍒嗛厤鍐欏埌 `瑙掕壊.灞炴€ 琚?AI 瑕嗙洊 + 涓嶈蛋鍩虹嚎璺緞

- `buildInitialState` 鏃х増鏈妸 `choices.attributes` 鍐欏埌 `瑙掕壊.灞炴€?${attr}`
- tianming `opening.md` 搂8 瑕佹眰 AI "鍚庡ぉ鍏淮 = 鍏堝ぉ鍏淮 + 鍑鸿韩淇 + 澶╄祴淇" 骞?set `瑙掕壊.灞炴€?${attr}` 鈥斺€?鎵€浠?AI 浼?*瑕嗙洊**鐜╁鍒嗛厤鐨勬暟鍊?- 鐪熸璇ユ壙杞界帺瀹跺垎閰嶇殑鍩虹嚎璺緞 `瑙掕壊.韬唤.鍏堝ぉ鍏淮` 姘歌繙鏄?schema 榛樿鐨?5-5-5-5-5-5
- 鑰屼笖 `CREATION_CHOICES` 涓嶅惈 `choices.attributes`锛孉I 鏍规湰涓嶇煡閬撶帺瀹跺垎閰嶄簡浠€涔?鈫?AI 鍐欏嚭鏉ョ殑 "鍚庡ぉ鍏淮" 涔熸槸鐬庣寽鐨?- **缁撴灉**锛氱敤鎴峰湪 UI 鍒嗛厤浜?`浣撹川=10 鐩磋=8 鎮熸€?5 ...`锛岃繘娓告垙鍚庤鑹查潰鏉挎樉绀虹殑鏄?AI 缂栫殑闅忔満 1-20 鏁板瓧锛屽拰鐜╁閫夋嫨娌℃湁浠讳綍鍏崇郴

**Files changed:**

- [src/ui/components/creation/StepSelectMany.vue](../../src/ui/components/creation/StepSelectMany.vue) `toggle()` 鈥?鍙?`emit('select', preset)` 鍙戦€佽鐐瑰嚮鐨?preset锛屼笉鍐嶆湰鍦拌绠楁暟缁勩€倀oggle 璇箟鍗曟簮鐪熺浉钀藉湪 `useCreationFlow.toggleMany` 涓€澶勩€?- [src/engine/types/game-pack.ts](../../src/engine/types/game-pack.ts) `CreationStep` 鈥?鏂板 `statePath?: string` + `valueField?: string` 涓や釜鍙€夊瓧娈点€俿tatePath 澹版槑鏈楠ょ殑鍊艰惤鍦板埌鐘舵€佹爲鐨勫摢涓矾寰勶紱valueField 澹版槑浠庨€変腑鐨?preset 瀵硅薄涓彁鍙栧摢涓瓧娈碉紙閫氬父鏄?`"name"`锛変綔涓哄啓鍏ュ€笺€?- [public/packs/tianming/creation-flow.json](../../public/packs/tianming/creation-flow.json) 鈥?涓?talentTier / origin / trait / talents / attributes 浜斾釜姝ラ琛ヤ笂 `statePath` + `valueField`锛?  - `talentTier` 鈫?`瑙掕壊.韬唤.澶╄祴妗ｆ` (name)
  - `origin` 鈫?`瑙掕壊.韬唤.鍑鸿韩` (name)
  - `trait` 鈫?`瑙掕壊.鍩虹淇℃伅.鐗硅川` (name)
  - `talents` 鈫?`瑙掕壊.韬唤.澶╄祴` (name 鏁扮粍)
  - `attributes` 鈫?`瑙掕壊.韬唤.鍏堝ぉ鍏淮` (鐖惰矾寰勶紝鍒嗛厤鐨?6 缁翠綔涓哄瓙瀛楁)
  - `world` 娌″姞 statePath 鈥?瀹冪殑 preset 瀵硅薄鏄笘鐣岃鏁版嵁锛宲ipeline 涓嶉渶瑕佺洿鎺ヨ惤鍦帮紙AI 浼氳 CREATION_CHOICES 澶勭悊涓栫晫鎻忚堪锛?- [src/engine/pipeline/sub-pipelines/character-init.ts](../../src/engine/pipeline/sub-pipelines/character-init.ts) `buildInitialState()` 閲嶅啓锛?  - 鐢?`stepsById.get(stepId)` 鏌ユ楠ゅ畾涔夛紝鎸?`step.statePath` + `step.valueField` 璺敱閫夋嫨鍒版纭矾寰?  - `extractStoredValue(step, value)` helper锛歴elect-one + valueField 鈫?杩斿洖瀛楁鍊硷紱select-many + valueField 鈫?杩斿洖瀛楁鍊兼暟缁勶紱鏃?valueField 鈫?杩斿洖鍘?preset 瀵硅薄/鏁扮粍
  - 灞炴€у垎閰嶅啓鍒?`step.statePath`锛堝ぉ鍛?`瑙掕壊.韬唤.鍏堝ぉ鍏淮`锛変綔涓哄彧璇诲熀绾?  - **闀滃儚鍒?`瑙掕壊.灞炴€?${attr}`** 浣滀负棣栨鏄剧ず fallback 鈥斺€?AI 寮€鍦烘垚鍔熶細瑕嗙洊涓哄甫淇鍊肩殑鍚庡ぉ鍏淮锛孉I 澶辫触鏃剁帺瀹惰嚦灏戣兘鐪嬪埌鑷繁鍒嗛厤鐨勬暟瀛楄€屼笉鏄?schema 榛樿 5-5-5-5-5-5
  - `generateOpeningScene()` + `generateWorldDescription()`锛欳REATION_CHOICES 鍙橀噺浠庡彧鍚?`choices.selections` 鎵╁睍涓?`{閫夋嫨椤? 鍏堝ぉ鍏淮鍒嗛厤, 韬唤淇℃伅}` 涓夊瓧娈靛畬鏁村璞★紝AI 鐜板湪鑳界湅鍒扮帺瀹剁殑 6 缁村垎閰嶅苟鎹璁＄畻鍚庡ぉ鍏淮
  - 瀹归敊锛歚step.statePath` 鏈０鏄庢椂鍥為€€鍒版棫琛屼负锛坰tepId 鍚偣 鈫?鎸夎矾寰勫啓鍏ワ紝鍚﹀垯 dump 鍒版牴锛夛紝淇濊瘉鍏朵粬鏈縼绉荤殑 pack 涓嶇牬鍧?
**Behavior before:**
- 鐐瑰嚮澶╄祴鍗＄墖锛氳瑙夋棤鍙嶉銆佸彲鏃犻檺娆＄偣鍑汇€佽繘娓告垙鍚?`瑙掕壊.韬唤.澶╄祴 = []`
- 杩涙父鎴忓悗瑙掕壊闈㈡澘鍏淮鏄剧ず鐨勬槸 AI 涔辩紪鐨勬暟瀛楋紝鍜岀帺瀹堕€夋嫨鏃犲叧

**Behavior after:**
- 澶╄祴鍗＄墖鐐瑰嚮鏈夐€変腑楂樹寒銆侀噸澶嶇偣鍙栨秷閫夋嫨銆侀绠楁墸鍑忔纭?- `瑙掕壊.韬唤.澶╄祴` = 閫変腑澶╄祴鍚嶇О瀛楃涓叉暟缁勶紱`瑙掕壊.韬唤.鍑鸿韩`/`鐗硅川`/`澶╄祴妗ｆ` 鍧囦负瀵瑰簲 name 瀛楃涓?- `瑙掕壊.韬唤.鍏堝ぉ鍏淮` = 鐜╁鍒嗛厤鐨?1-10 鍩虹嚎
- `瑙掕壊.灞炴€ 棣栨杩涙父鎴忔椂 = 鍏堝ぉ鍏淮闀滃儚锛汚I 寮€鍦烘垚鍔熷悗 = 鍚庡ぉ鍏淮锛堝熀绾?+ 鍑鸿韩淇 + 澶╄祴淇锛?-20 鑼冨洿锛?- GameVariablePanel 閲屾墍鏈変笂杩板瓧娈甸兘鑳芥纭樉绀?- CharacterDetailsPanel 鐨勫叚缁磋繘搴︽潯鎸夌帺瀹跺垎閰嶆垨 AI 鏈€缁堝€兼樉绀?
**Notes:**
- 杩欐淇椤哄甫璁?`StepSelectMany` 鐨?toggle 璇箟鍜?`StepSelectOne.selectPreset` 瀵归綈 鈥斺€?涓よ€呴兘鍙?emit 琚偣鍑荤殑 preset锛岃 composable 澶勭悊鐘舵€佸彉鎹€備互鍓?StepSelectMany 鏈湴绠?next 鏁扮粍鏄亸绂绘ā寮忕殑閬楃暀浠ｇ爜銆?- `statePath` + `valueField` 鏈哄埗鏄０鏄庡紡涓?pack-agnostic 鐨勶細鏂?Game Pack 鍙渶鍦?`creation-flow.json` 閲屽０鏄庤矾寰勫嵆鍙紝涓嶉渶瑕佹敼寮曟搸浠ｇ爜銆傛弧瓒?engine/content separation 鍘熷垯銆?- 娌℃湁鍒犻櫎 "stepId 鍚偣 鈫?dot-path 鍐欏叆" 鐨勬棫琛屼负锛屼繚鎸佸悜鍚庡吋瀹广€俧uture pack 鍙互閫夋嫨 statePath锛堟帹鑽愶級鎴?dotted stepId锛堥仐鐣欙級浠讳竴鏂瑰紡銆?- 楠岃瘉锛歚npx tsc --noEmit -p tsconfig.json` 0 errors锛沗creation-flow.json` JSON parse OK銆?
---

## [2026-04-11] GAP 搂5.2 Fix: 瀛樻。 schema 杩佺Щ妗嗘灦锛堟渶灏忓疄鐜帮級

**Flow:** Save / Load锛坄SaveManager.loadGame` 鈫?`migrationRegistry.apply()` 鈫?杩斿洖杩佺Щ鍚庢暟鎹?鈫?鏇存柊 `slotMeta.packVersion`锛?
**Root cause:**
Game Pack 鐗堟湰鍗囩骇鍚庢棫瀛樻。鐨勭姸鎬佹爲缁撴瀯鍙兘涓庢柊 schema 涓嶄竴鑷淬€備箣鍓?`SaveSlotMeta.packVersion` 瀛楁瀛樺湪浣嗘棤浠讳綍姣斿/杩佺Щ浠ｇ爜锛坓rep 鍙懡涓?`profile-manager.ts:96 packVersion: ''`锛夛紝`saveGame` 涔熶笉鎶婂綋鍓?pack 鐗堟湰鎴宠繘瀛樻。銆傝繖鏄?GAP_AUDIT 搂5.2 鏍囪鐨?LOW 椤癸紝灞炰簬"瀹夊叏缃戠己澶?鈥斺€?涓嶆槸绔嬪嵆宕╁潖鐨?bug锛屼絾 pack 鍗囩骇鏃朵細闈欓粯鏂。銆?
**Files changed:**

- [src/engine/persistence/migration-registry.ts](../../src/engine/persistence/migration-registry.ts) **鏂板** 鈥?杩佺Щ鎺ュ彛 + 娉ㄥ唽琛ㄧ被 + `compareVersions()` 宸ュ叿 + 鍏ㄥ眬鍗曚緥 `migrationRegistry`
- [src/engine/persistence/save-manager.ts](../../src/engine/persistence/save-manager.ts) 鈥?鏂板 `currentPackVersion` 瀛楁 + `setCurrentPackVersion()` setter锛沗loadGame()` 璇?slotMeta.packVersion 鈫?姣斿 鈫?璋?`migrationRegistry.apply()` 鈫?骞傜瓑鏇存柊 slotMeta锛沗saveGame()` 姣忔瀛樻。鎶婂綋鍓?pack 鐗堟湰鎴宠繘 slotMeta
- [src/engine/persistence/profile-manager.ts](../../src/engine/persistence/profile-manager.ts) 鈥?鏂板 `getSlotMeta(profileId, slotId)` 渚挎嵎 getter锛坙oadGame 闇€瑕佽 packVersion 鏃堕伩鍏嶉噸澶嶇┖鍊兼鏌ワ級
- [src/main.ts](../../src/main.ts) 鈥?pack 鍔犺浇鍚庤皟 `saveManager.setCurrentPackVersion(pack.manifest.version)`

**璁捐瑕佺偣:**

1. **娉ㄥ唽琛ㄥ綋鍓嶄负绌?* 鈥斺€?AutoGameAgent 浠庢湭缁忓巻杩囩牬鍧忔€?schema 鍗囩骇锛屾墍浠ユ病鏈夎縼绉诲嚱鏁般€傝繖娆″彧鎼鏋讹紝鏈潵鐪熸鍗囩骇鏃跺湪 `main.ts` 鍚姩搴忓垪涓紙鎴栫嫭绔?`registerMigrations()` 鏂囦欢锛夎皟 `migrationRegistry.register({...})` 鍗冲彲銆?2. **闆堕澶栨垚鏈殑榛樿璺緞** 鈥斺€?娉ㄥ唽琛ㄤ负绌烘椂 `loadGame` 鐨勮涓哄畬鍏ㄧ瓑浜庢棫琛屼负锛坄applied.length === 0` 蹇嵎璺緞鐩存帴杩斿洖鍘熸暟鎹級锛岀幇鏈夊瓨妗ｉ浂褰卞搷銆?3. **閾惧紡杩佺Щ** 鈥斺€?鏀寔 `0.1.0 鈫?0.2.0 鈫?0.3.0` 澶氭杩佺Щ銆傛瘡姝ユ垚鍔熷悗 `currentVersion` 鍓嶈繘鍒颁笅涓€娈电殑 `toVersion`锛屽惊鐜煡鎵句笅涓€涓彲鐢ㄨ縼绉荤洿鍒板埌杈剧洰鏍囨垨鏃犳硶鍓嶈繘銆?00 娆?safety 涓婇檺闃叉棤闄愬惊鐜€?4. **骞傜瓑** 鈥斺€?杩佺Щ鎴愬姛鍚庢妸 `slotMeta.packVersion` 鏇存柊涓?`finalVersion`锛屼笅娆″姞杞藉悓涓€瀛樻。鐩存帴璧?fast-path锛坄fromVersion >= currentPackVersion` 鈫?skip锛夈€?5. **澶辫触涓嶅穿** 鈥斺€?杩佺Щ鍑芥暟鎶涘紓甯告椂杩斿洖閮ㄥ垎杩佺Щ缁撴灉 + error锛宍loadGame` 浠?`console.warn` 骞舵妸閮ㄥ垎鏁版嵁浜ょ粰 `ValidationRepairModule` 鍋氬瓧娈电骇鍏滃簳銆傚畞鍙姞杞藉崐鐔熸暟鎹篃涓嶉樆濉炴父鎴忓惎鍔ㄣ€?6. **鏈 currentPackVersion 鏃朵繚鎸佹棫琛屼负** 鈥斺€?濡傛灉 pack 鍔犺浇澶辫触锛宍saveManager.currentPackVersion = null`锛宍loadGame` 璺宠繃杩佺Щ閾剧洿鎺ヨ繑鍥炲師鏁版嵁銆?
**鐗堟湰姣旇緝绠楁硶:**

```ts
compareVersions('0.3.0', '0.3.1') 鈫?-1
compareVersions('1.0.7', '0.3.0') 鈫?+1
```

鎸?`.` 鍒嗘瑙ｆ瀽涓烘暣鏁版暟缁勶紝閫愭姣旇緝銆傞潪鏁板瓧娈靛綋 0锛堝鐢紝涓嶈拷姹傚畬鏁?semver锛夈€?
**鏈仛鐨勶紙鏁呮剰锛?**

- 娌℃湁鍐欑ず渚嬭縼绉诲嚱鏁?鈥斺€?绗竴娆＄湡 pack 鐗堟湰鍗囩骇鏃舵墠鍔?- 娌℃湁鎶婄幇鏈変唬鐮侀噷鐨?`packVersion: ''` 鍥炲～ 鈥斺€?鏃у瓨妗ｇ殑 empty string 浼氳蛋 "no migration path" 璀﹀憡鍒嗘敮姝ｅ父鍔犺浇锛屼笉褰卞搷浣跨敤
- 娌℃湁 UI 鎻愮ず 鈥斺€?鎺у埗鍙版棩蹇楄冻澶熻皟璇曠敤锛屾櫘閫氱敤鎴风湅涓嶅埌涔熸病蹇呰

**楠岃瘉:**

- `npx tsc --noEmit -p tsconfig.json`: 0 errors
- 娉ㄥ唽琛ㄧ┖鏃?loadGame 琛屼负涓嶅彉锛坒ast-path `applied.length === 0`锛?- 閾惧紡搴旂敤绠楁硶缁忎唬鐮佸鏌ワ紙鎵剧涓€鏉″彲鐢ㄨ縼绉?+ 鍓嶈繘 + 100 娆?safety锛?
**瀵圭収 GAP_AUDIT:**

鍘熻瘎浼颁负 LOW锛孍ffort HIGH锛堝洜涓洪渶瑕佽璁?migration framework锛夈€傚疄闄呰惤鍦板悗浠ｇ爜閲忓緢灏忥紙~170 琛?migration-registry + 60 琛?save-manager 鏀瑰姩锛夛紝鍥犱负閲囩敤浜?绌烘敞鍐岃〃榛樿绛変簬鏃ц涓?鐨勮璁★紝鏃犻渶鏀逛换浣曡皟鐢ㄦ柟銆?
Gap-audit doc 宸插悓姝ユ洿鏂颁负 "13 fixed + 1 rejected (搂7.2 demo-only) + 1 by-design (搂11.3) + 1 fixed here (搂5.2)"銆傝 [gap-audit-2026-04-11.md](./gap-audit-2026-04-11.md) banner銆?
---

## [2026-04-11] CR-R 鎵规淇锛氬 CODE_REVIEW_2026-04-11.md 鍏ㄩ儴 29 椤圭殑瀵圭棁涓嬭嵂

**Scope:** 瀵?`CODE_REVIEW_2026-04-11.md` 涓彂鐜扮殑 4 HIGH + 11 MEDIUM + 14 LOW锛堟湁鏁堥」 22锛夊叏閮ㄨ惤鍦颁慨澶嶃€傛墍鏈変慨鏀逛繚鎸佹渶灏忎镜鍏ワ紝甯﹁鍐呮敞閲婃爣璁?`CR-R<N> (2026-04-11)` 浠ヤ究鍚庣画鍥炴函銆俆SC clean + JSON 閰嶇疆 parse 閫氳繃 + 鍏抽敭璺緞鎵嬪伐鏍稿銆?
### CR-R1 [HIGH] 鈥?StateManager 杩囨护鍣ㄨ矾寰勮В鏋愬櫒

**File:** [src/engine/core/state-manager.ts](src/engine/core/state-manager.ts)

涔嬪墠 StateManager 鍩轰簬 lodash-es `get/set`锛屼笉鏀寔 `绀句氦.鍏崇郴[鍚嶇О=X].濂芥劅搴 杩欑 filter 璇硶銆侫I 鐢熸垚鐨?command 璺緞涓€鏃︿娇鐢ㄦ褰㈠紡灏遍潤榛樺け璐ャ€備慨澶嶏細鏂板 `FILTER_SEGMENT_RE` 姝ｅ垯 + `resolveFilterPath` 瑙ｆ瀽鍣紝鍖归厤 `field=value` 杩囨护鍒板叿浣撶储寮曪紝鍐嶈浆鎴愭爣鍑嗙偣璺緞浜ょ粰 lodash銆? 涓祴璇曞満鏅叏閮ㄩ€氳繃锛堢储寮曡В鏋愩€乫ilter 瑙ｆ瀽銆乫ast-path pass-through銆佸け璐?fallback 绛夛級銆備负 CR-R8/R15 鎵撲笅鍩虹銆?
### CR-R2 [HIGH] 鈥?ResponseParser memoryEntry 鍘熺敓瑙ｆ瀽

**Files:** [src/engine/ai/types.ts](src/engine/ai/types.ts), [src/engine/ai/response-parser.ts](src/engine/ai/response-parser.ts), [src/engine/pipeline/sub-pipelines/npc-chat.ts](src/engine/pipeline/sub-pipelines/npc-chat.ts)

NpcChatPipeline 涔嬪墠鐢ㄨ嚜宸辩殑 `extractMemoryEntry` 瀵?raw JSON 鍋氱浜屾姝ｅ垯鎻愬彇锛岃剢寮变笖涓?ResponseParser 涓绘祦绋嬭劚鑺傘€傛柊澧?`AIResponse.memoryEntry` 瀛楁锛孯esponseParser 缁熶竴浜у嚭骞跺仛闀垮害鎴柇锛?80 鈫?79 + 鐪佺暐鍙凤級銆侼pcChatPipeline 鐩存帴娑堣垂 `parsed.memoryEntry`锛岀Щ闄?obsolete helper銆?
### CR-R3 [HIGH] 鈥?APIPanel 淇濆瓨鍓嶈〃鍗曟牎楠?
**File:** [src/ui/components/panels/APIPanel.vue](src/ui/components/panels/APIPanel.vue)

鍘熷厛淇濆瓨鎸夐挳鏈牎楠?name/url/apiKey/model 闈炵┖锛屽厑璁哥敤鎴蜂繚瀛樻畫缂洪厤缃€傛柊澧?`formValidationError` computed锛氶€愬瓧娈垫鏌?trimmed 闈炵┖锛岃繑鍥為鏉￠敊璇垨 null銆傛ā鏉夸笂鎸夐挳 disabled + 閿欒 hint 鏄剧ず锛沗saveAPI()` 淇濈暀鏈嶅姟绔厹搴曟牎楠岋紙闃插尽鎬э紝闃叉寜閽澶栭儴浠ｇ爜瑙﹀彂锛夈€?
### CR-R4 [HIGH] 鈥?ValidationRepair 宓屽瀵硅薄閫掑綊

**File:** [src/engine/behaviors/validation-repair.ts](src/engine/behaviors/validation-repair.ts)

鍘?`validateArrayItems` 鍙牎楠屾暟缁勫厓绱犵殑椤跺眰瀛楁锛屼笉杩涘叆宓屽 `object` / `array`銆傚鑷?NSFW `绉佸瘑淇℃伅.韬綋閮ㄤ綅[]` 杩欐牱鐨勬繁灞傚瓧娈电己澶辨案杩滀笉浼氳淇銆傛柊澧?`validateNestedObject` + 閫掑綊鍏ュ彛鐐癸細閬囧埌 `type:'object'` 涓嬫綔涓€灞傜户缁?default 濉厖 + number clamp + 鍐嶅祵濂楋紱閬囧埌 `type:'array'` 閫掑綊鍥?`validateArrayItems`銆?
### CR-R5 [MEDIUM] 鈥?debug prompt 鍙戝皠涓?NSFW 鍓ョ椤哄簭

**File:** [src/engine/pipeline/stages/context-assembly.ts](src/engine/pipeline/stages/context-assembly.ts)

涔嬪墠椤哄簭锛歚assemble 鈫?emit(debug) 鈫?stripTagFromMessages`锛屽鑷?PromptAssemblyPanel 鐪嬪埌鐨勬槸鏈墺绂荤増鏈紝鑰?AI 瀹為檯鏀跺埌宸插墺绂荤増鏈€傛柊椤哄簭锛歚assemble 鈫?strip 鈫?emit 鈫?send`锛屼笁鑰呯湅鍒板悓涓€浠藉唴瀹癸紝璋冭瘯鏃?AI 涓轰粈涔堟病鐪嬪埌 X"鐨勭枒鎯戞秷澶便€?
### CR-R6 [MEDIUM] 鈥?snapshot-sanitizer 鍗囩骇涓?path-aware

**File:** [src/engine/memory/snapshot-sanitizer.ts](src/engine/memory/snapshot-sanitizer.ts)

鍘熷疄鐜扮敤 JSON.stringify replacer 鎸?key 鍚嶅墺绂伙紙`绉佸瘑淇℃伅` / `韬綋`锛夛紝鏈潵 schema 鑻ュ湪闈?NSFW 浣嶇疆娣诲姞鍚屽悕 key 浼氳璇激銆傛柊瀹炵幇锛歚NSFW_STRIP_PATHS = ['绀句氦.鍏崇郴.*.绉佸瘑淇℃伅', '瑙掕壊.韬綋']` 鎸夊畬鏁磋矾寰勫墠缂€ + `*` 閫氶厤绗﹀尮閰嶏紱`sanitizeDeep` 閫掑綊閬嶅巻鐢熸垚鑴辨晱娣辨嫹璐濄€?/5 娴嬭瘯閫氳繃锛屽寘鎷?`韬綋閮ㄤ綅` / `韬綋鐗瑰緛鎻忚堪` 鐨?false-positive 闃叉姢銆傚師 `makeNsfwStripReplacer` 淇濈暀涓?`@deprecated` backward compat銆?
### CR-R7 [MEDIUM] 鈥?NpcChat 鍙厤缃巻鍙查暱搴?+ 鍥炴函鎬?trim

**Files:** [src/engine/pipeline/sub-pipelines/npc-chat.ts](src/engine/pipeline/sub-pipelines/npc-chat.ts), [public/packs/tianming/rules/npc-chat.json](public/packs/tianming/rules/npc-chat.json) *(new)*, [public/packs/tianming/manifest.json](public/packs/tianming/manifest.json), [src/main.ts](src/main.ts)

鍘熷疄鐜?`MAX_CHAT_HISTORY` 涓虹‖缂栫爜 const锛宲ack 鏃犳硶瑕嗙洊锛屼笖鏃у瓨妗ｉ噷鐨勮秴闀垮巻鍙蹭笉浼氳鍥炴函娓呯悊銆備慨澶嶏細

1. 鏂板 pack rule `rules/npc-chat.json` (`maxChatHistory: 20`)锛屽湪 manifest 娉ㄥ唽
2. NpcChatPipeline 鏋勯€犳椂浠?`gamePack.rules.npcChat.maxChatHistory` 璇诲彇锛堟牎楠?`>0 && 鈮?00`锛夛紝鏈厤缃椂鐢?`DEFAULT_MAX_CHAT_HISTORY=20`
3. 鏂板 `trimAllChatHistories()` 鍏紑鏂规硶锛寃alk 鎵€鏈?NPC 鐨?`绉佽亰鍘嗗彶` 鏁扮粍骞舵敹鏁涘埌 `maxChatHistory`
4. main.ts 璁㈤槄 `engine:state-changed` type='load' 浜嬩欢锛屽湪璇绘。/鍒涜瀹屾垚鍚庝竴娆℃€у洖婧?trim

### CR-R8 / CR-R15 [HIGH/MEDIUM] 鈥?NpcChat 鍛戒护浣滅敤鍩熶弗鏍兼牎楠?
**File:** [src/engine/pipeline/sub-pipelines/npc-chat.ts](src/engine/pipeline/sub-pipelines/npc-chat.ts)

鍘?`filterScopedCommands` 鍙鏌ヨ矾寰勫墠缂€锛屽厑璁?AI 瓒婃潈淇敼鍏朵粬 NPC 瀛楁锛堥€氳繃 `[鍚嶇О=鍏朵粬NPC]` 鎴?`[N]` 绱㈠紩鎸囧悜閭诲眳锛夈€傛柊鐗堜弗鏍艰В鏋愶細

- 蹇呴』浠?`绀句氦.鍏崇郴` 寮€澶达紙浣嗕笉鑳界瓑浜庡畠 鈥斺€?绂佹鏁存暟缁勬浛鎹級
- 蹇呴』绱ц窡 `[...]`锛堝惁鍒欐嫆缁濓紝濡?`绀句氦.鍏崇郴.瀛楁`锛?- 杩囨护鍣ㄥ舰寮?`[鍚嶇О=X]`锛歠ield 蹇呴』 `鍚嶇О` 涓?value 蹇呴』绛変簬褰撳墠 `npcName`
- 绱㈠紩褰㈠紡 `[N]`锛歂 蹇呴』 `=== npcIndex`锛堢鍚嶆柊澧?index 鍙傛暟锛?- 鎵€鏈夋嫆缁濋」鑱氬悎 `console.warn` 涓€娆★紝涓嶅埛灞?
### CR-R9 [MEDIUM] 鈥?ContentFilterModule NSFW 鍏崇郴 JSDoc

**File:** [src/engine/behaviors/content-filter.ts](src/engine/behaviors/content-filter.ts)

鎵╁睍妯″潡 JSDoc 璇存槑锛歵ianming pack 鐨?NSFW 璇勭骇涓嶇粡杩囨湰妯″潡锛堝洜涓?`[绉佸瘑]` tag 鍦?message content 灞傝€岄潪 variables 灞傦級锛屾湰妯″潡淇濈暀鏄负鍏朵粬璇勭骇锛堟毚鍔?琛€鑵ョ瓑锛夋彁渚涘０鏄庡紡寮€鍏炽€備笁鑰呭垎宸ワ細ContentFilter(variables) / stringifySnapshotForPrompt(state JSON) / stripTagFromMessages(messages) 鍚勫徃鍏惰亴銆傜ず渚嬩粠 `NSFW` 鏀逛负 `VIOLENCE` 閬垮厤璇銆?
### CR-R10 [MEDIUM] 鈥?APIPanel 绫诲埆鍒囨崲 per-category 缂撳瓨

**File:** [src/ui/components/panels/APIPanel.vue](src/ui/components/panels/APIPanel.vue)

鍘?`onCategoryChange` 寮哄埗閲嶇疆 provider/temperature/maxTokens 鍒扮被鍒粯璁ゅ€硷紝瀵艰嚧"LLM 濉簡涓€鍗?鈫?鍒?Embedding 鐪嬩竴鐪?鈫?鍒囧洖 LLM"鏃跺凡濉瓧娈佃娓呴浂銆傛柊绛栫暐锛歚categoryFormCache: Partial<Record<APICategory, CategorySlice>>` 瀛樺偍姣忎釜绫诲埆鐨勫瓧娈靛揩鐓э紝鍒囧嚭鏃?snapshot锛屽垏鍏ユ椂 restore 鎴栫敤 `CATEGORY_DEFAULTS`銆俙openAddModal` / `openEditModal` 鎵撳紑鏃舵竻绌虹紦瀛樸€傛ā鏉?`@click` 浼犲叆 previousCategory 鍙傛暟銆?
### CR-R11 [MEDIUM] 鈥?鍔熻兘鍒嗛厤"鏄剧ず鍏ㄩ儴 API"寮€鍏?
**File:** [src/ui/components/panels/APIPanel.vue](src/ui/components/panels/APIPanel.vue)

鏂板 `showAllInAssign` toggle锛氬紑鍚椂 `getAssignableAPIs` 杩斿洖鎵€鏈?API锛堢粫杩囩被鍒繃婊わ級銆傞€傜敤鍦烘櫙锛氳嚜寤虹綉鍏宠矾鐢便€佸己鍒舵妸 LLM 褰?Rerank 鐢ㄧ瓑鐢ㄦ埛鍒绘剰瑕嗙洊鐨勬儏鍐点€傞粯璁?off 淇濇寔瀹夊叏銆?
### CR-R12 [MEDIUM] 鈥?Split-gen 绗?姝?Claude 鍏煎鎬?
**Files:** [src/engine/pipeline/stages/ai-call.ts](src/engine/pipeline/stages/ai-call.ts), [src/engine/pipeline/sub-pipelines/character-init.ts](src/engine/pipeline/sub-pipelines/character-init.ts)

Claude API 涓ユ牸瑕佹眰 user/assistant 浜ゆ浛涓斾互 user 缁撳熬銆傛棫瀹炵幇 `[...assembled, { role: 'assistant', content: step1Raw }]` 缁撴潫鍦?assistant锛孋laude 浼氬綋浣?prefill 缁х画鍐欏彊浜嬭€岄潪浜у嚭缁撴瀯鍖栨暟鎹€傛柊瀹炵幇锛氬湪 assistant 鍚庡啀杩藉姞涓€鏉?user 鎸囦护娑堟伅锛?璇峰熀浜庝笂闈㈢殑姝ｆ枃杈撳嚭 commands/action_options/memory 鐨勭粨鏋勫寲鏁版嵁"锛夛紝褰㈡垚鏍囧噯澶氳疆缁撴瀯銆侽penAI 鍏煎绔偣鍑犱箮鏃犲奖鍝嶏紙瀹冧滑鏇村瀹癸級銆備富鍥炲悎 split-gen 鍜?opening scene split-gen 涓ゅ閮戒慨銆?
### CR-R14 [MEDIUM] 鈥?NpcChat 娴佸紡閫愬瓧鏄剧ず

**Files:** [src/engine/pipeline/sub-pipelines/npc-chat.ts](src/engine/pipeline/sub-pipelines/npc-chat.ts), [src/ui/components/shared/NpcChatModal.vue](src/ui/components/shared/NpcChatModal.vue)

NpcChatPipeline.chat 鏂板鍙€夌 3 鍙傛暟 `onStreamChunk`锛岄€忎紶缁?`aiService.generate` 鐨?stream/onStreamChunk銆侼pcChatModal 鍦?`sendMessage` 涓淮鎶?`streamingText` ref锛屾瘡鏀跺埌 chunk 杩藉姞骞舵粴搴曪紝鍝嶅簲瀹屾垚鍚庢竻绌猴紙鏈€缁堟皵娉＄敱鐘舵€佹爲 `绉佽亰鍘嗗彶` 鐨?reactive 閲嶇畻鑷姩娓叉煋锛夈€傛ā鏉垮湪 pending 姘旀场鍖烘寜 `streamingText` 鏄惁闈炵┖鍒囨崲"FormattedText 瀹炴椂鏄剧ず" vs "loading dots"銆?
### CR-R16 [LOW] 鈥?NPC 琚垹闄ゆ椂鑷姩鍏抽棴绉佽亰 modal

**File:** [src/ui/components/shared/NpcChatModal.vue](src/ui/components/shared/NpcChatModal.vue)

鏂板 watch锛氳嫢 relationships 鏁扮粍宸插姞杞戒絾鎵句笉鍒?`props.npc.鍚嶇О` 瀵瑰簲鐨勬潯鐩紝瑙嗕负璇?NPC 琚垹闄わ紙涓诲洖鍚?AI 鎸囦护鎴栨墜鍔ㄥ垹闄わ級锛岃嚜鍔?toast + 鍏抽棴 modal銆?
### CR-R17 [LOW] 鈥?state-schema.json NSFW $comment 澧炲己

**File:** [public/packs/tianming/schemas/state-schema.json](public/packs/tianming/schemas/state-schema.json)

`瑙掕壊.韬綋` 鍜?`绀句氦.鍏崇郴[].绉佸瘑淇℃伅` 鐨?`$comment` 瀛楁杩藉姞瀵?`snapshot-sanitizer.ts NSFW_STRIP_PATHS` 鐨勪氦鍙夊紩鐢?+ 鏈潵澶嶇敤璀﹀憡銆傛槑纭害瀹氾細schema 鑻ュ湪鍏朵粬浣嶇疆閲嶇敤鍚屽悕 key锛屽繀椤诲悓姝ユ洿鏂?NSFW_STRIP_PATHS銆?
### CR-R18 [LOW] 鈥?testConnection toast 鏄剧ず API 绫诲埆

**File:** [src/ui/components/panels/APIPanel.vue](src/ui/components/panels/APIPanel.vue)

toast 娑堟伅浠?`${api.name} 杩炴帴鎴愬姛` 鏀逛负 `${api.name} [LLM/Embedding/Rerank] 杩炴帴鎴愬姛`銆傜敤鎴峰湪閰嶇疆 SiliconFlow 杩欑被澶氱鐐?provider 鏃惰兘涓€鐪肩湅鍑鸿蛋鐨勬槸鍝潯璺緞銆?
### CR-R20 [LOW] 鈥?generateOpeningScene 缁熶竴閿欒鏃ュ織

**File:** [src/engine/pipeline/sub-pipelines/character-init.ts](src/engine/pipeline/sub-pipelines/character-init.ts)

鍘?split/single 涓ゆ潯璺緞鍚勮嚜 `console.warn` 鏍煎紡涓嶄竴锛?skipped" vs "failed"锛夈€傛柊澧?`logOpeningFailure(stage, err)` helper锛屾墍鏈夊け璐ョ粺涓€鏍煎紡 `[CharacterInit] Opening scene [<mode>:<step>] failed: <msg>`锛屼究浜?grep銆俿tage 鏋氫妇锛歚split:step1` / `split:step2` / `single:generate` / `single:missing-flow`銆?
### CR-R21 [LOW] 鈥?extractDefaultsFromSchema $ref 妫€娴?
**File:** [src/engine/pipeline/sub-pipelines/character-init.ts](src/engine/pipeline/sub-pipelines/character-init.ts)

褰撳墠 pack schema 鏈娇鐢?`$ref`锛屼絾鑻ユ湭鏉ユ煇瀛楁鏀圭敤 `{ "$ref": "#/definitions/X" }` 寮曠敤锛宍extractDefaultsFromSchema` 浼氶潤榛樿烦杩囪瀛楁锛堝洜涓?type 涓嶆槸 object 涓旀病鏈?properties锛夈€傛柊澧炴樉寮忔娴嬶細`'$ref' in propSchema` 鏃?warn 骞?continue锛屾槑纭憡鐭ュ紑鍙戣€呴渶瑕佹墿灞?schema resolver銆?
### CR-R25 [LOW] 鈥?formatGameTime 涓嫳 key fallback

**File:** [src/engine/pipeline/sub-pipelines/npc-chat.ts](src/engine/pipeline/sub-pipelines/npc-chat.ts)

鍘熷彧璇?`骞?鏈?鏃?灏忔椂/鍒嗛挓`锛岃嫢鏈潵 pack 鐢ㄨ嫳鏂囧瓧娈靛悕鍒欒繑鍥?0銆傛柊澧?`pick(cn, en)` helper 鍚屾椂灏濊瘯涓ゅ閿悕銆傚绾︿粛鏄腑鏂囦紭鍏堬紝鍙槸鏈€灏?fallback銆?
### CR-R26 [LOW] 鈥?RelationshipPanel 绌哄悕 NPC 绂佹绉佽亰

**File:** [src/ui/components/panels/RelationshipPanel.vue](src/ui/components/panels/RelationshipPanel.vue)

`openChat` 鍓嶇疆鏍￠獙 `npc.鍚嶇О.trim()` 闈炵┖锛岀┖鍚嶇洿鎺?toast "璇?NPC 灏氭湭璁剧疆鍚嶇О锛屾棤娉曠鑱? 骞?return銆傚師鍥狅細NpcChatPipeline.chat 鐨勫敮涓€鏍囪瘑鏄?`鍚嶇О`锛涚┖瀛楃涓蹭細瀵艰嚧 find 鍖归厤澶氫釜鏈懡鍚?NPC 鎴栧け璐ワ紝娼滃湪瓒婃潈鍐欏叆椋庨櫓銆俇I 灞傛嫤鎴渶渚垮疁銆?
### CR-R27 [LOW] 鈥?NpcChat 鐢ㄦ埛杈撳叆瑙勮寖鍖?
**File:** [src/engine/pipeline/sub-pipelines/npc-chat.ts](src/engine/pipeline/sub-pipelines/npc-chat.ts)

`chat()` 鍏ュ彛瀵?`userMessage` 鎵ц锛氱粺涓€ `\r\n?` 鈫?`\n` 鈫?鍘嬬缉 `\n{3,}` 鈫?`\n\n` 鈫?`trim()` 鈫?闄愰暱 2000 瀛楃锛堣秴闀挎埅鏂?+ warn锛夈€傞槻姝㈠鍒剁矘璐村甫鏉ョ殑娣峰悎鎹㈣绗﹀拰澶ф绌虹櫧鐐?prompt銆?
### CR-R28 [LOW] 鈥?NpcChatModal date-aware 鏃堕棿鎴?
**File:** [src/ui/components/shared/NpcChatModal.vue](src/ui/components/shared/NpcChatModal.vue)

`formatTimestamp` 鍗囩骇锛氫粖澶?鈫?`HH:mm`锛涙槰澶?鈫?`鏄ㄥぉ HH:mm`锛涘悓骞村叾浠?鈫?`M鏈圖鏃?HH:mm`锛涜法骞?鈫?`YYYY-M-D HH:mm`銆傞伩鍏嶄笉鍚屾棩瀛愬悓鏃跺埢鐨勬秷鎭湅璧锋潵涓€鏍枫€?
### 楠岃瘉

- `npx tsc --noEmit`锛? errors
- JSON pack 鏂囦欢 parse锛歚schema OK` / `manifest OK` / `npc-chat rule OK`
- 浠ｇ爜鍐?CR-R 娉ㄩ噴鏍囪榻愬叏锛屼究浜庡悗缁洖婧?
---

## [2026-04-11] Feature: NPC 绉佽亰锛圱alk锛? GAP_AUDIT 鍓╀綑椤?4 涓?
**Scope:** 瀹屾垚 GAP_AUDIT 閬楃暀鐨?搂11.4 / 搂4.1d / 搂4.1c / 搂7.2 鍥涢」銆偮?.2 浠?蹇嵎鍔ㄤ綔鎸夐挳"婕斿彉涓?*瀹屾暣鐨?NPC 寮傛绉佽亰瀛愮郴缁?*锛堝惈鏂?sub-pipeline + 涓撶敤 prompt + 鐙珛 UI modal + NPC edit form 鎵╁睍锛夆€斺€?婧愯嚜 demo `docs/design note` 搂浜?鐨勮璁?intent銆?
### 鑳屾櫙锛毬?.2 鑼冨洿鎵╁睍杩囩▼

鍘?GAP_AUDIT 鎶婅繖椤规爣璁颁负"Action queue 鎵╁睍鍒板叾浠栭潰鏉匡紙MEDIUM锛?銆傚疄闄呭拰鐢ㄦ埛璁ㄨ鏃朵粬鎸囧嚭鍘熻璁★紙瑙?demo `docs/design note` 绗?257-264 琛岋級鏄?*鐙珛浜庝富鍥炲悎鐨勫紓姝?NPC 绉佽亰**锛屽苟闈炵畝鍗曠殑 action queue 鏉＄洰锛?
> 浜斻€乶pc 瀵硅瘽绯荤粺锛堢鑱婏級鈴斥€硷笍
> 涓庝富鏁呬簨寮傛杩涜锛堝嵆鐙珛浜庝富鏁呬簨绯荤粺锛屼絾鏄粛灏忚寖鍥存洿鏂版暟鎹級锛?> UI 鐨勮瘽鍙互鍦?NPC 椤甸潰涓庡叾瀵硅瘽锛岄€氳繃 llm 澶勭悊銆?> 姝ょ被瀵硅瘽浠呮敼鍙樻 NPC 鐨勪俊鎭紙渚嬪锛屾敼鍙?NPC 鐨勫姩鏈猴紝鎴栬€呭鏌愪簨/浜虹殑鐪嬫硶锛夈€?> 姝ょ被瀵硅瘽闇€瑕佹洿鏂?NPC 鐨勮蹇嗚 NPC 鍦ㄤ富绾挎晠浜嬩腑鑳借寰楀璇濄€?
鐢ㄦ埛纭 demo 鏈韩涔熸湭瀹炵幇姝ゅ姛鑳斤紙`鈴斥€硷笍` = pending 楂樹紭鍏堢骇锛夛紝璁╂垜**fresh implementation**銆俆rade/request 琚槑纭Щ鍑?scope锛岃涓诲洖鍚?AI 閫氳繃瀵硅瘽鍚庝骇鐢熺殑 update action 鑷劧澶勭悊銆?
---

### 搂11.4 鈥?CommandExecutor 璺緞鏍规鐧藉悕鍗曪紙warn-only锛?
**Flow:** AI 杩斿洖 commands 鈫?ResponseParser 鈫?CommandExecutor 鈫?StateManager

**Root cause:** AI 鍙互鍐欎换鎰忚矾寰勶紙濡?`闅忔満瀛楁.鑳′贡鍐?123`锛夛紝`lodash.set` 鏃犺剳鍒涘缓锛岄暱娓告垙鍚庣姸鎬佹爲琚?鑴?鏁版嵁姹℃煋銆侴AP_AUDIT 搂11.4 鏍囪涓?ValidationRepairModule 搴斿仛璺緞鐧藉悕鍗曟鏌ワ紝浣嗘湭娉ㄥ唽"銆?
**Design choice (鐢ㄦ埛鎸囧畾):** 閫夐」 c 鈥?warn-only 鍏堟敹闆嗘暟鎹紝鍚庣画鍐嶅喅瀹氭槸鍚﹀崌绾у埌涓ユ牸鎷掔粷銆?
**Files changed:**
- `src/engine/core/command-executor.ts`:
  - 鏋勯€犲嚱鏁版柊澧炲彲閫夊弬 `pathRootWhitelist: readonly string[] | null = null`
  - 鏂板 `warnedUnknownRoots: Set<string>` 瀹炰緥瀛楁锛坰ession dedup锛?  - `execute()` 鍦ㄧ粨鏋勬牎楠屽悗璋冪敤 `warnIfUnknownPathRoot(command.key)`
  - 鏂板 `warnIfUnknownPathRoot` 绉佹湁鏂规硶锛氭彁鍙?path 绗竴涓?`.` 鎴?`[` 涔嬪墠鐨勬牴娈碉紝鑻ヤ笉鍦ㄧ櫧鍚嶅崟涓斿皻鏈憡璀﹀垯 `console.warn` + `eventBus.emit('ui:toast', {type:'warning'})`
  - 姣忎釜鏈煡鏍规姣?session 鍙憡璀︿竴娆★紙`warnedUnknownRoots` Set 鍘婚噸锛?  - 瀵煎叆 `eventBus`
- `src/main.ts`:
  - 浠?`pack.stateSchema.properties` 鍔ㄦ€佹彁鍙栭《灞?keys 浣滀负 `schemaRoots`
  - `new CommandExecutor(stateManager, schemaRoots)` 浼犲叆

**Behavior before:** AI 鑳介潤榛樺啓鍏ヤ换浣曡矾寰勶紝璋冭瘯鏃舵棤娉曞彂鐜?**Behavior after:** 鍐欏叆鏈煡鏍规鏃?console + toast 璀﹀憡涓€娆★紝鍛戒护浠嶆墽琛岋紙涓嶇牬鍧忓悜鍚庡吋瀹癸級锛涘紑鍙戣€呭彲鎹鍐冲畾鏄惁鍦ㄦ湭鏉ュ崌绾т负涓ユ牸鎷掔粷

**Pack 鐨勫悎娉曟牴娈碉細** `['鍏冩暟鎹?, '瑙掕壊', '涓栫晫', '绀句氦', 'NPC鍒楄〃', '璁板繂', '绯荤粺']`锛堜粠 tianming state-schema 鍔ㄦ€佽鍙栵級

---

### 搂4.1d 鈥?`extractDefaultsFromSchema` 瀵硅薄绾ч儴鍒?default 涓嶅悎骞跺祵濂楀睘鎬ч粯璁ゅ€?
**Flow:** 鍒涜 鈫?CharacterInitPipeline.buildInitialState 鈫?extractDefaultsFromSchema

**Root cause:** 鏃у疄鐜伴亣鍒?`{ type: 'object', default: {}, properties: {...} }` 缁撴瀯鏃讹紝浼樺厛浣跨敤椤跺眰 `default`锛堢┖瀵硅薄 `{}`锛夛紝**涓㈠純**宓屽 property 鐨勯粯璁ゅ€笺€?
**鍏蜂綋 bug 渚嬶紙tianming schema锛夛細**
```json
"鍏堝ぉ鍏淮": {
  "type": "object",
  "default": {},
  "properties": {
    "浣撹川": { "type": "number", "default": 5 },
    "鐩磋": { "type": "number", "default": 5 },
    "鎮熸€?: { "type": "number", "default": 5 },
    "姘旇繍": { "type": "number", "default": 5 },
    "榄呭姏": { "type": "number", "default": 5 },
    "蹇冩€?: { "type": "number", "default": 5 }
  }
}
```
鏃ч€昏緫杈撳嚭 `鍏堝ぉ鍏淮: {}`锛堢┖瀵硅薄锛夛紝鐜╁鍒涜鍚庡叚缁村叏缂哄け锛孶I 鏄剧ず undefined/0銆?
**Files changed:**
- `src/engine/pipeline/sub-pipelines/character-init.ts:244-290` 鈥?`extractDefaultsFromSchema` 鏀逛负**闈炵牬鍧忔€?*閫掑綊鍚堝苟锛?  1. 瀵硅薄瀛楁锛氬厛鐢?`default`锛堟垨 `{}`锛変綔涓?base锛屽啀閫掑綊濉厖**缂哄け鐨?*宓屽灞炴€ч粯璁ゅ€?  2. 闈炲璞″瓧娈垫湁 default 涓?target 涓皻鏃犺 key锛氱洿鎺ュ啓鍏ワ紙`!(key in target)` 淇濇姢鐖剁骇宸插～鍊硷級
  3. 闈炲璞℃棤 default锛氳烦杩?  - 閫掑綊鏃舵鏌?`key in target`锛屼繚璇?鏄惧紡鐖剁骇 default > 瀛愬睘鎬?default"浼樺厛绾?  - 澶ч噺娉ㄩ噴瑙ｉ噴绠楁硶鍜屼笌鏃х増鐨勫樊寮?
**楠岃瘉锛?* 鐢?node 鑴氭湰璺戝綋鍓?schema锛?```
鍏堝ぉ鍏淮: {"浣撹川":5,"鐩磋":5,"鎮熸€?:5,"姘旇繍":5,"榄呭姏":5,"蹇冩€?:5}  鉁?浣撳姏: {"褰撳墠":100,"涓婇檺":100}  鉁?(regression check, already worked)
nsfwMode: false, nsfwGenderFilter: female  鉁?鍑虹敓鏃ユ湡: {} (姝ｇ‘ 鈥?鏃犲瓙 default)
韬綋: {} (姝ｇ‘ 鈥?鏃犲瓙 default锛岀敱 AI 鍦ㄥ垱瑙掓椂 set 鍐欏叆)
```

**Behavior before:** 鍒涜鍚?`瑙掕壊.韬唤.鍏堝ぉ鍏淮` = `{}`锛屽叚缁村睘鎬у叏缂?**Behavior after:** 鍒涜鍚?`瑙掕壊.韬唤.鍏堝ぉ鍏淮` = `{浣撹川:5, 鐩磋:5, 鎮熸€?5, 姘旇繍:5, 榄呭姏:5, 蹇冩€?5}`锛屽熀绾垮€兼纭?
---

### 搂4.1c 鈥?鍒嗘寮€灞€瀹炵幇锛堜粠 demo design intent 澶嶅埢锛?
**Flow:** StepConfirmation toggle 鈫?CreationView.onStepSelect 鈫?CharacterInitPipeline.generateOpeningScene

**Root cause:** `StepConfirmation.vue` 鏈?鍒嗘鐢熸垚寮€灞€"toggle 浣?`CreationView.onStepSelect` 鐨?switch 娌℃湁 `'confirmation'` case锛宔mit 琚?default 鍒嗘敮 drop銆傚彟澶栧唴閮ㄦ寜閽?寮€濮嬫父鎴?鍙?emit 涓嶈皟鐢?finalize锛坧re-existing dead-button bug锛夈€?
**Design:** 浠呮媶鍒?`openingScene`锛堟湁澶ч噺 commands锛夛紝涓嶆媶鍒?`worldGeneration`锛坄worldGen.md` 宸茬粡鏄函鏂囨湰锛屾棤鎰忎箟鎷嗭級銆?
**Files added:**
- `public/packs/tianming/prompt-flows/opening-scene-step1.json` 鈥?modules = `[opening, splitGenStep1]`锛坥rder 0 opening 鎻愪緵鍒涜涓婁笅鏂囷紝order 1 splitGenStep1 浣滀负鏈€鍚庝竴鏉＄郴缁熸秷鎭己鍒惰緭鍑烘牸寮忚鐩?opening.md 鐨勫師杈撳嚭鏍煎紡锛?- `public/packs/tianming/prompt-flows/opening-scene-step2.json` 鈥?modules = `[opening, splitGenStep2]`

**Files changed:**
- `public/packs/tianming/manifest.json` 鈥?娉ㄥ唽涓や釜鏂?flow
- `src/engine/pipeline/sub-pipelines/character-init.ts`:
  - 鏂?interface `CharacterInitOptions { splitGen?: boolean }`
  - `execute(choices, options = {})` 绛惧悕鎵╁睍
  - `generateOpeningScene` 鎺ュ彈绗笁涓弬 `splitGen: boolean`锛屽垎鏀埌鏂?`generateOpeningSceneSplit` 鏂规硶鎴栬蛋鍘熷崟娆¤皟鐢?  - 鏂版柟娉?`generateOpeningSceneSplit(variables, step1Flow, step2Flow)`:
    - 绗?姝ワ細assemble `openingSceneStep1` flow锛岃皟 AI 寰楀埌 raw + text锛沞mit `ui:debug-prompt`
    - 绗?姝ュけ璐ョ洿鎺?`return null`锛堜笉灏濊瘯绗?姝ワ級
    - 绗?姝ワ細assemble `openingSceneStep2` flow锛屽湪 messages 鏈熬杩藉姞 `{role:'assistant', content: step1Raw}`锛屽啀璋?AI
    - 绗?姝ヨВ鏋?commands 骞?executeBatch锛涚2姝ュけ璐ヤ繚鐣欑1姝?text锛堟寚浠や涪澶变絾鍙欎簨浠嶅彲鐢級
  - 鍥為€€鏈哄埗锛氳嫢 pack 缂哄け step1/step2 flow锛岃嚜鍔?fallback 鍒板崟娆℃ā寮?+ console.warn
- `src/ui/components/creation/StepConfirmation.vue`:
  - 绉婚櫎 "褰撳墠鐗堟湰鍔熻兘棰勭暀" 鏂囨锛堝姛鑳界湡瀹炲彲鐢ㄤ簡锛?  - 鏂板 `emitCurrentOptions()` 鍑芥暟锛歵oggle 鏀瑰彉鏃剁珛鍗?emit `{__confirm:false, options}` 鈫?CreationView 鎸佺画鍚屾
  - 涓や釜 toggle锛坰treaming / generationMode锛夌殑 click handler 鏀逛负璋冩柊鍑芥暟
  - 淇濈暀 `startGame()` 鍙?`{__confirm:true, ...}` 鐢ㄤ簬鍐呴儴鎸夐挳锛堣涓嬶級
- `src/ui/views/CreationView.vue`:
  - 鏂板 `splitGenOpening = ref(false)` ref
  - `onStepSelect` switch 鏂板 `'confirmation'` case锛?    - 鑻?`payload.options.generationMode !== undefined` 鈫?鏇存柊 `splitGenOpening.value`
    - 鑻?`payload.__confirm === true` 鈫?璋?`onFinalize()`锛堜慨澶?pre-existing 鍐呴儴"寮€濮嬫父鎴?鎸夐挳 dead-button bug锛屼竴鐭充簩楦燂級
  - `onFinalize()` 涓?`characterInitPipeline.execute(choices, { splitGen: splitGenOpening.value })`

**Behavior before:** toggle 鎵撳紑鍚庣偣"寮€濮嬫父鎴?浠嶇劧璧板崟娆¤皟鐢紱鍐呴儴鎸夐挳瀹屽叏鏃犳晥
**Behavior after:** toggle 鎵撳紑鍚庝袱娆?AI 璋冪敤锛堢1姝ョ敓鎴愭鏂囷紝绗?姝ョ敓鎴愭寚浠わ級锛岄檷浣庡崟娆″搷搴斿鏉傚害鎻愰珮缁撴瀯鍖栨暟鎹噯纭巼锛涘唴閮?寮€濮嬫父鎴?鎸夐挳涔熻兘瑙﹀彂 finalize

---

### 搂7.2 鈥?NPC 绉佽亰鍔熻兘锛堜粠 demo design intent 鏂板缓锛?
**Flow:** RelationshipPanel 鈫?鍗＄墖 馃挰 绉佽亰 鎸夐挳 鈫?NpcChatModal 鈫?NpcChatPipeline 鈫?AI 鈫?update NPC state 鈫?modal refresh

**Scope decision (鐢ㄦ埛鎸囧畾):**
- 鉁?瀹炵幇 NPC Talk锛坅sync 1:1 瀵硅瘽瀛愮郴缁燂級
- 鉂?Trade / request 绉诲嚭 scope锛堣涓诲洖鍚?AI 閫氳繃瀵硅瘽鍚庣殑 update action 鑷劧澶勭悊锛?- 鉂?MapPanel 鍓嶅線鎸夐挳锛堥潪 MVP锛岃褰曚负 future feature锛?- 鉁?鎵╁睍 NPC edit modal 瀛楁锛堝榻?design note 搂70锛?
**Files added:**

1. `src/engine/pipeline/sub-pipelines/npc-chat.ts` 鈥?`NpcChatPipeline` 绫?   - 鍏ュ彛 `chat(npcName, userMessage): Promise<NpcChatResult>`
   - 姝ラ锛?     1. `findNpc(name)` 鈥?鍦?`绀句氦.鍏崇郴` 鏁扮粍鎸?`鍚嶇О` 鏌ユ壘锛堜笉浣跨敤 `[鍚嶇О=X]` 杩囨护鍣ㄨ娉曪紝鍥犱负 lodash 涓嶆敮鎸侊紱瑙?CR-R1锛?     2. 绔嬪嵆 `appendChatMessage` 鐜╁娑堟伅锛堟寔涔呭寲鍒扮姸鎬佹爲锛?     3. `buildVariables` 缁勮 prompt锛歂PC_PROFILE / PLAYER_NAME / PLAYER_LOCATION / WORLD_DESCRIPTION / GAME_TIME / SHORT_TERM_MEMORY / CHAT_HISTORY / USER_INPUT / NPC_NAME
     4. `promptAssembler.assemble('npcChat', variables)` 鈫?emit `ui:debug-prompt`
     5. `aiService.generate({messages, usageType: 'npc_chat'})`
     6. `responseParser.parse` 鑾峰彇 text + commands
     7. `filterScopedCommands` 闄愬埗 commands 鍙兘鍐?`绀句氦.鍏崇郴` 寮€澶寸殑璺緞
     8. `commandExecutor.executeBatch(scopedCommands)`
     9. `appendChatMessage` AI 鍥炲
     10. `extractMemoryEntry` 瑙ｆ瀽 `memoryEntry` 瀛楁锛坵orkaround锛歊esponseParser 娌″師鐢熸敮鎸?memoryEntry锛屾墜鍔ㄤ粠 raw JSON 鍐嶆 parse锛岃 CR-R2锛?     11. 濡傛湁 memoryEntry 鈫?`appendNpcMemory` push 鍒?NPC 鐨?`璁板繂` 鏁扮粍
   - 鍐呴儴宸ュ叿鏂规硶锛歚appendChatMessage` / `appendNpcMemory` / `filterScopedCommands` / `extractMemoryEntry` / `buildVariables` / `formatNpcProfile` / `formatGameTime` / `formatShortTermMemory` / `formatChatHistory`
   - 甯搁噺 `MAX_CHAT_HISTORY = 20` 鈥?瓒呭嚭鏃?FIFO 娣樻卑
   - `MAX_CHAT_HISTORY` dedup logic 閫氳繃 read-full-array 鈫?modify 鈫?write-full-array 缁曡繃 `[鍚嶇О=X]` 杩囨护鍣?bug
   - 鍓綔鐢ㄩ殧绂伙細**涓?*鍐?`narrativeHistory`锛?*涓?*瑙﹀彂璁板繂鎬荤粨/蹇冭烦/NPC 鐢熸垚绛変笅娓稿瓙绠＄嚎

2. `public/packs/tianming/prompts/npcChat.md` 鈥?NPC 绉佽亰 prompt
   - 7 涓?sections锛氫綘鏄皝 / 鍓ф儏鑳屾櫙 / 绉佽亰鍘嗗彶 / 鐜╁璇翠粈涔?/ 杈撳嚭鏍煎紡 / 瑙勫垯 / 鍐嶆寮鸿皟
   - 瑕佹眰 AI 绗竴浜虹О鍥炲锛屼弗鏍?JSON 杈撳嚭 `{text, commands?, memoryEntry?}`
   - 鏄庣‘鑼冨洿闄愬埗锛歚commands` path 蹇呴』褰㈠ `绀句氦.鍏崇郴[鍚嶇О={{NPC_NAME}}].瀛楁`
   - 鍓ф儏杩炶疮瑙勫垯锛氬熀浜庡綋鍓嶅墽鎯呰儗鏅拰鏈€杩戝墽鎯咃紝涓嶈兘缂栭€犱笌涓荤嚎鐭涚浘鐨勫唴瀹?   - 浜烘牸涓€鑷磋鍒欍€佸ソ鎰熷害鍙樺寲 卤10 浠ュ唴銆佺姝㈣秴闀跨嫭鐧?   - **涓嶅紩鍏?core.md**锛堜富鍥炲悎瑙勫垯瀵圭鑱婃棤鐢紝寰掑 token 鈥?鐢ㄦ埛鏄庣‘纭锛?
3. `public/packs/tianming/prompt-flows/npc-chat.json` 鈥?flow 瀹氫箟
   - modules = `[npcChat, order 0]`
   - `$comment` 璇存槑 context 娉ㄥ叆鏈哄埗

4. `src/ui/components/shared/NpcChatModal.vue` 鈥?鏂扮粍浠?   - Teleport 鍒?body 鐨勫叏灞?overlay modal
   - 甯冨眬锛歨eader锛圢PC 澶村儚 + 鍚嶇О + 绫诲瀷 chip + 浣嶇疆 + 濂芥劅搴﹀窘绔?+ 鍏抽棴鎸夐挳锛夆啋 messages 婊氬姩鍖?鈫?閿欒鎻愮ず锛堝彲閫夛級鈫?杈撳叆鍖猴紙textarea + send button锛?   - 娑堟伅 bubble 鏍峰紡瀵归綈涓绘父鎴忛潰鏉匡紙user 鍙冲榻愮传鑹诧紝NPC 宸﹀榻愮伆鑹诧級
   - 鍙戦€佹椂鏄剧ず loading dots indicator锛? 鐐?bounce 鍔ㄧ敾锛?   - **FormattedText 缁勪欢娓叉煋 AI 鍥炲** 鈥?鏀寔鍒ゅ畾鍗＄墖銆佺幆澧冩弿鍐欍€佸璇濈瓑鏍煎紡
   - 閿洏锛欵nter 鍙戦€侊紙鏀寔 IME `e.isComposing` 妫€鏌ラ伩鍏嶄腑鏂囪緭鍏ユ硶骞叉壈锛夈€丼hift+Enter 鎹㈣
   - 鍝嶅簲寮忥細
     - 浠?`useGameState().useValue(DEFAULT_ENGINE_PATHS.relationships)` 璇?NPC 鍒楄〃 鈫?computed `currentNpc` 瀹炴椂杩借釜
     - `chatHistory` computed 浠?`currentNpc.绉佽亰鍘嗗彶` 娲剧敓
     - 婊氬姩鍒板簳閮細`watch([modelValue, npc.鍚嶇О, chatHistory.length])` 瑙﹀彂
   - 鍏抽棴鏃朵笉娓呯┖ input锛堢敤鎴峰垏 tab 鍐嶅洖鏉ヨ兘缁х画锛?
**Files changed:**

5. `public/packs/tianming/schemas/state-schema.json` 鈥?鎵╁睍 `绀句氦.鍏崇郴.items.properties`:
   - 鏂板瀛楁锛歚骞撮緞`, `鑳屾櫙`, `鍐呭績鎯虫硶`, `鍦ㄥ仛浜嬮」`, `鎬ф牸鐗瑰緛` (array of string), `璁板繂` (array of string), `绉佽亰鍘嗗彶` (array of object `{role, content, timestamp}`)
   - 瀵归綈 design note 搂257 鍜?搂70

6. `src/engine/ai/types.ts` 鈥?UsageType union 鏂板 `'npc_chat'`锛堟敞閲婃爣璁?搂7.2锛?
7. `src/engine/stores/engine-api.ts` 鈥?`ALL_USAGE_TYPES` 鏁扮粍鏂板 `'npc_chat'`

8. `public/packs/tianming/manifest.json` 鈥?娉ㄥ唽 `npcChat` flow + `npcChat` prompt

9. `src/main.ts`:
   - import `NpcChatPipeline`
   - 鍦?pack 瀛樺湪鍧椾腑 `new NpcChatPipeline(stateManager, commandExecutor, aiService, responseParser, promptAssembler, pack, DEFAULT_ENGINE_PATHS, memoryManager)` 瀹炰緥鍖?   - `app.provide('npcChatPipeline', npcChatPipeline)` 娉ㄥ叆 Vue 渚?UI 灞傛秷璐?
10. `src/ui/components/panels/APIPanel.vue` 鈥?`USAGE_TYPE_META` 鏂板 `npc_chat: { label: 'NPC 绉佽亰', group: 'optional' }`锛岀敤鎴峰彲鍦?APIPanel 涓鸿鍔熻兘鍗曠嫭閰嶇疆 API

11. `src/ui/components/panels/RelationshipPanel.vue`:
    - import `NpcChatModal`
    - 鏂板 `showChatModal` / `chatNpc` refs
    - 鏂板 `openChat(npc, event)` 鍑芥暟锛坄event.stopPropagation()` 闃叉鍐掓场瑙﹀彂 edit modal锛?    - 鎵╁睍 `NpcRelation` interface + `NpcEditForm` interface 鏂板 7 瀛楁锛堟€у埆/骞撮緞/鑳屾櫙/鍐呭績鎯虫硶/鍦ㄥ仛浜嬮」/鎬ф牸鐗瑰緛/璁板繂锛?    - 鏂板 `newTraitInput` / `newMemoryInput` refs锛坱ag 杈撳叆缂撳啿锛?    - 鏂板 `addTrait/removeTrait/addMemory/removeMemory` 鍑芥暟
    - NPC card 鏂板 `.card-actions` 鍖猴紝鏀句竴涓?`馃挰 绉佽亰` 鎸夐挳
    - Edit Modal 瀹藉害浠?440px 鎵╁埌 520px锛屽垎 5 涓?`form-section`锛堝熀鏈俊鎭?/ 鎻忚堪涓庤儗鏅?/ 褰撳墠鐘舵€?/ 鎬ф牸鐗瑰緛 / 璁板繂鏉＄洰锛?    - 鎬ф牸鐗瑰緛鐢?tag list锛坈lick 脳 鍒犻櫎锛宨nput + 娣诲姞鎸夐挳锛?    - 璁板繂鐢?list item + 脳 鍒犻櫎 + input + 娣诲姞鎸夐挳
    - 妯℃澘鏈熬鎸傝浇 `<NpcChatModal v-model="showChatModal" :npc="chatNpc" />`
    - CSS 鏂板 `.card-actions` / `.card-action-btn` / `.form-section` / `.form-row` / `.form-group--half` / `.tag-list` / `.tag-item` / `.tag-delete` / `.tag-empty` / `.tag-input-row` / `.memory-list` / `.memory-item` / `.memory-text` / `.memory-delete` / `.memory-empty` / scrollbar 鏍峰紡

**Behavior before:** 鏃?NPC 绉佽亰鍔熻兘锛汵PC edit form 鍙湁 7 涓熀鏈瓧娈?**Behavior after:**
- 鐐瑰嚮 NPC 鍗＄墖鐨?馃挰 绉佽亰鎸夐挳 鈫?鎵撳紑鐙珛鑱婂ぉ modal 鈫?杈撳叆娑堟伅 鈫?AI 浠?NPC 韬唤鍥炲 鈫?瀵硅瘽鍘嗗彶鎸佷箙鍖栧埌 `绀句氦.鍏崇郴[].绉佽亰鍘嗗彶` 鈫?AI 杩斿洖鐨?commands 闄愬畾鍦ㄨ NPC 瀛楁 鈫?memoryEntry 鑷姩 push 鍒?NPC 鐨?`璁板繂` 鏁扮粍锛堜富绾?AI 鍙锛?- NPC edit modal 鏄剧ず 12+ 瀛楁锛屾敮鎸佺紪杈戞€ф牸 tag 鍒楄〃鍜岃蹇嗘潯鐩垪琛?- 鏂?usageType `'npc_chat'` 鍦?APIPanel 鍙崟鐙厤缃?API

**Design 鍙傜収:**
- `H:\ming\docs\design note` 绗簲鑺傘€宯pc 瀵硅瘽绯荤粺锛堢鑱婏級銆嶁€?鏍囨敞 `鈴斥€硷笍` 楂樹紭 pending
- `H:\ming\docs\design note` 绗?70 琛?鈥?"灏嗕汉鐗╁叧绯讳腑鐨勬墍鏈夐〉闈㈤兘鍦ㄦ瘡椤规暟鎹笂澧炲姞涓€缂栬緫鎸夐敭骞舵敮鎸佺敤鎴风紪杈?NPC 妗ｆ"
- `H:\ming\src\components\dashboard\RelationshipNetworkPanel.vue` 鈥?鍙傝€冨叾 inline edit 妯″紡锛堜絾鎴戦噰鐢?Modal + form sections 鑰岄潪 demo 鐨?click-to-edit锛岀悊鐢憋細scope 鍙帶 + 缁熶竴缂栬緫 UX锛?
### 璋冪爺涓殑鏂板彂鐜?
**Latent bug: `绀句氦.鍏崇郴[鍚嶇О=X]` filter path 涓嶈鏀寔**

GAP_AUDIT 杩囧幓浠庢湭璇嗗埆锛屾湰娆＄爺绌?NPC chat 瀹炵幇鏃跺彂鐜帮細`stateManager` 浣跨敤 `lodash-es/get/set`锛?*涓嶇悊瑙?`[field=value]` 杩囨护鍣ㄨ娉?*銆傛墍鏈?tianming prompts锛坄core.md`/`opening.md`/`splitGenStep2.md`/`privacyRepair.md`/`worldHeartbeat.md`/`npcChat.md`锛夐兘鍦?AI 鎸囦护涓娇鐢ㄨ繖涓娉?鈥斺€?AI 浜у嚭鐨勬绫诲懡浠や細琚?lodash 閿欒瑙ｆ瀽涓哄瓧闈㈤噺灞炴€у悕锛?*闈欓粯澶辫触**銆?
宸插湪 `CODE_REVIEW_2026-04-11.md:CR-R1` 璁板綍涓?HIGH 浼樺厛绾с€傛湰娆?NPC chat 瀹炵幇閫氳繃 read-full-array 鈫?find-by-name 鈫?modify 鈫?write-full-array 缁曡繃璇ラ棶棰橈紝浣嗗叾浠?NSFW commands / privacy repair commands 浠嶅彈褰卞搷銆傞渶瑕佷笓闂ㄤ竴娆?session 娣诲姞璺緞杩囨护鍣ㄨВ鏋愬櫒銆?
### Code Review

鏈浼氳瘽绱Н鍙樻洿锛圢SFW + API category + 4 涓?gap 淇 + NPC chat锛夊凡瀹屾暣璁板綍鍒?`CODE_REVIEW_2026-04-11.md`锛屽叡璇嗗埆 29 涓?items锛?*4 HIGH / 11 MEDIUM / 14 LOW**銆傛湭绔嬪嵆淇锛坧er `feedback_review_style.md` 瑙勫垯锛夛紝鐣欏緟鍚庣画浼氳瘽澶勭悊銆侶IGH 浼樺厛绾ф寜椤哄簭锛?- **CR-R1** `绀句氦.鍏崇郴[鍚嶇О=X]` 杩囨护鍣ㄨ矾寰勪笉琚?lodash 鐞嗚В锛堝奖鍝?NSFW 鍛戒护 / 绉佽亰鍛戒护 / 鎵€鏈?NPC 鐩稿叧 AI 鍛戒护锛?- **CR-R3** APIPanel 琛ㄥ崟鍏佽绌?apiKey/model 淇濆瓨
- **CR-R2** `ResponseParser` 涓嶈В鏋?`memoryEntry` 瀛楁锛圢pcChatPipeline 璧?fallback 鍐嶈В鏋愶級
- **CR-R4** `ValidationRepairModule.validateArrayItems` 涓嶉€掑綊宓屽瀵硅薄锛圢SFW 绉佸瘑淇℃伅涓嶄細琚?schema validator 鏍￠獙锛?
### TSC + JSON 楠岃瘉

姣忎釜 Phase 瀹屾垚鍚?`npx tsc --noEmit` 鈫?0 閿欒 0 璀﹀憡銆傛墍鏈夋柊澧?淇敼鐨?JSON 鏂囦欢锛坰chema / manifest / flow锛夐€氳繃 `JSON.parse` 楠岃瘉銆?
### 鏂囦欢娓呭崟

**鏂板缓 (5)锛?*
- `src/engine/pipeline/sub-pipelines/npc-chat.ts`
- `src/ui/components/shared/NpcChatModal.vue`
- `public/packs/tianming/prompts/npcChat.md`
- `public/packs/tianming/prompt-flows/npc-chat.json`
- `public/packs/tianming/prompt-flows/opening-scene-step1.json`
- `public/packs/tianming/prompt-flows/opening-scene-step2.json`
- `CODE_REVIEW_2026-04-11.md` (new)

**淇敼 (10)锛?*
- `src/engine/core/command-executor.ts` 鈥?璺緞鏍规鐧藉悕鍗?- `src/engine/pipeline/sub-pipelines/character-init.ts` 鈥?schema default merge + split-gen opening
- `src/engine/ai/types.ts` 鈥?UsageType 鏂板 'npc_chat'
- `src/engine/stores/engine-api.ts` 鈥?ALL_USAGE_TYPES + 'npc_chat'
- `src/main.ts` 鈥?CommandExecutor 鐧藉悕鍗?+ NpcChatPipeline 瀹炰緥鍖?+ provide
- `public/packs/tianming/schemas/state-schema.json` 鈥?NPC 瀛楁鎵╁睍
- `public/packs/tianming/manifest.json` 鈥?npcChat flow + opening-scene-step1/2 flows + npcChat/privacyRepair prompts
- `src/ui/components/creation/StepConfirmation.vue` 鈥?emit on toggle change
- `src/ui/views/CreationView.vue` 鈥?confirmation case + splitGen wiring
- `src/ui/components/panels/APIPanel.vue` 鈥?npc_chat USAGE_TYPE_META
- `src/ui/components/panels/RelationshipPanel.vue` 鈥?talk button + NpcChatModal mount + edit form 鎵╁睍

锛堝叡 17 涓枃浠讹級

---

## [2026-04-11] Feature: API 绫诲埆绯荤粺 鈥?鏀寔 SiliconFlow / Cohere / Jina 鐨勫師鐢?Embedding + Rerank 绔偣

**Scope:** 淇涓€涓?*鍗婃垚鍝佸姛鑳?*骞?*琛ラ綈 Engram 瀹岀編杩愯鎵€闇€鐨?API 閰嶇疆鑳藉姏**銆?
**鐢ㄦ埛鍦烘櫙锛?* 鐢ㄦ埛瑕佹帴鍏?SiliconFlow 鐨?rerank 鍜?embedding 鏈嶅姟锛圼鏂囨。](https://docs.siliconflow.cn/cn/api-reference/rerank/create-rerank)锛夛紝SiliconFlow 鐨?rerank 绔偣鏄?`POST /v1/rerank`锛圕ohere 鏍煎紡锛夛紝涓嶆槸 chat completion銆傚綋鍓嶄唬鐮佸畬鍏ㄤ笉鏀寔銆?
---

### Root cause 鈥?涓変釜鐩稿叧闂

**1. `Embedder` 鑷姩璇嗗埆 + 纭紪鐮佽矾寰勶紙鍗婂伐浣滐級**
- `buildEmbeddingEndpoint` 鎸?URL 閲?`cohere.ai`/`ollama` 绛夊叧閿瘝杩斿洖涓嶅悓璺緞锛孲iliconFlow 鍛戒腑 `openai` 鍒嗘敮锛坄/v1/embeddings`锛夆啋 **鍑戝阀鑳界敤**锛屽洜涓?SiliconFlow embedding 瀹屽叏 OpenAI 鍏煎
- 浣嗘病鏈夋敮鎸佽嚜瀹氫箟璺緞瑕嗙洊鏈哄埗锛岄亣鍒伴潪鏍囧噯璺緞鐨?provider 鏃犺В

**2. `Reranker` 鐢?LLM 鍋囪 rerank锛堝畬鍏ㄤ笉宸ヤ綔锛?*
- [reranker.ts:80-98](src/engine/memory/engram/reranker.ts) 鐨?`callRerankAPI` 鎶?rerank 璇锋眰鍖呰鎴?`messages: [{ role: 'user', content: JSON.stringify({task:'rerank',...}) }]`
- 璧?`aiService.generate` 鈫?chat completion 绔偣
- **姘歌繙涓嶄細**鍛戒腑鐪熸鐨?`/v1/rerank`
- 瀵?SiliconFlow/Cohere/Jina 杩欑被涓撶敤 rerank 鏈嶅姟锛氳姹傚彂鍒?`/v1/chat/completions` 鈫?HTTP 404 鈫?Reranker fallback 鍒?`fallbackSort`锛堟寜鍘熷 vector/graph score 鎺掑簭锛夛紝rerank 鍔熻兘瀹屽叏澶辨晥

**3. `getRerankEndpointUrl()` 鏄浠ｇ爜**
- [engine-api.ts:162](src/engine/stores/engine-api.ts) 鏈変竴涓敮鎸?`customRoutingPath` 鐨勫嚱鏁帮紝浣?grep 鍏?src 闆惰皟鐢ㄧ偣
- UI 涔熸病鏈夋毚闇?`useCustomRouting` / `customRoutingPath` 瀛楁缁欑敤鎴峰～

**4. APIPanel 娌℃硶鍖哄垎 API 鐢ㄩ€?*
- 鎵€鏈?API 閮界敤鍚屼竴涓〃鍗曪紙provider/url/apiKey/model/temperature/maxTokens锛夛紝鍗充娇鏄?embedding/rerank 涔熺‖濉?temperature 杩欑鏃犳剰涔夊瓧娈?- 鍔熻兘鍒嗛厤涓嬫媺妗嗕笉鍋氱被鍒鏌ワ紝鐢ㄦ埛鍙兘鎶?rerank API 鍒嗛厤缁?main 鍥炲悎鎴栧弽杩囨潵

---

### Solution 鈥?API 绫诲埆绯荤粺锛堣璁′笁閫変竴锛屽弬鑰?demo 鐨?useCustomRouting 浣嗕笉鐓ф惉锛?
鐢ㄦ埛鐨勫師璇濓細"鎴戜滑鍙互涓撻棬缁欏嚭涓€涓猺erank鍜宔mbedding鐨刟pi璁剧疆椤甸潰锛岀敤鎴峰彲浠ラ€氳繃three way toggle 鏉ユ敼鍙樹粬浠鏂板缓/閰嶇疆鐨刟pi绫诲瀷"

**鏍稿績鏀瑰姩锛氬紩鍏?`apiCategory: 'llm' | 'embedding' | 'rerank'` 瀛楁**
- `APIConfig` 鏂板鍙€夊瓧娈碉紝榛樿 `'llm'`锛堝悜鍚庡吋瀹规棫閰嶇疆锛?- 寮曟搸鏍规嵁杩欎釜瀛楁鍐冲畾锛?  - `'llm'`: 璧?`aiService.generate()` 鈫?provider 鍐冲畾绔偣
  - `'embedding'`: 璧?`Embedder` 鐩存帴 `fetch('/v1/embeddings')`
  - `'rerank'`: 璧?`Reranker.callNativeRerankAPI()` 鐩存帴 `fetch('/v1/rerank')`锛圕ohere/SiliconFlow 鏍煎紡锛?- UI 鏍规嵁姝ゅ瓧娈碉細
  - 缂栬緫寮圭獥椤堕儴涓夐€変竴 segment锛屽垏鎹㈠悗琛ㄥ崟瀛楁鍔ㄦ€佸彉鍖?  - 鍒楄〃鏄剧ず绫诲埆 badge锛堢传=LLM锛岃摑=Embedding锛岄噾=Rerank锛?  - 鍔熻兘鍒嗛厤涓嬫媺妗嗘寜绫诲埆杩囨护锛坋mbedding usage 鍙樉绀?'embedding' 绫?API锛宔tc.锛?
---

### Phase 1 鈥?APIConfig 绫诲瀷鎵╁睍

**Files changed:**
- `src/engine/ai/types.ts`:
  - 鏂板 `APICategory` type union + JSDoc
  - `APIConfig` 鏂板鍙€?`apiCategory?: APICategory` 瀛楁
  - `APIConfig.temperature/maxTokens` 娉ㄩ噴璇存槑浠?LLM 绫诲埆浣跨敤
  - `APIConfig.customRoutingPath` 娉ㄩ噴璇存槑鐜板湪瀵?embedding/rerank 绫诲埆鐢熸晥
- `src/engine/stores/engine-api.ts`:
  - `loadFromStorage` 涓鎵€鏈夌己澶?`apiCategory` 鐨勬棫閰嶇疆琛ヤ笂 `'llm'`锛堝悜鍚庡吋瀹硅縼绉伙級
  - `default` 閰嶇疆鍒濆鍖栨椂鏄惧紡璁?`apiCategory: 'llm'`

**Backward compat:** 鏃?localStorage 閲岀殑 API 閰嶇疆娌℃湁 `apiCategory` 瀛楁锛屽姞杞芥椂鍏ㄩ儴琚涓?`'llm'`銆傜敤鎴锋棤闇€鎵嬪姩杩佺Щ銆?
---

### Phase 2 鈥?Reranker 閲嶅啓 + Embedder 鏀寔鑷畾涔夎矾寰?
**Files changed:**
- `src/engine/memory/engram/reranker.ts`:
  - 鏂板椤跺眰甯搁噺 `DEFAULT_RERANK_PATH = '/v1/rerank'` + `RERANK_TIMEOUT_MS = 15_000`
  - 鏂板 `buildRerankEndpoint(config)` 宸ュ叿鍑芥暟锛氫紭鍏堜娇鐢?`customRoutingPath`锛屽惁鍒欑敤榛樿 `/v1/rerank`
  - `callRerankAPI` 鏀瑰悕涓?`rerank` 鏂规硶鍐呯殑鍒嗘敮閫昏緫锛氭寜 `config.apiCategory` 鍐冲畾璧?`callNativeRerankAPI`锛堢湡 rerank 绔偣锛夎繕鏄?`callLLMRerankAPI`锛堝悜鍚庡吋瀹圭殑 LLM 鍋囪 rerank锛?  - 鏂板 `callNativeRerankAPI(config, query, candidates, topK)`锛?    - 鐩存帴 `fetch(endpoint, { method: 'POST', headers: {Authorization: Bearer ...}, body })`
    - Body 鏍煎紡锛歚{ model, query, documents, top_n, return_documents: false }`锛圕ohere/SiliconFlow 鍏煎锛?    - 15s 瓒呮椂 + AbortController
  - 鏂板 `parseNativeRerankResponse`锛氳В鏋?`{ results: [{ index, relevance_score }] }` 鏍煎紡锛屾寜 index 鏄犲皠鍥?candidates锛岃繃婊ゆ棤鏁?index 鍜?NaN 鍒嗘暟锛屾寜 rerankScore 闄嶅簭 slice(topK)
  - 鍘?`parseRerankResponse` 閲嶅懡鍚嶄负 `parseLLMRerankResponse`锛堜粎鐢ㄤ簬 LLM 鍋囪璺緞锛?
- `src/engine/memory/engram/embedder.ts`:
  - `buildEmbeddingEndpoint` 鏂板"楂樼骇瑕嗙洊"浼樺厛绾э細
    1. 鑻?`useCustomRouting=true` 涓?`customRoutingPath` 闈炵┖ 鈫?鐢ㄥ畠鏇夸唬榛樿璺緞
    2. 鍚﹀垯鎸?`detectEmbeddingFormat` 鐨?provider 鏍煎紡閫夐粯璁よ矾寰?  - 淇濇寔鍘熸湁 `cohere 鈫?/v1/embed`, `openai/ollama 鈫?/v1/embeddings` 鑷姩妫€娴嬮€昏緫涓嶅彉

---

### Phase 3 鈥?APIPanel 缂栬緫寮圭獥涓夐€変竴 + 鍔ㄦ€佸瓧娈?
**Files changed:**
- `src/ui/components/panels/APIPanel.vue`:
  - import 鏂板 `APICategory`
  - `APIFormData` 鎺ュ彛鏂板 `apiCategory` + `useCustomRouting` + `customRoutingPath`
  - 鏂板 `CATEGORY_META` 鏄犲皠锛堟瘡绫荤殑 label + desc锛?  - 鏂板 `CATEGORY_OPTIONS` 鏁扮粍锛堟覆鏌?segment 鐢級
  - `openAddModal` / `openEditModal` 鍒濆鍖?杞藉叆 apiCategory 瀛楁锛堢紪杈戞棫閰嶇疆鏃堕粯璁?`'llm'`锛?  - 鏂板 `onCategoryChange()`锛氬垏鎹㈢被鍒椂閲嶇疆鏃犲叧瀛楁锛堝垏鍒?LLM 鎭㈠ provider锛屽垏鍒?embedding/rerank 璁?provider=custom + temperature/maxTokens=0锛?  - 妯℃澘鏀归€狅細
    - 寮圭獥椤堕儴鏂板涓夐€変竴 segment锛圠LM / Embedding / Rerank锛? 涓嬫柟鎻忚堪鏂囨湰
    - `v-if="form.apiCategory === 'llm'"` 鎺у埗 provider 閫夋嫨鍣ㄦ樉绀?    - URL 杈撳叆妗嗘牴鎹被鍒樉绀轰笉鍚?placeholder 鍜?hint锛坋mbedding/rerank 绫诲埆棰濆鎻愮ず浼氳嚜鍔ㄦ嫾 /v1/embeddings 鎴?/v1/rerank锛?    - Model 杈撳叆妗嗘牴鎹被鍒樉绀轰笉鍚?placeholder锛坄BAAI/bge-reranker-v2-m3` / `BAAI/bge-m3` / `gpt-4o`锛?    - 娓╁害/maxTokens 鍙湪 LLM 绫诲埆鏄剧ず
    - embedding/rerank 绫诲埆涓嬫柊澧?`<details>` 鎶樺彔鐨?楂樼骇閫夐」"锛歝heckbox + 鑷畾涔夎矾寰勮緭鍏?  - CSS 鏂板锛?    - `.category-segment` + `.category-segment__btn` 涓夐€変竴鎺т欢鏍峰紡
    - `.form-hint` + `.form-hint code` 璇存槑鏂囨湰鏍峰紡
    - `.form-advanced` 鎶樺彔鍖烘牱寮?    - `.form-checkbox` 澶嶉€夋闂磋窛

---

### Phase 4 鈥?API 鍒楄〃鏄剧ず绫诲埆 badge

**Files changed:**
- `src/ui/components/panels/APIPanel.vue`:
  - API 鍗＄墖鏍囬鍖烘柊澧炵被鍒?badge锛屾樉绀?`LLM`/`Embedding`/`Rerank`
  - Provider badge (`api-provider`) 鍙湪 LLM 绫诲埆鏄剧ず锛堝惁鍒欐棤鎰忎箟锛?  - API 璇︽儏鍖?`娓╁害` 琛屽彧鍦?LLM 绫诲埆鏄剧ず锛坋mbedding/rerank 涓嶇敤娓╁害锛?  - CSS `.api-category-badge` 涓夎壊涓婚锛歀LM 绱?/ Embedding 钃?/ Rerank 閲?
---

### Phase 5 鈥?鍔熻兘鍒嗛厤涓嬫媺妗嗘寜绫诲埆杩囨护

**Files changed:**
- `src/ui/components/panels/APIPanel.vue`:
  - 鏂板 `requiredCategoryFor(type: UsageType): APICategory` 鍑芥暟锛坋mbedding鈫抏mbedding, rerank鈫抮erank, 鍏朵粬鈫抣lm锛?  - 鏂板 `getAssignableAPIs(type: UsageType): APIConfig[]`锛氬彧杩斿洖 `apiCategory` 鍖归厤鐨?API锛?*渚嬪**锛氬綋鍓嶅凡鍒嗛厤鐨?API 鍗充娇绫诲埆涓嶅尮閰嶄篃淇濈暀鍦ㄥ垪琛紙鍚﹀垯 dropdown 绌虹櫧锛岀敤鎴风湅涓嶅埌璀﹀憡锛?  - 鏂板 `isApiCategoryMismatch(api, type)`锛氬垽鏂槸鍚﹂渶瑕佹樉绀鸿鍛?  - 涓変釜 assignment 涓嬫媺妗嗭紙蹇呴€?鍙€?RAG锛夊叏閮ㄦ敼涓?`v-for="api in getAssignableAPIs(type)"`
  - 涓嶅尮閰嶇殑 API 鍚嶇О鍚庤拷鍔?`鈿?绫诲埆涓嶅尮閰峘
  - RAG 缁勬柊澧?`<span class="assign-group-hint">` 鎻愮ず鐢ㄦ埛"闇€瑕佸厛鍒涘缓 Embedding/Rerank 绫诲埆鐨?API"
  - RAG 缁勭殑 dropdown 涓虹┖鏃舵樉绀?`鈥?鏆傛棤鍖归厤绫诲埆鐨?API 鈥擿 鍗犱綅
  - `USAGE_TYPE_META` 琛ラ綈涔嬪墠閬楁紡鐨?`privacy_repair: { label: '鎵╁睍瀛楁淇', group: 'optional' }`
  - CSS 鏂板 `.assign-group-hint` 鏍峰紡

---

### Phase 6 鈥?杩炴帴娴嬭瘯鎸夌被鍒彂閫佷笉鍚岃姹?
**Files changed:**
- `src/engine/ai/ai-service.ts`:
  - `testConnection` 鍙傛暟鏂板 `apiCategory?: 'llm'|'embedding'|'rerank'` + `customRoutingPath?: string`
  - 鎸夌被鍒瀯寤轰笉鍚岀殑 endpoint + body + 鍝嶅簲鏍￠獙鍣細
    - **LLM**: POST `/v1/chat/completions`, body `{model, messages:[{role:'user',content:'璇蜂粎杈撳嚭鏁板瓧 1'}], max_tokens:10}`, 楠岃瘉 `choices[0].message.content`
    - **Embedding**: POST `/v1/embeddings`, body `{model, input:'杩炴帴娴嬭瘯'}`, 楠岃瘉 `data[0].embedding` 鏄暟缁?    - **Rerank**: POST `/v1/rerank`, body `{model, query:'杩炴帴娴嬭瘯', documents:['foo','bar'], top_n:2}`, 楠岃瘉 `results` 鏄暟缁?  - embedding/rerank 鏀寔 `customRoutingPath` 瑕嗙洊榛樿璺緞

- `src/ui/components/panels/APIPanel.vue`:
  - `testConnection(api)` 璋冪敤澧炲姞 `apiCategory: api.apiCategory ?? 'llm'` 鍜?`customRoutingPath: api.useCustomRouting ? api.customRoutingPath : undefined` 鍙傛暟

---

### 鐢ㄦ埛浣跨敤娴佺▼绀轰緥锛圫iliconFlow 鎺ュ叆锛?
1. **娣诲姞 Embedding API**锛?   - 鐐瑰嚮"娣诲姞 API"
   - 绫诲埆閫?`Embedding`
   - 鍚嶇О锛歚SiliconFlow Embedding`
   - URL锛歚https://api.siliconflow.cn`
   - API Key锛歚sk-xxx`
   - Model锛歚BAAI/bge-m3`
   - 淇濆瓨 鈫?鐐瑰嚮娴嬭瘯杩炴帴锛堝疄闄呬細 POST 鍒?`/v1/embeddings`锛?
2. **娣诲姞 Rerank API**锛?   - 绫诲埆閫?`Rerank`
   - URL锛歚https://api.siliconflow.cn`锛堝拰 embedding 鍏辩敤 base锛屼絾鐙珛閰嶇疆鍥犱负 model 涓嶅悓锛?   - Model锛歚BAAI/bge-reranker-v2-m3`
   - 淇濆瓨 鈫?娴嬭瘯杩炴帴锛圥OST `/v1/rerank`锛?
3. **鍔熻兘鍒嗛厤**锛?   - 杩涘叆"鍔熻兘鍒嗛厤"寮圭獥
   - RAG 闃舵涓?`鍚戦噺鍖朻 鐨?dropdown 鍙樉绀?`SiliconFlow Embedding`
   - `閲嶆帓搴廯 鐨?dropdown 鍙樉绀?`SiliconFlow Rerank`
   - 鑷姩杩囨护锛屾棤娉曡閰?
4. **Engram 杩愯**锛?   - hybrid 妫€绱㈡椂 `Embedder.embed()` 鈫?POST SiliconFlow `/v1/embeddings`
   - `Reranker.rerank()` 鈫?`callNativeRerankAPI` 鈫?POST SiliconFlow `/v1/rerank` 鈫?瑙ｆ瀽 Cohere 鏍煎紡鍝嶅簲 鈫?杩斿洖鐪熸鐨?rerank 缁撴灉

---

### 鍚戝悗鍏煎鎬?
1. **鏃?API 閰嶇疆**锛歭ocalStorage 閲屾病鏈?`apiCategory` 瀛楁鐨勯厤缃紝`loadFromStorage` 鑷姩琛?`'llm'`
2. **涔嬪墠鍒嗛厤缁?rerank 鐨?LLM API**锛歚Reranker` 妫€娴嬪埌 `apiCategory !== 'rerank'` 鏃?fallback 鍒?`callLLMRerankAPI`锛堝師鏈夌殑"LLM 鍋囪 rerank"閫昏緫锛夛紝涓嶄細绐佺劧宕╂簝
3. **涔嬪墠鍒嗛厤缁?embedding 鐨?API**锛歚Embedder` 鍘熸湰灏辨湁鐙珛 fetch 璺緞锛岀户缁伐浣?4. **UI 鍒楄〃**锛氭棫閰嶇疆鏄剧ず `LLM` badge锛堥粯璁ゅ€硷級
5. **TypeScript**锛歚apiCategory` 鏄彲閫夊瓧娈碉紝鏃т唬鐮佺紪璇戦€氳繃

---

### TSC 楠岃瘉

瀹屾暣淇鍚?`npx tsc --noEmit` 鈫?0 閿欒 0 璀﹀憡锛堟瘡涓?phase 瀹屾垚鍚庢鏌ヤ竴娆?+ 鏈€缁堟鏌ワ級

---

### 鏂囦欢娓呭崟锛? 涓慨鏀癸紝0 涓柊寤猴級

- `src/engine/ai/types.ts` 鈥?APICategory 绫诲瀷 + APIConfig.apiCategory 瀛楁
- `src/engine/stores/engine-api.ts` 鈥?鍚戝悗鍏煎杩佺Щ + 榛樿閰嶇疆
- `src/engine/memory/engram/reranker.ts` 鈥?鍙岃矾寰?rerank 瀹炵幇 + Cohere/SiliconFlow 鍝嶅簲瑙ｆ瀽
- `src/engine/memory/engram/embedder.ts` 鈥?鑷畾涔夎矾寰勮鐩栨敮鎸?- `src/engine/ai/ai-service.ts` 鈥?`testConnection` 鎸夌被鍒彂閫?- `src/ui/components/panels/APIPanel.vue` 鈥?涓夐€変竴 segment + 绫诲埆 badge + dropdown 杩囨护 + 娴嬭瘯璋冪敤浼犲弬

锛堝叡 6 涓枃浠讹紝涔嬪墠棰勪及 6 涓枃浠?鈥?瀹為檯鐩哥锛?
---

### 宸茬煡鐨勫悗缁敼杩涚┖闂达紙闈炴湰娆¤寖鍥达級

1. **Rerank 妯″瀷棰勮鍒楄〃**锛氱洰鍓?model 杈撳叆妗嗘槸鑷敱鏂囨湰锛屾湭鏉ュ彲鎺ュ叆 SiliconFlow `/v1/models` 骞舵寜 category 鑷姩杩囨护 rerank/embedding 妯″瀷
2. **鑷畾涔?provider format**锛氱洰鍓?Reranker 鍙敮鎸?Cohere 鏍煎紡銆傝嫢鏈潵鎺ュ叆闈?Cohere 鏍煎紡鐨?rerank 鏈嶅姟锛堝鏌愪簺 Jina 鍙樹綋锛夛紝闇€瑕佸紩鍏?provider format 妫€娴?3. **閿欒澶勭悊澧炲己**锛歳erank API 杩斿洖 5xx 鏃剁殑鑷姩閲嶈瘯鐩墠渚濊禆 Reranker 鐨?try/catch fallback锛屽彲杩涗竴姝ュ仛鎸囨暟閫€閬?
---

## [2026-04-11] Fix: SettingsPanel TDZ 閿欒瀵艰嚧鎵€鏈夎缃?tab 鐐瑰嚮宕╂簝

**Flow:** 娓告垙涓?鈫?鐐瑰嚮璁剧疆鎸夐挳 鈫?SettingsPanel 鎸傝浇

**Symptom:** 娴忚鍣ㄦ帶鍒跺彴鎶?```
SettingsPanel.vue:193 Uncaught (in promise) ReferenceError:
  Cannot access 'isLoaded' before initialization
```
闅忓悗绾ц仈鎶涘嚭澶氫釜 Vue 鍐呴儴閿欒锛坄Cannot read properties of null (reading 'component')`銆乣Cannot destructure property 'el' of 'vnode' as it is null` 绛夛級锛屽洜涓?setup() 鎶涢敊鍚?vnode 鎸傝浇澶辫触銆?
**Root cause:** 涓婁竴娆?NSFW 鍔熻兘瀹炵幇鏃讹紝鎴戞妸 NSFW 璁剧疆浠ｇ爜鍧楃敤 `// 鈹€鈹€鈹€ B.2.1 Action Options` 浣滀负閿氱偣鎻掑叆锛屼絾褰撴椂娌℃剰璇嗗埌 `const { isLoaded, get, setValue } = useGameState()` 鏄湪 `// 鈹€鈹€鈹€ B.2.2 Heartbeat` 鑺傦紙閿氱偣涔嬪悗锛夋墠瑙ｆ瀯鐨勩€傜粨鏋滐細

- 绗?128-197 琛岋紙NSFW 鍧楋級寮曠敤 `isLoaded.value` 鍜?`setValue(...)`
- 绗?230 琛屾墠瑙ｆ瀯鍑?`isLoaded` / `setValue`
- setup() 鎵ц鍒?`watch(() => isLoaded.value, ...)` 鏃?`isLoaded` 杩樺湪 TDZ锛坱emporal dead zone锛夛紝鎶涘嚭 ReferenceError

杩欐槸**绾綅缃敊璇?* 鈥?閫昏緫瀹屽叏姝ｇ‘锛屽彧鏄湪閿欒鐨勫湴鏂广€俆SC 娌℃鏌ュ嚭鏉ユ槸鍥犱负 TypeScript 鐨?block-level 鍒嗘瀽鎶?`const` 澹版槑瑙嗕负 hoist 鍚庣殑 binding锛孴DZ 鏄繍琛屾椂妫€鏌ャ€?
**Files changed:**
- `src/ui/components/panels/SettingsPanel.vue`:
  - 鍒犻櫎閿欎綅鐨?NSFW 浠ｇ爜鍧楋紙鍘熺 113-197 琛岋級
  - 鍦?`const { isLoaded, get, setValue } = useGameState();` 涔嬪悗閲嶆柊鎻掑叆鍚屼竴浠ｇ爜鍧?  - 鏂板潡寮€澶村鍔犳敞閲婅鏄?*涓轰粈涔堝繀椤绘斁鍦ㄨ繖閲?*锛岄槻姝互鍚庡啀琚敊缃?
**Behavior before:** 鎵撳紑璁剧疆闈㈡澘绔嬪嵆宕╂簝锛屾墍鏈?tab 閮戒笉鍙敤

**Behavior after:** 璁剧疆闈㈡澘姝ｅ父鏄剧ず锛孨SFW 鍖哄潡涓?Heartbeat/NPC 鍖哄潡涓€璧峰伐浣?
**Notes:**
- `isLoaded` 鐨勫紩鐢ㄤ綅缃細206锛坙oadNsfwSettings锛夈€?18锛坰aveNsfwSettings锛夈€?30锛坵atch锛夊叏閮ㄥ湪 144 琛屽０鏄庝箣鍚?鈥?TDZ 瑙ｅ喅
- TSC 鏃犳硶鎹曡幏杩欑被 TDZ 閿欒锛屽彧鑳介潬杩愯鏃躲€傝繖涔熸槸涓轰粈涔堝簲璇ユ€绘槸鍦ㄥ紑鍙戜腑鍔犺浇鍙楀奖鍝嶉〉闈㈠仛 smoke test锛堟湰娆?NSFW 瀹炵幇閬楁紡浜嗚繖涓€姝ワ級
- 鏋舵瀯鎬ч槻鎶ゆ€濊€冿細鏈潵鍙€冭檻灏?settings 妯″潡鎷嗗垎涓哄涓?composable 鏂囦欢锛堝 `useNsfwSettings.ts`锛夛紝閬垮厤鍦ㄥ崟涓?SFC 鍐呭洜鎻掑叆椤哄簭瀵艰嚧 TDZ

---

## [2026-04-11] NSFW 鏍稿績鍔熻兘瀹屾暣瀹炵幇锛圙AP_AUDIT 搂11.2 A+B+C锛?
**Scope:** 鐢ㄦ埛鏄庣‘鏍囪 NSFW 涓?娓告垙鏍稿績鍔熻兘"锛岃姹傚仛瀹屾暣鐨勮璁′笌瀹炵幇銆傛湰鏉＄洰璁板綍浠?design discussion 鈫?decision 鈫?15-phase 瀹炵幇鐨勫叏杩囩▼銆傚搴旇璁¤璁鸿鏈細璇濈涓€杞璇濓紙鐢ㄦ埛鍐崇瓥 6 椤癸級銆?
**瑕嗙洊 GAP_AUDIT 涓変釜瀛愰」锛?*
- **A锛圥rompt 灞傚墺绂伙紝寮€鍚椂蹇呴』姝ｅ父宸ヤ綔锛?*锛氱敤 `[绉佸瘑] / [/绉佸瘑]` tag 鍖呰９鎵╁睍瀛楁鎸囦护锛宍nsfwMode=false` 鏃朵粠 messages 绾у埆鍓ョ銆倀ag 鍚嶄负涓枃鑰岄潪 `[NSFW]` 鈥?瑙勯伩鑻辨枃妯″瀷鐨勫叧閿瘝鍐呭杩囨护銆?- **B锛圫chema 蹇呭～ + 杞牎楠?+ B2 鑷姩淇锛?*锛歴tate-schema 鏂板 `瑙掕壊.韬綋` / `绀句氦.鍏崇郴.items.绉佸瘑淇℃伅` 瀹屾暣瀛楁瀹氫箟锛沗CommandExecutionStage` 姣忓洖鍚堟壂鎻忕己澶憋紝`console.warn` + toast 杞鍛?+ 鍐?`ctx.meta.pendingPrivacyRepair`锛沗PrivacyProfileRepairPipeline` 浣滀负鏂板瓙绠＄嚎琚?orchestrator 娑堣垂骞惰嚜鍔ㄨ皟 AI 琛ラ綈锛岄噸璇曟鏁扮敤鎴峰彲閰嶃€?- **C锛堜繚鐣欐暟鎹?+ 涓嶅彂閫佺粰 AI + UI 涓嶉檺锛?*锛氬師濮嬬姸鎬佹爲姘歌繙淇濈暀瀹屾暣鏁版嵁锛沗ContextAssemblyStage` 鍦ㄥ簭鍒楀寲 `GAME_STATE_JSON` 鏃堕€氳繃 JSON.stringify replacer 鎸?key 杩囨护锛坄绉佸瘑淇℃伅`銆乣韬綋`锛夛紱GameVariablePanel 渚濈敤鎴锋槑纭姹備繚鎸佸叏瀛楁鍙锛坉ebug tool 涓嶈繃婊わ級銆?
---

### 璁捐鍐崇瓥锛堢敤鎴锋媿鏉匡級

| # | 鍐崇瓥 | 鐢ㄦ埛閫夋嫨 |
|---|---|---|
| 1 | 瀛樺偍缁撴瀯 | **閫夐」 X 宓屽** 鈥?`绀句氦.鍏崇郴.items.绉佸瘑淇℃伅`锛屼笌 demo parity |
| 2 | Tag 鍚?| **`[绉佸瘑]` / `[/绉佸瘑]`**锛堜腑鏂囪閬胯嫳鏂囧叧閿瘝杩囨护锛?|
| 3 | 閲嶈瘯娆℃暟 | **APIPanel 瀹㈠埗鍖?*锛?-3锛岄粯璁?1锛?|
| 4 | usageType | **鏂板鐙珛 `'privacy_repair'`**锛屼笌 `instruction_generation` 鍒嗙 |
| 5 | 蹇呭～涓ユ牸搴?| **涓瓑 8 瀛楁**锛堟槸鍚︿负澶勫コ/澶勭敺銆佽韩浣撻儴浣嶃€佹€ф牸鍊惧悜銆佹€у彇鍚戙€佹€х櫀濂姐€佹€ф复鏈涚▼搴︺€佹€т氦鎬绘鏁般€佹€т即渚ｅ悕鍗曪級 |
| 6 | 楠岃瘉閫昏緫浣嶇疆 | **绠＄嚎闃舵鍐呰仈**锛堜笉姹℃煋 BehaviorRunner 绛惧悕锛?|

**4 涓潪闃诲灏忓喅绛栵紙鎴戣嚜涓婚€夊畾锛夛細**
- NSFW 璁剧疆鏄?**user-level**锛堝瓨 `localStorage['aga_nsfw_settings']`锛夛紝鍚屾椂鍚屾鍒扮姸鎬佹爲 `绯荤粺.nsfwMode` / `绯荤粺.nsfwGenderFilter` 浣挎湰鍥炲悎绔嬪嵆鐢熸晥锛涜鍙栭『搴忥細鐘舵€佹爲 鈫?localStorage 鈫?榛樿 `false / 'female'`
- **鐘舵€佹爲榛樿鍊?* `nsfwMode=false`锛堝畨鍏ㄩ粯璁わ級锛宍nsfwGenderFilter='female'`锛堜笌 demo 榛樿涓€鑷达級
- **鏃㈠瓨娓告垙鎵撳紑 NSFW 鏃?* 涓嬩竴鍥炲悎楠岃瘉鍣ㄦ娴嬪埌鎵€鏈変笉瀹屾暣 NPC 鈫?涓€娆℃€ф壒閲忎慨澶嶈皟鐢?- **鐜╁娉曡韩 `瑙掕壊.韬綋`** 鍙湅 `nsfwMode`锛屼笉鐪?`nsfwGenderFilter`锛堢帺瀹跺彧鏈変竴涓級

---

### Phase 1 鈥?State schema 鏂板 NSFW 瀛楁

**Files changed:**
- `public/packs/tianming/schemas/state-schema.json`
  - 鏂板 `瑙掕壊.韬綋` 瀹屾暣缁撴瀯锛堣韩楂?浣撻噸/涓夊洿/鏁忔劅鐐?寮€鍙戝害/绾硅韩涓庡嵃璁?鑳搁儴鎻忚堪/绉佸鎻忚堪/鐢熸畺鍣ㄦ弿杩帮級
  - 鏂板 `绀句氦.鍏崇郴.items.properties.鎬у埆` + `绀句氦.鍏崇郴.items.properties.绉佸瘑淇℃伅` 瀹屾暣瀛愬璞★紙12 瀛楁锛屼絾鏍￠獙鏃跺彧涓瓑涓ユ牸搴︽鏌?8 椤癸級
  - 鏂板 `绯荤粺.nsfwMode: boolean default false` + `绯荤粺.nsfwGenderFilter: string enum ['all','male','female'] default 'female'`

---

### Phase 2 鈥?3 涓彁绀鸿瘝鏂囦欢鐢?`[绉佸瘑]` tag 鍖呰９

**Root cause:** `ContentFilterModule` 鐢?`[TAG]...[/TAG]` 姝ｅ垯鍖归厤锛屼絾鐜版湁鎻愮ず璇嶆病鏈?tag 鍖呰９锛孋ontentFilter 杩愯鏃舵壂涓嶅埌浠讳綍涓滆タ鍓ョ銆?
**Files changed:**
- `public/packs/tianming/prompts/opening.md` 鈥?搂11 "鐜╁娉曡韩锛圢SFW锛? 鏁存鐢?`[绉佸瘑]...[/绉佸瘑]` 鍖呰９锛涙爣棰樹粠 "NSFW" 鏀逛负涓€?"鐜╁娉曡韩"
- `public/packs/tianming/prompts/splitGenStep2.md` 鈥?NPC 绉佸瘑淇℃伅娈佃惤 + NPC 瀵硅薄妯℃澘涓殑 `绉佸瘑淇℃伅` 鏉′欢娉ㄩ噴閮界敤 `[绉佸瘑]` 鍖呰９
- `public/packs/tianming/prompts/core.md` 鈥?搂鍗佸叚 鏁磋妭锛圢PC 绉佸瘑淇℃伅 + 鐜╁娉曡韩 + 绂佹浜嬮」 3 灏忚妭锛夌敤 `[绉佸瘑]` 鍖呰９锛汵PC 鍒涘缓妯℃澘涓殑 `绉佸瘑淇℃伅` 鏉′欢娉ㄩ噴鍚屾鍖呰９

---

### Phase 3 鈥?`sanitize-snapshot.ts` 宸ュ叿 + 鎺ュ叆 ContextAssemblyStage

**Files added:**
- `src/engine/memory/snapshot-sanitizer.ts` 鈥?鏂板缓宸ュ叿鏂囦欢锛屼袱缁勫嚱鏁帮細
  - `stringifySnapshotForPrompt(snapshot, nsfwMode, indent)` 鈥?鐢?JSON.stringify replacer 鍦ㄥ簭鍒楀寲杩囩▼涓浂鎷疯礉鍓ョ `绉佸瘑淇℃伅` 鍜?`韬綋` key
  - `stripTagFromMessages(messages, tag)` + `stripTagFromText(text, tag)` 鈥?messages 绾у埆鐨?`[tag]...[/tag]` 姝ｅ垯鍓ョ锛孭romote Assembler 娓叉煋鍚庤繍琛?
**鏋舵瀯鍙戠幇锛?* 鎴戝湪瀹炵幇涓彂鐜?`ContentFilterModule.onContextAssembly(stateManager, variables)` 绛惧悕鍙兘鏀?`variables` dict锛屼絾 `[绉佸瘑]` tag 瀹為檯鍑虹幇鍦?`promptAssembler.assemble()` 涔嬪悗鐨?`messages[].content` 閲岋紙raw prompt 缁忚繃 templateEngine.render 杩涗簡 message content锛夈€俙ContentFilterModule` 瀵?NSFW 鍦烘櫙鏃犳晥銆傛墍浠ユ垜鏂板 `stripTagFromMessages` 宸ュ叿锛屽湪 `ContextAssemblyStage` 閲?assemble 涔嬪悗鐩存帴鍓ョ messages銆俙ContentFilterModule` 淇濈暀鐢ㄤ簬鏈潵鍏朵粬 variable-level 璇勭骇鍓ョ鍦烘櫙銆?
**Files changed:**
- `src/engine/pipeline/stages/context-assembly.ts`:
  - 鏂板 import `stringifySnapshotForPrompt` / `stripTagFromMessages` / `NSFW_STRIP_TAG`
  - `execute()` 涓湪鏋勫缓 `variables` 鏃惰 `绯荤粺.nsfwMode` 鐘舵€侊紝鐢?sanitizer 鐢熸垚 `gameStateJson`
  - `execute()` 鍦?`promptAssembler.assemble()` 涔嬪悗銆乺eturn 涔嬪墠锛岃嫢 `!nsfwMode` 鍒欏 `messages` 鍜?`splitStep2Messages` 璋?`stripTagFromMessages(m, NSFW_STRIP_TAG)`
  - 鍓ョ鍦?`ui:debug-prompt` 浜嬩欢鍙戝皠涔嬪悗 鈥?璋冭瘯闈㈡澘鏄剧ず鍘熸枃锛屽疄闄呭彂 AI 鏄墺绂诲悗鐨勭増鏈紙渚夸簬 debug 瀵规瘮锛?
---

### Phase 4 鈥?`content-filter.json` 鏀圭敤 `[绉佸瘑]` tag

**Files changed:**
- `public/packs/tianming/rules/content-filter.json` 鈥?`promptStripTags` 浠?`["NSFW","ADULT","R18"]` 鏀逛负 `["绉佸瘑"]`锛?description 璇存槑鏀圭敤涓枃 tag 鐨勭悊鐢憋紙瑙勯伩鑻辨枃妯″瀷鍏抽敭璇嶈繃婊わ級

**娉細** 杩欎釜閰嶇疆鐜板湪鐞嗚涓婁粛浼氳 `ContentFilterModule.onContextAssembly` 浣跨敤锛堝幓鎵?`variables`锛夛紝浣嗗涓婃墍杩?NSFW 鍐呭涓嶅湪 variables 閲岋紝鎵€浠ュ NSFW 鍦烘櫙鏄?no-op銆傝繖涓厤缃繚鐣欎笅鏉ヤ负鏈潵鐨勫叾浠?variable-level 璇勭骇鐣欐帴鍙ｃ€?
---

### Phase 5 鈥?`privacy-profile-validator.ts` 鍏变韩宸ュ叿

**Files added:**
- `src/engine/validators/privacy-profile-validator.ts` 鈥?绾?utility锛屽鍑猴細
  - `type NsfwGenderFilter = 'all' | 'male' | 'female'`
  - `interface PrivacyIncompleteReport { npcNames, playerBodyMissing, total }`
  - `isPrivacyProfileComplete(obj)` 鈥?8 瀛楁涓瓑涓ユ牸搴︽鏌ワ紱`鎬т即渚ｅ悕鍗昤 鍏佽绌烘暟缁勶紙澶勫コ/澶勭敺鐘舵€佸悎娉曪級锛屽叾浠栨暟缁勪笉鍏佽绌猴紱璇嗗埆"寰呯敓鎴?/"鏆傛棤"/"鏃?绛夊崰浣?  - `isPlayerBodyComplete(obj)` 鈥?鐜╁娉曡韩 5 蹇呭～锛氳韩楂?浣撻噸/涓夊洿/鏁忔劅鐐?寮€鍙戝害锛涗笁鍥村繀椤诲惈瀛愬瓧娈?  - `readNsfwSettings(stateManager)` 鈥?鐘舵€佹爲 鈫?localStorage 鈫?榛樿鐨?fallback 閾?  - `findIncompletePrivacy(stateManager, paths, genderFilter)` 鈥?鎵弿杩斿洖 report锛涙寜 genderFilter 杩囨护 NPC锛涚帺瀹朵笉杩囨护

**涓轰粈涔堟娊鎴?utility 鑰岄潪 behavior module锛?*
涓や釜璋冪敤鐐?鈥?`CommandExecutionStage`锛堟娴嬭Е鍙戯級鍜?`PrivacyProfileRepairPipeline`锛坮etry 鍒ゅ仠锛夐渶瑕佸鐢ㄧ浉鍚岀殑楠岃瘉閫昏緫銆傜函鍑芥暟渚夸簬娴嬭瘯銆佹棤鐘舵€併€佹棤鍓綔鐢ㄣ€?
---

### Phase 6 鈥?`PrivacyProfileRepairPipeline` 绫?
**Files added:**
- `src/engine/pipeline/sub-pipelines/privacy-profile-repair.ts` 鈥?鏂板瓙绠＄嚎锛?  - `execute(initialReport)` 鈥?鎺ユ敹棣栨 incomplete 鎶ュ憡锛岃繘 retry 寰幆
  - 姣忔寰幆锛氳皟 `runOneAttempt` 鈫?閲嶆柊 `findIncompletePrivacy` 鈫?鍒ゅ仠
  - `maxAttempts = maxRetries + 1`锛堥娆¤皟鐢ㄥ繀瀹氬彂鐢燂紝maxRetries=0 涔熻嚦灏戣皟涓€娆★級
  - 寰幆鍐呬换浣曢敊璇笉閲嶈瘯锛岀‖ break 閫€鍑?  - 鏈€缁堣繑鍥?`{ success, attempts, remaining }` 缁?orchestrator
- `runOneAttempt(report, filter, attempt)`:
  - 缁勮鍙橀噺锛歚NPC_LIST`锛堝惈姣忎釜 NPC 鐨勫悕绉?绫诲瀷/鎬у埆/鎻忚堪/鑳屾櫙锛夈€乣NPC_COUNT`銆乣PLAYER_BODY_MISSING`銆乣GENDER_FILTER`銆乣ATTEMPT_NUMBER`
  - 璋?`promptAssembler.assemble('privacyProfileRepair', variables)`
  - `eventBus.emit('ui:debug-prompt', {...})` 璁?PromptAssemblyPanel 鍙
  - 璋?`aiService.generate({ messages, usageType: 'privacy_repair' })`
  - 瑙ｆ瀽杩斿洖鐨?commands 骞?`commandExecutor.executeBatch`
- `readMaxRetries()` 鈥?浠?`localStorage['aga_ai_settings'].privacyRepairRetries` 璇伙紝榛樿 1

---

### Phase 7 鈥?鏂板 `privacyRepair.md` prompt + flow + manifest

**Files added:**
- `public/packs/tianming/prompts/privacyRepair.md` 鈥?鏂?prompt 鏂囦欢锛屾暣涓唴瀹瑰寘鍦?`[绉佸瘑]` tag 涓紙杩欐牱鍏抽棴 nsfwMode 鏃朵笉浼氳鍙戠粰 AI锛屼絾瀹為檯杩欎釜 prompt 鍙湪 nsfwMode=true 鏃舵墠琚皟鐢紝tag 鏄槻寰℃€х殑锛夈€傚寘鍚細
  - 浠诲姟鎻忚堪锛堜慨澶嶇己澶卞瓧娈?+ 绗?N 娆″皾璇曪級
  - NPC 鍒楄〃灞曠ず锛坄{{NPC_LIST}}`锛?  - 蹇呭～ 8 瀛楁瑙勮寖 + 閫昏緫涓€鑷存€х‖绾︽潫
  - 鐜╁娉曡韩鏉′欢琛ュ厖锛坄{{PLAYER_BODY_MISSING}}`锛?  - 杈撳嚭鏍煎紡瑙勮寖锛堝彧杈?commands锛? 绂佹浜嬮」
- `public/packs/tianming/prompt-flows/privacy-profile-repair.json` 鈥?鏂?flow锛宮odules = `[privacyRepair]`锛堜笉闇€瑕?core 鍥犱负 repair 浠诲姟涓嶆秹鍙婂彊浜嬭鑼冿級

**Files changed:**
- `public/packs/tianming/manifest.json`:
  - `promptFlows` 鏂板 `privacyProfileRepair`
  - `prompts` 鏁扮粍鏂板 `privacyRepair`

---

### Phase 8 鈥?鏂板 `'privacy_repair'` UsageType

**Files changed:**
- `src/engine/ai/types.ts` 鈥?`UsageType` union 鏂板 `'privacy_repair'`锛堟彃鍏ュ湪 `location_npc_generation` 鍜?`embedding` 涔嬮棿锛?- `src/engine/stores/engine-api.ts` 鈥?`ALL_USAGE_TYPES` 鏁扮粍鍚屾鏂板 `'privacy_repair'`

**Behavior:** APIPanel 鐨?鍔熻兘鍒嗛厤"琛ㄦ牸鑷姩鍑虹幇 `privacy_repair` 琛岋紝鐢ㄦ埛鍙粰瀹冨崟鐙厤缃?API锛涗笉閰嶇疆鏃堕粯璁ゅ洖閫€鍒?`default` API銆?
---

### Phase 9 鈥?Validator 鎺ュ叆 CommandExecutionStage

**Files changed:**
- `src/engine/pipeline/stages/command-execution.ts`:
  - import `findIncompletePrivacy` + `readNsfwSettings` + `eventBus`
  - 鏋勯€犲嚱鏁版柊澧?`paths: EnginePathConfig` 鍙傛暟锛堥渶瑕?`paths.relationships`锛?  - `execute()` 鍦?`behaviorRunner.runAfterCommands` 涔嬪悗璋?`runPrivacyValidation(ctx)`
  - `runPrivacyValidation()` 绉佹湁鏂规硶锛?    - `readNsfwSettings` 璇诲綋鍓嶆ā寮忥紱`nsfwMode=false` 鐩存帴杩斿洖
    - `findIncompletePrivacy` 鎵弿锛沗total=0` 鐩存帴杩斿洖
    - `console.warn` 杞鍛?+ `eventBus.emit('ui:toast', { type: 'warning' })` UI 鎻愮ず
    - 鍐?`ctx.meta['pendingPrivacyRepair'] = report`
- `src/engine/core/game-orchestrator.ts:158` 鈥?`CommandExecutionStage` 鏋勯€犺皟鐢ㄦ柊澧炵 4 鍙?`paths`

**鎵弿绛栫暐锛?* 鎵弿鏁翠釜 NPC 鍒楄〃鑰岄潪鍙湅 `changeLog`銆傚師鍥狅細
1. 鐢ㄦ埛棣栨寮€鍚?nsfwMode 鍚庢棦瀛?NPC 涔熼渶瑕佽琛ラ綈锛堟壒閲忎竴娆′慨澶嶏級
2. AI 鍙兘 set 宸插瓨鍦?NPC 鐨勫叾浠栧瓧娈典絾閬楁紡 `绉佸瘑淇℃伅`
3. 鎵弿鎴愭湰浣庯紙瀛楁瀛樺湪鎬ф鏌ワ紝涓嶆秹鍙?AI 璋冪敤锛?
---

### Phase 10 鈥?Orchestrator 娑堣垂 `pendingPrivacyRepair`

**Files changed:**
- `src/engine/core/game-orchestrator.ts`:
  - import `PrivacyProfileRepairPipeline` + `PrivacyIncompleteReport`
  - `SubPipelineBundle` 鎺ュ彛鏂板 `privacyRepair?: PrivacyProfileRepairPipeline`
  - `runPostRoundSubPipelines` 鍦ㄧ 4 姝?NPC 鐢熸垚涔嬪悗鏂板绗?5 姝?绉佸瘑淇℃伅淇"锛?    - 璇?`ctx.meta['pendingPrivacyRepair']` 鑾峰彇 report
    - 璋?`this.subPipelines.privacyRepair.execute(report)`
    - 鎴愬姛鏃?`ui:toast success`锛?.5s锛夛紝澶辫触鏃?`ui:toast warning`锛?s + 鍓╀綑鏁伴噺锛?    - 浠讳綍寮傚父閮?catch 骞?console.error锛屼笉褰卞搷鍏朵粬瀛愮绾?
**鏀惧湪 NPC 鐢熸垚涔嬪悗鐨勫師鍥狅細** npcGeneration 鏂扮敓鎴愮殑 NPC 浼氬湪**涓嬩竴鍥炲悎**鐨?CommandExecutionStage 琚壂鎻忥紙鍥犱负 npcGeneration 鏄?post-round 璋冨害锛屽綋鍓嶅洖鍚堢殑 validator 宸茬粡璺戣繃锛夈€傛墍浠ユ湰鍥炲悎鐨?privacy repair 鍙拡瀵逛富绠＄嚎 AI 鐢熸垚/淇敼鐨?NPC銆?
---

### Phase 11 鈥?`main.ts` 瀹炰緥鍖栦慨澶嶇绾?
**Files changed:**
- `src/main.ts`:
  - import `PrivacyProfileRepairPipeline`
  - 鏂板 `privacyRepairPipeline: PrivacyProfileRepairPipeline | undefined`
  - 鍦?pack 瀛樺湪鐨勫疄渚嬪寲鍧椾腑鏋勯€?`new PrivacyProfileRepairPipeline(stateManager, commandExecutor, aiService, responseParser, promptAssembler, pack, DEFAULT_ENGINE_PATHS)`
  - `GameOrchestrator` 鏋勯€犺皟鐢ㄧ殑 `SubPipelineBundle` 瀵硅薄鏂板 `privacyRepair: privacyRepairPipeline`

---

### Phase 12 鈥?SettingsPanel NSFW section

**Files changed:**
- `src/ui/components/panels/SettingsPanel.vue`:
  - 鏂板 `NSFW_KEY = 'aga_nsfw_settings'` + `NsfwSettings` interface + `defaultNsfw` + `nsfwSettings ref` + `nsfwGenderOptions`
  - `loadNsfwSettings()` 鈥?璇?localStorage锛屽惎鍔ㄦ椂鑻?`isLoaded.value` 鍒欏悓姝ュ埌鐘舵€佹爲
  - `saveNsfwSettings()` 鈥?鍐?localStorage + 鍚屾鐘舵€佹爲
  - `syncNsfwToStateTree()` 鈥?璋?`setValue('绯荤粺.nsfwMode', ...)` / `setValue('绯荤粺.nsfwGenderFilter', ...)` + 瑙﹀彂 `engine:request-save`
  - `watch(() => isLoaded.value, loaded => loaded && syncNsfwToStateTree())` 鈥?娓告垙鍔犺浇鍚庤ˉ涓€娆″悓姝?  - `watch(nsfwSettings, () => saveNsfwSettings(), { deep: true })` 鈥?鑷姩鎸佷箙鍖?  - `onMounted` 鏂板 `loadNsfwSettings()`
  - 妯℃澘鏂板"鎵╁睍鍐呭锛堟垚浜猴級"section锛屽惈锛?    - "鍚敤鎵╁睍鍐呭" toggle锛堣鏄庡紑鍚悗 AI 浼氫负 NPC 鐢熸垚 `绉佸瘑淇℃伅`锛屽叧闂悗鏁版嵁淇濈暀浣嗕笉鍙戦€佺粰 AI锛?    - "鎬у埆杩囨护" select锛坄鍏ㄩ儴鎬у埆 / 浠呯敺鎬?NPC / 浠呭コ鎬?NPC`锛岃鏄庣帺瀹舵硶韬笉鍙楁杩囨护褰卞搷锛?    - 鎬у埆杩囨护鍦?`nsfwMode=false` 鏃?disabled

**鍙屽眰瀛樺偍閫昏緫锛?*
- localStorage (user-level) 纭繚璺ㄥ瓨妗ｆ寔涔呭寲 鈥?鐢ㄦ埛璁剧疆涓€娆″悗鎵€鏈夋柊娓告垙榛樿寮€鍚?- 鐘舵€佹爲 (save-level) 纭繚鏈洖鍚堢珛鍗崇敓鏁?鈥?淇濆瓨鍚庝篃鑳藉洖鏀撅紙璋冭瘯鏃舵湁鐢級
- 璇诲彇椤哄簭锛氱姸鎬佹爲浼樺厛 鈫?localStorage fallback 鈫?榛樿鍊硷紙涓?`readNsfwSettings` 淇濇寔涓€鑷达級

---

### Phase 13 鈥?APIPanel 娣诲姞 privacyRepairRetries 杈撳叆妗?
**Files changed:**
- `src/ui/components/panels/APIPanel.vue`:
  - 鏂板 `privacyRepairRetries = ref<number>(savedSettings.privacyRepairRetries ?? 1)`
  - `saveAISettings()` 鍐欏叆鐨?JSON 瀵硅薄鏂板 `privacyRepairRetries` 瀛楁
  - 妯℃澘"AI 鐢熸垚璁剧疆"section 鍦?Max retries 琛屼箣鍚庢柊澧?鎵╁睍瀛楁淇閲嶈瘯娆℃暟"琛岋紝鍙栧€艰寖鍥?0-3锛屽惈璇存槑鏂囨湰锛堣В閲婇娆″繀瀹氳皟鐢?+ 寤鸿鍊?1锛?
---

### Phase 14 鈥?`readAISettings` 鎵╁睍锛堝疄闄呬负 N/A锛?
璇勪及鍚庡彂鐜?`PrivacyProfileRepairPipeline.readMaxRetries()` 宸茬粡鐩存帴浠?localStorage 璇?`aga_ai_settings.privacyRepairRetries`锛屼笌 APIPanel 鍐欏叆鐨?key 涓€鑷淬€俙GameOrchestrator.readAISettings` 鍙渶瑕佽 `streaming` 鍜?`splitGen`锛堢敤浜庢瘡鍥炲悎鐨勬祦寮忓紑鍏筹級锛屼笉闇€瑕佽 `privacyRepairRetries`锛堥偅鏄瓙绠＄嚎鑷繁鐨勪簨锛夈€傛棤闇€鏀瑰姩銆?
---

### Phase 15 鈥?楠岃瘉

- `npx tsc --noEmit` 鈫?0 閿欒 0 璀﹀憡锛堝娆′腑閫旀鏌?+ 鏈€缁堟鏌ワ級
- JSON 璇硶鏍￠獙閫氳繃锛歴tate-schema.json / manifest.json / privacy-profile-repair.json / content-filter.json

---

### 鍏抽敭鏁版嵁娴侊紙瀹屾暣鍥炲悎绀轰緥锛?
鍋囪 `nsfwMode=true`, `nsfwGenderFilter='female'`锛岀帺瀹惰繘鍏ラ厭棣嗛亣鍒版柊濂虫€?NPC"鏉庡鍎?锛?
1. **涓诲洖鍚?AI 鐢熸垚** 鈫?杩斿洖 commands: `push 绀句氦.鍏崇郴 鈫?{鍚嶇О:"鏉庡鍎?, 鎬у埆:"濂?, 绫诲瀷:"閲嶇偣", ...}`锛堜絾 AI 蹇樹簡甯?`绉佸瘑淇℃伅`锛?2. **CommandExecutionStage.execute**:
   - `commandExecutor.executeBatch` 鎵ц push
   - `behaviorRunner.runAfterCommands` 璺?   - `runPrivacyValidation(ctx)`:
     - `readNsfwSettings` 鈫?`nsfwMode=true, filter='female'`
     - `findIncompletePrivacy` 鎵弿 NPC 鈫?鏉庡鍎挎€у埆濂崇鍚?filter锛宍绉佸瘑淇℃伅=undefined`锛屾姤鍛?`{npcNames:['鏉庡鍎?], playerBodyMissing:false, total:1}`
     - `console.warn` + `ui:toast` warning
     - 鍐?`ctx.meta.pendingPrivacyRepair = report`
3. **PostProcessStage** 姝ｅ父璺戝畬锛堣蹇嗚拷鍔犮€佸彊浜嬪巻鍙层€乤uto-save锛?4. **PipelineRunner.run() 杩斿洖**
5. **GameOrchestrator.runPostRoundSubPipelines**:
   - 绗?1-4 姝ユ寜鍘熼€昏緫
   - **绗?5 姝?*: 璇诲埌 `pendingPrivacyRepair`锛岃皟 `subPipelines.privacyRepair.execute(report)`:
     - `readNsfwSettings` 鍐嶇‘璁?     - `maxRetries = readMaxRetries()` 鈫?榛樿 1
     - `while report.total > 0 && attempts < 2`:
       - Attempt 1:
         - `buildNpcListVariable(['鏉庡鍎?])` 鈫?鎷煎嚭鍚潕濠夊効鍚嶇О/绫诲瀷/鎬у埆/鎻忚堪/鑳屾櫙鐨?markdown
         - `promptAssembler.assemble(privacyProfileRepair, variables)` 鈫?prompt 鍖呭惈 `[绉佸瘑]` tag锛堜絾鏈璋冪敤 nsfwMode=true锛屼笉浼氳 strip锛?         - `eventBus.emit('ui:debug-prompt')` 鈫?PromptAssemblyPanel 鍙
         - `aiService.generate({messages, usageType: 'privacy_repair'})` 鈫?鐢ㄤ笓闂ㄧ殑 API 璺敱
         - 瑙ｆ瀽 commands锛歚[{action:'set', path:'绀句氦.鍏崇郴[鍚嶇О=鏉庡鍎縘.绉佸瘑淇℃伅', value:{...}}]`
         - `commandExecutor.executeBatch` 搴旂敤
       - `findIncompletePrivacy` 閲嶆柊鎵弿 鈫?`total=0` 鈫?閫€鍑哄惊鐜?   - 杩斿洖 `{success:true, attempts:1}`
   - `ui:toast success "鎵╁睍瀛楁宸茶嚜鍔ㄨˉ榻?`

**涓嬩竴鍥炲悎 AI** 鐪嬪埌 `GAME_STATE_JSON` 鍚潕濠夊効瀹屾暣 `绉佸瘑淇℃伅`锛堝洜涓?nsfwMode=true锛宻anitizer passthrough锛夛紝鍙户缁敓鎴愮鍚堣瀹氱殑浜掑姩鍐呭銆?
**鍏抽棴 nsfwMode 鍚庣殑琛屼负**锛?- 鍘熺姸鎬佹爲渚濈劧鍚潕濠夊効 `绉佸瘑淇℃伅`
- 涓嬩竴鍥炲悎 `ContextAssemblyStage` 鏋勫缓 `GAME_STATE_JSON` 鏃剁敤 `stringifySnapshotForPrompt(snapshot, false)` 鈫?replacer 鍓ョ `绉佸瘑淇℃伅` 鍜?`韬綋` 鈫?AI 鐪嬪埌鐨勬槸鍒犲噺鐗?- `ContextAssemblyStage` 鍦?`promptAssembler.assemble` 涔嬪悗璋?`stripTagFromMessages` 鈫?`[绉佸瘑]...[/绉佸瘑]` 娈佃惤琚垹闄?鈫?AI 鐪嬪埌鐨?prompt 閲屾病鏈夎姹傜敓鎴愮瀵嗕俊鎭殑浠讳綍鎸囦护
- `CommandExecutionStage.runPrivacyValidation` 瑙?`nsfwMode=false` 鐩存帴杩斿洖 鈫?涓嶈Е鍙戜慨澶?- GameVariablePanel 渚濈劧鏄剧ず瀹屾暣鐘舵€佹爲锛堢敤鎴锋槑纭姹傦級

---

### 鏋舵瀯鍥?
```
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?鐢ㄦ埛鍦?SettingsPanel 鍒囨崲 NSFW toggle                       鈹?鈹?  鈹溾攢 鍐?localStorage['aga_nsfw_settings']                   鈹?鈹?  鈹斺攢 閫氳繃 setValue 鍐欑姸鎬佹爲 绯荤粺.nsfwMode                    鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                          鈹?                          鈻?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?涓诲洖鍚?PipelineRunner.run()                                  鈹?鈹?                                                             鈹?鈹? ContextAssemblyStage.execute                                鈹?鈹?   鈹溾攢 璇?stateManager.get('绯荤粺.nsfwMode')                   鈹?鈹?   鈹溾攢 stringifySnapshotForPrompt (鑻?false 鍓ョ privacy/韬綋)鈹?鈹?   鈹溾攢 promptAssembler.assemble                               鈹?鈹?   鈹溾攢 eventBus.emit('ui:debug-prompt') 鈫?璋冭瘯闈㈡澘鐪嬪師鏂?     鈹?鈹?   鈹斺攢 stripTagFromMessages (鑻?false 鍓ョ [绉佸瘑] 娈佃惤)       鈹?鈹?                                                             鈹?鈹? AICallStage.execute 鈫?aiService.generate                    鈹?鈹?                                                             鈹?鈹? CommandExecutionStage.execute                               鈹?鈹?   鈹溾攢 commandExecutor.executeBatch                           鈹?鈹?   鈹溾攢 behaviorRunner.runAfterCommands                        鈹?鈹?   鈹斺攢 runPrivacyValidation (鑻?nsfwMode=true 鎵弿鍐?flag)    鈹?鈹?                                                             鈹?鈹? PostProcessStage 鈫?memory + autoSave                        鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                          鈹?                          鈻?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?GameOrchestrator.runPostRoundSubPipelines                    鈹?鈹?                                                             鈹?鈹? 璇?ctx.meta.pendingPrivacyRepair                            鈹?鈹?   鈹?                                                        鈹?鈹?   鈹斺攢 PrivacyProfileRepairPipeline.execute(report)           鈹?鈹?        鈹斺攢 while remaining.total > 0 && attempts < maxTries: 鈹?鈹?            鈹溾攢 runOneAttempt:                                鈹?鈹?            鈹?  鈹溾攢 鏋勫缓 NPC_LIST 鍙橀噺                        鈹?鈹?            鈹?  鈹溾攢 promptAssembler.assemble(privacyRepair)   鈹?鈹?            鈹?  鈹溾攢 eventBus.emit('ui:debug-prompt')          鈹?鈹?            鈹?  鈹溾攢 aiService.generate(usageType:privacy_repair)鈹?鈹?            鈹?  鈹斺攢 commandExecutor.executeBatch              鈹?鈹?            鈹斺攢 findIncompletePrivacy 閲嶆柊鎵弿鍒ゅ仠             鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?```

---

### 鏂囦欢娓呭崟锛堟湰娆?Phase 鍚堣 17 涓枃浠?+ 4 鏂板缓锛?
**鏂板缓锛? 涓級锛?*
- `src/engine/memory/snapshot-sanitizer.ts`
- `src/engine/validators/privacy-profile-validator.ts`
- `src/engine/pipeline/sub-pipelines/privacy-profile-repair.ts`
- `public/packs/tianming/prompts/privacyRepair.md`
- `public/packs/tianming/prompt-flows/privacy-profile-repair.json`

**淇敼锛?2 涓級锛?*
- `public/packs/tianming/schemas/state-schema.json`
- `public/packs/tianming/manifest.json`
- `public/packs/tianming/rules/content-filter.json`
- `public/packs/tianming/prompts/opening.md`
- `public/packs/tianming/prompts/splitGenStep2.md`
- `public/packs/tianming/prompts/core.md`
- `src/engine/pipeline/stages/context-assembly.ts`
- `src/engine/pipeline/stages/command-execution.ts`
- `src/engine/core/game-orchestrator.ts`
- `src/main.ts`
- `src/engine/ai/types.ts`
- `src/engine/stores/engine-api.ts`
- `src/ui/components/panels/SettingsPanel.vue`
- `src/ui/components/panels/APIPanel.vue`

---

## [2026-04-11] GAP_AUDIT 鍏ㄩ潰淇锛圥hase A + B + C锛?
**Scope:** 涓€娆℃€т慨澶?`implementation-plan/GAP_AUDIT_2026-04-11.md` 涓瘑鍒殑鍏ㄩ儴 gap锛堥櫎鐣欑粰鐢ㄦ埛鍐崇瓥鐨?action queue 鎵╁睍銆丯SFW runtime 绾ц仈銆乻chema migration 绛夛紝璇﹁ GAP_AUDIT 搂13 鍒嗛樁娈靛缓璁級銆?
**Flow 娑电洊锛?* 涓荤绾?鈫?sub-pipelines 鈫?琛屼负妯″潡 鈫?璁板繂涓夊眰 鈫?鍒涜 鈫?PromptAssemblyPanel 璋冭瘯

鏈鏄郴缁熸€?wiring 淇锛屼笉鏄崟鐐?bug fix銆傚垎缁勮褰曞涓嬶細

---

### Phase A0: `DEFAULT_ENGINE_PATHS.npcList` 鎸囧悜瀛ゅ効璺緞

**Root cause:** `types.ts:330` 瀹氫箟 `npcList: 'NPC鍒楄〃'`锛屼絾 tianming 瀹為檯鎶?NPC 瀛樺湪 `绀句氦.鍏崇郴`锛坄opening.md` / `core.md` / `RelationshipPanel` 閮借鍐欐璺緞锛夈€俙NPC鍒楄〃` 鏄?`state-schema.json:267` 閲岀殑瀛ゅ効椤跺眰瀛楁锛屼粠鏈 AI 鎴?UI 鐪熸浣跨敤銆俙WorldHeartbeatPipeline.findNpcList()` 鍜?`NpcGenerationPipeline.findGlobalNpcList()` 渚濊禆 `paths.npcList`锛屽洜姝ゅ嵆浣垮瓙绠＄嚎琚惎鐢ㄤ篃姘歌繙鎵句笉鍒?NPC銆?
**Files changed:**
- `src/engine/pipeline/types.ts:330` 鈥?`npcList` 浠?`'NPC鍒楄〃'` 鏀逛负 `'绀句氦.鍏崇郴'`锛屽姞娉ㄩ噴璇存槑

**Behavior before:** 瀛愮绾?grep NPC 濮嬬粓涓虹┖
**Behavior after:** 鍊欓€?NPC 鑳借姝ｇ‘绛涢€夊苟閫佺粰 AI

---

### Phase A1 + A1b: WorldHeartbeat 娴佹按绾夸笌鎻愮ず璇嶅彉閲忓悕瀵逛笉涓?
**Root cause:**
1. `public/packs/tianming/prompts/worldHeartbeat.md` 浣跨敤 `{{NPC_BLOCKS}}` / `{{CONTEXT_BLOCK}}` 鍗犱綅绗?2. `WorldHeartbeatPipeline.buildHeartbeatVariables()` 鍗寸敓鎴?`HEARTBEAT_NPCS` / `HEARTBEAT_NPC_COUNT` / `GAME_TIME`
3. `manifest.json.promptFlows` 鏍规湰娌℃湁 `worldHeartbeat` 鏉＄洰 鈥?瀛愮绾?`gamePack.promptFlows['worldHeartbeat']` 鍙栧埌 `undefined`锛岀洿鎺ユ棭閫€

**Files changed:**
- `public/packs/tianming/prompt-flows/world-heartbeat.json` 鈥?鏂板缓 flow 瀹氫箟锛宮odules = `[worldHeartbeat]`
- `public/packs/tianming/manifest.json` 鈥?`promptFlows` 澧炲姞 `worldHeartbeat` 鏉＄洰
- `src/engine/pipeline/sub-pipelines/world-heartbeat.ts:127-163` 鈥?`buildHeartbeatVariables` 閲嶅啓锛氳緭鍑?`NPC_BLOCKS`锛堝惈 鍚嶇О/绫诲瀷/浣嶇疆/褰撳墠澶栬矊鐘舵€?鍐呭績鎯虫硶/鍦ㄥ仛浜嬮」 澶氬瓧娈电粨鏋勶級+ `CONTEXT_BLOCK`锛堟父鎴忔椂闂?+ 鐜╁浣嶇疆锛夛紝涓庢彁绀鸿瘝鍗犱綅绗︿弗鏍煎榻?
**Behavior before:** 鍗充娇寮鸿杩愯 world heartbeat锛宲rompt 鍙橀噺鍏ㄩ敊浣嶏紝AI 杈撳嚭鏃犳剰涔夊懡浠?**Behavior after:** 鎻愮ず璇嶆ā鏉胯兘姝ｅ父濉厖鍊欓€?NPC 瑙嗚淇℃伅

---

### Phase A2: Pack 缂?7 涓?rules/*.json 鏂囦欢

**Root cause:** `main.ts` 鑻ヨ娉ㄥ唽 `ComputedFieldsModule` / `EffectLifecycleModule` / `ThresholdTriggersModule` / `NpcBehaviorModule` / `ContentFilterModule` / `CrossRefSyncModule` 绛夎涓烘ā鍧楋紝闇€瑕佷粠 `pack.rules.*` 璇诲彇 config銆備絾 `manifest.rules` 鍙０鏄庝簡 `enginePaths`锛屽叾浠栬鍒欐枃浠舵牴鏈笉瀛樺湪锛圙AP_AUDIT 搂10.2锛夈€?
**Files added:**
- `public/packs/tianming/rules/computed-fields.json` 鈥?2 鏉℃淳鐢熷瓧娈碉紙浣撳姏/绮惧姏鐧惧垎姣旓級锛屽湪 onRoundEnd + onLoad 瑙﹀彂
- `public/packs/tianming/rules/effect-lifecycle.json` 鈥?`瑙掕壊.鏁堟灉` 鏁扮粍鐨?buff/debuff 鐢熷懡鍛ㄦ湡閰嶇疆锛屾寔缁椂闂村瓧娈典负 `鎸佺画鏃堕棿鍒嗛挓`锛屽摠鍏靛€?`999999`
- `public/packs/tianming/rules/threshold-triggers.json` 鈥?2 鏉￠槇鍊艰鍒欙細`浣撳姏.褰撳墠 <= 0` 鈫?emit `character:fainted`锛沗绮惧姏.褰撳墠 <= 0` 鈫?emit `character:exhausted`
- `public/packs/tianming/rules/npc-behavior.json` 鈥?4 绉?NPC 绫诲瀷锛堥噸鐐?娆¤/璺汉 = stay锛涘悓浼?= follow-or-wander锛?- `public/packs/tianming/rules/content-filter.json` 鈥?NSFW 璇勭骇锛坄绯荤粺.nsfwMode`锛夛紝strip tags = `[NSFW]` / `[ADULT]` / `[R18]`
- `public/packs/tianming/rules/cross-ref-sync.json` 鈥?鍗曟潯瑙勫垯锛歚绀句氦.鍏崇郴[].浣嶇疆` 鈫?`涓栫晫.鍦扮偣淇℃伅[].NPC` 鍙屽悜鍚屾

**Files changed:**
- `public/packs/tianming/manifest.json` 鈥?`rules` 瀛楁澧炲姞涓婅堪 6 涓敭

**Behavior before:** 鍗充娇娉ㄥ唽琛屼负妯″潡涔熸病瑙勫垯鍙瘎浼帮紝鍏ㄩ儴绌鸿浆
**Behavior after:** 6 涓ā鍧楁湁鏈€灏忓彲杩愯鐨勫垵濮嬮厤缃紝瑕嗙洊鏈€甯哥敤鐨勬淳鐢熷瓧娈点€乥uff 杩囨湡銆侀槇鍊艰Е鍙戙€丯PC 璺熼殢銆佸唴瀹硅繃婊ゃ€丯PC鈫斿湴鐐瑰紩鐢ㄥ悓姝?
---

### Phase A3: 7 涓涓烘ā鍧楁湭娉ㄥ唽锛圙1 HIGH锛?
**Root cause:** `src/main.ts` 鍙敞鍐屼簡 `TimeService` 鍜?`MemoryCompilerModule`锛屽叾浣?7 涓ā鍧楋紙`ComputedFieldsModule` / `EffectLifecycleModule` / `ThresholdTriggersModule` / `NpcBehaviorModule` / `ValidationRepairModule` / `ContentFilterModule` / `CrossRefSyncModule`锛夎櫧鐒舵湁瀹屾暣瀹炵幇浣嗕粠鏈 `behaviorRunner.register()` 璋冪敤銆俙BehaviorRunner.dispatch` 鍙亶鍘嗗凡娉ㄥ唽妯″潡锛岃繖浜涢挬瀛愶紙onRoundEnd / afterCommands / onGameLoad / onContextAssembly锛変粠鏈瑙﹀彂銆?
**Files changed:**
- `src/main.ts:31-57` 鈥?鏂板 7 涓涓烘ā鍧楃殑 import + 琛屼负閰嶇疆绫诲瀷 import
- `src/main.ts:184-252` 鈥?鍦?TimeService/MemoryCompiler 娉ㄥ唽涔嬪悗锛屾柊澧炴敞鍐屽潡锛氫粠 `pack.rules` 璇诲彇 JSON 骞堕€愪釜瀹炰緥鍖?+ 娉ㄥ唽锛堟敞鍐岄『搴忚€冭檻渚濊禆锛歍imeService 鈫?ComputedFields/EffectLifecycle/Threshold/NpcBehavior/ContentFilter/CrossRefSync 鈫?ValidationRepair 鏀跺熬锛夈€傛瘡涓?config 缂哄け鏃堕潤榛樿烦杩囷紝涓嶅己鍒朵緷璧?pack 鍐呭
- `EffectLifecycleModule` 鏋勯€犲嚱鏁伴渶瑕?`calendarConfig`锛屽鐢?TimeService 鐢ㄧ殑 60/24/30/12 + `骞?鏈?鏃?灏忔椂/鍒嗛挓` format锛堣繖鏄浜屽纭紪鐮侊紝鍙湭鏉ユ彁鐐间负鍏变韩甯搁噺锛?
**Behavior before:** 琛嶇敓瀛楁浠庝笉鏇存柊锛沚uff/debuff 姘镐笉杩囨湡锛涢槇鍊间簨浠朵粠涓嶈Е鍙戯紱鍚屼即 NPC 涓嶈窡闅忕帺瀹讹紱NSFW 杩囨护澶辨晥锛汚I 鑴忔暟鎹笉淇锛汵PC 鈫?鍦扮偣寮曠敤涓嶅悓姝?**Behavior after:** 6 涓ā鍧楁湁 pack config 鏃惰繍琛岋紱ValidationRepair 璇?pack.stateSchema 濮嬬粓杩愯

---

### Phase A4 + A5: 4 涓?sub-pipeline 鏈疄渚嬪寲 + pending flag 鏃犱汉娑堣垂锛圙2 HIGH锛?
**Root cause:** GAP_AUDIT 搂1.3 + 搂2.2 鈥?`MemorySummaryPipeline` / `MidTermRefinePipeline` / `WorldHeartbeatPipeline` / `NpcGenerationPipeline` 4 涓被瀹屾暣瀹氫箟锛屼絾 `grep 'new \w*Pipeline'` 鍏?src 涓嬮浂缁撴灉銆傚悓鏃?`PostProcessStage:87` 璁剧疆 `ctx.meta['pendingSummary'] = true` 鍜?`:101` 璁剧疆 `ctx.meta['pendingHeartbeat'] = true`锛屼絾 `GameOrchestrator.runRound` 浠庝笉璇昏繖浜?flag銆?
**Files changed:**
- `src/engine/core/game-orchestrator.ts:65-83` 鈥?鏂板 `SubPipelineBundle` 鎺ュ彛 + 鏋勯€犲嚱鏁板彲閫夊弬鏁?`subPipelines`锛堟墦鍖呬紶閫掕€岄潪鏁ｅ紑 4 涓弬鏁帮紝渚夸簬鏈潵鎵╁睍锛?- `src/engine/core/game-orchestrator.ts:96-114` 鈥?`GameOrchestrator` 绫绘柊澧?private field `subPipelines: SubPipelineBundle`
- `src/engine/core/game-orchestrator.ts:243-318` 鈥?`runRound` 閲嶅啓锛?  - 鍦?`runner.run()` 涔嬪墠鎹曡幏 `locationBefore`锛堢帺瀹舵湰鍥炲悎寮€濮嬫椂鐨勪綅缃級
  - 灏?`runner.run()` 鐨勮繑鍥炲€煎瓨鍒?`finalCtx`锛堜箣鍓嶄涪寮冿級
  - `finally` 涔嬪悗璋?`runPostRoundSubPipelines(finalCtx, stateManager, locationBefore)`
- `src/engine/core/game-orchestrator.ts:320-398` 鈥?鏂板 `runPostRoundSubPipelines` 鏂规硶锛氫緷娆℃鏌?pendingSummary 鈫?MemorySummaryPipeline 鈫?妫€鏌?`memoryManager.isMidTermFull()` 鈫?MidTermRefinePipeline 鈫?妫€鏌?pendingHeartbeat 鈫?WorldHeartbeatPipeline 鈫?妫€鏌?`locationAfter !== locationBefore` 鈫?NpcGenerationPipeline銆傛瘡涓瓙绠＄嚎鐙珛 try/catch锛屼竴涓け璐ヤ笉褰卞搷鍏朵粬
- `src/main.ts:280-326` 鈥?4 涓瓙绠＄嚎鐨勫疄渚嬪寲锛堜粎鍦?pack 瀛樺湪鏃讹級
- `src/main.ts:343-355` 鈥?`GameOrchestrator` 鏋勯€犺皟鐢ㄥ鍔犵浜屼釜鍙€夊弬鏁?`SubPipelineBundle`锛坢emorySummary / midTermRefine / worldHeartbeat / npcGeneration / memoryManager / paths锛?
**Behavior before:**
- 鐭湡璁板繂婊?8 鏉″悗姘歌繙涓嶆€荤粨 鈫?鏃犵晫澧為暱 鈫?token 鐖嗙偢
- 涓湡璁板繂姘歌繙涓嶇簿鐐?- 涓栫晫蹇冭烦 UI 鏈夐厤缃潰鏉夸絾鍚庣姘镐笉鎵ц
- 鐜╁杩涘叆鏂板湴鐐逛笉浼氳Е鍙?NPC 鐢熸垚

**Behavior after:**
- 璁板繂涓夊眰閾捐矾瀹屾暣锛氱煭鏈熸弧 鈫?鎬荤粨涓轰腑鏈?鈫?涓湡婊?鈫?绮剧偧涓洪暱鏈?- 蹇冭烦鍛ㄦ湡鍒拌揪鏃?WorldHeartbeatPipeline 涓?5 涓€欓€?NPC 鍒锋柊鐘舵€?- 鐜╁绉诲姩鍒版湭鐢熸垚杩?NPC 鐨勬柊鍦扮偣鏃?NpcGenerationPipeline 寮傛鐢熸垚 NPC

---

### Phase B: 4 涓?sub-pipeline 涓嶅彂 `ui:debug-prompt`锛圙3 MEDIUM锛?
**Root cause:** 鍓嶆淇鍙粰 `ContextAssemblyStage` 鍜?`CharacterInitPipeline` 鍔犱簡 `eventBus.emit('ui:debug-prompt', ...)`銆傚叾浣?4 涓瓙绠＄嚎锛坢emory-summary / mid-term-refine / world-heartbeat / npc-generation锛夐兘鐩存帴鍦?`promptAssembler.assemble()` 涔嬪悗閫?AI锛岃烦杩囦簡璋冭瘯鍩嬬偣銆?
**Files changed:**
- `src/engine/pipeline/sub-pipelines/memory-summary.ts:28, 110-118` 鈥?import `eventBus` + emit锛坒low: `memorySummary`锛?- `src/engine/pipeline/sub-pipelines/mid-term-refine.ts:25, 106-114` 鈥?emit锛坒low: `midTermRefine`锛?- `src/engine/pipeline/sub-pipelines/world-heartbeat.ts:33, 68-76` 鈥?emit锛坒low: `worldHeartbeat`锛?- `src/engine/pipeline/sub-pipelines/npc-generation.ts:32, 64-72` 鈥?emit锛坒low: `npcGeneration`锛?
**Behavior before:** PromptAssemblyPanel 鍙樉绀?mainRound / splitGenStep1 / splitGenStep2 / worldGeneration / openingScene 鐨勫揩鐓э紝瀛愮绾跨粍瑁呭畬鍏ㄤ笉鍙
**Behavior after:** 璋冭瘯闈㈡澘鑳界湅鍒?4 涓柊 flow 鐨勫畬鏁?prompt 缁勮锛屼究浜庨獙璇佸瓙绠＄嚎瀹為檯鍙戠粰 AI 鐨勫唴瀹?
---

### Phase C1: 鍒涜寮€鍦哄彊浜嬩笉鍐欏叆鐭湡璁板繂锛埪?.4 / 搂4.1a MEDIUM锛?
**Root cause:** `CharacterInitPipeline:95-108` 鐢熸垚寮€鍦哄彊浜嬪悗鍙?push 鍒?`narrativeHistory`锛屼笉璋?`memoryManager.appendShortTerm()`銆傜涓€鍥炲悎 `MemoryRetriever.retrieve()` 鍙戠幇鐭湡/涓湡/闀挎湡鍏ㄧ┖ 鈫?杩斿洖绌哄瓧绗︿覆 鈫?`MEMORY_BLOCK` 涓虹┖銆侫I 鍦ㄩ娆″璇濇椂鐪嬪埌鐨勮蹇嗗潡瀹屽叏绌虹櫧锛屽け鍘诲寮€鍦哄満鏅殑涓婁笅鏂囨劅鐭ャ€?
**Files changed:**
- `src/engine/pipeline/sub-pipelines/character-init.ts:36` 鈥?import `MemoryManager` type
- `src/engine/pipeline/sub-pipelines/character-init.ts:57-75` 鈥?鏋勯€犲嚱鏁板鍔犲彲閫夊弬鏁?`memoryManager?: MemoryManager`锛堜繚鎸佸彲閫変互鍏煎鐜版湁娴嬭瘯锛?- `src/engine/pipeline/sub-pipelines/character-init.ts:100-118` 鈥?鍦ㄥ紑鍦哄彊浜嬪啓鍏?narrativeHistory 涔嬪悗锛岃嫢 `memoryManager` 瀛樺湪鍒欒皟 `appendShortTerm(openingScene, 0)`锛坮oundNumber=0 琛ㄧず"寮€灞€鍓?锛?- `src/main.ts:270` 鈥?`new CharacterInitPipeline(...)` 璋冪敤鏈€鍚庝竴涓弬鏁板鍔?`memoryManager`

**Behavior before:** 棣栨瀵硅瘽鏃?MEMORY_BLOCK 涓虹┖锛孉I 涓嶇煡閬撳垰鍒氬彂鐢熶簡浠€涔?**Behavior after:** 棣栨瀵硅瘽鏃剁煭鏈熻蹇嗗凡鏈変竴鏉?`[绗?鍥炲悎] ${寮€鍦哄彊浜媫`锛孉I 鑳芥帴涓婂紑鍦轰笂涓嬫枃

---

### Phase C2: 闅愬紡涓湡璁板繂鏃?trim锛屾棤鐣屽闀匡紙搂2.3 MEDIUM锛?
**Root cause:** `MemoryManager.appendImplicitMidTerm()` 鍙?push 涓?trim銆侫I 姣忚疆鐨?`mid_term_memory` 瀛楁閮戒細杩藉姞锛屾病鏈夋€荤粨娑堣垂鏈哄埗锛屾暟缁勬棤鐣屽闀裤€傛瘡娆?`MemoryRetriever.retrieve()` 鎶婂叏閮ㄩ殣寮忎腑鏈熻蹇嗘敞鍏?prompt锛岄暱娓告垙鍚?token 鐖嗙偢銆?
**Files changed:**
- `src/engine/memory/memory-manager.ts:154-186` 鈥?鏂板 static `MAX_IMPLICIT_MID_TERM = 40`锛沗appendImplicitMidTerm()` 鏀逛负锛氳拷鍔犲墠鑻ュ凡杈句笂闄愶紝鍏?slice 涓㈠純鏈€鏃х殑 N 鏉★紝鍐?push 鏂版潯鐩?
**Behavior before:** 闅愬紡涓湡璁板繂鍗曡皟澧為暱锛岄暱娓告垙鍚?prompt 鑶ㄨ儉
**Behavior after:** 淇濈暀鏈€杩?40 鏉★紝FIFO 娣樻卑

---

### Phase C3: 鍙欎簨鍘嗗彶鏃?200 鏉′笂闄愶紙搂7.3 LOW锛?
**Root cause:** `PostProcessStage:118-136` 姣忓洖鍚?push 2 鏉★紙user + assistant锛変絾浠庝笉 trim銆俙ContextAssemblyStage:76` 鎶婂叏閲?`narrativeHistory` 娉ㄥ叆 prompt 浣滀负 `chatHistory` 鈥斺€?闀挎父鎴忓悗姣忔缁勮閮藉涓婂崈鏉℃秷鎭紝token/鎴愭湰绾挎€х垎鐐搞€?娉ㄦ剰锛歚StateManager.MAX_HISTORY = 200` 鏄?`changeHistory`锛堝彉鏇磋拷韪級锛屽拰鍙欎簨鍘嗗彶鏃犲叧銆?
**Files changed:**
- `src/engine/pipeline/stages/post-process.ts:38-51` 鈥?鏂板 static `MAX_NARRATIVE_HISTORY = 200`锛堚増 100 鍥炲悎瀵硅瘽锛夛紝鍔犳敞閲婅鏄庨€夋嫨鐞嗙敱
- `src/engine/pipeline/stages/post-process.ts:148-150` 鈥?push 涓ゆ潯涔嬪悗璋?`trimNarrativeHistory()`
- `src/engine/pipeline/stages/post-process.ts:158-180` 鈥?鏂板 `trimNarrativeHistory()` 鏂规硶锛氫竴娆℃€?`stateManager.set(...slice(-N))` 鑰岄潪閫愭潯 pull锛屽噺灏?StateChange 璁板綍閲?
**Behavior before:** 200+ 鍥炲悎鍚庢瘡娆?AI 璋冪敤鐨?prompt token 鍙揪鏁颁竾
**Behavior after:** 鏈€澶氫繚鐣欐渶杩?200 鏉″彊浜嬶紝绋冲畾鍦?100 鍥炲悎瀵硅瘽绐楀彛

---

### Phase C4: CreationView 鍐椾綑鐨?save鈫抣oad 寰€杩旓紙搂4.1b LOW锛?
**Root cause:** GAP_AUDIT 搂4.1b 鈥?`CharacterInitPipeline.execute()` 鍐呴儴宸茬粡 `saveManager.saveGame(snapshot)`锛屼絾 `CreationView.onFinalize()` 涔嬪悗鍙堣皟 `saveManager.loadGame()` 璇诲洖 + `engineState.loadGame(data, ...)` 閲嶈銆傜敱浜?Pinia tree 涓?StateManager 鐨?reactive proxy 鏄?*鍚屼竴寮曠敤**锛坄linkStateManager` 涔嬪悗锛夛紝`stateManager` 閲岀殑鏁版嵁宸茬粡鍙嶆槧鍒?Pinia锛屾牴鏈笉闇€瑕佽鍥炪€?
**Files changed:**
- `src/engine/stores/engine-state.ts:121-142` 鈥?鏂板 `markLoaded(packId, profileId, slotId)` 鍑芥暟锛氬彧璁剧疆 `isGameLoaded` / `activePackId` / `activeProfileId` / `activeSlotId` 鍥涗釜鍏冩暟鎹瓧娈碉紝瀹屽叏涓嶅姩 tree
- `src/engine/stores/engine-state.ts:180` 鈥?export `markLoaded`
- `src/ui/views/CreationView.vue:42-45` 鈥?绉婚櫎 `SaveManager` type import
- `src/ui/views/CreationView.vue:87-91` 鈥?绉婚櫎 `saveManager` inject
- `src/ui/views/CreationView.vue:249-271` 鈥?`onFinalize` 涓殑 `saveManager.loadGame() + engineState.loadGame()` 鏇挎崲涓?`engineState.markLoaded()`
- `src/ui/views/CreationView.vue:22-31` 鈥?鏂囦欢澶存敞閲婂悓姝ユ洿鏂帮紝璇存槑绉婚櫎 saveManager 渚濊禆鐨勫師鍥?
**Avoided cost:**
- 1 娆?IDB 璇?- 1 娆?JSON 搴忓垪鍖?+ 鍙嶅簭鍒楀寲
- 1 娆?`stateManager.loadTree()` 寰€杩旓紙娓呯┖ + 閲嶆柊璧嬪€煎悓鏍风殑鏁版嵁锛?
**Behavior before:** 鍒涜瀹屾垚鍚?UI 鎰熺煡鏈夎交寰欢杩燂紙棰濆 I/O + 鏁版嵁閲嶆柊鍐欏叆鍝嶅簲寮忕郴缁燂級
**Behavior after:** 鍒涜瀹屾垚鍚庣洿鎺ユ爣璁板苟瀵艰埅鍒?/game锛屾棤澶氫綑 I/O

---

### TSC 楠岃瘉

鎵€鏈?Phase A + B + C 瀹屾垚鍚?`npx tsc --noEmit` 0 閿欒 0 璀﹀憡銆備慨鏀规秹鍙婏細
- 5 涓?`main.ts` 瀵煎叆 + 鍒濆鍖栧潡
- 5 涓?sub-pipeline 鏂囦欢鏂板 `eventBus.emit`
- 1 涓?`game-orchestrator.ts` 閲嶅ぇ閲嶆瀯锛? SubPipelineBundle 鎺ュ彛 + runPostRoundSubPipelines 鏂规硶锛?- 4 涓?behavior module 鐩稿叧鐨?pack rules/*.json
- 1 涓?memory-manager trim 瀹炵幇
- 1 涓?post-process 鐨勫彊浜嬪巻鍙?cap
- 1 涓?engine-state 鐨?markLoaded 鍑芥暟
- 1 涓?CreationView 鐨?onFinalize 绠€鍖?
### GAP_AUDIT 鏈鐞嗛」锛堢暀缁欏悗缁細璇濓級

浠ヤ笅鏉＄洰闇€瑕佺敤鎴峰喅绛栨垨杈冨ぇ璁捐鏀瑰姩锛屾湰娆′笉鍔細
- 7.2: Action queue 鍙湁 InventoryPanel 鍙戦€?鈥?闇€瑕?UI 璁捐鍐冲畾鍝簺闈㈡澘鍔犲摢浜涘姩浣滄寜閽?- 11.2: NSFW runtime 绾ц仈 鈥?闇€瑕佽璁?validator 瑙勫垯涓庡瓧娈电櫧鍚嶅崟锛圕ontentFilterModule 鍙鐞?prompt 灞傦級
- 11.4: CommandExecutor 璺緞鐧藉悕鍗?鈥?搴旂敱 ValidationRepairModule 鎵╁睍鑰岄潪鍦?CommandExecutor 閲屽仛
- 5.2: Schema migration 妗嗘灦 鈥?鐙珛鐨勫ぇ宸ョ▼
- 4.1c: 鍒嗘寮€灞€ UI 鈥?`StepConfirmation.vue` 鑷爣涓?褰撳墠鐗堟湰鍔熻兘棰勭暀"锛岄潪 bug
- 4.1d: `extractDefaultsFromSchema` 鏁扮粍 default 鈥?褰撳墠澶╁懡 schema 鏈Е鍙戯紝淇濈暀瑙傚療

---

## [2026-04-10] Fix: PromptAssemblyPanel 姘歌繙鏄剧ず绌烘暟鎹紙浜嬩欢涓?store 鏈ˉ鎺ワ級

**Flow:** 娓告垙涓诲洖鍚?/ 鍒涜 鈫?ContextAssemblyStage / CharacterInitPipeline 鈫?`ui:debug-prompt` 浜嬩欢 鈫?PromptAssemblyPanel

**Root cause (partial implementation):** 鏁版嵁娴佹柇閾?鈥?1. `src/engine/pipeline/stages/context-assembly.ts` 鍙仛 `eventBus.emit('ui:debug-prompt', ...)`锛屾病鏈変换浣曡闃呰€?2. `src/engine/stores/engine-prompt.ts` 瀹氫箟浜?`recordAssembly()` 鏂规硶浣嗘病鏈変换浣曡皟鐢ㄧ偣
3. `PromptAssemblyPanel.vue` 姝ｇ‘浠?`usePromptDebugStore().snapshots` 璇绘暟鎹紝浣?store 姘歌繙涓虹┖
4. 棰濆锛歚CharacterInitPipeline.generateWorldDescription()` 鍜?`generateOpeningScene()` 瀹屽叏鏈?emit 浜嬩欢锛屽垱瑙掗樁娈电殑 prompt 浠庢湭杩涘叆璋冭瘯闈㈡澘

**Demo 鍘熺悊瀵圭収锛堣瑙?`implementation-plan/PARITY_IMPL_PLAN_ADDENDUM.md` 搂Z锛夛細**
- Demo 鐨?`promptAssemblyStore.record(snapshot)` 鍦?`AIBidirectionalSystem.ts` 閲岀洿鎺ヨ璋冪敤锛屾瘡娆?AI 璋冪敤鍓嶇粍瑁?modules 鏃朵竴骞?record
- 姝ｅ紡鐗堥€夋嫨浜嬩欢瑙ｈ€︼紙engine 灞備笉 import UI store锛夛紝浣嗗繕浜嗗姞妗ユ帴璁㈤槄

**Files changed:**
- `src/engine/core/game-orchestrator.ts` 鈥?鏂板 import `usePromptDebugStore` + `AIMessage`锛涘湪 `subscribeToEvents()` 涓柊澧?`eventBus.on('ui:debug-prompt', ...)` 璁㈤槄鍣紝灏?payload 杞彂鍒?`usePromptDebugStore().recordAssembly(flow, messages, variables, roundNumber)`锛汸inia 鏈氨缁椂 try/catch 闈欓粯闄嶇骇锛堥伩鍏嶆祴璇曠幆澧冨穿婧冿級
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?`ui:debug-prompt` payload 澧炲姞 `roundNumber: ctx.roundNumber`锛涘垎姝ユā寮忎笅棰濆涓?Step2 鍙戜竴娆′簨浠讹紙姝ゅ墠鍙彂 Step1锛屽鑷?Step2 娑堟伅鍦ㄩ潰鏉夸腑涓嶅彲瑙侊級
- `src/engine/pipeline/sub-pipelines/character-init.ts` 鈥?import `eventBus`锛沗generateWorldDescription()` 鍜?`generateOpeningScene()` 鍦ㄨ皟鐢?AI 鍓嶅悇 emit 涓€娆?`ui:debug-prompt`锛坒low: `worldGeneration` / `openingScene`锛?
**Behavior before:** 鍙戦€佷换鎰忓鍥炲悎鍚庢墦寮€ Prompt 缁勮璋冭瘯闈㈡澘锛屽缁堟樉绀恒€屽皻鏃?Prompt 缁勮鏁版嵁銆?
**Behavior after:**
- 鍒涜鍚庨潰鏉挎樉绀?2 鏉″揩鐓э細`worldGeneration` + `openingScene`
- 鏅€氫富鍥炲悎姣忔鏂板 1 鏉?`mainRound` 蹇収
- 鍒嗘妯″紡姣忔鏂板 2 鏉″揩鐓э紙Step1 + Step2锛夛紝鍚勮嚜鐙珛鏄剧ず娑堟伅鍒楄〃鍜岄浼?tokens
- 瓒呰繃 10 鏉℃椂鐜舰缂撳啿娣樻卑鏈€鏃ф潯鐩?
**Notes:** 鏈敼鍔?`engine-prompt.ts` store 鏈韩鍜?`PromptAssemblyPanel.vue`锛岃瘉鏄?store API 宸插畬鏁达紝缂虹殑鍙槸 wiring銆侱emo 鐨?per-module 缁撴瀯鍖栬皟璇曞瓧娈碉紙`鏋勬垚`/`鐢熸垚鍘熷洜`/`apiCallDescription`锛夋湭绉绘锛孉DDENDUM 搂Z.3 鍒楀嚭璁捐宸紓鍜屾湭绉绘椤规竻鍗曘€?
---

## [2026-04-10] Feature: 瀹炵幇鍙欎簨鍒ゅ畾鍗＄墖瀵屾牸寮忔覆鏌擄紙FormattedText 缁勪欢锛?
**Flow:** MainGamePanel 鈫?鍙欎簨娑堟伅鏄剧ず

**Background:** AI 鍙欎簨姝ｆ枃涓亣鍒版帰绱?绀句氦/鍐茬獊绛夊叧閿鍔ㄦ椂锛屼細鎻掑叆鍒ゅ畾鏍囪锛屾牸寮忎负锛?```
銆栫被鍨?缁撴灉,鍒ゅ畾鍊?X,闅惧害:Y,鍩虹:B,骞歌繍:L,鐜:E,鐘舵€?S銆?```
姝ｅ紡鐗堟鍓嶇洿鎺ヤ互 `{{ msg.content }}` 绾枃鏈覆鏌擄紝鍒ゅ畾鏍囪浠ュ師濮嬬鍙峰舰寮忔樉绀猴紝鏃犺瑙夊尯鍒嗐€?
**Root cause (missing feature):** 鏈疄鐜?`FormattedText` 瀵屾牸寮忔覆鏌撶粍浠讹紝鍙欎簨鏂囨湰涓墍鏈夌壒娈婃爣璁帮紙鍒ゅ畾 `銆栥€梎銆佺幆澧?`銆愩€慲銆佸唴蹇?`` ` ` ``銆佸璇?`""/""`锛夊潎浠ョ函瀛楃鏄剧ず銆?
**Files added:**
- `src/ui/components/common/FormattedText.vue` 鈥?鏂板缓瀵屾牸寮忔覆鏌撶粍浠讹紝绉绘鑷?demo `FormattedText.vue`锛岄€傞厤 tianming 鍒ゅ畾瀛楁鍚嶏細
  - `銆栫被鍨?缁撴灉,鍒ゅ畾鍊?X,闅惧害:Y,鍩虹:B,骞歌繍:L,鐜:E,鐘舵€?S銆梎 鈫?鍒ゅ畾鍗＄墖锛堟垚鍔?澶辫触/澶ф垚鍔?澶уけ璐ュ洓鑹蹭富棰橈級
  - `銆?..銆慲 鈫?鐜鎻忓啓锛堟枩浣撶伆鑹诧級
  - `` `...` `` 鈫?NPC 鍐呭績锛堟洿寮辫壊鏂滀綋锛?  - `"..."` / `"..."` 鈫?瀵硅瘽锛堜富鑹查珮浜級
  - 鏅€氭枃鏈師鏍锋樉绀?
**Files modified:**
- `src/ui/components/panels/MainGamePanel.vue` 鈥?寮曞叆 `FormattedText`锛屽皢鍘嗗彶娑堟伅 `{{ msg.content }}` 鍜屾祦寮忔枃鏈?`{{ streamingText }}` 鏇挎崲涓?`<FormattedText :text="..." />`

**Behavior before:** 鍒ゅ畾濡?`銆栨帰绱?鎴愬姛,鍒ゅ畾鍊?45,闅惧害:35銆梎 鍦ㄦ秷鎭涓互鍘熷鏂囨湰鏄剧ず锛屾棤瑙嗚宸紓

**Behavior after:** 鍒ゅ畾浠ュ僵鑹插崱鐗囧舰寮忓唴宓屽湪鍙欎簨涓紝鏄剧ず绫诲瀷鏍囩銆佺粨鏋滃窘绔犮€佸悇鍒ゅ畾鏁板€硷紱鎴愬姛/澶ф垚鍔?澶辫触/澶уけ璐ュ垎鍒娇鐢ㄧ豢/閲?绾?娣辩孩鑹蹭富棰橈紱娴佸紡鐢熸垚杩囩▼涓疄鏃舵覆鏌?
---

## [2026-04-10] Fix: EventPanel 鍒犻櫎纭 Modal v-model 闈炴硶琛ㄨ揪寮忓鑷寸紪璇戦敊璇?
**Flow:** 娓告垙涓?鈫?鍙充晶闈㈡澘 鈫?涓栫晫蹇冭烦锛圗ventPanel锛?
**Root cause:** `EventPanel.vue:378` 鏈変袱涓潪娉?Vue 妯℃澘琛ㄨ揪寮忥細
1. `v-model="!!deleteTargetId"` 鈥?`!!` 鍙岄噸鍙栧弽缁撴灉涓嶅彲鍐欙紝Vue 缂栬瘧鍣ㄦ棤娉曠敓鎴愬搴旂殑 setter锛屾姤 `Unexpected token (1:1)`
2. `@update:model-value="if (!$event) deleteTargetId = null"` 鈥?`if` 鏄鍙ヨ€岄潪琛ㄨ揪寮忥紝涓嶈兘鐢ㄥ湪 template attribute 鐨?inline handler 涓?
**Files changed:**
- `src/ui/components/panels/EventPanel.vue` 鈥?鍦?`deleteTargetId` ref 鏃佹坊鍔?`showDeleteModal` computed锛坓etter: `deleteTargetId !== null`锛宻etter: `if (!v) deleteTargetId = null`锛夛紱Modal 鏀逛负 `v-model="showDeleteModal"`锛岀Щ闄?`@update:model-value` handler

**Behavior before:** 鐐瑰嚮涓栫晫蹇冭烦闈㈡澘鏃?Vite 鎶ョ紪璇戦敊璇紝EventPanel 鏃犳硶娓叉煋锛岀偣鍑诲悗鐧藉睆

**Behavior after:** 鍒犻櫎纭寮圭獥姝ｅ父鏄剧ず锛屽叧闂脊绐楁椂 `deleteTargetId` 鑷姩娓呯┖

---

## [2026-04-10] Fix: 娴佸紡杈撳嚭寮€鍏虫湭鎺у埗涓诲洖鍚堢敓鎴愶紱鏂板鍒嗘鐢熸垚鍔熻兘

**Flow:** APIPanel 璁剧疆 鈫?GameOrchestrator.runRound() 鈫?AICallStage

### Bug 1: 娴佸紡寮€鍏虫棤鏁?
**Root cause:** `GameOrchestrator.runRound()` 濮嬬粓缁?`PipelineContext` 璁剧疆 `onStreamChunk` 鍥炶皟锛宍AICallStage` 閫氳繃 `stream: !!ctx.onStreamChunk` 鍒ゆ柇鏄惁娴佸紡锛屽洜姝や笉绠?APIPanel 鐨?娴佸紡杈撳嚭"寮€鍏崇姸鎬侊紝姣忔閮戒互 `stream: true` 鍙戣捣璇锋眰銆?
**Fix:**
- `src/engine/core/game-orchestrator.ts` 鈥?鏂板 `readAISettings()` 鍑芥暟锛屽湪姣忓洖鍚堝紑濮嬫椂浠?`localStorage('aga_ai_settings')` 璇诲彇 `{ streaming, splitGen }` 涓や釜璁剧疆
- `runRound()` 涓細`streaming === false` 鏃朵笉璁剧疆 `onStreamChunk`锛堣祴 `undefined`锛夛紝AICallStage 鑷劧浼?`stream: false`

**Behavior before:** 鍏抽棴"娴佸紡杈撳嚭"鍚庝粛浠?SSE stream 妯″紡璇锋眰 AI锛屽鑷?UI 浠嶆樉绀洪€愬瓧鎵撳瓧鏈烘晥鏋?
**Behavior after:** 鍏抽棴鍚庝互鏅€氶潪娴佸紡璇锋眰锛孉I 鍏ㄩ噺杩斿洖鍚庝竴娆℃€ф樉绀?
---

### Feature: 涓诲洖鍚堝垎姝ョ敓鎴?
**Background:** 鍒嗘鐢熸垚灏嗕竴娆′富鍥炲悎鎷嗕负涓ゆ API 璋冪敤锛氱1姝ヤ粎鐢熸垚鍙欎簨姝ｆ枃锛坄{"text":"..."}`锛夛紝绗?姝ュ熀浜庣1姝ユ鏂囩敓鎴愭寚浠?閫夐」/璁板繂锛堜笉鍚?`text`锛夈€傝繖鍑忓皯鍗曟 AI 杈撳嚭鐨勫鏉傚害锛屾彁楂樼粨鏋勫寲鏁版嵁鐨勫噯纭€с€?
**Files added:**
- `public/packs/tianming/prompts/splitGenContext.md` 鈥?娓告垙鐘舵€?璁板繂/鐢ㄦ埛杈撳叆鐨勬ā鏉挎敞鍏ワ紙琚袱涓垎姝?flow 寮曠敤锛?- `public/packs/tianming/prompt-flows/split-gen-main-round-step1.json` 鈥?绗?姝?flow锛歔splitGenStep1 + core + splitGenContext]
- `public/packs/tianming/prompt-flows/split-gen-main-round-step2.json` 鈥?绗?姝?flow锛歔splitGenStep2 + core + splitGenContext]
- `public/packs/tianming/manifest.json` 鈥?娉ㄥ唽涓や釜鏂?flow 鍜?`splitGenContext` 鎻愮ず璇?
**Files modified:**
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?妫€娴?`ctx.meta.splitGen`锛涗负 true 鏃跺垎鍒粍瑁?step1/step2 鐨?messages锛宻tep2 messages 瀛樺叆 `ctx.meta.splitStep2Messages`锛涘洖閫€鍒?mainRound 鍚﹀垯涓嶅彉
- `src/engine/pipeline/stages/ai-call.ts` 鈥?妫€娴?`ctx.meta.splitStep2Messages`锛涘瓨鍦ㄦ椂锛氱1姝ヨ皟 AI锛堟祦寮忥級锛岀2姝ユ敞鍏ョ1姝ュ搷搴斾负 assistant 涓婁笅鏂囧啀璋?AI锛堥潪娴佸紡锛夛紝鍚堝苟涓や釜 parsedResponse锛坱ext 鏉ヨ嚜 step1锛宑ommands/actionOptions/memory 鏉ヨ嚜 step2锛?- `src/engine/core/game-orchestrator.ts` 鈥?`runRound()` 璇诲彇 `splitGen` 璁剧疆锛屽啓鍏?`ctx.meta.splitGen`
- `src/ui/components/panels/APIPanel.vue` 鈥?鍦?AI 鐢熸垚璁剧疆"鍖哄煙鏂板"鍒嗘鐢熸垚"寮€鍏筹紝鎸佷箙鍖栧埌 `aga_ai_settings.splitGen`

**Behavior before:** 涓诲洖鍚堝彧鏈夊崟娆?AI 璋冪敤锛涘垎姝ョ敓鎴?prompts 瀛樺湪浣嗘棤娉曡浣跨敤

**Behavior after:** 寮€鍚?鍒嗘鐢熸垚"鍚庢瘡鍥炲悎鍙戣捣涓ゆ API 璇锋眰锛岀1娆℃祦寮忔樉绀哄彊浜嬫枃鏈紝绗?娆￠潤榛樿幏鍙栧懡浠ゆ暟鎹紱鍏抽棴鏃惰涓轰笌涔嬪墠鐩稿悓

---

## [2026-04-10] Fix: crypto.randomUUID() 鍦?HTTP 鏈湴寮€鍙戠幆澧冧腑鎶涘嚭 TypeError

**Flow:** Main Round 鈫?GameOrchestrator.runRound() 鈫?鏋勫缓 PipelineContext 鈫?crypto.randomUUID()

**Root cause:** `crypto.randomUUID()` 灞炰簬 Web Crypto API 鐨?Secure Context Only 鎺ュ彛锛屽湪 `http://localhost`锛堥潪 HTTPS锛夌幆澧冧笅閮ㄥ垎 Chromium 鐗堟湰涓嶆彁渚涙鏂规硶锛岃皟鐢ㄦ椂鎶涘嚭 `TypeError: crypto.randomUUID is not a function`銆俙generationId` 瀛楁鐢ㄤ簬娴佸紡鍝嶅簲鍖归厤锛屼笉闇€瑕佸瘑鐮佸寮哄害闅忔満鎬э紝鍙渶鍞竴鍗冲彲銆?
**Files changed:**
- `src/engine/core/game-orchestrator.ts:18-28` 鈥?鏂板 `generateId()` 鍑芥暟锛氫紭鍏堜娇鐢?`crypto.randomUUID()`锛岄檷绾у埌 `crypto.getRandomValues()`锛坔ttp 涓嬪彲鐢級鐢熸垚 UUID v4 鏍煎紡瀛楃涓?- `src/ui/components/panels/EventPanel.vue:174` 鈥?鍐呰仈涓夊厓鍏煎鍐欐硶
- `src/ui/components/panels/SettingsPanel.vue:288` 鈥?鍐呰仈涓夊厓鍏煎鍐欐硶

**Behavior before:** 鍙戦€佸璇濇椂鎺у埗鍙版姤 `TypeError: crypto.randomUUID is not a function`锛屾暣涓?pipeline 鍥犳湭鎹曡幏寮傚父宕╂簝锛孶I 鏃犲搷搴?
**Behavior after:** `generateId()` 鍦?HTTP 鐜涓嬮€氳繃 `getRandomValues` 鐢熸垚绛夋晥鍞竴 ID锛宲ipeline 姝ｅ父杩愯

---

## [2026-04-09] Fix: ResponseParser 涓㈠純鎵€鏈?AI 鍛戒护锛坧ath vs key 瀛楁鍚嶄笉鍖归厤锛?
**Flow:** Character Init / Main Round 鈫?AI Response 鈫?ResponseParser 鈫?CommandExecutor 鈫?State Update

**Root cause:** AI 鎻愮ず璇嶏紙core.md銆乷pening.md銆乵ainRound.md 绛夛級缁熶竴浣跨敤 `"path"` 瀛楁鍚嶆爣璇嗙洰鏍囪矾寰勶紝渚嬪锛?```json
{"action": "set", "path": "瑙掕壊.鍩虹淇℃伅.褰撳墠浣嶇疆", "value": "..."}
```
浣?`ResponseParser.normalizeCommands()` 杩囨护鍣ㄨ姹?`'key' in c`锛坄Command` 鎺ュ彛浣跨敤 `key`锛夛紝瀵艰嚧鎵€鏈?AI 杩斿洖鐨勫懡浠よ闈欓粯涓㈠純锛堣繃婊ゅ悗绌烘暟缁勶級锛宍CommandExecutor.executeBatch()` 鏀跺埌绌烘暟缁勶紝闆舵潯鍛戒护鎵ц銆?
**鏍规湰鍘熷洜閾撅細**
- 鎻愮ず璇?鈫?`path` 瀛楁 鉁?- `normalizeCommands` 杩囨护 鈫?`'key' in c` 涓嶆弧瓒?鈫?鎵€鏈夊懡浠よ drop 鉁?- `executeBatch([])` 鈫?鐘舵€佹爲涓嶅彉 鉁?- UI 鍙樉绀?schema 榛樿鍊硷紙鍒濆鍙橀噺锛夛紝AI 鐢熸垚鐨勬墍鏈夋洿鏂板叏閮ㄤ涪澶?鉁?
**Files changed:**
- `src/engine/ai/response-parser.ts:111-125` 鈥?`normalizeCommands()` 浠?`.filter()` 鏀逛负鏄惧紡寰幆锛屾帴鍙?`key` 鎴?`path` 瀛楁锛坄obj.key ?? obj.path`锛夛紝瑙勮寖鍖栦负 `Command.key`锛屽吋瀹瑰弻鏍煎紡

**Behavior before:** 寮€灞€鐢熸垚鍚庯紝闄ゅ垵濮嬪彉閲忓锛孉I 鐢熸垚鐨勬墍鏈夊彉閲忥紙浣嶇疆銆佸０鏈涖€佸湴鐐广€丯PC銆佷綋鍔涚瓑锛夊潎涓嶆洿鏂帮紱鎵€鏈?AI 鍥炲悎浜﹀悓鏍锋棤鐘舵€佸彉鏇?
**Behavior after:** AI 杩斿洖鐨?`path` 鏍煎紡鍛戒护琚纭В鏋愪负 `Command.key`锛屼紶鍏?`CommandExecutor` 鍚庢寜棰勬湡鏇存柊鐘舵€佹爲锛孶I 瀹炴椂鍝嶅簲

**Notes:** `Command` 鎺ュ彛淇濇寔 `key` 瀛楁涓嶅彉锛涘彉鏇翠粎鍦ㄨВ鏋愬眰鍋氭槧灏勶紝涓嶅奖鍝?`CommandExecutor` 鍙?`StateManager` 閫昏緫銆傛棫鏍煎紡 `key` 瀛楁浠嶅吋瀹广€?
---

## [2026-04-09] Fix: RelationshipPanel v-else 鏃犵浉閭?v-if 缂栬瘧閿欒

**Flow:** Social Panel 鈫?RelationshipPanel 鈫?NPC 鍏虫敞鍒囨崲鎸夐挳鍥炬爣

**Root cause:** SVG 鍐呬袱涓?`<path>` 閮界敤浜?`v-if="npc.鍏虫敞"`锛岀浜屼釜 `v-else` 鍜岀涓変釜 `v-else` 涓庣涓€涓?`v-if` 涓嶅湪鐩搁偦鍏冪礌閾句笂锛孷ue 缂栬瘧鍣ㄦ姤 "v-else has no adjacent v-if"銆?
**Files changed:**
- `src/ui/components/panels/RelationshipPanel.vue:240-245` 鈥?涓や釜 "eye open" path 鍚堝苟杩?`<template v-if="npc.鍏虫敞">`锛屼袱涓?"eye closed" path 鍚堝苟杩?`<template v-else>`

**Behavior before:** Vite HMR overlay 鎶ョ紪璇戦敊璇紝RelationshipPanel 鏃犳硶娓叉煋

**Behavior after:** 鍥炬爣姝ｅ父鏄剧ず锛堝叧娉ㄧ姸鎬?= 鐫佺溂锛屾湭鍏虫敞 = 闂溂鍔犳枩绾匡級

---

## [2026-04-09] Fix: engineState.loadGame() 鍒囨柇 StateManager 鍝嶅簲寮忛摼鎺ュ鑷?AI 鍛戒护涓嶆洿鏂?UI

**Flow:** Main Round Pipeline 鈫?CommandExecution 鈫?UI 鍝嶅簲寮忔洿鏂?
**Root cause:** `engine-state.ts` 鐨?`loadGame()` 鐢?`tree.value = data` 鐩存帴鏇挎崲 Pinia ref锛屾瘡娆″姞杞藉瓨妗ｉ兘鍒囨柇浜?`linkStateManager()` 寤虹珛鐨?Pinia 鈫?StateManager 鍏变韩鍝嶅簲寮忓紩鐢ㄣ€備箣鍚?AI 杩斿洖鐨?commands 琚?`CommandExecutor` 鍐欏叆 `StateManager.state`锛屼絾 Pinia `tree.value` 鎸囧悜涓嶅悓瀵硅薄锛孶I 鎰熺煡涓嶅埌浠讳綍鍙樺寲銆?
**鎶€鏈粏鑺?**
- `linkStateManager(sm)`: 浠?`tree.value = sm.getTree()`锛坮eactive proxy 瀵硅薄 `X`锛?- `loadGame(data)` 涔嬪墠: Pinia `tree.value` = `X`, StateManager `state` = `X` 鈫?鍚屼竴寮曠敤 鉁?- `loadGame(data)` 涔嬪悗: Pinia `tree.value` = `data`锛堟柊瀵硅薄 `Y`锛? StateManager `state` = `X` 鈫?鍙岃建涓嶅悓姝?鉂?- AI 鍛戒护鍐?`X`锛孭inia 鏄剧ず `Y`锛岀敤鎴风湅涓嶅埌鍙樺寲

**Files changed:**
- `src/engine/stores/engine-state.ts` 鈥?`linkStateManager()` 鏂板淇濆瓨 `_linkedStateManager` 寮曠敤锛沗loadGame()` 鏀逛负锛氳嫢 `_linkedStateManager` 瀛樺湪鍒欒皟鐢?`_linkedStateManager.loadTree(data)` 灏卞湴鏇存柊 reactive 瀵硅薄锛堜繚鎸佸紩鐢ㄤ笉鍙橈級锛屽惁鍒欓檷绾т负鐩存帴鏇挎崲 ref

**Behavior before:** 鍒涜瀹屾垚杩涘叆娓告垙鍚庯紝AI 姣忓洖鍚堣繑鍥炵殑 commands锛堝鏇存柊浣撳姏銆侀噾甯併€佷綅缃級鎵ц鍚?UI 瀹屽叏涓嶅搷搴旓紱鍙湁鍒濆鍙橀噺锛堝垱瑙掓椂鍐欏叆鐨?schema default锛夊彲瑙?
**Behavior after:** AI commands 閫氳繃 StateManager 鍐欏叆鍚庯紝Pinia reactive 鏍戠珛鍗虫洿鏂帮紝UI 瀹炴椂鍝嶅簲

**Notes:** `StateManager.loadTree()` 宸叉纭疄鐜板氨鍦版洿鏂帮紙娓呯┖ keys + Object.assign锛夛紝涓嶄細鐮村潖 reactive ref銆傛 fix 涓嶅奖鍝?rollback/clear 閫昏緫銆?
---

## [2026-04-09] Fix #33: ProfileManager.clearAll() 涓嶅瓨鍦ㄥ鑷?IndexedDB 鏈竻鐞?
**Flow:** Settings 鈫?Clear All Data

**Root cause:** `SettingsPanel.clearAllData()` 閫氳繃 type-cast `as { clearAll?: () => Promise<void> }` 璋冪敤浜嗕竴涓笉瀛樺湪鐨勬柟娉曘€俙ProfileManager` 娌℃湁 `clearAll()` 瀹炵幇锛屽鑷?IndexedDB 涓殑瀛樻。鏁版嵁浠庢湭琚竻闄わ紝鍙湁 `localStorage.clear()` 鎵ц浜嗐€?
**Files changed:**
- `src/engine/persistence/profile-manager.ts` 鈥?鏂板 `clearAll()` 鏂规硶锛氳皟鐢?`idbAdapter.clear()` 娓呯┖鏁翠釜 IndexedDB object store锛屽苟閲嶇疆鍐呭瓨缂撳瓨 `this.root = { activeProfile: null, profiles: {} }`
- `src/ui/components/panels/SettingsPanel.vue` 鈥?`clearAllData()` 鏀逛负鐩存帴 `await profileManager.clearAll()`锛岀Щ闄?type-cast 鏉′欢妫€鏌?
**Behavior before:** 鐐瑰嚮"娓呴櫎鎵€鏈夋暟鎹?浠呮竻绌?localStorage锛孖ndexedDB 瀛樻。鏁版嵁淇濈暀锛岄噸鍚悗瀛樻。浠嶅彲璇诲彇

**Behavior after:** IndexedDB 瀹屽叏娓呯┖锛宭ocalStorage 娓呯┖锛岃烦杞嚦棣栭〉

**Notes:** `idbAdapter.clear()` 鏄?`src/engine/persistence/idb-adapter.ts` 涓凡鏈夌殑鏂规硶锛屾竻绌烘暣涓?object store

---

## [2026-04-09] Fix #35: TopBar/RightSidebar 蹇€熶繚瀛樻棤鏉′欢鏄剧ず"鎴愬姛"toast

**Flow:** Main Game 鈫?Quick Save (TopBar 淇濆瓨鎸夐挳 / RightSidebar 淇濆瓨鎸夐挳)

**Root cause:** 涓ゅ `handleQuickSave()`/`handleSave()` 鍦?`eventBus.emit('engine:request-save')` 鍚庣珛鍗虫樉绀?淇濆瓨鎴愬姛" toast锛屼笉绛夊緟瀹為檯淇濆瓨缁撴灉銆俙engine:request-save` 鐢?`GameOrchestrator` 寮傛澶勭悊锛屽け璐ユ椂鏃犱换浣曢€氱煡璺緞銆?
**Files changed:**
- `src/engine/types/event-bus.ts` 鈥?鏂板 `'engine:save-error'` 浜嬩欢鍚?- `src/engine/core/game-orchestrator.ts` 鈥?`engine:request-save` handler 鐨?`.catch()` 涓?emit `'engine:save-error'`
- `src/ui/components/layout/TopBar.vue` 鈥?`handleQuickSave()` 鏀逛负鍗曟浜嬩欢鐩戝惉妯″紡锛氭敞鍐?`engine:save-complete` / `engine:save-error` 涓€娆℃€х洃鍚櫒锛?s 瓒呮椂鑷姩娓呯悊锛涙垚鍔?澶辫触鍒嗗埆鏄剧ず瀵瑰簲 toast
- `src/ui/components/layout/RightSidebar.vue` 鈥?`handleSave()` 鍚屼笂

**Behavior before:** 淇濆瓨澶辫触鏃剁敤鎴风湅鍒?蹇€熶繚瀛樻垚鍔?

**Behavior after:** 鎴愬姛鈫?蹇€熶繚瀛樻垚鍔?锛屽け璐モ啋鏄剧ず閿欒鍘熷洜锛?s 瓒呮椂鈫掗潤榛橈紙涓嶆樉绀轰换浣?toast锛?
---

## [2026-04-09] Fix #34: LeftSidebar Engram 璋冭瘯鍏ュ彛涓嶅彈 config.debug 鎺у埗

**Flow:** Settings 鈫?Engram 鈫?Enable debug 鈫?Sidebar 鏄剧ず"Engram 璋冭瘯"鍏ュ彛

**Root cause:** `LeftSidebar` 鐨?`panelGroups` 鏄潤鎬佹暟缁勶紝鍦?`onMounted` 鏃跺浐鍖栵紝涓嶅搷搴?`EngramConfig.debug` 鐨勫彉鍖栥€傚嵆浣跨敤鎴峰叧闂?debug 妯″紡锛屼晶杈规爮鍏ュ彛浠嶄繚鎸佹樉绀恒€?
**Files changed:**
- `src/engine/memory/engram/engram-config.ts` 鈥?`saveEngramConfig()` 鏈熬 emit `'engram:config-changed'` 浜嬩欢锛坧ayload: `{ debug: boolean }`锛?- `src/engine/types/event-bus.ts` 鈥?鏂板 `'engram:config-changed'` 浜嬩欢鍚?- `src/ui/components/layout/LeftSidebar.vue` 鈥?`panelGroups` 鐢遍潤鎬佹暟缁勬敼涓?`computed<PanelGroup[]>`锛屽姩鎬佽繃婊?`/game/engram-debug` 鍏ュ彛锛沗onMounted` 娉ㄥ唽 `engram:config-changed` 鐩戝惉鍣ㄦ洿鏂?`engramDebugVisible` ref锛沗onUnmounted` 娓呯悊鐩戝惉鍣?
**Behavior before:** Engram 璋冭瘯鍏ュ彛濮嬬粓鏄剧ず锛屼笉鍙?debug 寮€鍏虫帶鍒?
**Behavior after:** `config.debug = true` 鏃舵樉绀哄叆鍙ｏ紝鍏抽棴鏃剁珛鍗虫秷澶憋紙鏃犻渶鍒锋柊椤甸潰锛?
---

## [2026-04-09] Fix #36: context-assembly.ts recentNpcNames 纭紪鐮佷负绌烘暟缁?
**Flow:** Main Round Pipeline 鈫?ContextAssembly Stage 鈫?Engram Hybrid Retrieval

**Root cause:** `ContextAssemblyStage.retrieveMemory()` 浼犵粰 `UnifiedRetriever` 鐨?`recentNpcNames: []` 鏄啓姝荤殑绌烘暟缁勶紙鍘熸湁 TODO 娉ㄩ噴鏈疄鐜帮級锛屽鑷?UnifiedRetriever 鐨勫浘閬嶅巻鍜?NPC 浣嶇疆瑙勫垯鍒嗘敮瀹屽叏鏃犳硶鍖归厤浠讳綍 NPC 瀹炰綋銆?
**Files changed:**
- `src/engine/pipeline/stages/context-assembly.ts` 鈥?`recentNpcNames: []` 鏇挎崲涓?`this.extractRecentNpcNames()` 璋冪敤锛涙柊澧炵鏈夋柟娉?`extractRecentNpcNames()`锛氫粠 `stateManager.get(paths.engramMemory)` 璇诲彇瀹炰綋鍒楄〃锛岃繃婊?`type === 'npc'`锛屾寜 `lastSeen` 闄嶅簭锛屽彇鏈€杩?10 涓悕绉?
**Behavior before:** Engram hybrid 妫€绱腑 NPC 瑙勫垯鍒嗘敮濮嬬粓鏃犲尮閰嶏紝鍥鹃亶鍘嗛€€鍖?
**Behavior after:** 鏈€杩戜氦浜掔殑 NPC 琚撼鍏ュ浘閬嶅巻璧风偣锛孨PC 浣嶇疆瑙勫垯姝ｅ父瑙﹀彂

---

## [2026-04-09] Fix #37: UnifiedRetriever 鍔ㄦ€?import Pinia store锛堟灦鏋勮繚鍙嶏級

**Flow:** Main Round Pipeline 鈫?Engram Hybrid Retrieval 鈫?Debug 鏁版嵁璁板綍

**Root cause:** `unified-retriever.ts` 鍦?`retrieve()` 鍐呴€氳繃 `await import('../../stores/engram-debug')` 鍔ㄦ€佸紩鍏?Pinia store锛岃繚鍙嶄簡"寮曟搸灞備笉寰椾緷璧?Vue/Pinia 涓婁笅鏂?鍘熷垯銆傚湪绠＄嚎鎵ц涓婁笅鏂囦腑 Pinia 铏界劧宸插垵濮嬪寲锛屼絾姝ゆā寮忔灦鏋勪笂鑴嗗急涓斾笉鍙祴璇曘€?
**Files changed:**
- `src/engine/memory/engram/unified-retriever.ts` 鈥?鍒犻櫎 `import { loadEngramConfig }` 鍜屽姩鎬?import 鍧楋紱鏂板 `IDebugRecorder` 鎺ュ彛锛堝紩鎿庡唴瀹氫箟锛屼笌 store 瑙ｈ€︼級锛沗UnifiedRetriever` 鏋勯€犲嚱鏁版柊澧炲彲閫夌 5 鍙傛暟 `debugRecorder?: IDebugRecorder`锛沗retrieve()` 涓敼涓?`this.debugRecorder?.recordRetrieve({...})`锛堝彲閫夐摼锛屼笉瀛樺湪鏃堕潤榛樿烦杩囷級
- `src/main.ts` 鈥?import `useEngramDebugStore`锛堝湪 `app.use(pinia)` 涔嬪悗锛孷ue 涓婁笅鏂囨湁鏁堬級锛涘疄渚嬪寲 `engramDebugStore = useEngramDebugStore()`锛涗紶鍏?`new UnifiedRetriever(vectorStore, embedder, reranker, undefined, engramDebugStore)`

**Behavior before:** debug 鏁版嵁渚濊禆鍔ㄦ€?import锛屽彲鑳藉湪闈?Vue 涓婁笅鏂囦腑闈欓粯澶辫触

**Behavior after:** `engramDebugStore` 鍦?`main.ts` 鍚姩鏃舵敞鍏ワ紝鐢熷懡鍛ㄦ湡鐢?Vue app 绠＄悊锛屽紩鎿庡眰鏃?Pinia 渚濊禆

---

## [2026-04-09] Fix #38: SavePanel.loadSlot 浣跨敤褰撳墠 session packId 鑰岄潪瀛樻。鐨?packId

**Flow:** Save/Load Flow 鈫?SavePanel 鈫?璇诲彇瀛樻。妲?
**Root cause:** `loadSlot()` 浣跨敤 `activePackId.value` 浣滀负鍔犺浇鏃剁殑 pack 涓婁笅鏂囷紝浣嗘鍊煎弽鏄犵殑鏄綋鍓?session 鍚姩鐨?pack锛岃€岄潪瀛樻。鑷韩璁板綍鐨?`slotMeta.packId`銆傚湪鏈潵澶?pack 鍦烘櫙涓嬩細灏嗗瓨妗ｅ姞杞藉埌閿欒鐨?pack 涓婁笅鏂囥€?
**Files changed:**
- `src/ui/components/panels/SavePanel.vue:loadSlot()` 鈥?`const packId = activePackId.value ?? ''` 鏀逛负 `const slot = slots.value.find(s => s.slotId === slotId); const packId = slot?.packId ?? activePackId.value ?? ''`

**Behavior before:** 鎬绘槸鐢ㄥ綋鍓嶆椿璺?pack ID锛堝崟 pack 鍦烘櫙鏃犳劅鐭ュ樊寮傦級

**Behavior after:** 浼樺厛浣跨敤瀛樻。鑷韩璁板綍鐨?packId锛屽洖閫€鍒板綋鍓嶆椿璺?packId

---

## [2026-04-09] Fix #39: RightSidebar 瀵煎嚭鎸夐挳鏄案涔?stub

**Flow:** Main Game 鈫?RightSidebar 鈫?瀵煎嚭鎸夐挳

**Root cause:** `handleExport()` 浠?emit 涓€涓?`'瀵煎嚭鍔熻兘鍑嗗涓€?` 鐨?info toast锛屾病鏈夊疄闄呭姛鑳姐€係avePanel 宸叉湁瀹屾暣鐨勫鍑哄疄鐜般€?
**Files changed:**
- `src/ui/components/layout/RightSidebar.vue` 鈥?import `useRouter`锛沗handleExport()` 鏀逛负 `void router.push('/game/save')`锛堝鑸埌 SavePanel锛岀敤鎴峰彲鍦ㄥ叾涓娇鐢ㄥ畬鏁村鍑哄姛鑳斤級

**Behavior before:** 鐐瑰嚮瀵煎嚭寮瑰嚭"鍑嗗涓?鍗犱綅 toast

**Behavior after:** 鐐瑰嚮瀵煎嚭瀵艰埅鑷?SavePanel

---

## [2026-04-09] Fix #41: main.ts 娉ㄩ噴璇?妯″潡绾у彉閲?浣嗗疄闄呮槸鍑芥暟灞€閮ㄥ彉閲?
**Flow:** N/A 鈥?浠ｇ爜鍙鎬?
**Root cause:** 娉ㄩ噴 "璧嬪€肩粰妯″潡绾у彉閲忕‘淇濈敓鍛藉懆鏈? 涓庝唬鐮佺煕鐩撅紙`orchestrator` 鏄?`bootstrap()` 鍑芥暟鍐呭眬閮ㄥ彉閲忥級銆傚疄闄?GC 瀹夊叏鍘熷洜鏄?`eventBus` 瀵圭洃鍚櫒鎸佹湁寮哄紩鐢?+ `app.provide()` 浼犻€掑紩鐢ㄣ€?
**Files changed:**
- `src/main.ts` 鈥?鏇存柊娉ㄩ噴涓?"閫氳繃 app.provide() 灏嗗紩鐢ㄤ紶閫掑埌 Vue 搴旂敤灞傦紝纭繚鐢熷懡鍛ㄦ湡涓庡簲鐢ㄤ竴鑷?

**Behavior before:** 娉ㄩ噴璇璇昏€呰涓洪渶瑕佺敤妯″潡绾у彉閲忛槻姝?GC

**Behavior after:** 娉ㄩ噴鍑嗙‘鎻忚堪 GC 瀹夊叏鐨勭湡瀹炲師鍥?
---

## [2026-04-09] Fix #28: SavePanel slot 璇︽儏 emoji 杩濆弽 CLAUDE.md 绾﹀畾

**Flow:** Save/Load Flow 鈫?SavePanel 鈫?瀛樻。妲借鎯呭睍绀?
**Root cause:** `SavePanel.vue` 鐨?slot 璇︽儏琛屼娇鐢ㄤ簡 馃懁馃搷馃晲 emoji锛岃繚鍙嶄簡 CLAUDE.md 涓?"Only use emojis if the user explicitly requests it" 绾﹀畾銆?
**Files changed:**
- `src/ui/components/panels/SavePanel.vue:510-513` 鈥?绉婚櫎涓夊 emoji 鍓嶇紑锛坄馃懁 `銆乣馃搷 `銆乣馃晲 `锛?
---

## [2026-04-09] Fix #27: demo-save-adapter 蹇冭烦瀛楁璺緞涓?DEFAULT_ENGINE_PATHS 涓嶄竴鑷?
**Flow:** Data Migration 鈫?adaptDemoSave() 鈫?鏃х増瀛樻。杞崲

**Root cause:** 閫傞厤鍣ㄥ垵濮嬪寲蹇冭烦鑺傜偣鏃朵娇鐢ㄤ簡涓庢柊 schema 涓嶄竴鑷寸殑瀛楁鍚嶏細`鍚敤`锛堝簲涓?`enabled`锛夈€佺己灏?`period` 瀛楁銆乣涓婃蹇冭烦鍥炲悎搴忓彿`锛堝簲涓?`涓婃鎵ц鏃堕棿`锛夈€?
**Files changed:**
- `src/engine/persistence/demo-save-adapter.ts` 鈥?蹇冭烦鍒濆鍊间粠 `{ 閰嶇疆: { 鍚敤: false }, 鍘嗗彶: [], 涓婃蹇冭烦鍥炲悎搴忓彿: 0 }` 鏀逛负 `{ 閰嶇疆: { enabled: false, period: 5 }, 鍘嗗彶: [], 涓婃鎵ц鏃堕棿: 0 }`锛屼笌 `DEFAULT_ENGINE_PATHS.heartbeatEnabled/Period/LastRun` 瀵归綈

**Notes:** `DEFAULT_ENGINE_PATHS.heartbeatLastRun = '涓栫晫.鐘舵€?蹇冭烦.涓婃鎵ц鏃堕棿'`

---

## [2026-04-09] Fix #23: AIService 閲嶈瘯绛栫暐鏃犳寚鏁伴€€閬夸笖涓嶅揩閫熷け璐ヤ簬 401

**Flow:** All AI Calls 鈫?AIService.executeWithRetry()

**Root cause:** 閲嶈瘯寤惰繜浣跨敤绾挎€х瓥鐣ワ紙`1000 脳 attempt ms`锛夛紝娌℃湁鎸囨暟閫€閬挎垨 jitter锛屼篃涓嶅 401 閿欒蹇€熷け璐ワ紙浼氱櫧鐧介噸璇曟秷鑰楁椂闂达級銆?
**Files changed:**
- `src/engine/ai/ai-service.ts:executeWithRetry()` 鈥?閫€閬挎敼涓烘寚鏁?+ jitter锛歚Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 10000)`锛涙柊澧?401/Unauthorized/Invalid API Key 妫€娴嬶紝鍛戒腑鏃剁珛鍗?`throw` 涓嶉噸璇?
**Behavior before:** 姣忔閲嶈瘯鍥哄畾绛夊緟 1s/2s/3s锛?01 閿欒涔熶細閲嶈瘯

**Behavior after:** 閫€閬挎椂闂存寚鏁板闀匡紙绾?0.5s銆?.5s銆?.5s銆?..鏈€闀?10s锛夛紱401 绔嬪嵆澶辫触涓嶉噸璇?
---

## [2026-04-09] Fix #24: CommandExecutor 缂哄皯 demo 绾ч獙璇侀摼

**Flow:** Main Round Pipeline 鈫?CommandExecution Stage 鈫?CommandExecutor.executeBatch()

**Root cause:** `CommandExecutor.execute()` 鍙湪 `case 'add'` 妫€鏌?NaN锛屾病鏈夌粨鏋勯獙璇併€佸€兼竻鐞嗐€佹暟鍊艰寖鍥寸害鏉熴€佹垨鏁扮粍瀹归噺闄愬埗锛孉I 鐢熸垚鐨勫紓甯稿€硷紙鏋佸ぇ鏁般€佸瓧绗︿覆鍐欏叆鏁板€煎瓧娈点€佹暟缁勬棤闄愬闀匡級浼氱洿鎺ュ啓鍏ョ姸鎬佹爲銆?
**Files changed:**
- `src/engine/core/command-executor.ts` 鈥?鏂板甯搁噺 `MAX_NUMERIC_VALUE = 999_999`銆乣MAX_ARRAY_CAPACITY = 200`锛沗execute()` 鏂板 4 姝ラ獙璇侀摼锛氣憼缁撴瀯楠岃瘉锛坅ction/key 蹇呴』瀛樺湪锛夆憽set 鍊兼竻鐞嗭紙string trim, NaN鈫?锛夆憿鏁板€间慨澶嶏紙clamp 0~999999锛夆懀push 瀹归噺闄愬埗锛堣秴 200 鍏?pull 鏈€鏃у厓绱狅級锛涙柊澧?helper 鍑芥暟 `clampNumber()`銆乣sanitizeValue()`

**Behavior before:** AI 鐢熸垚 `{ action: 'set', key: '瑙掕壊.灞炴€?浣撳姏', value: 9999999 }` 浼氱洿鎺ュ啓鍏ワ紱push 鍒版棤闄愬ぇ鏁扮粍涓嶅彈闄?
**Behavior after:** 鏁板€煎す鑷?[0, 999999]锛涙暟缁勮秴 200 鍏冪礌鏃惰嚜鍔ㄦ窐姹版渶鏃?
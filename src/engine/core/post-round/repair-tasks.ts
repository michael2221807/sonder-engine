import { eventBus } from '../event-bus';
import type { PipelineContext } from '../../pipeline/types';
import type { PrivacyIncompleteReport } from '../../validators/privacy-profile-validator';
import type { PostRoundEnv } from './types';

/** Post-round repair tasks (privacy repair, generic field repair + edge-review write-back). Moved verbatim. */
export async function runPrivacyRepair(env: PostRoundEnv, ctx: PipelineContext): Promise<void> {
  const { sub } = env;
  // ── 5. §11.2 B: 私密信息修复（NSFW 核心） ──
  // CommandExecutionStage 在 nsfwMode=true 时扫描并写 ctx.meta.pendingPrivacyRepair。
  // 这里消费该 flag，通过 PrivacyProfileRepairPipeline 补齐缺失字段（带 retry）。
  //
  // 放在 npcGeneration 之后的原因：新生成的 NPC 也需要被扫描和补齐。
  // 但 npcGeneration 本身不触发 validator（那是下一回合 CommandExecutionStage 的事）。
  // 所以本回合的 privacy repair 只针对主管线 AI 生成/修改的 NPC。
  const pendingPrivacy = ctx.meta['pendingPrivacyRepair'] as PrivacyIncompleteReport | undefined;
  if (pendingPrivacy && sub.privacyRepair) {
    try {
      const result = await sub.privacyRepair.execute(pendingPrivacy);
      if (result.success) {
        console.log(`[Orchestrator] PrivacyProfileRepairPipeline completed in ${result.attempts} attempt(s)`);
        eventBus.emit('ui:toast', {
          type: 'success',
          i18nKey: 'engine.toast.privacyFieldsRepaired',
          message: '扩展字段已自动补齐',
          duration: 1500,
        });
      } else {
        console.warn(
          `[Orchestrator] PrivacyProfileRepairPipeline finished with ${result.remaining.total} remaining after ${result.attempts} attempts`,
        );
        eventBus.emit('ui:toast', {
          type: 'warning',
          i18nKey: 'engine.toast.privacyFieldsIncomplete',
          i18nParams: { count: result.remaining.total },
          message: `仍有 ${result.remaining.total} 项扩展字段未补齐（已达重试上限）`,
          duration: 3000,
        });
      }
    } catch (err) {
      console.error('[Orchestrator] PrivacyProfileRepairPipeline failed:', err);
    }
  }
}

export async function runFieldRepair(env: PostRoundEnv): Promise<void> {
  const { sub, stateManager } = env;
  // ── 6. 通用字段补齐（2026-04-18） ──
  // Runs AFTER privacy repair so newly-populated 私密信息 (and its 4 required
  // body parts, 初夜 fields etc.) don't get flagged as missing by the
  // generic validator. Scans `rules/required-fields.json` against current
  // state; fires repair pipeline only when at least one entity has gaps.
  if (sub.fieldRepair) {
    try {
      const result = await sub.fieldRepair.execute();
      // When the extra (feature-owned) task was the only work, the basic-fields messages do not apply.
      const onlyExtra = !!result.extra && !result.fieldsNeeded && !result.entityEnrichResult && !result.edgeReviewResult;
      if (result.extra && !result.extra.resolved) {
        eventBus.emit('ui:toast', {
          type: 'warning',
          i18nKey: 'engine.toast.extraRepairIncomplete',
          message: '部分自动修复未完成，本回合照常保留',
          duration: 3000,
        });
      }
      if (result.attempts > 0 && !onlyExtra) {
        if (result.success) {
          console.log(`[Orchestrator] FieldRepairPipeline completed in ${result.attempts} attempt(s)`);
          eventBus.emit('ui:toast', {
            type: 'success',
            i18nKey: 'engine.toast.basicFieldsRepaired',
            message: '基础字段已自动补齐',
            duration: 1500,
          });
        } else {
          console.warn(
            `[Orchestrator] FieldRepairPipeline finished with ${result.remaining.total} remaining after ${result.attempts} attempts`,
          );
          eventBus.emit('ui:toast', {
            type: 'warning',
            i18nKey: 'engine.toast.basicFieldsIncomplete',
            i18nParams: { count: result.remaining.total },
            message: `仍有 ${result.remaining.total} 项字段未补齐（已达重试上限）`,
            duration: 3000,
          });
        }
      }
      if (result.entityEnrichResult && result.entityEnrichResult.enriched > 0) {
        console.log(
          `[Orchestrator] EntityEnrich: ${result.entityEnrichResult.enriched} entity(s) enriched (${result.entityEnrichResult.remaining} still pending)`,
        );
      }
      if (result.edgeReviewResult) {
        if (result.edgeReviewResult.invalidated > 0) {
          console.log(
            `[Orchestrator] EdgeReview: ${result.edgeReviewResult.invalidated} edge(s) invalidated out of ${result.edgeReviewResult.reviewed} reviewed`,
          );
        }
        const p = sub.paths;
        if (p) {
          const history = stateManager.get<Array<Record<string, unknown>>>(p.narrativeHistory) ?? [];
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i]._engramWrite) {
              // That one field only (存档瘦身 P1): a set of the whole history deep-copies it three times.
              stateManager.set(`${p.narrativeHistory}.${i}._engramWrite.reviewResult`, result.edgeReviewResult, 'system');
              break;
            }
          }
        }
      }
    } catch (err) {
      console.error('[Orchestrator] FieldRepairPipeline failed:', err);
    }
  }
}

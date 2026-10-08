/**
 * useSessionMode — 会话模式（游玩 / 写卡）反应式单例（Story 9 / D17）
 *
 * 双层 source of truth：
 * - durable: `SaveSlotMeta.sessionType`（每存档持久化，缺省 'play'）
 * - reactive: 本模块的 module-singleton `sessionType` ref，供 UI 模板分支
 *
 * 引擎纯度：引擎管线**永不读** sessionType。本 composable 是纯 UI 层，
 * 仅通过既有 ProfileManager（轻量元数据写）落盘。sessionType 不进 GameStateTree，
 * 不进 DEFAULT_ENGINE_PATHS，不进 .aga-card。
 *
 * 初始化点：由 GameLayout 在 session 期间持有并 watch(activeSlotId) → syncFromActiveSlot()，
 * 保证 watcher 不随子面板卸载而断（见 plan P2）。其余组件只读 isWorldBuilding。
 */
import { ref, computed } from 'vue';
import { injectService } from '@/ui/injection-keys';
import type { ComputedRef, Ref } from 'vue';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { eventBus } from '@/engine/core/event-bus';
import type { SessionType } from '@/engine/types/persistence';
// App doc: docs/user-guide/pages/game-overview.md §4.0.5

/** Module-singleton：跨路由/组件共享同一会话模式状态。 */
const sessionType = ref<SessionType>('play');
/** 持久化进行中——防止快速双击产生并发写 + 错误回滚基线（R1 issue 4）。 */
const isPersisting = ref(false);

export interface UseSessionModeReturn {
  /** 当前会话模式（响应式只读引用） */
  sessionType: Ref<SessionType>;
  /** 是否写卡模式 */
  isWorldBuilding: ComputedRef<boolean>;
  /** 持久化进行中（UI 可据此禁用切换按钮，防并发） */
  isPersisting: Ref<boolean>;
  /** 设置模式并持久化到当前存档元数据（失败回滚 + toast） */
  setMode: (mode: SessionType) => Promise<void>;
  /** 在游玩 / 写卡之间切换 */
  toggle: () => Promise<void>;
  /** 从当前活跃存档槽的元数据同步模式（slot 切换 / 载入时调用） */
  syncFromActiveSlot: () => void;
}

export function useSessionMode(): UseSessionModeReturn {
  const store = useEngineStateStore();
  // 与 SavePanel / HomeView / CardExportFlow 同一注入 key
  const profileManager = injectService('profileManager', undefined);

  const isWorldBuilding = computed(() => sessionType.value === 'worldBuilding');

  function syncFromActiveSlot(): void {
    // 先默认 'play'：单例永不残留上一会话的模式，无论 slot / profileManager 是否可用（R1 issue 1）。
    sessionType.value = 'play';
    const pid = store.activeProfileId;
    const sid = store.activeSlotId;
    if (!pid || !sid || !profileManager) return;
    sessionType.value = profileManager.getSlotMeta(pid, sid)?.sessionType ?? 'play';
  }

  async function setMode(mode: SessionType): Promise<void> {
    // 同模式 no-op；持久化进行中则忽略（防并发写 + 错误回滚基线错乱，R1 issue 4）
    if (sessionType.value === mode || isPersisting.value) return;

    const pid = store.activeProfileId;
    const sid = store.activeSlotId;

    // 真·无 slot（如创角途中）：仅内存态。顶栏开关在无 slot 时本就隐藏，属良性路径。
    if (!pid || !sid) {
      sessionType.value = mode;
      return;
    }

    // 有 slot 却拿不到持久层 = 非预期故障，不是"无 slot"。必须报错，
    // 否则乐观改了 ref 但没落盘，下次 sync 会静默回退、用户毫无感知（R1 issue 2）。
    if (!profileManager) {
      eventBus.emit('ui:toast', {
        type: 'error',
        i18nKey: 'layout.sessionMode.persistFailed',
        message: '切换会话模式失败',
      });
      throw new Error('useSessionMode.setMode: profileManager unavailable');
    }

    const prev = sessionType.value;
    sessionType.value = mode; // optimistic — UI 立即响应
    isPersisting.value = true;
    try {
      await profileManager.updateSlotMeta(pid, sid, { sessionType: mode });
    } catch (err) {
      // 持久化失败 → 回滚反应式态，避免"看似已切换实则没存"
      sessionType.value = prev;
      eventBus.emit('ui:toast', {
        type: 'error',
        i18nKey: 'layout.sessionMode.persistFailed',
        message: '切换会话模式保存失败',
      });
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      isPersisting.value = false;
    }
  }

  function toggle(): Promise<void> {
    return setMode(sessionType.value === 'play' ? 'worldBuilding' : 'play');
  }

  return { sessionType, isWorldBuilding, isPersisting, setMode, toggle, syncFromActiveSlot };
}

/**
 * 仅供单测：重置 module-singleton，防止用例间状态串扰。
 * 生产代码请勿调用。
 */
export function __resetSessionModeForTest(): void {
  sessionType.value = 'play';
  isPersisting.value = false;
}

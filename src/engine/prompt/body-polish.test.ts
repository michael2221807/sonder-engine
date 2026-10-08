/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { DEFAULT_BODY_POLISH_PROMPT } from './body-polish-default';
import { BODY_POLISH_COT } from './body-polish-cot';

// Pack file path relative to this test file (works in both ESM and vitest runtimes).
const packPath = fileURLToPath(
  new URL('../../../public/packs/tianming/prompts/bodyPolish.md', import.meta.url),
);

/**
 * Phase 4 migration verification (2026-04-19) — proves the ported polish prompt
 * obeys the wuxia-removal policy while preserving the NSFW vocabulary
 * clause (explicit user directive).
 *
 * Design doc: docs/research/mrjh-migration/06-round-divider-plan.md §8.1.
 */

describe('DEFAULT_BODY_POLISH_PROMPT — migration constraints', () => {
  describe('MUST-KEEP tokens (verbatim NSFW clause + structural rules)', () => {
    // User explicit directive (2026-04-19): keep 第[11]条 verbatim, including every anatomical word.
    const NSFW_WORDS = ['肉棒', '小穴', '阴蒂', '乳头', '蜜液', '精液'];
    for (const w of NSFW_WORDS) {
      it(`contains anatomical vocabulary: ${w}`, () => {
        expect(DEFAULT_BODY_POLISH_PROMPT).toContain(w);
      });
    }

    it('retains the NSFW clause sentence structure (第 11 条)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).toContain(
        '11) 若原文已经进入 NSFW 场景，你应该把过于含混的成人描写整理成清楚、直白、可感的身体表达',
      );
    });

    it('retains the output structure hard-rule (thinking + 正文)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).toContain('<thinking>...</thinking>');
      expect(DEFAULT_BODY_POLISH_PROMPT).toContain('<正文>...</正文>');
    });

    it('teaches AGA judgement format (〖...〗 with key:value,) and forbids legacy 【判定】 line format', () => {
      // AGA format must be documented.
      expect(DEFAULT_BODY_POLISH_PROMPT).toContain('〖类型:结果,判定值:X,难度:Y,基础:B,幸运:L,环境:E,状态:S〗');
      // Explicit rule: preserve byte-for-byte.
      expect(DEFAULT_BODY_POLISH_PROMPT).toMatch(/byte-identical|字面保留/);
    });

    it('retains <judge> handling rules (thinking-block, AGA-compatible)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).toContain('<judge>');
    });

    it('retains the Step 1–7 execution order', () => {
      for (let i = 1; i <= 7; i++) {
        expect(DEFAULT_BODY_POLISH_PROMPT).toContain(`Step${i}`);
      }
    });

    it('retains role label: 叙事小说主编 (post-replacement)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).toContain('叙事小说主编');
    });
  });

  describe('MUST-REMOVE tokens (wuxia-specific language)', () => {
    it('does NOT contain 武侠小说 (replaced with 叙事小说)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('武侠小说');
    });

    it('does NOT contain 功法 (deleted from hard-rules list)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('功法');
    });

    it('does NOT contain 门派 (deleted from hard-rules list)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('门派');
    });

    it('does NOT contain 古风净化 (deleted from Step3 parenthetical)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('古风净化');
    });

    it('does NOT cite wuxia novels (reference-literature section removed)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('雪中悍刀行');
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('世子很凶');
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('娱乐春秋');
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('参考文脉');
    });

    it('does NOT contain wuxia combat imagery (deleted examples)', () => {
      // From Example #6 动作链 and #10 暴力段落 — both deleted entirely.
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('拧腰送肘');
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('刀锋自肋下');
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('寒光掠过');
    });

    it('does NOT contain 拔刀 (deleted from Example #6 优 line)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).not.toContain('拔刀');
    });
  });

  describe('AGA format — no legacy row-type tags', () => {
    /**
     * AGA does not split narrative by 旁白/角色名 line-prefix tags. The prompt
     * must NOT instruct the model to produce those — they'd render as
     * environment markers in AGA's FormattedText (italic gray), which is wrong.
     * The one required mention is in the "do NOT emit these tags" rule itself;
     * that's allowed. So we assert each token appears only in rule/prohibition
     * contexts (not as output examples).
     */

    it('has an explicit rule banning 【旁白】 / 【角色名】 / 【路人甲】 prefixes', () => {
      // The prompt must tell the model not to emit these.
      expect(DEFAULT_BODY_POLISH_PROMPT).toMatch(/不得[\s\S]*?【旁白】/);
      expect(DEFAULT_BODY_POLISH_PROMPT).toMatch(/不得[\s\S]*?【角色名/);
    });

    it('never uses 【旁白】 / 【角色名】 as an instructive example (only in bans)', () => {
      // Any occurrence of 【旁白】 or 【角色名】 in example blocks (劣/优 lines) would
      // teach the model to emit them. We check by asserting those tokens never
      // appear on a line starting with `- 劣：` or `- 优：`.
      const lines = DEFAULT_BODY_POLISH_PROMPT.split('\n');
      const exampleLines = lines.filter((l) => /^- (劣|优)：/.test(l));
      for (const line of exampleLines) {
        expect(line).not.toContain('【旁白】');
        expect(line).not.toContain('【角色名】');
      }
    });

    it('has an explicit rule to preserve 〖...〗 judgement blocks byte-for-byte', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).toMatch(/byte-identical|字面保留/);
      expect(DEFAULT_BODY_POLISH_PROMPT).toContain('不改写、不合并');
    });

    it('forbids rewriting judgement blocks into legacy pipe-separated format', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT).toMatch(/不得.*旧式|不得.*【判定】/);
    });
  });

  describe('integrity', () => {
    it('is a non-trivial prompt (post-format-cleanup ~3.8KB)', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT.length).toBeGreaterThan(3500);
    });

    it('ends with Step7 final review sentence', () => {
      expect(DEFAULT_BODY_POLISH_PROMPT.trimEnd().endsWith('<正文>\`。')).toBe(true);
    });
  });
});

describe('BODY_POLISH_COT — migration constraints', () => {
  it('contains all Step0–Step13 headers', () => {
    for (let i = 0; i <= 13; i++) {
      expect(BODY_POLISH_COT).toContain(`Step${i}:`);
    }
  });

  it('retains the NSFW vocabulary clause at Step 7 verbatim', () => {
    // User explicit directive: these words stay.
    const NSFW_WORDS = ['肉棒', '小穴', '阴蒂', '乳头', '蜜液', '精液'];
    for (const w of NSFW_WORDS) {
      expect(BODY_POLISH_COT).toContain(w);
    }
  });

  it('retains <thinking> / <正文> output contract', () => {
    expect(BODY_POLISH_COT).toContain('<thinking>');
    expect(BODY_POLISH_COT).toContain('</thinking>');
    expect(BODY_POLISH_COT).toContain('<正文>');
  });

  it('does NOT contain 招式 (deleted from Step 1)', () => {
    expect(BODY_POLISH_COT).not.toContain('招式');
  });

  it('has AGA judgement format rule (〖...〗 byte-identical preservation)', () => {
    expect(BODY_POLISH_COT).toContain('〖类型:结果,判定值:X,难度:Y,基础:B,幸运:L,环境:E,状态:S〗');
    expect(BODY_POLISH_COT).toContain('byte-identical');
  });

  it('bans 【旁白】 / 【角色名】 row-prefix tags', () => {
    expect(BODY_POLISH_COT).toMatch(/绝不输出[\s\S]*?【旁白】/);
    expect(BODY_POLISH_COT).toMatch(/不按说话者拆分行/);
  });
});

describe('pack file sync — public/packs/tianming/prompts/bodyPolish.md', () => {
  const readNormalizedPack = () => readFileSync(packPath, 'utf-8').replace(/\r\n/g, '\n');
  /**
   * The pack file is the runtime-visible copy (consumed by PromptAssembler).
   * TS constants are the source of truth; a drift between them means users get
   * a different prompt than the code declares. This test fails loudly if they
   * diverge — fix by running `node scripts/sync-body-polish-pack.mjs` from
   * the repo root.
   */
  it('contains DEFAULT_BODY_POLISH_PROMPT verbatim', () => {
    const pack = readNormalizedPack();
    expect(pack).toContain(DEFAULT_BODY_POLISH_PROMPT);
  });

  it('contains BODY_POLISH_COT verbatim', () => {
    const pack = readNormalizedPack();
    expect(pack).toContain(BODY_POLISH_COT);
  });
});

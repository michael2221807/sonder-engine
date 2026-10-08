/**
 * Sync the bodyPolish pack file from the TS constants.
 *
 * Run: `node scripts/sync-body-polish-pack.mjs` from repo root.
 *
 * Reads the TS source files, extracts the template literal content,
 * un-escapes `\\\`` back to `` ` ``, and writes the pack markdown file.
 * This keeps the runtime pack file and the TS unit-test constants in sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function extractLiteral(tsRelPath, varName) {
  const abs = path.join(repoRoot, tsRelPath);
  const src = fs.readFileSync(abs, 'utf-8');
  const marker = `export const ${varName} = `;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`no marker for ${varName} in ${tsRelPath}`);
  const openBacktick = String.fromCharCode(96);
  const openIdx = src.indexOf(openBacktick, start + marker.length);
  if (openIdx < 0) throw new Error(`no opening backtick for ${varName}`);
  const closeSeq = openBacktick + ';';
  const closeIdx = src.indexOf(closeSeq, openIdx + 1);
  if (closeIdx < 0) throw new Error(`no closing backtick-semi for ${varName}`);
  const raw = src.slice(openIdx + 1, closeIdx);
  // Un-escape \` → ` (the only escape sequence used inside these template literals).
  const pattern = String.fromCharCode(92, 96); // `\` + `` ` ``
  return raw.split(pattern).join(openBacktick);
}

const defaultPrompt = extractLiteral(
  'src/engine/prompt/body-polish-default.ts',
  'DEFAULT_BODY_POLISH_PROMPT',
);
const cotPrompt = extractLiteral(
  'src/engine/prompt/body-polish-cot.ts',
  'BODY_POLISH_COT',
);

const outPath = path.join(repoRoot, 'public/packs/tianming/prompts/bodyPolish.md');
fs.writeFileSync(outPath, defaultPrompt + '\n\n' + cotPrompt + '\n', 'utf-8');

console.log(
  `pack synced: default=${defaultPrompt.length} chars, cot=${cotPrompt.length} chars, total=${fs.statSync(outPath).size} bytes`,
);

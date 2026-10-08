/**
 * Composition-aware anchor injection — ported
 *
 * Filters a character anchor's positive prompt based on composition type.
 * Portrait crops to face/hair tags; secret parts allow only body-relevant
 * tags; half-body/full-length/scene pass the full anchor unchanged.
 *
 * Two strategies (in priority order):
 * 1. Structured features — pick from categorized tag arrays
 * 2. Raw prompt parsing — regex allow/deny on comma-split tokens
 *
 * All regex patterns are verbatim from the original codebase.
 */
import type { AnchorStructuredFeatures, SecretPartType } from './types';
import { splitByComma, dedupTokens } from './prompt-tokens';

export type AnchorComposition = 'portrait' | 'half-body' | 'full-length' | 'scene' | 'secret_part' | 'custom';

export interface AnchorInput {
  positive: string;
  structuredFeatures?: AnchorStructuredFeatures;
}

export interface AnchorInjectionOptions {
  composition: AnchorComposition;
  secretPartType?: SecretPartType;
}

// ── Camera/composition words to always strip ──
const CAMERA_WORDS_RE = /(headshot|portrait|upper body|waist-?up|full body|cowboy shot|close-?up|extreme close-?up|wide shot|mid shot|low angle|high angle|standing|sitting|kneeling|running|framing|character sheet|composition|depth of field|rule of thirds|feet included|floor contact|avatar)/i;

// ── Helper utility functions ──

/** Remove camera/composition words */
function removeCameraWords(tokens: string[]): string[] {
  return tokens.filter((token) => !CAMERA_WORDS_RE.test(token));
}

/**
 * Pick tags from structured feature arrays by key — ported
 */
function pickFromFeatures(
  features: AnchorStructuredFeatures | undefined,
  keys: Array<keyof AnchorStructuredFeatures>,
  limit = 24,
): string[] {
  if (!features) return [];
  const fragments = keys
    .flatMap((key) => (Array.isArray(features[key]) ? features[key]! : []))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return removeCameraWords(dedupTokens(fragments)).slice(0, Math.max(0, limit));
}

/**
 * Pick tags from raw positive prompt via allow/deny regex — ported
 */
function pickFromRawPrompt(
  positive: string,
  params: { allow: RegExp; deny: RegExp; limit?: number },
): string[] {
  if (!positive) return [];
  // NAI weight syntax → skip injection to avoid breaking grouped syntax
  if (/::/.test(positive)) return [];
  const tokens = removeCameraWords(dedupTokens(splitByComma(positive)));
  const filtered = tokens.filter((token) => params.allow.test(token) && !params.deny.test(token));
  return filtered.slice(0, Math.max(0, params.limit ?? 24));
}

/**
 * Filter a character anchor's positive prompt based on composition.
 *
 * Returns a comma-joined string of composition-appropriate tags,
 * or the full anchor positive prompt for compositions that need
 * the complete visual DNA (half-body, full-length, scene, custom).
 *
 * Build composition-aware anchor injection prompt — ported
 */
export function injectAnchorByComposition(
  anchor: AnchorInput | null | undefined,
  options: AnchorInjectionOptions,
): string {
  const positive = (anchor?.positive || '').trim();
  const features = anchor?.structuredFeatures;
  const composition = options.composition;

  // ── Portrait (头像): face/hair/eye/skin/age only ──
  if (composition === 'portrait') {
    const tokensFromFeatures = pickFromFeatures(
      features,
      ['appearance', 'hairstyle', 'hairColor', 'eyes', 'skinTone', 'ageAppearance', 'specialTraits'],
      20,
    );
    if (tokensFromFeatures.length > 0) return tokensFromFeatures.join(', ');

    // Allow regex (verbatim from original)
    const allow = /(1girl|1boy|girl|boy|woman|man|female|male|young|adult|teen|hair|eyes?|iris|pupil|eyebrow|eyelash|face|lips?|mouth|nose|skin|complexion|freckle|mole|beauty mark|scar|tattoo|makeup|ear|neck)/i;
    // Deny regex (verbatim from original)
    const deny = /(breast|bust|cleavage|waist|hip|thigh|leg|feet|nude|dress|robe|hanfu|armor|outfit|clothing|sleeve|glove|stocking|boots|pants|skirt|kimono|cape|cloak|weapon|sword|background|scenery|environment|landscape)/i;
    return pickFromRawPrompt(positive, { allow, deny, limit: 16 }).join(', ');
  }

  // ── Secret part (部位特写) ──
  if (composition === 'secret_part') {
    const part = options.secretPartType;

    // Breast close-up: allow breast/skin/age tags
    if (part === 'breast') {
      const allow = /(breast|breasts|bust|cup|cleavage|nipple|nipples|areola|chest|skin|complexion|pale|fair|tan|young|adult|teen)/i;
      const deny = /(face|eyes?|hair|lips?|mouth|nose|dress|robe|hanfu|armor|outfit|clothing|upper body|waist|portrait|full body)/i;

      const tokens = pickFromFeatures(features, ['bust', 'skinTone', 'ageAppearance'], 14)
        .filter((token) => allow.test(token) && !deny.test(token));
      if (tokens.length > 0) return tokens.join(', ');

      return pickFromRawPrompt(positive, { allow, deny, limit: 10 }).join(', ');
    }

    // Other secret parts (vagina/anus): only safe skin/age tags
    const allow = /(skin|complexion|pale|fair|tan|young|adult|teen)/i;
    const deny = /(face|eyes?|hair|dress|robe|hanfu|armor|outfit|clothing|upper body|waist|portrait|full body|standing|sitting|kneeling|feet)/i;

    const safe = pickFromFeatures(features, ['skinTone', 'ageAppearance'], 8)
      .filter((token) => allow.test(token) && !deny.test(token));
    if (safe.length > 0) return safe.join(', ');

    return pickFromRawPrompt(positive, { allow, deny, limit: 6 }).join(', ');
  }

  // ── Half-body / Full-length / Scene / Custom: full anchor unchanged ──
  return positive;
}

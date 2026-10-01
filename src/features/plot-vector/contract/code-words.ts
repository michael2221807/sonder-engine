/**
 * Whether a card's own code uses a name (PO 2026-10-01): its rule reads `ctx.level`, or it returns a `relay`. Read
 * from the code with comments and string literals taken out, so a word in a comment or a text does not count; a
 * quoted object key (`{ "relay": …`, `, "level": …`) still does.
 */
const NOISE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;

export function codeMentions(onPass: string, name: string): boolean {
  const code = onPass.replace(NOISE, (match: string, quote: string | undefined, inner: string | undefined, at: number) => {
    if (!quote) return ' ';
    // A key sits after `{` or `,` and before `:`; a string in a ternary or a case label does not.
    const key = /^\s*:/.test(onPass.slice(at + match.length)) && /[{,]\s*$/.test(onPass.slice(0, at));
    return key ? ` ${inner ?? ''} ` : '""';
  });
  return new RegExp(`\\b${name}\\b`).test(code);
}

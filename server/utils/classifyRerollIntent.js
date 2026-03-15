'use strict';

/**
 * classifyRerollIntent — classify a reroll prompt as a relative modifier or full replacement.
 *
 * Returns one of three values:
 *
 *   'micro_adjust'  — the prompt contains relative/incremental modifier language
 *                     (e.g. "same vibe but 30 minutes later", "a bit more casual",
 *                     "closer to midtown"). Callers should inject MICRO-ADJUSTMENT
 *                     instructions into the Claude prompt and pass prior suggestions
 *                     as reference context.
 *
 *   'full_replace'  — the prompt is substantive but contains no recognizable modifier
 *                     signals. Callers should generate fresh suggestions from scratch.
 *
 *   'ambiguous'     — the prompt is falsy, empty, or fewer than 4 words. Callers should
 *                     fall back to full_replace behavior (ambiguous is never treated as
 *                     micro_adjust — when in doubt, replace).
 *
 * Error behavior: the entire function body is wrapped in try/catch. On any unexpected
 * error the function logs the error and returns 'ambiguous', which callers treat as
 * full_replace. This ensures a bug here never silently corrupts Claude output.
 *
 * @param {string} prompt - the user's raw reroll input (before sanitization)
 * @returns {'micro_adjust' | 'full_replace' | 'ambiguous'}
 */
function classifyRerollIntent(prompt) {
  try {
    // ── Ambiguous: empty / too short to classify reliably ──────────────────────
    if (!prompt || typeof prompt !== 'string') {
      console.debug(`[classifyRerollIntent] (empty/null) → ambiguous`);
      return 'ambiguous';
    }
    const trimmed = prompt.trim();
    if (!trimmed) {
      console.debug(`[classifyRerollIntent] (blank) → ambiguous`);
      return 'ambiguous';
    }
    // Single-word prompts are too sparse to classify reliably — treat as ambiguous.
    // Multi-word prompts (2+) proceed to pattern matching so phrases like
    // "closer to midtown" and "totally new ideas" (3 words each) are classified.
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 2) {
      console.debug(`[classifyRerollIntent] "${trimmed}" (${wordCount} word < 2) → ambiguous`);
      return 'ambiguous';
    }

    const lower = trimmed.toLowerCase();

    // ── micro_adjust patterns ───────────────────────────────────────────────────
    const patterns = [
      // Temporal modifiers — "30 minutes later", "an hour earlier", "push it back"
      /\b(earlier|later|sooner|push.?it.?back|move.?it.?up|same.?time.?but|\d+\s*min(utes?)?|an?\s+hour\s+(earlier|later))\b/,
      // Vibe modifiers — "same vibe", "a bit more casual", "slightly more low-key"
      /\b(same\s+vibe|similar\s+vibe|keep\s+the\s+vibe|a\s+(bit|little)\s+more|slightly\s+(more|less)|a\s+(bit|little)\s+less|more\s+casual|more\s+formal|more\s+upscale|more\s+low.?key|toned\s+down|dialed\s+up)\b/,
      // Distance modifiers — "closer", "nearby", "same neighborhood"
      /\b(closer|further|nearby|same\s+area|same\s+neighborhood)\b/,
      // Swap signals — "swap out X", "instead of Y", "sub out Z"
      /\b(swap\s+out|replace|instead\s+of|sub\s+out)\b/,
      // Explicit preservers — "keep everything else", "just change X"
      /\b(keep\s+everything\s+else|otherwise\s+the\s+same|just\s+change|only\s+change)\b/,
    ];

    const isMicroAdjust = patterns.some(re => re.test(lower));
    const result = isMicroAdjust ? 'micro_adjust' : 'full_replace';

    console.debug(`[classifyRerollIntent] "${prompt.slice(0, 80)}" → ${result}`);
    return result;

  } catch (err) {
    console.error('[classifyRerollIntent] unexpected error:', err.message);
    return 'ambiguous';
  }
}

module.exports = { classifyRerollIntent };

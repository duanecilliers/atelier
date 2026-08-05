/**
 * Model identity — provider + a short display name, derived from a model id.
 *
 * The cockpit's design language says color means STATUS, never brand, so a
 * model's provenance is shown as a monochrome letter-tile + short name (see
 * components/run/ModelBadge.tsx), not a colored vendor logo. This is the pure
 * derivation behind that: no rendering, no colors.
 */

export interface ModelIdentity {
  /** Coarse provider bucket, e.g. "anthropic", "openai", "google". */
  provider: string;
  /** Model name with any "provider/" path prefix stripped. */
  short: string;
}

// Ordered: first hit wins. Matched against the whole id so "anthropic/claude-…"
// and a bare "claude-opus-4-8" both resolve.
const RULES: [RegExp, string][] = [
  [/claude|anthropic/i, 'anthropic'],
  [/gpt|openai|codex|\bo[134]\b/i, 'openai'],
  [/gemini|palm|google/i, 'google'],
  [/kimi|moonshot/i, 'moonshot'],
  [/glm|z-?ai/i, 'zai'],
  [/deepseek/i, 'deepseek'],
  [/qwen/i, 'qwen'],
  [/llama|meta/i, 'meta'],
  [/mistral|mixtral/i, 'mistral'],
  [/grok|xai/i, 'xai'],
];

export function modelIdentity(model: string | null | undefined): ModelIdentity | null {
  if (!model) return null;
  const slash = model.indexOf('/');
  const short = slash >= 0 ? model.slice(slash + 1) : model;
  for (const [re, provider] of RULES) {
    if (re.test(model)) return { provider, short };
  }
  // Unknown vendor: fall back to the path prefix as the provider, else "model".
  return { provider: slash > 0 ? model.slice(0, slash) : 'model', short };
}

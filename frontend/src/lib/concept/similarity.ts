// Pure cosine similarity over Korean character-bigram TF vectors — deterministic,
// no external deps. Ported from Nodi-figma/lib/similarity.js. Used as the fallback
// grouping signal (grouping.ts) when embeddings are absent.

function normalize(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigramTF(text: string): Map<string, number> {
  const s = normalize(text);
  const tf = new Map<string, number>();
  if (s.length === 0) return tf;
  if (s.length === 1) {
    tf.set(s, 1);
    return tf;
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    tf.set(g, (tf.get(g) || 0) + 1);
  }
  return tf;
}

// cosineSimilarity(textA, textB) -> 0..1
export function cosineSimilarity(textA: string, textB: string): number {
  const A = bigramTF(textA);
  const B = bigramTF(textB);
  if (A.size === 0 || B.size === 0) return 0;

  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let dot = 0;
  for (const [g, ca] of small) {
    const cb = large.get(g);
    if (cb) dot += ca * cb;
  }
  let na = 0;
  for (const c of A.values()) na += c * c;
  let nb = 0;
  for (const c of B.values()) nb += c * c;

  const denom = Math.sqrt(na * nb);
  return denom ? Math.min(1, dot / denom) : 0;
}

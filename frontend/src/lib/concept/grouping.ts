// Semantic-similarity online clustering for the concept tree.
// Each concept is assigned to the nearest existing group (by cosine of its query
// embedding vs the group centroid); if none is close enough, it starts a new
// group. Deterministic given a fixed concept order (rehydration replays in
// created_at.asc order → identical groups). When an embedding is missing, falls
// back to Korean-bigram title similarity (lib/concept/similarity).

import { cosineSimilarity } from "./similarity";
import type { ConceptGroup } from "./types";

// Gemini embeddings are L2-normalized; cosine over them is well-scaled. These
// thresholds are conservative defaults — tune against real output.
export const GROUP_EMBED_THRESHOLD = 0.82;
export const GROUP_TEXT_THRESHOLD = 0.34;

function cosineVec(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb);
  return denom ? dot / denom : 0;
}

export interface AssignInput {
  id: string;
  title: string;
  embedding?: number[] | null;
}

export interface AssignResult {
  groups: ConceptGroup[];
  groupId: string;
}

// Assign one concept to a group, returning the NEW groups array (immutable) and
// the chosen groupId. Pure — safe to call in a reducer.
export function assignConcept(
  groups: ConceptGroup[],
  concept: AssignInput,
  opts?: { embedThreshold?: number; textThreshold?: number },
): AssignResult {
  const emb = concept.embedding ?? null;
  const embThr = opts?.embedThreshold ?? GROUP_EMBED_THRESHOLD;
  const txtThr = opts?.textThreshold ?? GROUP_TEXT_THRESHOLD;

  let bestIdx = -1;
  let bestSim = -1;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let sim: number;
    let thr: number;
    if (emb && emb.length && g.centroid.length === emb.length) {
      sim = cosineVec(emb, g.centroid);
      thr = embThr;
    } else {
      sim = cosineSimilarity(concept.title, g.label);
      thr = txtThr;
    }
    if (sim > bestSim && sim >= thr) {
      bestSim = sim;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0) {
    const next = groups.slice();
    const g = next[bestIdx];
    const n = g.memberIds.length;
    let centroid = g.centroid;
    if (emb && emb.length) {
      if (g.centroid.length === emb.length && n > 0) {
        // running mean
        centroid = g.centroid.map((v, k) => (v * n + emb[k]) / (n + 1));
      } else if (g.centroid.length === 0) {
        centroid = emb.slice();
      }
    }
    next[bestIdx] = {
      ...g,
      memberIds: [...g.memberIds, concept.id],
      centroid,
    };
    return { groups: next, groupId: g.id };
  }

  // new group; representative = this concept (stable id)
  const id = `grp-${concept.id}`;
  const group: ConceptGroup = {
    id,
    label: concept.title,
    memberIds: [concept.id],
    centroid: emb ? emb.slice() : [],
    repConceptId: concept.id,
  };
  return { groups: [...groups, group], groupId: id };
}

// Rebuild all groups from an ordered concept list (rehydration). Order MUST be
// stable (created_at.asc) for determinism.
export function buildGroups(
  concepts: AssignInput[],
  opts?: { embedThreshold?: number; textThreshold?: number },
): ConceptGroup[] {
  let groups: ConceptGroup[] = [];
  for (const c of concepts) {
    groups = assignConcept(groups, c, opts).groups;
  }
  return groups;
}

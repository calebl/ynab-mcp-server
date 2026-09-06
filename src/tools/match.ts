/**
 * Fuzzy name matching, so tools can accept the names you would say out loud
 * ("the coffee place", "Ally checking") instead of requiring YNAB's UUIDs.
 *
 * Matching is deliberately conservative: an ambiguous or unrecognised name
 * raises rather than guessing, because the caller is usually about to write to
 * the budget.
 */

export interface NamedEntity {
  id: string;
  name: string;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Scores a candidate name against a query from 0 (no match) to 1 (exact),
 * favouring whole-string matches over scattered word overlap.
 */
export function scoreMatch(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);

  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q)) return 0.9;
  if (c.includes(q)) return 0.8;

  const queryWords = q.split(" ");
  const candidateWords = new Set(c.split(" "));
  const hits = queryWords.filter((word) => candidateWords.has(word)).length;
  if (hits === 0) return 0;

  // Partial word overlap lands between 0.3 and 0.7 depending on how much of
  // the query the candidate actually accounts for.
  return 0.3 + 0.4 * (hits / queryWords.length);
}

export interface RankedMatch<T extends NamedEntity> {
  item: T;
  score: number;
}

/** Ranks every candidate that matches at all, best first. */
export function rankMatches<T extends NamedEntity>(
  query: string,
  candidates: T[]
): RankedMatch<T>[] {
  return candidates
    .map((item) => ({ item, score: scoreMatch(query, item.name) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
}

/**
 * Resolves a name to exactly one entity.
 *
 * Throws when nothing matches, or when the top two candidates score equally -
 * the error names the near misses so the caller can pick one.
 */
export function resolveName<T extends NamedEntity>(
  query: string,
  candidates: T[],
  kind: string
): T {
  const ranked = rankMatches(query, candidates);

  if (ranked.length === 0) {
    const available = candidates.map((c) => c.name).slice(0, 15).join(", ");
    throw new Error(
      `No ${kind} matching "${query}". Available ${kind}s: ${available}${candidates.length > 15 ? ", ..." : ""}`
    );
  }

  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    const tied = ranked
      .filter((match) => match.score === ranked[0].score)
      .map((match) => match.item.name)
      .join(", ");
    throw new Error(
      `"${query}" is ambiguous - it matches several ${kind}s equally well: ${tied}. Use the ${kind} id instead.`
    );
  }

  return ranked[0].item;
}

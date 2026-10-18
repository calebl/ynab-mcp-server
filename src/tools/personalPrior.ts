import * as ynab from "ynab";

/**
 * A naive-Bayes "personal prior" learned at call time from a plan's own
 * categorized outflows. Each household files payees its own way (restaurants
 * under groceries, clinics under a savings category), which general-purpose
 * models cannot know, while the plan's history encodes it directly.
 *
 * Features are payee and bank-import name tokens, the account, and a coarse
 * amount bucket. Probabilities are the classifier's own and are never
 * reported as model confidence.
 */

// Tokens that appear across unrelated merchants in bank-import strings.
const STOP_TOKENS = new Set([
  "the", "and", "inc", "llc", "com", "www", "pos", "debit", "purchase", "card", "tst", "paypal", "usa",
]);
const MIN_TOKEN_LENGTH = 3;
const MAX_AMOUNT_BUCKET = 12;

export interface PriorRanking {
  categoryId: string;
  probability: number;
}

export interface PersonalPrior {
  trainingRows: number;
  categoryCount: number;
  rank(transaction: ynab.TransactionDetail): PriorRanking[];
}

function nameTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[0-9#*]+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOP_TOKENS.has(token));
}

function amountBucket(milliunits: number): string {
  const magnitude = Math.abs(milliunits) / 1000;
  return `amount:${Math.min(Math.floor(Math.log2(magnitude + 1)), MAX_AMOUNT_BUCKET)}`;
}

export function priorFeatures(transaction: ynab.TransactionDetail): string[] {
  const features = new Set<string>();
  for (const field of [transaction.payee_name, transaction.import_payee_name, transaction.import_payee_name_original]) {
    for (const token of nameTokens(field)) features.add(`name:${token}`);
  }
  features.add(`account:${transaction.account_id}`);
  features.add(amountBucket(transaction.amount));
  return [...features];
}

/** Trains on rows whose category is already known to be eligible; the caller filters them. */
export function trainPersonalPrior(rows: ynab.TransactionDetail[]): PersonalPrior {
  const labelCounts = new Map<string, number>();
  const featureCounts = new Map<string, Map<string, number>>();
  const featureTotals = new Map<string, number>();
  const vocabulary = new Set<string>();

  for (const row of rows) {
    const label = row.category_id as string;
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    const counts = featureCounts.get(label) ?? new Map<string, number>();
    featureCounts.set(label, counts);
    for (const feature of priorFeatures(row)) {
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
      featureTotals.set(label, (featureTotals.get(label) ?? 0) + 1);
      vocabulary.add(feature);
    }
  }

  const total = rows.length;
  return {
    trainingRows: total,
    categoryCount: labelCounts.size,
    rank(transaction) {
      if (total === 0) return [];
      // A feature never seen in training says nothing about any category, but
      // scoring it would penalize categories with more history.
      const features = priorFeatures(transaction).filter((feature) => vocabulary.has(feature));
      const scores = [...labelCounts.entries()].map(([label, count]) => {
        const counts = featureCounts.get(label) as Map<string, number>;
        const denominator = (featureTotals.get(label) ?? 0) + vocabulary.size;
        let score = Math.log(count / total);
        for (const feature of features) {
          score += Math.log(((counts.get(feature) ?? 0) + 1) / denominator);
        }
        return { categoryId: label, score };
      });
      const best = Math.max(...scores.map((entry) => entry.score));
      const normalizer = scores.reduce((sum, entry) => sum + Math.exp(entry.score - best), 0);
      return scores
        .map((entry) => ({ categoryId: entry.categoryId, probability: Math.exp(entry.score - best) / normalizer }))
        .sort((a, b) => b.probability - a.probability || a.categoryId.localeCompare(b.categoryId));
    },
  };
}

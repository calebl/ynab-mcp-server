/**
 * Copy for the reminder.
 *
 * A nag you can predict is a nag you stop reading, so the wording rotates with
 * the date the same way the hour does — stable within a day, different the
 * next.
 */

export interface Snark {
  summary: string;
  description: string;
}

interface Vars {
  count: number;
  money: string;
  noun: string;
}

const TITLES: ((v: Vars) => string)[] = [
  (v) => `${v.count} ${v.noun} living rent-free in your budget (${v.money})`,
  (v) => `${v.money} of pure mystery. ${v.count} ${v.noun}.`,
  (v) => `YNAB has questions. ${v.count} of them. (${v.money})`,
  (v) => `${v.count} ${v.noun} still wearing name tags that say "???" (${v.money})`,
  (v) => `Someone spent ${v.money} and told no one. ${v.count} ${v.noun}.`,
  (v) => `${v.count} uncategorized ${v.noun} doing absolutely nothing (${v.money})`,
  (v) => `Your budget is ${v.money} of vibes right now (${v.count} ${v.noun})`,
  (v) => `${v.count} ${v.noun} awaiting their life's purpose (${v.money})`,
  (v) => `${v.money} unaccounted for. The spreadsheet weeps. (${v.count} ${v.noun})`,
  (v) => `Categorize ${v.count} ${v.noun} or keep pretending (${v.money})`,
  (v) => `${v.count} ${v.noun} in the inbox of shame (${v.money})`,
  (v) => `That ${v.money} isn't going to explain itself (${v.count} ${v.noun})`,
];

/** Used when the pending amounts net to nothing, so a "$0.00" title reads wrong. */
const TITLES_NO_MONEY: ((v: Vars) => string)[] = [
  (v) => `${v.count} ${v.noun} still wearing name tags that say "???"`,
  (v) => `${v.count} ${v.noun} living rent-free in your budget`,
  (v) => `YNAB has questions. ${v.count} of them.`,
  (v) => `${v.count} ${v.noun} awaiting their life's purpose`,
];

const CLOSERS: string[] = [
  "Two minutes in YNAB and you're free.",
  "Open YNAB. Tap things. Feel powerful.",
  "Or ask Claude to do it, you magnificent delegator.",
  "It takes less time than reading this reminder twice.",
  "Future you would like a word.",
  "The categories are right there. They're waiting.",
];

/** Stable per-day index into a list, salted so different lists don't move together. */
function pick(date: string, salt: string, length: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${salt}:${date}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;

  return hash % length;
}

export function buildSnark(
  date: string,
  count: number,
  money: string,
  detail: string,
  backlog: number,
): Snark {
  const vars: Vars = { count, money, noun: count === 1 ? "transaction" : "transactions" };

  // A netted-out total (a refund, say) would otherwise read as "$0.00 of pure mystery".
  const hasMoney = /[1-9]/.test(money);
  const titles = hasMoney ? TITLES : TITLES_NO_MONEY;
  const summary = titles[pick(date, "title", titles.length)](vars);
  const closer = CLOSERS[pick(date, "closer", CLOSERS.length)];

  const backlogLine = backlog > 0
    ? `\n\nAlso, ${backlog} ${backlog === 1 ? "straggler" : "stragglers"} from previous months are still out there. No pressure. Some pressure.`
    : "";

  return {
    summary,
    description: `${detail} so far this month.\n\n${closer}${backlogLine}`,
  };
}

// Storage and scheduling. The schema lives here and nowhere else, so the
// popup, the list page and the worker can't drift apart on what a problem
// record looks like.
//
// local storage, not sync: sync caps each item at 8KB and a couple hundred
// problems would sail past that.

export const SCHEMA_VERSION = 1;

// Day 0 is the solve itself. This ladder is what the due dates look like if
// every review lands exactly on time, which mostly they won't.
export const LADDER_DAYS = [0, 1, 3, 7, 14, 30, 60];

// The gaps are what actually gets scheduled from. See markReviewed.
export const GAPS = [1, 2, 4, 7, 16, 30];

export const TOTAL_REVIEWS = GAPS.length;

const STORAGE_KEY = 'leetreminder';

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    problems: [],
    archive: [],
    meta: {
      lastNotifiedDate: null,
      lastWakeAt: null
    }
  };
}

// --- dates ---
//
// Everything is a local calendar day written as YYYY-MM-DD, compared day to
// day rather than as a timestamp. Something due today has to stay due until
// midnight wherever the user actually is, which rules out UTC anywhere.

export function toDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayStr() {
  return toDateStr(new Date());
}

export function parseDateStr(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  // Noon rather than midnight. Add a day across a DST change from midnight
  // and you can land back on the same date.
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function addDays(dateStr, days) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// Whole days between two dates, negative if `to` is the earlier one.
export function dayDiff(from, to) {
  return Math.round((parseDateStr(to) - parseDateStr(from)) / 86400000);
}

// ISO dates sort in the order they read, so comparing the strings is a
// correct day comparison and we can skip the Date objects entirely.
export function isDueOn(problem, today = todayStr()) {
  return !!problem.dueDate && problem.dueDate <= today;
}

export function daysOverdue(problem, today = todayStr()) {
  if (!problem.dueDate) return 0;
  const diff = dayDiff(problem.dueDate, today);
  return diff > 0 ? diff : 0;
}

export function formatDateStr(dateStr) {
  if (!dateStr) return '—';
  const d = parseDateStr(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// "Today", "Tomorrow", "in 4 days", "3 days overdue".
export function relativeDayLabel(dateStr, today = todayStr()) {
  const diff = dayDiff(today, dateStr);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return '1 day overdue';
  if (diff < -1) return `${-diff} days overdue`;
  return `in ${diff} days`;
}

// --- urls ---

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

// Handles the shapes these two sites actually use:
//   leetcode.com/problems/two-sum/  (and /description/, /solutions/, ...)
//   neetcode.io/problems/two-sum    (and ?list=..., #hash)
// Null for anything else, so we never end up saving a problem list page.
export function parseProblemUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  let source = null;
  if (host === 'leetcode.com') source = 'leetcode';
  else if (host === 'neetcode.io') source = 'neetcode';
  else return null;

  if (parts[0] !== 'problems' || !parts[1]) return null;

  const slug = decodeURIComponent(parts[1]).toLowerCase();
  if (!SLUG_RE.test(slug)) return null;

  return { source, slug, canonicalUrl: canonicalUrlFor(source, slug) };
}

export function canonicalUrlFor(source, slug) {
  return source === 'neetcode'
    ? `https://neetcode.io/problems/${slug}`
    : `https://leetcode.com/problems/${slug}/`;
}

// "two-sum" -> "Two Sum", for when there's no page to scrape or the scrape
// came back empty.
export function prettifySlug(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function normalizeDifficulty(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('eas')) return 'Easy';
  if (v.startsWith('med')) return 'Medium';
  if (v.startsWith('har')) return 'Hard';
  return 'Unknown';
}

// --- reading and writing state ---

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();

  let state = { ...defaultState(), ...raw };
  state.meta = { ...defaultState().meta, ...(raw.meta || {}) };
  state.problems = Array.isArray(raw.problems) ? raw.problems : [];
  state.archive = Array.isArray(raw.archive) ? raw.archive : [];

  // Migrations chain on here when the shape changes:
  //   if (state.schemaVersion < 2) { ...; state.schemaVersion = 2; }

  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

export async function getState() {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  return migrate(bag[STORAGE_KEY]);
}

async function putState(state) {
  state.schemaVersion = SCHEMA_VERSION;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

// Read, modify, write. Set `abort` on whatever `fn` returns to bail out
// without saving.
async function mutate(fn) {
  const state = await getState();
  const result = await fn(state);
  if (result && result.abort) return result;
  await putState(state);
  return result || { ok: true };
}

export async function replaceState(state) {
  return putState(migrate(state));
}

// --- problem records ---
//
// {
//   slug:       "two-sum",
//   title:      "Two Sum",
//   difficulty: "Easy" | "Medium" | "Hard" | "Unknown",
//   sources:    { leetcode?: url, neetcode?: url },  // two sites, one record
//   addedAt:    "2026-09-20",  // shown in the UI, never scheduled from
//   stage:      0..6,          // reviews done; 0 means solved but not reviewed
//   dueDate:    "2026-09-21",  // absolute, and the only thing we trust
//   lastReviewedOn: "2026-09-21" | null,
//   history:    [{ review, dueWas, doneOn }],
//   graduatedAt: "2026-11-20"  // archive only
// }

function makeProblem({ slug, source, url, title, difficulty, today }) {
  return {
    slug,
    title: title || prettifySlug(slug),
    difficulty: normalizeDifficulty(difficulty),
    sources: { [source]: url || canonicalUrlFor(source, slug) },
    addedAt: today,
    stage: 0,
    dueDate: addDays(today, GAPS[0]),
    lastReviewedOn: null,
    history: []
  };
}

export function primaryUrl(problem) {
  return (
    problem.sources?.leetcode ||
    problem.sources?.neetcode ||
    canonicalUrlFor('leetcode', problem.slug)
  );
}

export function sourceLabel(problem) {
  const keys = Object.keys(problem.sources || {});
  if (keys.length === 0) return 'Unknown';
  const names = { leetcode: 'LeetCode', neetcode: 'NeetCode' };
  return keys.map((k) => names[k] || k).join(' + ');
}

export function reviewLabel(problem) {
  return `Review ${Math.min(problem.stage + 1, TOTAL_REVIEWS)} of ${TOTAL_REVIEWS}`;
}

// Dedupes on slug, so adding two-sum from LeetCode and then again from
// NeetCode gets you one record with two links instead of two rows that
// drift out of sync.
export async function addProblem({ slug, source, url, title, difficulty }) {
  if (!slug || !SLUG_RE.test(slug)) return { ok: false, status: 'invalid' };
  if (source !== 'leetcode' && source !== 'neetcode') return { ok: false, status: 'invalid' };

  const today = todayStr();
  return mutate((state) => {
    const existing = state.problems.find((p) => p.slug === slug);
    if (existing) {
      const hadSource = !!existing.sources?.[source];
      existing.sources = { ...existing.sources, [source]: url || canonicalUrlFor(source, slug) };
      // Upgrade placeholder metadata if this visit scraped something better.
      if (title && (!existing.title || existing.title === prettifySlug(slug))) existing.title = title;
      if (existing.difficulty === 'Unknown' && difficulty) {
        existing.difficulty = normalizeDifficulty(difficulty);
      }
      return { ok: true, status: hadSource ? 'duplicate' : 'merged', problem: existing };
    }

    const archived = state.archive.find((p) => p.slug === slug);
    if (archived) {
      return { ok: false, status: 'graduated', problem: archived, abort: true };
    }

    const problem = makeProblem({ slug, source, url, title, difficulty, today });
    state.problems.push(problem);
    return { ok: true, status: 'added', problem };
  });
}

// Tick a review off. Two things here that are easy to get wrong:
//
// Early ticks are refused in this function, not just greyed out in the UI,
// because the UI is the easy half to get right.
//
// The next due date counts from today, the day it actually got done. Finish
// a review three days late and the rest of the ladder moves out three days
// with it, rather than the next interval quietly getting shorter.
export async function markReviewed(slug, opts = {}) {
  const today = opts.today || todayStr();
  return mutate((state) => {
    const idx = state.problems.findIndex((p) => p.slug === slug);
    if (idx === -1) return { ok: false, status: 'not-found', abort: true };

    const p = state.problems[idx];
    if (!p.dueDate || p.dueDate > today) {
      return { ok: false, status: 'not-due', dueDate: p.dueDate, abort: true };
    }

    p.history.push({ review: p.stage + 1, dueWas: p.dueDate, doneOn: today });
    p.stage += 1;
    p.lastReviewedOn = today;

    if (p.stage >= TOTAL_REVIEWS) {
      p.dueDate = null;
      p.graduatedAt = today;
      state.problems.splice(idx, 1);
      state.archive.push(p);
      return { ok: true, status: 'graduated', problem: p };
    }

    // today + the next gap, not addedAt + anything.
    p.dueDate = addDays(today, GAPS[p.stage]);
    return { ok: true, status: 'advanced', problem: p };
  });
}

export async function deleteProblem(slug) {
  return mutate((state) => {
    const before = state.problems.length + state.archive.length;
    state.problems = state.problems.filter((p) => p.slug !== slug);
    state.archive = state.archive.filter((p) => p.slug !== slug);
    const after = state.problems.length + state.archive.length;
    return { ok: after < before, status: after < before ? 'deleted' : 'not-found' };
  });
}

// Drop a graduated problem back at the bottom of the ladder.
export async function restartProblem(slug) {
  const today = todayStr();
  return mutate((state) => {
    const idx = state.archive.findIndex((p) => p.slug === slug);
    if (idx === -1) return { ok: false, status: 'not-found', abort: true };
    const p = state.archive[idx];
    state.archive.splice(idx, 1);
    delete p.graduatedAt;
    p.stage = 0;
    p.addedAt = today;
    p.dueDate = addDays(today, GAPS[0]);
    p.lastReviewedOn = null;
    p.history = [];
    state.problems.push(p);
    return { ok: true, status: 'restarted', problem: p };
  });
}

// --- queries ---
//
// All recomputed from storage on demand. Nothing caches a due count, because
// a cached one is wrong the moment the day rolls over.

// Due today plus anything overdue, worst first.
export function selectDue(state, today = todayStr()) {
  return state.problems
    .filter((p) => isDueOn(p, today))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.slug.localeCompare(b.slug)));
}

// Not due yet, soonest first.
export function selectUpcoming(state, today = todayStr()) {
  return state.problems
    .filter((p) => !isDueOn(p, today))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.slug.localeCompare(b.slug)));
}

export async function getDueCount(today = todayStr()) {
  const state = await getState();
  return selectDue(state, today).length;
}

// --- meta ---

export async function getMeta() {
  return (await getState()).meta;
}

export async function setMeta(patch) {
  return mutate((state) => {
    state.meta = { ...state.meta, ...patch };
    return { ok: true, meta: state.meta };
  });
}

// True for the first caller of the day, false for everyone after. This is
// what keeps a worker restart from firing the same reminder twice.
export async function claimDailyNotification(today = todayStr()) {
  const result = await mutate((state) => {
    if (state.meta.lastNotifiedDate === today) return { ok: false, claimed: false };
    state.meta.lastNotifiedDate = today;
    return { ok: true, claimed: true };
  });
  return !!result.claimed;
}

// --- dev helpers, behind the hidden panel in the popup ---

export const dev = {
  // Shift one problem back N days so it comes due now.
  async backdate(slug, days = 1) {
    return mutate((state) => {
      const p = state.problems.find((x) => x.slug === slug);
      if (!p) return { ok: false, status: 'not-found', abort: true };
      p.addedAt = addDays(p.addedAt, -days);
      if (p.dueDate) p.dueDate = addDays(p.dueDate, -days);
      return { ok: true, status: 'backdated', problem: p };
    });
  },

  // Same thing, for everything at once.
  async backdateAll(days = 1) {
    return mutate((state) => {
      for (const p of state.problems) {
        p.addedAt = addDays(p.addedAt, -days);
        if (p.dueDate) p.dueDate = addDays(p.dueDate, -days);
      }
      return { ok: true, status: 'backdated', count: state.problems.length };
    });
  },

  // Forget that today's reminder already went out.
  async clearNotifyFlag() {
    return setMeta({ lastNotifiedDate: null });
  },

  async wipe() {
    await chrome.storage.local.remove(STORAGE_KEY);
    return { ok: true, status: 'wiped' };
  }
};

export const STORAGE_KEY_NAME = STORAGE_KEY;

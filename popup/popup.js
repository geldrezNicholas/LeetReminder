// The popup. Opening it counts as a wake: it asks the worker to rescan and
// repaint, and works out what's due from storage itself rather than trusting
// a number from anywhere else.

import {
  getState,
  selectDue,
  selectUpcoming,
  todayStr,
  daysOverdue,
  formatDateStr,
  relativeDayLabel,
  addProblem,
  markReviewed,
  deleteProblem,
  parseProblemUrl,
  prettifySlug,
  primaryUrl,
  sourceLabel,
  reviewLabel,
  dev,
  STORAGE_KEY_NAME
} from '../src/storage.js';

const UPCOMING_PREVIEW = 6;

const NOTIFY_RESULT = {
  ok: 'Notification fired.',
  'already-today': 'Already notified today. Reset the flag to fire again.',
  'nothing-due': 'Nothing due, so no notification.',
  failed: 'Chrome refused the notification. Check its permission.'
};

const $ = (sel) => document.querySelector(sel);

const els = {
  brand: $('#brand'),
  dueChip: $('#due-chip'),
  addCurrent: $('#add-current'),
  togglePaste: $('#toggle-paste'),
  pasteForm: $('#paste-form'),
  pasteUrl: $('#paste-url'),
  status: $('#status'),
  dueList: $('#due-list'),
  dueCount: $('#due-count'),
  dueEmpty: $('#due-empty'),
  upcomingList: $('#upcoming-list'),
  upcomingCount: $('#upcoming-count'),
  upcomingEmpty: $('#upcoming-empty'),
  upcomingMore: $('#upcoming-more'),
  linkAll: $('#link-all'),
  linkArchive: $('#link-archive'),
  devPanel: $('#dev')
};

// --- tiny dom helpers ---

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

let statusTimer = null;
function setStatus(message, tone = 'info', sticky = false) {
  clearTimeout(statusTimer);
  if (!message) {
    els.status.hidden = true;
    els.status.textContent = '';
    return;
  }
  els.status.hidden = false;
  els.status.textContent = message;
  els.status.dataset.tone = tone;
  if (!sticky) statusTimer = setTimeout(() => setStatus(''), 4500);
}

// --- rendering ---

function difficultyNode(difficulty) {
  const key = String(difficulty || 'Unknown').toLowerCase();
  return el('span', { class: `diff diff--${key}`, text: difficulty || 'Unknown' });
}

function buildRow(problem, { locked }) {
  const today = todayStr();
  const late = daysOverdue(problem, today);

  const tick = el('input', {
    type: 'checkbox',
    class: 'tick',
    disabled: locked,
    title: locked
      ? `Locked until ${formatDateStr(problem.dueDate)}. No early reviews.`
      : 'Mark reviewed'
  });
  tick.dataset.slug = problem.slug;
  tick.dataset.action = 'review';

  const meta = el('span', { class: 'row__meta' }, [
    difficultyNode(problem.difficulty),
    el('span', { class: 'sep', text: '·' }),
    el('span', { text: sourceLabel(problem) }),
    el('span', { class: 'sep', text: '·' }),
    el('span', { text: reviewLabel(problem) })
  ]);

  if (late > 0) {
    meta.appendChild(el('span', { class: 'sep', text: '·' }));
    meta.appendChild(
      el('span', {
        class: 'overdue-flag',
        text: `${late} day${late === 1 ? '' : 's'} overdue`
      })
    );
  } else if (locked) {
    meta.appendChild(el('span', { class: 'sep', text: '·' }));
    meta.appendChild(
      el('span', {
        class: 'locked-flag',
        text: `${formatDateStr(problem.dueDate)} (${relativeDayLabel(problem.dueDate, today)})`
      })
    );
  } else {
    meta.appendChild(el('span', { class: 'sep', text: '·' }));
    meta.appendChild(el('span', { text: 'due today' }));
  }

  const open = el('a', {
    class: 'iconbtn',
    href: primaryUrl(problem),
    target: '_blank',
    rel: 'noreferrer',
    title: 'Open problem in a new tab',
    text: '↗'
  });

  const remove = el('button', {
    class: 'iconbtn iconbtn--danger',
    title: 'Delete this problem',
    text: '✕'
  });
  remove.dataset.slug = problem.slug;
  remove.dataset.action = 'delete';

  return el(
    'li',
    {
      class: `row${locked ? ' row--locked' : ''}${late > 0 ? ' row--overdue' : ''}`
    },
    [
      tick,
      el('span', { class: 'row__body' }, [
        el('a', {
          class: 'row__title',
          href: primaryUrl(problem),
          target: '_blank',
          rel: 'noreferrer',
          title: problem.title,
          text: problem.title
        }),
        meta
      ]),
      el('span', { class: 'row__actions' }, [open, remove])
    ]
  );
}

async function render() {
  const today = todayStr();
  const state = await getState();
  const due = selectDue(state, today);
  const upcoming = selectUpcoming(state, today);

  els.dueChip.textContent = due.length > 0 ? `${due.length} due` : 'all clear';
  els.dueChip.className = due.length > 0 ? 'chip' : 'chip chip--quiet';

  els.dueCount.textContent = String(due.length);
  els.upcomingCount.textContent = String(upcoming.length);

  els.dueList.replaceChildren(...due.map((p) => buildRow(p, { locked: false })));
  els.dueEmpty.hidden = due.length > 0;

  const shown = upcoming.slice(0, UPCOMING_PREVIEW);
  els.upcomingList.replaceChildren(...shown.map((p) => buildRow(p, { locked: true })));
  els.upcomingEmpty.hidden = upcoming.length > 0;

  if (upcoming.length > shown.length) {
    els.upcomingMore.hidden = false;
    els.upcomingMore.textContent = `Show all ${upcoming.length} upcoming`;
  } else {
    els.upcomingMore.hidden = true;
  }

  els.linkAll.textContent = `All problems (${state.problems.length})`;
  els.linkArchive.textContent = `Archive (${state.archive.length})`;
}

// --- adding ---

async function scrapeTab(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'leetreminder:scrape' });
  try {
    const res = await ask();
    if (res && res.ok) return res;
  } catch {
    /* not injected yet; try again after the inject below */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    const res = await ask();
    if (res && res.ok) return res;
  } catch (err) {
    console.debug('[LeetReminder] scrape failed', err);
  }
  return null;
}

function reportAdd(result, slug) {
  const name = result.problem?.title || prettifySlug(slug);
  switch (result.status) {
    case 'added':
      setStatus(`Added "${name}". First review tomorrow.`, 'ok');
      break;
    case 'merged':
      setStatus(`"${name}" was already tracked. Linked this source too.`, 'warn');
      break;
    case 'duplicate':
      setStatus(`"${name}" is already tracked.`, 'warn');
      break;
    case 'graduated':
      setStatus(`"${name}" already graduated. Restart it from the Archive.`, 'warn', true);
      break;
    default:
      setStatus('Could not add that problem.', 'error');
  }
}

async function addFromCurrentTab() {
  els.addCurrent.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const parsed = tab?.url ? parseProblemUrl(tab.url) : null;

    if (!parsed) {
      setStatus(
        'This tab is not a LeetCode or NeetCode problem page. Open a problem, or paste its URL.',
        'error',
        true
      );
      return;
    }

    const scraped = tab.id != null ? await scrapeTab(tab.id) : null;
    const title =
      (scraped?.title && scraped.title.trim()) ||
      (tab.title ? tab.title.replace(/\s*[-–|]\s*(LeetCode|NeetCode).*$/i, '').trim() : '') ||
      prettifySlug(parsed.slug);

    const result = await addProblem({
      slug: parsed.slug,
      source: parsed.source,
      url: tab.url,
      title,
      difficulty: scraped?.difficulty || 'Unknown'
    });

    reportAdd(result, parsed.slug);
    await refresh();
  } finally {
    els.addCurrent.disabled = false;
  }
}

async function addFromPastedUrl(event) {
  event.preventDefault();
  const raw = els.pasteUrl.value.trim();
  if (!raw) return;

  const parsed = parseProblemUrl(raw);
  if (!parsed) {
    setStatus('Not a recognised problem URL. Expected leetcode.com/problems/… or neetcode.io/problems/…', 'error', true);
    return;
  }

  // No page to scrape, so the slug is all we have to go on.
  const result = await addProblem({
    slug: parsed.slug,
    source: parsed.source,
    url: parsed.canonicalUrl,
    title: prettifySlug(parsed.slug),
    difficulty: 'Unknown'
  });

  reportAdd(result, parsed.slug);
  els.pasteUrl.value = '';
  await refresh();
}

// --- row actions ---

async function onListClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const { action, slug } = target.dataset;

  if (action === 'review') {
    event.preventDefault();
    target.disabled = true;
    const result = await markReviewed(slug);
    if (!result.ok) {
      // storage.js refuses early ticks too, in case the UI lets one past.
      target.checked = false;
      target.disabled = false;
      setStatus(
        result.status === 'not-due'
          ? `Not due until ${formatDateStr(result.dueDate)}. No early reviews.`
          : 'Could not update that review.',
        'error'
      );
      return;
    }
    setStatus(
      result.status === 'graduated'
        ? `"${result.problem.title}" graduated. It's in the archive now.`
        : `Nice. Next review ${formatDateStr(result.problem.dueDate)}.`,
      'ok'
    );
    await refresh();
    return;
  }

  if (action === 'delete') {
    const result = await deleteProblem(slug);
    if (result.ok) setStatus('Deleted.', 'ok');
    await refresh();
  }
}

// --- dev panel, hidden behind five clicks on the title ---

function wireDevPanel() {
  let clicks = 0;
  let timer = null;
  els.brand.addEventListener('click', () => {
    clicks += 1;
    clearTimeout(timer);
    timer = setTimeout(() => (clicks = 0), 1200);
    if (clicks >= 5) {
      clicks = 0;
      els.devPanel.hidden = !els.devPanel.hidden;
      setStatus(els.devPanel.hidden ? 'Dev tools hidden.' : 'Dev tools shown.', 'warn');
    }
  });

  els.devPanel.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-dev]');
    if (!btn) return;
    const action = btn.dataset.dev;

    if (action === 'back1') await dev.backdateAll(1);
    else if (action === 'back7') await dev.backdateAll(7);
    else if (action === 'back31') await dev.backdateAll(31);
    else if (action === 'clear-notify') await dev.clearNotifyFlag();
    else if (action === 'notify') {
      // Doesn't reset the flag first, so firing twice in a row shows the
      // once-a-day guard actually doing its job.
      const res = await chrome.runtime.sendMessage({ type: 'leetreminder:test-notification' });
      setStatus(NOTIFY_RESULT[res?.reason] || 'Could not reach the worker.', 'warn');
    } else if (action === 'wipe') {
      await dev.wipe();
    }

    if (action !== 'notify') setStatus(`Dev: ${action} done.`, 'warn');
    await refresh();
  });
}

// --- boot ---

async function refresh() {
  await render();
  // Keep the badge honest after whatever we just changed.
  try {
    await chrome.runtime.sendMessage({ type: 'leetreminder:refresh-badge' });
  } catch {
    /* worker is restarting; it repaints itself when it comes back */
  }
}

function wire() {
  els.addCurrent.addEventListener('click', addFromCurrentTab);
  els.pasteForm.addEventListener('submit', addFromPastedUrl);

  els.togglePaste.addEventListener('click', () => {
    const open = els.pasteForm.hidden;
    els.pasteForm.hidden = !open;
    els.togglePaste.setAttribute('aria-expanded', String(open));
    if (open) els.pasteUrl.focus();
  });

  els.dueList.addEventListener('click', onListClick);
  els.upcomingList.addEventListener('click', onListClick);

  els.upcomingMore.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/list.html?view=upcoming') });
  });

  // Pick up changes made by the list page or the worker.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY_NAME]) render();
  });

  wireDevPanel();
}

(async function init() {
  wire();
  await render();
  // Rescan and repaint, but no notification: they're looking at the list.
  try {
    await chrome.runtime.sendMessage({ type: 'leetreminder:wake', notify: false });
  } catch {
    /* ignore */
  }
})();

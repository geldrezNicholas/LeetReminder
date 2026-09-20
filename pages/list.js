// The full list and the archive. Four views, picked with ?view= or the tab
// strip. Same storage module as the popup, so the same rules apply.

import {
  getState,
  selectDue,
  selectUpcoming,
  todayStr,
  daysOverdue,
  formatDateStr,
  relativeDayLabel,
  markReviewed,
  deleteProblem,
  restartProblem,
  primaryUrl,
  sourceLabel,
  reviewLabel,
  isDueOn,
  LADDER_DAYS,
  TOTAL_REVIEWS,
  dev,
  STORAGE_KEY_NAME
} from '../src/storage.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const tabsEl = document.getElementById('tabs');

const NOTIFY_RESULT = {
  ok: 'Notification fired.',
  'already-today': 'Already notified today. Reset the flag to fire again.',
  'nothing-due': 'Nothing due, so no notification.',
  failed: 'Chrome refused the notification. Check macOS notification settings.',
  error: 'The worker hit an error. Open its console for the details.'
};

const VIEWS = ['due', 'upcoming', 'all', 'archive'];
const params = new URLSearchParams(location.search);
let view = params.get('view');
if (!VIEWS.includes(view)) view = 'due';

// Off unless you ask for it, so the page people actually use stays clean.
let devMode = params.get('dev') === '1';

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
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
}

let statusTimer = null;
function setStatus(message, tone = 'info') {
  clearTimeout(statusTimer);
  if (!message) {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
  statusTimer = setTimeout(() => setStatus(''), 5000);
}

// The row of little day pills: filled for done, outlined for what's next.
function ladderNode(problem, graduated) {
  const rungs = LADDER_DAYS.slice(1).map((day, i) => {
    const done = graduated || problem.stage > i;
    const next = !graduated && problem.stage === i;
    return el('span', {
      class: `rung${done ? ' rung--done' : ''}${next ? ' rung--next' : ''}`,
      text: `${day}d`,
      title: `Review ${i + 1} of ${TOTAL_REVIEWS}, day ${day} of the ladder`
    });
  });
  return el('span', { class: 'ladder' }, rungs);
}

function buildRow(problem, { graduated }) {
  const today = todayStr();
  const locked = !graduated && !isDueOn(problem, today);
  const late = graduated ? 0 : daysOverdue(problem, today);

  const tick = el('input', {
    type: 'checkbox',
    class: 'tick',
    disabled: graduated || locked,
    title: graduated
      ? 'Graduated'
      : locked
        ? `Locked until ${formatDateStr(problem.dueDate)}. No early reviews.`
        : 'Mark reviewed'
  });
  tick.dataset.slug = problem.slug;
  tick.dataset.action = 'review';

  const meta = el('span', { class: 'row__meta' }, [
    el('span', {
      class: `diff diff--${String(problem.difficulty || 'unknown').toLowerCase()}`,
      text: problem.difficulty || 'Unknown'
    }),
    el('span', { class: 'sep', text: '·' }),
    el('span', { text: sourceLabel(problem) }),
    el('span', { class: 'sep', text: '·' }),
    el('span', {
      text: graduated ? `All ${TOTAL_REVIEWS} reviews done` : reviewLabel(problem)
    }),
    el('span', { class: 'sep', text: '·' }),
    el('span', { text: `added ${formatDateStr(problem.addedAt)}` })
  ]);

  if (graduated) {
    meta.appendChild(el('span', { class: 'sep', text: '·' }));
    meta.appendChild(el('span', { text: `graduated ${formatDateStr(problem.graduatedAt)}` }));
  } else if (late > 0) {
    meta.appendChild(el('span', { class: 'sep', text: '·' }));
    meta.appendChild(
      el('span', { class: 'overdue-flag', text: `${late} day${late === 1 ? '' : 's'} overdue` })
    );
  } else {
    meta.appendChild(el('span', { class: 'sep', text: '·' }));
    meta.appendChild(
      el('span', {
        class: locked ? 'locked-flag' : '',
        text: `due ${formatDateStr(problem.dueDate)} (${relativeDayLabel(problem.dueDate, today)})`
      })
    );
  }

  const actions = [
    el('a', {
      class: 'iconbtn',
      href: primaryUrl(problem),
      target: '_blank',
      rel: 'noreferrer',
      title: 'Open problem',
      text: '↗'
    })
  ];

  if (graduated) {
    const restart = el('button', { class: 'iconbtn', title: 'Restart the ladder', text: '↻' });
    restart.dataset.slug = problem.slug;
    restart.dataset.action = 'restart';
    actions.push(restart);
  } else if (devMode) {
    for (const days of [1, 7]) {
      const b = el('button', {
        class: 'iconbtn',
        title: `Dev: back-date this problem ${days} day(s)`,
        text: `−${days}d`
      });
      b.dataset.slug = problem.slug;
      b.dataset.action = 'backdate';
      b.dataset.days = String(days);
      actions.push(b);
    }
  }

  const remove = el('button', { class: 'iconbtn iconbtn--danger', title: 'Delete', text: '✕' });
  remove.dataset.slug = problem.slug;
  remove.dataset.action = 'delete';
  actions.push(remove);

  return el(
    'li',
    { class: `row${locked ? ' row--locked' : ''}${late > 0 ? ' row--overdue' : ''}` },
    [
      tick,
      el('span', { class: 'row__body' }, [
        el('a', {
          class: 'row__title',
          href: primaryUrl(problem),
          target: '_blank',
          rel: 'noreferrer',
          text: problem.title
        }),
        meta,
        ladderNode(problem, graduated)
      ]),
      el('span', { class: 'row__actions' }, actions)
    ]
  );
}

async function render() {
  const today = todayStr();
  const state = await getState();

  for (const tab of tabsEl.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }

  document.getElementById('dev').hidden = !devMode;

  let items;
  let graduated = false;
  if (view === 'due') items = selectDue(state, today);
  else if (view === 'upcoming') items = selectUpcoming(state, today);
  else if (view === 'archive') {
    items = [...state.archive].sort((a, b) =>
      String(b.graduatedAt).localeCompare(String(a.graduatedAt))
    );
    graduated = true;
  } else {
    items = [...state.problems].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  }

  listEl.replaceChildren(...items.map((p) => buildRow(p, { graduated })));
  emptyEl.hidden = items.length > 0;
  emptyEl.textContent =
    view === 'archive'
      ? 'No graduated problems yet. Finish the day-60 review to land here.'
      : view === 'due'
        ? 'Nothing due today.'
        : 'Nothing here yet.';

  document.title = `${items.length} ${view} · LeetReminder`;
}

listEl.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, slug, days } = target.dataset;

  if (action === 'review') {
    event.preventDefault();
    const result = await markReviewed(slug);
    if (!result.ok) {
      target.checked = false;
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
        : `Marked reviewed. Next due ${formatDateStr(result.problem.dueDate)}.`,
      'ok'
    );
  } else if (action === 'delete') {
    await deleteProblem(slug);
    setStatus('Deleted.', 'ok');
  } else if (action === 'restart') {
    const result = await restartProblem(slug);
    if (result.ok) setStatus(`"${result.problem.title}" is back in the queue at review 1.`, 'ok');
  } else if (action === 'backdate') {
    await dev.backdate(slug, Number(days));
    setStatus(`Dev: back-dated ${slug} by ${days} day(s).`, 'warn');
  }

  await render();
});

tabsEl.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  view = tab.dataset.view;
  history.replaceState(null, '', `?view=${view}`);
  render();
});

document.querySelector('.dev').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-dev]');
  if (!btn) return;
  const action = btn.dataset.dev;

  if (action === 'back1') await dev.backdateAll(1);
  else if (action === 'back7') await dev.backdateAll(7);
  else if (action === 'back31') await dev.backdateAll(31);
  else if (action === 'clear-notify') await dev.clearNotifyFlag();
  else if (action === 'notify') {
    // Leaves the flag alone, so firing twice shows the once-a-day guard work.
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'leetreminder:test-notification' });
    } catch (err) {
      setStatus(`Worker unreachable: ${err.message}`, 'error');
      await render();
      return;
    }
    setStatus(
      NOTIFY_RESULT[res?.reason] ||
        'No reply from the worker. Reload the extension and reopen this page.',
      'warn'
    );
  } else if (action === 'wipe') {
    if (!confirm('Delete every tracked problem and the archive?')) return;
    await dev.wipe();
  }

  if (action !== 'notify') setStatus(`Dev: ${action} done.`, 'warn');
  await render();
});

// Same five clicks on the title as the popup.
(function wireDevToggle() {
  let clicks = 0;
  let timer = null;
  document.getElementById('brand').addEventListener('click', () => {
    clicks += 1;
    clearTimeout(timer);
    timer = setTimeout(() => (clicks = 0), 1200);
    if (clicks < 5) return;
    clicks = 0;
    devMode = !devMode;
    setStatus(devMode ? 'Dev tools shown.' : 'Dev tools hidden.', 'warn');
    render();
  });
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY_NAME]) render();
});

render();

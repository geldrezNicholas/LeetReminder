// The service worker.
//
// Chrome kills this after roughly 30 seconds of idle and starts it again
// when something needs it, so nothing here keeps state in memory and nothing
// uses setTimeout. Alarms are the only timer that outlives the worker.
//
// The alarm is only a nudge to wake up though. What's due gets recomputed
// from storage every time, which is why leaving Chrome shut for a week still
// gives you the right list when you open it again.

import {
  getState,
  selectDue,
  todayStr,
  claimDailyNotification,
  STORAGE_KEY_NAME
} from './storage.js';

const TICK_ALARM = 'leetreminder:tick';
const MIDNIGHT_ALARM = 'leetreminder:midnight';
const NOTIFICATION_ID = 'leetreminder:daily';

const BADGE_COLOR = '#e0483e';
const BADGE_TEXT_COLOR = '#ffffff';

// --- alarms ---

async function ensureAlarms() {
  // Hourly, to cover waking from sleep, changing timezone, or just missing
  // the midnight one.
  const tick = await chrome.alarms.get(TICK_ALARM);
  if (!tick) {
    await chrome.alarms.create(TICK_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  }

  // Just after local midnight, so the day rolls over promptly.
  const midnight = await chrome.alarms.get(MIDNIGHT_ALARM);
  if (!midnight) {
    const when = new Date();
    when.setHours(24, 0, 30, 0); // 00:00:30 tomorrow, local
    await chrome.alarms.create(MIDNIGHT_ALARM, { when: when.getTime(), periodInMinutes: 1440 });
  }
}

// --- badge ---

// Badge text doesn't survive a browser restart, so every wake path ends up
// calling this.
async function paintBadge(count) {
  const n = typeof count === 'number' ? count : (await computeDue()).count;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
    }
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    await chrome.action.setTitle({
      title: n > 0 ? `${n} review${n === 1 ? '' : 's'} due` : 'LeetReminder: nothing due'
    });
  } catch (err) {
    console.warn('[LeetReminder] badge paint failed', err);
  }
  return n;
}

// --- what's due ---

async function computeDue() {
  const today = todayStr();
  const state = await getState();
  const due = selectDue(state, today);
  return { today, due, count: due.length, state };
}

// --- the daily reminder ---

async function maybeNotify({ today, due }) {
  if (due.length === 0) return { fired: false, reason: 'nothing-due' };

  // The claim is persisted, so restarting the worker a dozen times in a day
  // still only gets you one reminder.
  const claimed = await claimDailyNotification(today);
  if (!claimed) return { fired: false, reason: 'already-today' };

  const overdue = due.filter((p) => p.dueDate < today).length;
  const lines = due.slice(0, 3).map((p) => `• ${p.title}`);
  if (due.length > 3) lines.push(`…and ${due.length - 3} more`);

  const message = [
    overdue > 0 ? `${overdue} overdue` : null,
    `${due.length} review${due.length === 1 ? '' : 's'} waiting`
  ]
    .filter(Boolean)
    .join(' · ');

  try {
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Time to review',
      message: `${message}\n${lines.join('\n')}`,
      priority: 2
    });
  } catch (err) {
    console.warn('[LeetReminder] notification failed', err);
    return { fired: false, reason: 'failed' };
  }
  return { fired: true, reason: 'ok' };
}

// --- the one wake path ---

// Alarms, startup, install, cold start and the popup all come through here,
// and all of them get a fresh scan.
async function wake(reason, { notify = true } = {}) {
  await ensureAlarms();
  const snapshot = await computeDue();
  await paintBadge(snapshot.count);
  if (notify) await maybeNotify(snapshot);
  console.debug(`[LeetReminder] wake(${reason}) → ${snapshot.count} due on ${snapshot.today}`);
  return { count: snapshot.count, today: snapshot.today };
}

// --- wiring ---

chrome.runtime.onInstalled.addListener((details) => {
  wake(`installed:${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  // A restart wipes the badge, so this is the one that repaints it.
  wake('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM && alarm.name !== MIDNIGHT_ALARM) return;
  wake(`alarm:${alarm.name}`);
});

// Repaint on any write to our bucket. No notifying from in here: ticking a
// review off shouldn't be able to set a reminder going.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY_NAME]) return;
  paintBadge();
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== NOTIFICATION_ID) return;
  chrome.notifications.clear(id);
  try {
    // Chrome 127 and up can open the popup straight from a click like this.
    // Older versions throw, so fall back to the list page.
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('pages/list.html?view=due') });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'leetreminder:wake') {
    // Opening the popup counts as a wake.
    wake('popup', { notify: msg.notify !== false }).then(sendResponse);
    return true;
  }
  if (msg.type === 'leetreminder:refresh-badge') {
    paintBadge().then((count) => sendResponse({ count }));
    return true;
  }
  if (msg.type === 'leetreminder:test-notification') {
    computeDue()
      .then((snapshot) => maybeNotify(snapshot))
      .then((result) => sendResponse(result));
    return true;
  }
});

// Cold start, usually after being killed mid-afternoon. Repaint right away.
wake('worker-start', { notify: false });

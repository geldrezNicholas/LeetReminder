// Reads the title and difficulty off a problem page.
//
// Both sites are SPAs that reshuffle their markup every few months, so not
// one of these selectors is trustworthy on its own and each has something
// behind it. If the whole chain comes up empty the popup falls back to the
// tab title and calls the difficulty Unknown, which is good enough.
//
// Declared in the manifest, and the popup can also inject this same file
// with chrome.scripting into a tab that was already open.

(() => {
  // The popup may inject this into a tab that already ran it.
  if (window.__leetreminderContentLoaded) return;
  window.__leetreminderContentLoaded = true;

  const DIFFICULTY_WORDS = ['easy', 'medium', 'hard'];

  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();

  // Strip the "1. " numbering and the " - LeetCode" tail.
  function tidyTitle(raw) {
    let t = clean(raw);
    t = t.replace(/^\d+\.\s*/, '');
    t = t.replace(/\s*[-–|]\s*(LeetCode|NeetCode).*$/i, '');
    t = t.replace(/^(LeetCode|NeetCode)\s*[-–|]\s*/i, '');
    return clean(t);
  }

  function metaContent(selector) {
    const el = document.querySelector(selector);
    return el ? el.getAttribute('content') : null;
  }

  // Last resort: find a leaf element whose entire text is just the word.
  function difficultyByText() {
    const nodes = document.querySelectorAll('div,span,p,a,button,td,li');
    const limit = Math.min(nodes.length, 3000);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      if (el.childElementCount > 0) continue; // leaf nodes only
      const text = clean(el.textContent).toLowerCase();
      if (text.length > 6) continue;
      if (DIFFICULTY_WORDS.includes(text)) return text;
    }
    return null;
  }

  // LeetCode puts the level in a class name; NeetCode uses a coloured chip.
  function difficultyByClass() {
    const el = document.querySelector(
      '[class*="text-difficulty-"],[class*="difficulty-"],[class*="_difficulty"]'
    );
    if (el) {
      const match = /difficulty[-_]?(easy|medium|hard)/i.exec(el.className || '');
      if (match) return match[1].toLowerCase();
      const text = clean(el.textContent).toLowerCase();
      if (DIFFICULTY_WORDS.includes(text)) return text;
    }
    // The chip case.
    for (const word of DIFFICULTY_WORDS) {
      const chip = document.querySelector(`.${word}, [class$="-${word}"], [class*=" ${word} "]`);
      if (chip && clean(chip.textContent).toLowerCase() === word) return word;
    }
    return null;
  }

  function currentSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('problems');
    return i >= 0 && parts[i + 1] ? decodeURIComponent(parts[i + 1]).toLowerCase() : null;
  }

  function scrapeLeetCode() {
    const slug = currentSlug();
    let title =
      clean(document.querySelector('div[data-cy="question-title"]')?.textContent) || null;

    if (!title && slug) {
      // The heading is a link back to the problem. Longest one wins, since
      // the short ones tend to be breadcrumbs.
      const anchors = document.querySelectorAll(`a[href*="/problems/${slug}"]`);
      let best = '';
      for (const a of anchors) {
        const text = clean(a.textContent);
        if (text.length > best.length && text.length < 120) best = text;
      }
      if (best) title = best;
    }
    if (!title) title = metaContent('meta[property="og:title"]');
    if (!title) title = document.title;

    return {
      title: tidyTitle(title),
      difficulty: difficultyByClass() || difficultyByText()
    };
  }

  function scrapeNeetCode() {
    const slug = currentSlug();
    let title =
      clean(document.querySelector('h1')?.textContent) ||
      clean(document.querySelector('[class*="problem-title"],[class*="title"]')?.textContent) ||
      null;

    if (!title && slug) {
      const anchors = document.querySelectorAll(`a[href*="/problems/${slug}"]`);
      for (const a of anchors) {
        const text = clean(a.textContent);
        if (text && text.length < 120) {
          title = text;
          break;
        }
      }
    }
    if (!title) title = metaContent('meta[property="og:title"]');
    if (!title) title = document.title;

    let tidy = tidyTitle(title);
    // If all we got back was the site name, that's not a title.
    if (!tidy || /^neetcode/i.test(tidy)) tidy = '';

    return {
      title: tidy,
      difficulty: difficultyByClass() || difficultyByText()
    };
  }

  function scrape() {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    const base = host === 'neetcode.io' ? scrapeNeetCode() : scrapeLeetCode();
    return {
      ok: true,
      slug: currentSlug(),
      url: location.href,
      title: base.title || '',
      difficulty: base.difficulty || '',
      host
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'leetreminder:scrape') {
      try {
        sendResponse(scrape());
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }
  });
})();

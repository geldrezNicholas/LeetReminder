# LeetReminder

## What it does

Chrome extension that reminds you to re-solve LeetCode and NeetCode problems before you
forget them.

I kept losing problems about three weeks after grinding them, which is roughly when
they'd turn up in an interview. Click a button on the problem page and it schedules the
reviews for you.

## Features

- Add the problem you're on with one click, or paste a URL for one you're not
- Six reviews per problem, at 1, 3, 7, 14, 30 and 60 days
- Badge on the toolbar icon counting what's due today plus anything overdue
- One desktop reminder a day, and only if something is actually due
- Overdue problems stay overdue with a day count instead of expiring
- Reviews stay locked until the day they're due
- LeetCode and NeetCode links to the same problem count as one entry
- Finished problems move to an archive you can browse or restart from
- Everything stays on your machine. No account, no server, no tracking

## How it works

Load it at `chrome://extensions` with Developer mode on and "Load unpacked", then pin
it so you can see the badge.

Adding a problem counts as day 0. From there you get six reviews on a fixed ladder:

```
day   0     1     3     7     14    30    60
    solve  r1    r2    r3    r4    r5    r6
```

There's no easy/hard grading and no way to send a problem backwards. Three things it's
strict about:

**No early reviews.** The checkbox is locked until the due date. Re-solving something
the day after you solved it teaches you nothing.

**No missed ones either.** Nothing expires and nothing quietly advances. A review that
came due three weeks ago is still sitting there, marked 21 days overdue.

**Late reviews push the rest back.** Do a day-7 review on day 8 and the next one lands
on day 15, not day 14, so you always get the full interval from the day you actually
did the work.

Problems are stored locally with an absolute due date each, and what's due gets
recalculated from scratch every time the extension wakes up. Closing Chrome for a week
doesn't break anything.

For testing, click the "LeetReminder" title five times in the popup to open a dev panel
that back-dates problems, which is indistinguishable from time having passed.

## Disclaimer

Not affiliated with LeetCode or NeetCode in any way. It reads the problem title and
difficulty off the page, so if either site reshuffles its markup the scraping may fall
back to the tab title until I fix it. None of your data leaves your browser, but it
also isn't backed up anywhere, so uninstalling loses your queue.

Personal project, no warranty, use at your own risk.

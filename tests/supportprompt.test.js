/*
 * src/shared/supportprompt.js: when the popup may show the occasional support note.
 */
loadSrc('src/config.js', 'src/shared/supportprompt.js');

var SP = __TAS__.supportPrompt;
var DAY = SP.DAY;
var T0 = Date.UTC(2026, 0, 1);

function base(over) {
  var o = {
    now: T0 + 30 * DAY,
    installedAt: T0,
    seen: { total: 1500, lastKey: 'k', lastCount: 0 },
    state: { version: '2.0.3' },
    version: '2.0.3',
    hasLink: true
  };
  Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
  return o;
}

test('supportprompt: shown after 7 days and 1,000 ads', function () {
  var r = SP.decide(base());
  assert.ok(r.show, r.reason);
  assert.equal(r.milestone, 1000);
  assert.equal(r.count, 1500);
});

test('supportprompt: not before 7 days since install', function () {
  assert.equal(SP.decide(base({ now: T0 + 6 * DAY })).reason, 'too-new');
  assert.ok(SP.decide(base({ now: T0 + 7 * DAY })).show, 'exactly 7 days');
  assert.equal(SP.decide(base({ installedAt: 0 })).reason, 'too-new', 'no install date');
});

test('supportprompt: not below 1,000 ads', function () {
  assert.equal(SP.decide(base({ seen: { total: 999 } })).reason, 'below-milestone');
  assert.ok(SP.decide(base({ seen: { total: 1000 } })).show);
});

test('supportprompt: never on the first popup open after install or update', function () {
  var r = SP.decide(base({ state: { version: '2.0.2' } }));
  assert.equal(r.show, false);
  assert.equal(r.reason, 'first-open');
  assert.ok(r.firstOpen);
  assert.equal(SP.decide(base({ state: {} })).reason, 'first-open', 'fresh install');
});

test('supportprompt: only at a new milestone, at most once every 60 days', function () {
  var now = T0 + 30 * DAY;
  var st = SP.shown({ version: '2.0.3' }, now, 1000);
  assert.equal(SP.decide(base({ state: st, now: now + 100 * DAY, seen: { total: 9000 } })).reason, 'same-milestone');
  assert.equal(SP.decide(base({ state: st, now: now + 59 * DAY, seen: { total: 12000 } })).reason, 'recently-shown');
  var r = SP.decide(base({ state: st, now: now + 60 * DAY, seen: { total: 12000 } }));
  assert.ok(r.show, r.reason);
  assert.equal(r.milestone, 10000);
  assert.equal(SP.milestoneFor(49999), 10000);
  assert.equal(SP.milestoneFor(50000), 50000);
  assert.equal(SP.milestoneFor(100000), 100000);
});

test('supportprompt: "Not now" snoozes 60 days', function () {
  var now = T0 + 30 * DAY;
  var st = SP.snooze({ version: '2.0.3', lastMilestone: 0 }, now);
  assert.equal(st.snoozedUntil, now + 60 * DAY);
  assert.equal(SP.decide(base({ state: st, now: now + 59 * DAY })).reason, 'snoozed');
  assert.ok(SP.decide(base({ state: st, now: now + 60 * DAY })).show);
});

test('supportprompt: "Don\'t ask again" is permanent', function () {
  var st = SP.never({ version: '2.0.3' });
  assert.equal(SP.decide(base({ state: st, now: T0 + 9999 * DAY, seen: { total: 1e6 } })).reason, 'never');
  assert.equal(st.reminders, false, 'the settings switch shows off');
});

test('supportprompt: the settings switch turns it off and on', function () {
  var off = SP.setReminders({ version: '2.0.3' }, false);
  assert.equal(SP.decide(base({ state: off })).reason, 'off');
  var on = SP.setReminders(SP.never({ version: '2.0.3' }), true);
  assert.equal(on.never, false, 'switching on clears "never"');
  assert.ok(SP.decide(base({ state: on })).show);
  assert.equal(SP.normalizeState({}).reminders, true, 'on by default');
});

test('supportprompt: nothing without a support link', function () {
  assert.equal(SP.decide(base({ hasLink: false })).reason, 'no-link');
});

test('supportprompt: counts add up per page load without double counting', function () {
  var k1 = SP.pageKey(5, 'https://a.example/', 111);
  var k2 = SP.pageKey(5, 'https://a.example/', 222);
  var s = SP.accumulate(null, k1, 10);
  assert.deepEqual(s, { total: 10, lastKey: k1, lastCount: 10 });
  s = SP.accumulate(s, k1, 10);
  assert.equal(s.total, 10, 'same load, same count: nothing added');
  s = SP.accumulate(s, k1, 14);
  assert.equal(s.total, 14, 'same load: only the growth');
  s = SP.accumulate(s, k2, 3);
  assert.equal(s.total, 17, 'new load: whole count');
  assert.equal(s.lastKey, k2, 'only the last key is kept');
  s = SP.accumulate(s, k2, -4);
  assert.equal(s.total, 17, 'bad counts ignored');
});

test('supportprompt: message says "at least" with a grouped number', function () {
  assert.equal(SP.formatCount(1234567), '1,234,567');
  assert.equal(SP.formatCount(999), '999');
  var m = SP.message(12034);
  assert.includes(m, 'AdBrake has blocked at least 12,034 ads for you.');
  assert.includes(m, 'consider supporting development.');
});

test('supportprompt: thanks() is the short popup line with a grouped count', function () {
  assert.equal(SP.thanks(10021), 'Thanks for using AdBrake: at least 10,021 ads blocked so far.');
  assert.equal(SP.thanks(-5), 'Thanks for using AdBrake: at least 0 ads blocked so far.');
});

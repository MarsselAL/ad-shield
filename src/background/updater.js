/*
 * Weekly filter-list update. Loaded by service-worker.js with importScripts after blocking.js,
 * filterlist.js, lists.js and general.js.
 *
 *  - Network: GET the three public list URLs in lists.js (EasyList, EasyPrivacy, EasyList Cookie
 *    List; https only, credentials omitted, no cache, 15 MB cap, 60 s timeout). Only weekly
 *    (chrome.alarms) while "Update filter lists automatically" is on, or when the options page
 *    asks ("Update now"). Nothing else is requested or sent: no telemetry, no remote config.
 *  - Conversion: filterlist.convertLists, the JavaScript port of tools/filterlist.py.
 *  - All or nothing: the update is applied only when all three lists download, have a version
 *    header, give at least 60 % of the packaged rule count, are not older than the lists in use
 *    and at least one is newer, and all rules fit Chrome's dynamic rule limits. Otherwise the
 *    lists in use stay (the cosmetic data is merged from all three lists, so a partial update
 *    would mix list versions in site.json).
 *  - Install: general.installLists (one queue with the rest of the general blocker's DNR work):
 *    one atomic updateDynamicRules, then chrome.storage.local "listRules" / "listSite" / "lists".
 *  - Extension update: if a packaged list is newer than the updated one, back to the packaged lists.
 * Generic cosmetic CSS (rules/cosmetic/*.css, generic.json, generic_excepted.json) is not updated.
 */
/* global chrome */
(function () {
  'use strict';
  var ns = self.__TAS__;
  var S = ns.settings;
  var B = ns.blocking;
  var F = ns.filterlist;
  var L = ns.lists;
  var G = ns.general;
  var log = ns.createLogger('lists', function () { return false; });
  var ALARM_WEEKLY = 'as-lists-weekly';
  var ALARM_SOON = 'as-lists-soon';
  var OPTIONS_PAGE = 'src/options/options.html';
  var running = null;
  var ops = Promise.resolve();

  function serial(fn) {
    var p = ops.then(fn, fn);
    ops = p.catch(function () {});
    return p;
  }

  function packagedInfo() {
    return fetch(chrome.runtime.getURL('rules/build-info.json')).then(function (r) { return r.json(); });
  }
  function packagedJson(path) {
    return fetch(chrome.runtime.getURL(path)).then(function (r) { return r.json(); }).catch(function () { return null; });
  }

  function readAll() {
    return Promise.all([
      chrome.storage.local.get([L.META_KEY, S.STORAGE_KEY, B.STORAGE_KEY]),
      packagedInfo()
    ]).then(function (res) {
      return {
        meta: res[0][L.META_KEY] || null,
        settings: S.normalize(res[0][S.STORAGE_KEY]),
        blocking: B.normalize(res[0][B.STORAGE_KEY]),
        info: res[1],
        packaged: L.packagedLists(res[1])
      };
    });
  }

  function saveMeta(meta) {
    var o = {};
    o[L.META_KEY] = meta;
    return chrome.storage.local.set(o);
  }

  // ---------------------------------------------------------------- download
  function readCapped(resp) {
    var len = Number(resp.headers && resp.headers.get && resp.headers.get('content-length'));
    if (len > L.MAX_BYTES) return Promise.reject(new Error('larger than ' + L.MAX_BYTES + ' bytes'));
    if (!resp.body || typeof resp.body.getReader !== 'function' || typeof TextDecoder !== 'function') {
      return resp.text().then(function (t) {
        if (t.length > L.MAX_BYTES) throw new Error('larger than ' + L.MAX_BYTES + ' bytes');
        return t;
      });
    }
    var reader = resp.body.getReader(), dec = new TextDecoder('utf-8'), parts = [], total = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { parts.push(dec.decode()); return parts.join(''); }
        total += r.value.byteLength;
        if (total > L.MAX_BYTES) {
          try { reader.cancel(); } catch (e) { /* ignore */ }
          throw new Error('larger than ' + L.MAX_BYTES + ' bytes');
        }
        parts.push(dec.decode(r.value, { stream: true }));
        return pump();
      });
    }
    return pump();
  }

  function download(url) {
    if (url.indexOf('https://') !== 0) return Promise.reject(new Error('not https'));
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, L.TIMEOUT_MS);
    var opts = { credentials: 'omit', cache: 'no-cache', redirect: 'follow' };
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (resp) {
      if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
      if (resp.url && resp.url.indexOf('https://') !== 0) throw new Error('redirected away from https');
      return readCapped(resp);
    }).then(function (text) {
      clearTimeout(timer);
      return text;
    }, function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || String(e));
    });
  }

  // ---------------------------------------------------------------- update
  /** Drop regex rules this Chrome cannot compile (one bad rule would fail the whole update). */
  function dropUnsupportedRegex(rules) {
    var dnr = chrome.declarativeNetRequest;
    if (typeof dnr.isRegexSupported !== 'function') return Promise.resolve(rules);
    return Promise.all(rules.map(function (r) {
      var rx = r.condition && r.condition.regexFilter;
      if (!rx) return true;
      return dnr.isRegexSupported({ regex: rx, isCaseSensitive: !!r.condition.isUrlFilterCaseSensitive })
        .then(function (res) { return !!(res && res.isSupported); }, function () { return false; });
    })).then(function (keep) {
      return rules.filter(function (r, i) { return keep[i]; });
    });
  }

  function update() {
    var now = Date.now();
    var ctx;
    return readAll().then(function (c) {
      ctx = c;
      var texts = {}, errors = {};
      return Promise.all(L.LISTS.map(function (l) {
        return download(l.url).then(function (t) { texts[l.key] = t; }, function (e) { errors[l.key] = 'download failed: ' + e.message; });
      })).then(function () {
        if (Object.keys(errors).length) return finish(false, 'Download failed; the lists in use were kept.', errors);
        var conv = F.convertLists(texts);
        var inUse = L.installedVersions(ctx.meta, ctx.packaged);
        var checks = {};
        L.LISTS.forEach(function (l) { checks[l.key] = L.checkList(conv.lists[l.key], ctx.packaged[l.key], inUse[l.key]); });
        var d = L.decide(checks);
        if (d.upToDate) return finish(true, 'Already up to date.', null);
        if (!d.apply) return finish(false, 'A list failed its checks; the lists in use were kept.', d.errors);
        var rules = {}, counts = {};
        return Promise.all(L.LISTS.map(function (l) {
          return dropUnsupportedRegex(L.toDynamic(conv.lists[l.key].rules, B.DYNAMIC_BASES[l.feature])).then(function (r) {
            rules[l.feature] = r;
            counts[l.feature] = r.length;
          });
        })).then(function () {
          var tooMany = L.fitCheck(rules, L.limitsFrom(chrome.declarativeNetRequest), 1);
          if (tooMany) return finish(false, tooMany + '; the lists in use were kept.', null);
          return Promise.all([packagedJson('rules/cosmetic/generic.json'), packagedJson('rules/cosmetic/generic_excepted.json')]).then(function (pg) {
            var site = L.addPackagedGenericExceptions(conv.site, pg[0], pg[1]);
            var meta = L.successMeta(conv, counts, now);
            return G.installLists({ rules: rules, site: site, meta: meta }).then(function () {
              log.info('filter lists updated', JSON.stringify(counts));
              return { ok: true, message: 'Updated.' };
            }, function (e) {
              return finish(false, 'Chrome refused the rules (' + (e && e.message) + '); the lists in use were kept.', null);
            });
          });
        });
      });
    }).catch(function (e) {
      return finish(false, 'Update failed: ' + ((e && e.message) || e), null);
    });

    function finish(ok, message, errors) {
      return chrome.storage.local.get(L.META_KEY).then(function (r) {
        return saveMeta(L.checkedMeta(r[L.META_KEY], now, ok, message, errors));
      }).then(function () { return { ok: ok, message: message, errors: errors || null }; });
    }
  }

  /** One update at a time; a second request while one runs gets the same result. */
  function updateNow() {
    if (!running) {
      running = serial(update).then(function (res) { running = null; return res; }, function (e) { running = null; throw e; });
    }
    return running;
  }

  function reset(message) {
    return serial(function () {
      return chrome.storage.local.get(L.META_KEY).then(function (r) {
        return G.resetLists(L.packagedMeta(r[L.META_KEY], Date.now(), message));
      }).then(function () { return { ok: true, message: message }; });
    });
  }

  // ---------------------------------------------------------------- scheduling
  /** Weekly alarm while auto-update is on (no alarm at all when off); a check soon when one is due. */
  function schedule() {
    return readAll().then(function (c) {
      var auto = c.settings.enabled !== false && c.blocking.autoUpdateLists;
      if (!auto) return Promise.all([chrome.alarms.clear(ALARM_WEEKLY), chrome.alarms.clear(ALARM_SOON)]);
      return chrome.alarms.get(ALARM_WEEKLY).then(function (a) {
        if (!a) chrome.alarms.create(ALARM_WEEKLY, { delayInMinutes: 7 * 24 * 60, periodInMinutes: 7 * 24 * 60 });
        if (L.isDue(c.meta, c.packaged, Date.now())) chrome.alarms.create(ALARM_SOON, { delayInMinutes: 1 });
      });
    }).catch(function (e) { log.warn('schedule failed', e && e.message); });
  }

  function onAlarm(alarm) {
    if (!alarm || (alarm.name !== ALARM_WEEKLY && alarm.name !== ALARM_SOON)) return undefined;
    return readAll().then(function (c) {
      if (c.settings.enabled === false || !c.blocking.autoUpdateLists) return undefined;
      if (!L.isDue(c.meta, c.packaged, Date.now())) return undefined;
      return updateNow();
    }).catch(function (e) { log.warn('scheduled update failed', e && e.message); });
  }

  function onInstalled(details) {
    var p = Promise.resolve();
    if (details && details.reason === 'update') {
      p = readAll().then(function (c) {
        if (L.shouldRevert(c.meta, c.packaged)) return reset('The new version brings newer built-in lists.');
        return undefined;
      });
    }
    return p.catch(function (e) { log.warn('post-update check failed', e && e.message); }).then(schedule);
  }

  // ---------------------------------------------------------------- messages (options page)
  function fromExtensionPage(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    var url = String(sender.url || '');
    if (url.indexOf(chrome.runtime.getURL('')) !== 0) return false;
    return !sender.tab || url.indexOf(chrome.runtime.getURL(OPTIONS_PAGE)) === 0;
  }

  function status() {
    return readAll().then(function (c) {
      return {
        meta: c.meta,
        packaged: c.packaged,
        rows: L.statusRows(c.meta, c.packaged),
        running: !!running,
        autoUpdateLists: c.blocking.autoUpdateLists
      };
    });
  }

  var HANDLERS = {
    'as-lists-status': status,
    'as-lists-update-now': updateNow,
    'as-lists-reset': function () { return reset('Using the built-in lists.'); }
  };

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object' || !Object.prototype.hasOwnProperty.call(HANDLERS, msg.type)) return false;
    if (!fromExtensionPage(sender)) return false;
    HANDLERS[msg.type]().then(sendResponse, function (e) {
      sendResponse({ ok: false, message: (e && e.message) || String(e) });
    });
    return true;
  });

  if (chrome.alarms) chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.runtime.onInstalled.addListener(onInstalled);
  chrome.runtime.onStartup.addListener(function () { schedule(); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && (changes[S.STORAGE_KEY] || changes[B.STORAGE_KEY])) schedule();
  });

  ns.updater = { updateNow: updateNow, reset: reset, schedule: schedule, onAlarm: onAlarm, onInstalled: onInstalled, status: status, fromExtensionPage: fromExtensionPage };
})();

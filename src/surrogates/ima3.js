/*
 * Surrogate for the Google IMA HTML5 SDK, https://imasdk.googleapis.com/js/sdkloader/ima3.js.
 * Served by AdBrake's ads_surrogates DNR redirect rule instead of the blocked script. Our own code
 * (MIT), written from Google's public IMA SDK API reference; no ad is requested or shown.
 *
 * Video players that use IMA stall when the SDK is simply blocked (google.ima is undefined). With
 * this stub they find google.ima, and every AdsLoader.requestAds() ends in an AD_ERROR event
 * (VAST_EMPTY_RESPONSE, "no ads"), which players handle by playing the content. Constructors and
 * enums players touch are present; any other method of these objects is a no-op returning
 * undefined (Proxy), so an unexpected setter does not throw.
 */
(function () {
  'use strict';
  var w = window;
  if (w.google && w.google.ima && typeof w.google.ima.AdsLoader === 'function') return; // the real SDK is there

  var VERSION = '3.0.0';
  var noop = function () {};

  function tolerant(obj) {
    if (typeof Proxy !== 'function') return obj;
    return new Proxy(obj, {
      get: function (target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
        if (prop === 'then' || prop === 'toJSON') return undefined; // never look like a promise
        return noop;
      }
    });
  }

  function later(fn) { setTimeout(fn, 0); }

  // ---- events (IMA's addEventListener takes one type or a list, a handler, capture, scope)
  function Emitter() { this.listeners = []; }
  Emitter.prototype.addEventListener = function (types, handler, capture, scope) {
    if (typeof handler !== 'function') return;
    [].concat(types).forEach(function (t) { this.listeners.push({ type: t, fn: handler, scope: scope }); }, this);
  };
  Emitter.prototype.removeEventListener = function (types, handler) {
    var list = [].concat(types);
    this.listeners = this.listeners.filter(function (l) { return !(l.fn === handler && list.indexOf(l.type) !== -1); });
  };
  Emitter.prototype.dispatch = function (ev) {
    this.listeners.slice().forEach(function (l) {
      if (l.type !== ev.type) return;
      try { l.fn.call(l.scope || null, ev); } catch (e) { /* the player's handler failed: not ours to report */ }
    });
  };

  // ---- errors
  var ErrorCode = {
    API_ERROR: 1102, ADS_REQUEST_NETWORK_ERROR: 1012, AUTOPLAY_DISALLOWED: 1205, FAILED_TO_REQUEST_ADS: 1005,
    INVALID_ADX_EXTENSION: 1105, INVALID_ARGUMENTS: 1101, UNKNOWN_AD_RESPONSE: 1010, UNKNOWN_ERROR: 900,
    VAST_ASSET_NOT_FOUND: 1007, VAST_EMPTY_RESPONSE: 1009, VAST_LINEAR_ASSET_MISMATCH: 403, VAST_LOAD_TIMEOUT: 301,
    VAST_MALFORMED_RESPONSE: 100, VAST_MEDIA_LOAD_TIMEOUT: 402, VAST_NO_ADS_AFTER_WRAPPER: 303,
    VAST_NONLINEAR_ASSET_MISMATCH: 503, VAST_PROBLEM_DISPLAYING_MEDIA_FILE: 405, VAST_SCHEMA_VALIDATION_ERROR: 101,
    VAST_TOO_MANY_REDIRECTS: 302, VAST_TRAFFICKING_ERROR: 200, VAST_UNEXPECTED_DURATION_ERROR: 202,
    VAST_UNEXPECTED_LINEARITY: 201, VAST_UNSUPPORTED_VERSION: 102, VAST_WRAPPER_ERROR: 300, VIDEO_PLAY_ERROR: 400,
    VPAID_ERROR: 901
  };
  function AdError(message, code, type) {
    this.message = message;
    this.errorCode = code;
    this.type = type;
  }
  AdError.prototype.getErrorCode = function () { return this.errorCode; };
  AdError.prototype.getMessage = function () { return this.message; };
  AdError.prototype.getType = function () { return this.type; };
  AdError.prototype.getVastErrorCode = function () { return ErrorCode.VAST_NO_ADS_AFTER_WRAPPER; };
  AdError.prototype.getInnerError = function () { return null; };
  AdError.prototype.toString = function () { return 'AdError ' + this.errorCode + ': ' + this.message; };
  AdError.ErrorCode = ErrorCode;
  AdError.Type = { AD_LOAD: 'adLoadError', AD_PLAY: 'adPlayError' };

  function AdErrorEvent(error, context) {
    this.type = AdErrorEvent.Type.AD_ERROR;
    this.error = error;
    this.context = context;
  }
  AdErrorEvent.prototype.getError = function () { return this.error; };
  AdErrorEvent.prototype.getUserRequestContext = function () { return this.context === undefined ? null : this.context; };
  AdErrorEvent.Type = { AD_ERROR: 'adError' };

  function AdEvent(type) { this.type = type; }
  AdEvent.prototype.getAd = function () { return null; };
  AdEvent.prototype.getAdData = function () { return null; };
  AdEvent.Type = {
    AD_BREAK_READY: 'adBreakReady', AD_BUFFERING: 'adBuffering', AD_CAN_PLAY: 'adCanPlay', AD_METADATA: 'adMetadata',
    AD_PROGRESS: 'adProgress', ALL_ADS_COMPLETED: 'allAdsCompleted', CLICK: 'click', COMPLETE: 'complete',
    CONTENT_PAUSE_REQUESTED: 'contentPauseRequested', CONTENT_RESUME_REQUESTED: 'contentResumeRequested',
    DURATION_CHANGE: 'durationChange', FIRST_QUARTILE: 'firstQuartile', IMPRESSION: 'impression',
    INTERACTION: 'interaction', LINEAR_CHANGED: 'linearChanged', LOADED: 'loaded', LOG: 'log', MIDPOINT: 'midpoint',
    PAUSED: 'pause', RESUMED: 'resume', SKIPPABLE_STATE_CHANGED: 'skippableStateChanged', SKIPPED: 'skip',
    STARTED: 'start', THIRD_QUARTILE: 'thirdQuartile', USER_CLOSE: 'userClose', VIDEO_CLICKED: 'videoClicked',
    VIDEO_ICON_CLICKED: 'videoIconClicked', VOLUME_CHANGED: 'volumeChange', VOLUME_MUTED: 'mute'
  };

  // ---- ads manager (never handed out by requestAds, present for players that build one)
  function AdsManager() {
    Emitter.call(this);
    return tolerant(this);
  }
  AdsManager.prototype = Object.create(Emitter.prototype);
  AdsManager.prototype.constructor = AdsManager;
  AdsManager.prototype.init = noop;
  AdsManager.prototype.start = function () {
    var self = this;
    later(function () { self.dispatch(new AdEvent(AdEvent.Type.ALL_ADS_COMPLETED)); });
  };
  AdsManager.prototype.destroy = function () { this.listeners = []; };
  AdsManager.prototype.getCuePoints = function () { return []; };
  AdsManager.prototype.getRemainingTime = function () { return 0; };
  AdsManager.prototype.getVolume = function () { return 1; };
  AdsManager.prototype.isCustomClickTrackingUsed = function () { return false; };
  AdsManager.prototype.isCustomPlaybackUsed = function () { return false; };
  AdsManager.prototype.getAdSkippableState = function () { return false; };

  function AdsManagerLoadedEvent(context) {
    this.type = AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED;
    this.context = context;
  }
  AdsManagerLoadedEvent.prototype.getAdsManager = function () { return new AdsManager(); };
  AdsManagerLoadedEvent.prototype.getUserRequestContext = function () { return this.context === undefined ? null : this.context; };
  AdsManagerLoadedEvent.Type = { ADS_MANAGER_LOADED: 'adsManagerLoaded' };

  // ---- settings
  function ImaSdkSettings() {
    this.values = { locale: 'en', numRedirects: 4, playerType: '', playerVersion: '', ppid: '', vpaidMode: 0,
      autoPlayAdBreaks: true, cookiesEnabled: true, disableCustomPlaybackForIOS10Plus: false, featureFlags: {} };
    return tolerant(this);
  }
  [['Locale', 'locale'], ['NumRedirects', 'numRedirects'], ['PlayerType', 'playerType'], ['PlayerVersion', 'playerVersion'],
    ['Ppid', 'ppid'], ['VpaidMode', 'vpaidMode'], ['DisableCustomPlaybackForIOS10Plus', 'disableCustomPlaybackForIOS10Plus'],
    ['FeatureFlags', 'featureFlags']].forEach(function (p) {
    ImaSdkSettings.prototype['get' + p[0]] = function () { return this.values[p[1]]; };
    ImaSdkSettings.prototype['set' + p[0]] = function (v) { this.values[p[1]] = v; };
  });
  ImaSdkSettings.prototype.isAutoPlayAdBreaks = function () { return this.values.autoPlayAdBreaks; };
  ImaSdkSettings.prototype.setAutoPlayAdBreaks = function (v) { this.values.autoPlayAdBreaks = v; };
  ImaSdkSettings.prototype.isCookiesEnabled = function () { return this.values.cookiesEnabled; };
  ImaSdkSettings.prototype.setCookiesEnabled = function (v) { this.values.cookiesEnabled = v; };
  ImaSdkSettings.prototype.isVpaidAllowed = function () { return this.values.vpaidMode !== 0; };
  ImaSdkSettings.prototype.setVpaidAllowed = function (v) { this.values.vpaidMode = v ? 1 : 0; };
  ImaSdkSettings.VpaidMode = { DISABLED: 0, ENABLED: 1, INSECURE: 2 };
  ImaSdkSettings.CompanionBackfillMode = { ALWAYS: 'always', ON_MASTER_AD: 'on_master_ad' };
  var settings = new ImaSdkSettings();

  // ---- the objects a player builds
  function AdDisplayContainer() { return tolerant(this); }
  AdDisplayContainer.prototype.initialize = noop;
  AdDisplayContainer.prototype.destroy = noop;

  function AdsLoader() {
    Emitter.call(this);
    return tolerant(this);
  }
  AdsLoader.prototype = Object.create(Emitter.prototype);
  AdsLoader.prototype.constructor = AdsLoader;
  AdsLoader.prototype.requestAds = function (request, context) {
    var self = this;
    later(function () {
      self.dispatch(new AdErrorEvent(new AdError('No ads (ad request blocked).', ErrorCode.VAST_EMPTY_RESPONSE,
        AdError.Type.AD_LOAD), context));
    });
  };
  AdsLoader.prototype.contentComplete = noop;
  AdsLoader.prototype.destroy = function () { this.listeners = []; };
  AdsLoader.prototype.getSettings = function () { return settings; };
  AdsLoader.prototype.getVersion = function () { return VERSION; };

  function AdsRequest() {
    this.adTagUrl = '';
    this.adsResponse = null;
    this.linearAdSlotWidth = 0;
    this.linearAdSlotHeight = 0;
    this.nonLinearAdSlotWidth = 0;
    this.nonLinearAdSlotHeight = 0;
    return tolerant(this);
  }
  AdsRequest.prototype.setAdWillAutoPlay = noop;
  AdsRequest.prototype.setAdWillPlayMuted = noop;
  AdsRequest.prototype.setContinuousPlayback = noop;

  function AdsRenderingSettings() {
    this.autoAlign = true;
    this.bitrate = -1;
    this.enablePreloading = false;
    this.loadVideoTimeout = 8000;
    this.mimeTypes = null;
    this.playAdsAfterTime = -1;
    this.restoreCustomPlaybackStateOnAdBreakComplete = false;
    this.uiElements = null;
    this.useStyledLinearAds = false;
    this.useStyledNonLinearAds = false;
    return tolerant(this);
  }

  function CompanionAdSelectionSettings() {
    this.creativeType = 'All';
    this.resourceType = 'All';
    this.sizeCriteria = 'SelectExactMatch';
    return tolerant(this);
  }
  CompanionAdSelectionSettings.CreativeType = { ALL: 'All', FLASH: 'Flash', IMAGE: 'Image' };
  CompanionAdSelectionSettings.ResourceType = { ALL: 'All', HTML: 'Html', IFRAME: 'IFrame', STATIC: 'Static' };
  CompanionAdSelectionSettings.SizeCriteria = { IGNORE: 'IgnoreSize', SELECT_EXACT_MATCH: 'SelectExactMatch', SELECT_NEAR_MATCH: 'SelectNearMatch' };

  var ima = {
    AdCuePoints: function () { return tolerant(this); },
    AdDisplayContainer: AdDisplayContainer,
    AdError: AdError,
    AdErrorEvent: AdErrorEvent,
    AdEvent: AdEvent,
    AdsLoader: AdsLoader,
    AdsManager: AdsManager,
    AdsManagerLoadedEvent: AdsManagerLoadedEvent,
    AdsRenderingSettings: AdsRenderingSettings,
    AdsRequest: AdsRequest,
    CompanionAdSelectionSettings: CompanionAdSelectionSettings,
    ImaSdkSettings: ImaSdkSettings,
    OmidAccessMode: { DOMAIN: 'domain', FULL: 'full', LIMITED: 'limited' },
    OmidVerificationVendor: {},
    UiElements: { AD_ATTRIBUTION: 'adAttribution', COUNTDOWN: 'countdown' },
    ViewMode: { FULLSCREEN: 'fullscreen', NORMAL: 'normal' },
    VERSION: VERSION,
    settings: settings
  };
  if (!w.google || (typeof w.google !== 'object' && typeof w.google !== 'function')) w.google = {};
  w.google.ima = ima;
})();

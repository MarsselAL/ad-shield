/*
 * Surrogate for Google Publisher Tag (securepubads.g.doubleclick.net/tag/js/gpt.js and
 * www.googletagservices.com/tag/js/gpt.js): a googletag object whose cmd.push runs the queued
 * functions against no-op slot / pubads objects.
 * From DuckDuckGo tracker-surrogates, surrogates/gpt.js
 * (https://github.com/duckduckgo/tracker-surrogates, commit 1cca57fa1edc945f208423d478c1d2aa50655141).
 * Copyright (c) 2021-2023 Duck Duck Go, Inc. Licensed under the Apache License, Version 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0; copy in LICENSE-duckduckgo.md next to this file).
 * Modified by AdBrake (2026-11-25): the existing command queue is read only when
 * window.googletag.cmd is an array (the original threw on a googletag object without cmd).
 * Served by AdBrake's ads_surrogates DNR redirect rules.
 */
(() => {
    'use strict';
    const noop = () => {};
    const noopReturnNull = () => { return null; };
    const noopReturnEmptyArray = () => { return []; };
    const noopReturnEmptyString = () => { return ''; };
    const noopReturnThis = function () {
        return this;
    };
    const noopHandler = {
        get: function (target, prop, receiver) {
            if (typeof target[prop] !== 'undefined') {
                return Reflect.get(...arguments);
            }
            return noop;
        }
    };
    const noopReturnThisHandler = {
        get: function (target, prop, receiver) {
            if (typeof target[prop] !== 'undefined') {
                return Reflect.get(...arguments);
            }
            return noopReturnThis;
        }
    };
    const passbackTarget = {
        display: noop,
        get: noopReturnNull
    };
    let targeting = {};
    function setTargeting (key, value) {
        const val = Array.isArray(value) ? value : [value];
        targeting[key] = val;
    }
    function getTargeting (key) {
        if (key in targeting) {
            return targeting[key];
        }
        return [];
    }
    function getTargetingKeys () {
        return Object.keys(targeting);
    }
    function clearTargeting (key) {
        if (key) {
            targeting[key] = [];
        } else {
            targeting = {};
        }
    }
    const pubadsTarget = {
        addEventListener: noopReturnThis,
        clearCategoryExclusions: noopReturnThis,
        clearTagForChildDirectedTreatment: noopReturnThis,
        clearTargeting,
        definePassback: function () { return new Proxy(passbackTarget, noopReturnThisHandler); },
        defineOutOfPagePassback: function () { return new Proxy(passbackTarget, noopReturnThisHandler); },
        get: noopReturnNull,
        getAttributeKeys: noopReturnEmptyArray,
        getTargetingKeys,
        getSlots: noopReturnEmptyArray,
        set: noopReturnThis,
        setCategoryExclusion: noopReturnThis,
        setCookieOptions: noopReturnThis,
        setForceSafeFrame: noopReturnThis,
        setLocation: noopReturnThis,
        setPublisherProvidedId: noopReturnThis,
        setRequestNonPersonalizedAds: noopReturnThis,
        setSafeFrameConfig: noopReturnThis,
        setTagForChildDirectedTreatment: noopReturnThis,
        setTargeting,
        getTargeting,
        setVideoContent: noopReturnThis
    };
    const companionadsTarget = {
        addEventListener: noopReturnThis
    };
    const sizeMappingTarget = {
        build: noopReturnNull
    };
    const contentTarget = {
        addEventListener: noopReturnThis
    };
    const slotTarget = {
        get: noopReturnNull,
        getAdUnitPath: noopReturnEmptyArray,
        getAttributeKeys: noopReturnEmptyArray,
        getCategoryExclusions: noopReturnEmptyArray,
        getDomId: noopReturnEmptyString,
        getSlotElementId: noopReturnEmptyString,
        getTargeting,
        getTargetingKeys
    };
    const gptObj = {
        _loadStarted_: true,
        apiReady: true,
        pubadsReady: true,
        cmd: [],
        pubads: function () { return new Proxy(pubadsTarget, noopHandler); },
        companionAds: function () { return new Proxy(companionadsTarget, noopHandler); },
        sizeMapping: function () { return new Proxy(sizeMappingTarget, noopReturnThisHandler); },
        content: function () { return new Proxy(contentTarget, noopHandler); },
        defineSlot: function () { return new Proxy(slotTarget, noopReturnThisHandler); },
        defineOutOfPageSlot: function () { return new Proxy(slotTarget, noopReturnThisHandler); },
        defineUnit: noopReturnNull,
        destroySlots: noop,
        disablePublisherConsole: noop,
        display: noop,
        enableServices: noop,
        getVersion: noopReturnEmptyString,
        setAdIframeTitle: noop
    };
    const commandQueue = (window.googletag && Array.isArray(window.googletag.cmd)) ? window.googletag.cmd : [];
    gptObj.cmd.push = function (arg) {
        if (typeof arg === 'function') {
            try {
                arg();
            } catch (error) {
            }
        }
        return 1;
    };
    window.googletag = gptObj;
    while (commandQueue.length > 0) {
        gptObj.cmd.push(commandQueue.shift());
    }
})();

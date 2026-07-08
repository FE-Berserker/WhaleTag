/**
 * Runtime API injected into every extension iframe.
 * Built as a standalone script; no bundler, no Node imports.
 */
(function () {
  'use strict';

  var PROTOCOL_VERSION = 1;
  var handlers = [];
  var localeHandlers = [];
  var currentLocale = 'en';

  function validateOrigin(event) {
    return event.source === window.parent;
  }

  function notifyLocale() {
    localeHandlers.forEach(function (handler) {
      try {
        handler(currentLocale);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[whaleExt] locale handler error', e);
      }
    });
  }

  window.addEventListener('message', function (event) {
    if (!validateOrigin(event)) return;
    if (!event.data || event.data.protocolVersion !== PROTOCOL_VERSION) return;
    if (event.data.source !== 'host') return;

    var message = event.data.message;
    // Track locale centrally so every extension gets it for free, then still
    // forward the raw message to generic onMessage handlers.
    if (message && message.type === 'setLocale') {
      var next = message.locale || 'en';
      if (next !== currentLocale) {
        currentLocale = next;
        notifyLocale();
      }
    }

    handlers.forEach(function (handler) {
      try {
        handler(message);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[whaleExt] message handler error', e);
      }
    });
  });

  window.whaleExt = {
    postMessage: function (msg) {
      window.parent.postMessage(
        {
          protocolVersion: PROTOCOL_VERSION,
          source: 'extension',
          message: msg,
        },
        '*'
      );
    },
    onMessage: function (handler) {
      handlers.push(handler);
      return function () {
        var idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    /** Current host UI locale (e.g. 'en', 'zh'). */
    get locale() {
      return currentLocale;
    },
    /** Subscribe to locale changes; fires immediately with the current locale. */
    onLocale: function (handler) {
      localeHandlers.push(handler);
      try {
        handler(currentLocale);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[whaleExt] locale handler error', e);
      }
      return function () {
        var idx = localeHandlers.indexOf(handler);
        if (idx >= 0) localeHandlers.splice(idx, 1);
      };
    },
    /** Pick a catalog entry for the current locale, falling back to the base
     *  language tag then to `en`. catalog = { en: {...}, zh: {...} }. */
    t: function (catalog) {
      if (!catalog) return {};
      if (catalog[currentLocale]) return catalog[currentLocale];
      var base = currentLocale.split('-')[0];
      if (catalog[base]) return catalog[base];
      return catalog.en || {};
    },
    manifest: /* MANIFEST_INJECTED_BY_BUILD */ {},
  };
})();

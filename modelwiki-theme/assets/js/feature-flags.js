(function () {
  'use strict';

  var STORAGE_KEY = 'mw-feature-flags';
  var listeners = {};
  var idCounter = 0;

  var defaults = {
    useNewClient: true,
    showGallery: false,
    lazyLoadImages: true
  };

  function loadFlags() {
    var flags = {};
    var key;

    for (key in defaults) {
      if (defaults.hasOwnProperty(key)) flags[key] = defaults[key];
    }

    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        var parsed = JSON.parse(stored);
        for (key in parsed) {
          if (parsed.hasOwnProperty(key)) flags[key] = parsed[key];
        }
      }
    } catch (_) {}

    try {
      var params = new URLSearchParams(window.location.search);
      params.forEach(function (value, key) {
        if (key.indexOf('ff_') === 0) {
          var flagKey = key.substring(3);
          if (value === 'false' || value === '0') flags[flagKey] = false;
          else if (value === 'true' || value === '1') flags[flagKey] = true;
          else flags[flagKey] = value;
        }
      });
    } catch (_) {}

    return flags;
  }

  var current = loadFlags();

  function notify(key, newVal, oldVal) {
    var list = listeners[key];
    if (list) {
      for (var id in list) {
        if (list.hasOwnProperty(id)) {
          try { list[id](newVal, oldVal); } catch (_) {}
        }
      }
    }
    var wild = listeners['*'];
    if (wild) {
      for (var id in wild) {
        if (wild.hasOwnProperty(id)) {
          try { wild[id](key, newVal, oldVal); } catch (_) {}
        }
      }
    }
  }

  window.MW = window.MW || {};

  window.MW.featureFlags = {
    get: function (key) {
      return current[key];
    },

    getAll: function () {
      var copy = {};
      for (var key in current) {
        if (current.hasOwnProperty(key)) copy[key] = current[key];
      }
      return copy;
    },

    set: function (key, value) {
      var old = current[key];
      current[key] = value;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (_) {}
      notify(key, value, old);
    },

    reset: function () {
      current = {};
      for (var key in defaults) {
        if (defaults.hasOwnProperty(key)) current[key] = defaults[key];
      }
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      notify('*', null, null);
    },

    onChange: function (key, callback) {
      if (!listeners[key]) listeners[key] = {};
      var id = 'l' + (idCounter++);
      listeners[key][id] = callback;
      return function () {
        delete listeners[key][id];
      };
    }
  };
})();

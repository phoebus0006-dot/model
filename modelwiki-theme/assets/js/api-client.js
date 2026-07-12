(function () {
  'use strict';

  var DEFAULTS = {
    baseUrl: '/api/v1',
    timeout: 15000
  };

  var requestIdCounter = 0;

  function nextId() {
    return 'mw-' + (++requestIdCounter) + '-' + Date.now().toString(36);
  }

  function convertBigInts(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'number') {
      return Number.isInteger(obj) && obj > Number.MAX_SAFE_INTEGER ? String(obj) : obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(convertBigInts);
    }
    if (typeof obj === 'object') {
      var result = {};
      for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
          result[key] = convertBigInts(obj[key]);
        }
      }
      return result;
    }
    return obj;
  }

  function ModelWikiAPIError(message, status, code, details, requestId) {
    this.name = 'ModelWikiAPIError';
    this.message = message || 'Request failed';
    this.status = status || 0;
    this.code = code || null;
    this.details = details || null;
    this.requestId = requestId || null;
  }
  ModelWikiAPIError.prototype = Object.create(Error.prototype);
  ModelWikiAPIError.prototype.constructor = ModelWikiAPIError;

  function ModelWikiAPI(options) {
    options = options || {};
    this._baseUrl = options.baseUrl || DEFAULTS.baseUrl;
    this._timeout = options.timeout || DEFAULTS.timeout;
    this._requestInterceptors = [];
    this._responseInterceptors = [];
    this._getToken = options.getToken || function () { return ''; };
    this._onUnauthorized = options.onUnauthorized || function () {};
  }

  ModelWikiAPI.prototype.addRequestInterceptor = function (fn) {
    this._requestInterceptors.push(fn);
    var self = this;
    return function () {
      var idx = self._requestInterceptors.indexOf(fn);
      if (idx !== -1) self._requestInterceptors.splice(idx, 1);
    };
  };

  ModelWikiAPI.prototype.addResponseInterceptor = function (fn) {
    this._responseInterceptors.push(fn);
    var self = this;
    return function () {
      var idx = self._responseInterceptors.indexOf(fn);
      if (idx !== -1) self._responseInterceptors.splice(idx, 1);
    };
  };

  ModelWikiAPI.prototype._buildUrl = function (path, params) {
    var url = this._baseUrl + path;
    if (params) {
      var qs = [];
      for (var key in params) {
        if (params.hasOwnProperty(key)) {
          var value = params[key];
          if (value !== undefined && value !== null && value !== '') {
            qs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
          }
        }
      }
      if (qs.length) url += '?' + qs.join('&');
    }
    return url;
  };

  ModelWikiAPI.prototype._handleResponse = function (response, data) {
    if (!response.ok || (data && data.success === false)) {
      var details = data && data.error && data.error.details;
      var code = data && data.error && (data.error.code || null);
      var message =
        details && details[0] && details[0].message
          ? details[0].message
          : data && data.error && data.error.message
            ? data.error.message
            : response.statusText || 'Request failed';

      if (response.status === 401) {
        this._onUnauthorized();
      }

      throw new ModelWikiAPIError(message, response.status, code, details, nextId());
    }
    return data;
  };

  ModelWikiAPI.prototype._request = function (method, path, options) {
    options = options || {};
    var self = this;
    var aborted = false;
    var state = { loading: true, error: null, data: null, retry: null };

    var execute = function () {
      aborted = false;
      state.loading = true;
      state.error = null;
      state.data = null;
      state.retry = execute;

      var controller = new AbortController();
      var timeoutId = setTimeout(function () {
        controller.abort();
      }, options.timeout || self._timeout);

      var url = self._buildUrl(path, options.params);
      var headers = { Accept: 'application/json' };
      var token = self._getToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      if (options.body && method !== 'GET') {
        headers['Content-Type'] = 'application/json';
      }

      var fetchOpts = {
        method: method,
        headers: headers,
        signal: controller.signal
      };
      if (options.body && method !== 'GET') {
        fetchOpts.body = JSON.stringify(options.body);
      }

      // request interceptors
      var intercepted = { url: url, fetchOptions: fetchOpts, method: method, path: path, params: options.params, body: options.body };
      for (var i = 0; i < self._requestInterceptors.length; i++) {
        var result = self._requestInterceptors[i](intercepted);
        if (result) intercepted = result;
      }

      // feature flag check
      if (window.MW && window.MW.featureFlags && !window.MW.featureFlags.get('useNewClient')) {
        clearTimeout(timeoutId);
        state.loading = false;
        state.error = new ModelWikiAPIError('New API client disabled by feature flag', 0, 'FF_DISABLED', null, nextId());
        return Promise.resolve(state);
      }

      return fetch(intercepted.url, intercepted.fetchOptions)
        .then(function (response) {
          clearTimeout(timeoutId);
          return response.json().catch(function () {
            return {};
          }).then(function (data) {
            if (aborted) return state;

            // response interceptors
            for (var j = 0; j < self._responseInterceptors.length; j++) {
              var interceptedData = self._responseInterceptors[j](data);
              if (interceptedData !== undefined) data = interceptedData;
            }

            self._handleResponse.call(self, response, data);

            var payload = data.data !== undefined ? data.data : data;
            state.loading = false;
            state.data = convertBigInts(payload);
            state.error = null;
            return state;
          });
        })
        .catch(function (err) {
          clearTimeout(timeoutId);
          if (aborted) return state;

          if (err instanceof ModelWikiAPIError) {
            state.loading = false;
            state.error = err;
            return state;
          }

          if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
            state.loading = false;
            state.error = new ModelWikiAPIError('Request timed out', 0, 'TIMEOUT', null, nextId());
            return state;
          }

          state.loading = false;
          state.error = new ModelWikiAPIError(
            err.message || 'Network error',
            0,
            'NETWORK_ERROR',
            null,
            nextId()
          );
          return state;
        });
    };

    state.retry = execute;
    return execute();
  };

  ModelWikiAPI.prototype.getFigures = function (params) {
    if (params === undefined) params = {};
    return this._request('GET', '/figures', { params: params });
  };

  ModelWikiAPI.prototype.getFigure = function (slug) {
    return this._request('GET', '/figures/' + encodeURIComponent(slug));
  };

  ModelWikiAPI.prototype.search = function (query) {
    return this._request('GET', '/search', { params: { q: query } });
  };

  ModelWikiAPI.prototype.getCategories = function () {
    return this._request('GET', '/categories');
  };

  ModelWikiAPI.prototype.getSeries = function (slug) {
    var path = slug ? '/series/' + encodeURIComponent(slug) : '/series';
    return this._request('GET', path);
  };

  ModelWikiAPI.prototype.getManufacturer = function (slug) {
    return this._request('GET', '/manufacturers/' + encodeURIComponent(slug));
  };

  ModelWikiAPI.prototype.getCharacters = function () {
    return this._request('GET', '/characters');
  };

  if (typeof window !== 'undefined') {
    window.ModelWikiAPI = ModelWikiAPI;
  }
})();

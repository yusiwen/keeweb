'use strict';

var Backbone = require('backbone'),
    Logger = require('../util/logger'),
    AppSettingsModel = require('../models/app-settings-model'),
    RuntimeDataModel = require('../models/runtime-data-model'),
    Links = require('../const/links');

var MaxRequestRetries = 3;

var StorageBase = function() {
};

_.extend(StorageBase.prototype, {
    name: null,
    icon: null,
    iconSvg: null,
    enabled: false,
    system: false,
    uipos: null,

    logger: null,
    appSettings: AppSettingsModel.instance,
    runtimeData: RuntimeDataModel.instance,

    init: function() {
        if (!this.name) {
            throw 'Failed to init provider: no name';
        }
        if (!this.system) {
            var enabled = this.appSettings.get(this.name);
            if (typeof enabled === 'boolean') {
                this.enabled = enabled;
            }
        }
        this.logger = new Logger('storage-' + this.name);
        return this;
    },

    _xhr: function(config) {
        var xhr = new XMLHttpRequest();
        if (config.responseType) {
            xhr.responseType = config.responseType;
        }
        var statuses = config.statuses || [200];
        var that = this;
        xhr.addEventListener('load', function() {
            if (statuses.indexOf(xhr.status) >= 0) {
                return config.success && config.success(xhr.response, xhr);
            }
            if (xhr.status === 401 && that._oauthToken) {
                that._oauthRefreshToken(function(err) {
                    if (err) {
                        return config.error && config.error('unauthorized', xhr);
                    } else {
                        config.tryNum = (config.tryNum || 0) + 1;
                        if (config.tryNum >= MaxRequestRetries) {
                            that.logger.info('Too many authorize attempts, fail request', config.url);
                            return config.error && config.error('unauthorized', xhr);
                        }
                        that.logger.info('Repeat request, try #' + config.tryNum, config.url);
                        that._xhr(config);
                    }
                });
            } else {
                return config.error && config.error('http status ' + xhr.status, xhr);
            }
        });
        xhr.addEventListener('error', function() {
            return config.error && config.error('network error', xhr);
        });
        xhr.addEventListener('timeout', function() {
            return config.error && config.error('timeout', xhr);
        });
        xhr.open(config.method || 'GET', config.url);
        if (this._oauthToken) {
            xhr.setRequestHeader('Authorization',
                this._oauthToken.tokenType + ' ' + this._oauthToken.accessToken);
        }
        _.forEach(config.headers, function(value, key) {
            xhr.setRequestHeader(key, value);
        });
        xhr.send(config.data);
    },

    _openPopup: function(url, title, width, height) {
        var dualScreenLeft = window.screenLeft !== undefined ? window.screenLeft : screen.left;
        var dualScreenTop = window.screenTop !== undefined ? window.screenTop : screen.top;

        var winWidth = window.innerWidth ? window.innerWidth : document.documentElement.clientWidth ? document.documentElement.clientWidth : screen.width;
        var winHeight = window.innerHeight ? window.innerHeight : document.documentElement.clientHeight ? document.documentElement.clientHeight : screen.height;

        var left = ((winWidth / 2) - (width / 2)) + dualScreenLeft;
        var top = ((winHeight / 2) - (height / 2)) + dualScreenTop;

        var settings = {
            width: width,
            height: height,
            left: left,
            top: top,
            dialog: 'yes',
            dependent: 'yes',
            scrollbars: 'yes',
            location: 'yes'
        };
        settings = Object.keys(settings).map(function(key) { return key + '=' + settings[key]; }).join(',');

        var win = window.open(url, title, settings);
        if (win && win.focus) {
            win.focus();
        }
        return win;
    },

    _getOauthRedirectUrl: function() {
        var redirectUrl = window.location.href;
        if (redirectUrl.lastIndexOf('file:', 0) === 0) {
            redirectUrl = Links.WebApp;
        }
        return redirectUrl;
    },

    _oauthAuthorize: function(callback) {
        var that = this;
        if (that._oauthToken && !that._oauthToken.expired) {
            return callback();
        }
        var opts = this._getOAuthConfig();
        var oldToken = that.runtimeData.get(that.name + 'OAuthToken');
        if (oldToken && !oldToken.expired) {
            that._oauthToken = oldToken;
            callback();
            return;
        }
        var url = opts.url + '?client_id={cid}&scope={scope}&response_type=token&redirect_uri={url}'
            .replace('{cid}', encodeURIComponent(opts.clientId))
            .replace('{scope}', encodeURIComponent(opts.scope))
            .replace('{url}', encodeURIComponent(this._getOauthRedirectUrl()));
        that.logger.debug('OAuth popup opened');
        if (!that._openPopup(url, 'OAuth', opts.width, opts.height)) {
            callback('cannot open popup');
        }
        var popupClosed = function() {
            Backbone.off('popup-closed', popupClosed);
            window.removeEventListener('message', windowMessage);
            that.logger.error('OAuth error', 'popup closed');
            callback('popup closed');
        };
        var windowMessage = function(e) {
            if (!e.data) {
                return;
            }
            Backbone.off('popup-closed', popupClosed);
            window.removeEventListener('message', windowMessage);
            var token = that._oauthMsgToToken(e.data);
            if (token.error) {
                that.logger.error('OAuth error', token.error, token.errorDescription);
                callback(token.error);
            } else {
                that._oauthToken = token;
                that.runtimeData.set(that.name + 'OAuthToken', token);
                that.logger.debug('OAuth success');
                callback();
            }
        };
        Backbone.on('popup-closed', popupClosed);
        window.addEventListener('message', windowMessage);
    },

    _oauthMsgToToken: function(data) {
        // jshint camelcase:false
        if (data.error || !data.token_type) {
            return { error: data.error || 'no token', errorDescription: data.error_description };
        }
        return {
            tokenType: data.token_type,
            accessToken: data.access_token,
            authenticationToken: data.authentication_token,
            expiresIn: data.expires_in,
            scope: data.scope,
            userId: data.user_id
        };
    },

    _oauthRefreshToken: function(callback) {
        this._oauthToken.expired = true;
        this.runtimeData.set(this.name + 'OAuthToken', this._oauthToken);
        this._oauthAuthorize(callback);
    }
});

StorageBase.extend = Backbone.Model.extend;

module.exports = StorageBase;

(function(){
    'use strict';

    // Cookie banner
    var cookieBanner = document.getElementById('mw-cookie-banner');
    var cookieAccept = document.getElementById('mw-cookie-accept');
    if (cookieBanner && cookieAccept) {
        if (!localStorage.getItem('mw-cookie-accepted')) {
            cookieBanner.style.display = 'flex';
        }
        cookieAccept.addEventListener('click', function() {
            localStorage.setItem('mw-cookie-accepted', '1');
            cookieBanner.style.display = 'none';
        });
    }

    // Mobile menu toggle
    var menuBtn = document.getElementById('mw-mobile-menu-btn');
    var mobileMenu = document.getElementById('mw-mobile-menu');
    if (menuBtn && mobileMenu) {
        menuBtn.addEventListener('click', function() {
            var isOpen = mobileMenu.classList.contains('open');
            if (isOpen) {
                mobileMenu.classList.remove('open');
                menuBtn.textContent = '\u2630';
            } else {
                mobileMenu.classList.add('open');
                menuBtn.textContent = '\u2715';
            }
        });
    }

    // Gallery thumbnail click - swap main image
    var mainImage = document.getElementById('mw-main-image') || document.getElementById('gallery-main-img');
    var thumbs = document.querySelectorAll('.mw-gallery-thumb');
    if (mainImage && thumbs.length > 0) {
        thumbs.forEach(function(thumb) {
            thumb.addEventListener('click', function() {
                var fullSrc = this.getAttribute('data-full');
                var nextAlt = this.getAttribute('data-alt') || (this.querySelector('img') ? this.querySelector('img').alt : '');
                if (fullSrc) {
                    mainImage.src = fullSrc;
                    mainImage.setAttribute('data-full', fullSrc);
                    mainImage.alt = nextAlt || mainImage.alt;
                    thumbs.forEach(function(t) { t.classList.remove('active'); }); 
                    this.classList.add('active');
                }
            });
        });
    }

    // Lightbox
    var lightbox = document.getElementById('mw-lightbox');
    var lightboxImg = document.getElementById('mw-lightbox-img');
    var lightboxClose = document.getElementById('mw-lightbox-close');
    if (lightbox && lightboxImg) {
        if (mainImage) {
            mainImage.style.cursor = 'zoom-in';
            mainImage.addEventListener('click', function() {
                lightboxImg.src = this.getAttribute('data-full') || this.src;
                lightboxImg.alt = this.alt;
                lightbox.classList.add('open');
                document.body.style.overflow = 'hidden';
            });
        }
        if (lightboxClose) {
            lightboxClose.addEventListener('click', function() {
                lightbox.classList.remove('open');
                document.body.style.overflow = '';
            });
        }
        lightbox.addEventListener('click', function(e) {
            if (e.target === lightbox) {
                lightbox.classList.remove('open');
                document.body.style.overflow = '';
            }
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && lightbox.classList.contains('open')) {
                lightbox.classList.remove('open');
                document.body.style.overflow = '';
            }
        });
    }

    var API_BASE = '/api/v1';
    var tokenKey = 'mw-auth-token';
    var userKey = 'mw-auth-user';
    // i18n strings — injected from PHP via window.MW_I18N
    var i18n = window.MW_I18N || {};
    function t(key) { return i18n[key] || key; }
    var passwordChecks = {
        length: function(value) { return value.length >= 8; },
        upper: function(value) { return /[A-Z]/.test(value); },
        lower: function(value) { return /[a-z]/.test(value); },
        special: function(value) { return /[^A-Za-z0-9]/.test(value); }
    };

    function getToken() {
        return sessionStorage.getItem(tokenKey) || '';
    }

    function getUser() {
        try {
            return JSON.parse(sessionStorage.getItem(userKey) || 'null');
        } catch (e) {
            return null;
        }
    }

    function setSession(token, user) {
        sessionStorage.setItem(tokenKey, token);
        sessionStorage.setItem(userKey, JSON.stringify(user || {}));
        updateAccountLinks();
    }

    function clearSession() {
        sessionStorage.removeItem(tokenKey);
        sessionStorage.removeItem(userKey);
        updateAccountLinks();
    }

    function apiFetch(endpoint, options) {
        options = options || {};
        var headers = options.headers || {};
        if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        var token = getToken();
        if (token) headers.Authorization = 'Bearer ' + token;
        return fetch(API_BASE + endpoint, {
            method: options.method || 'GET',
            headers: headers,
            body: options.body ? JSON.stringify(options.body) : undefined
        }).then(function(resp) {
            return resp.json().catch(function() { return {}; }).then(function(data) {
                if (!resp.ok || data.success === false) {
                    var detailMessage = data.error && data.error.details && data.error.details[0] && data.error.details[0].message;
                    var err = new Error(detailMessage || (data.error && (data.error.message || data.error.code)) || 'Request failed');
                    err.response = data;
                    err.status = resp.status;
                    throw err;
                }
                return data;
            });
        });
    }

    function esc(text) {
        return String(text == null ? '' : text).replace(/[&<>"']/g, function(ch) {
            return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[ch];
        });
    }

    function updateAccountLinks() {
        var user = getUser();
        document.querySelectorAll('[data-mw-account-link]').forEach(function(link) {
            link.textContent = user ? t('Personal Space') : t('Log in');
            if (user && user.displayName) link.setAttribute('title', user.displayName);
            else link.removeAttribute('title');
        });
    }

    function requireLogin() {
        if (getToken()) return true;
        var lang = document.documentElement.lang || '';
        window.location.href = '/account/' + (lang ? '?lang=' + lang : '');
        return false;
    }

    function renderSpaceItems(container, items) {
        if (!container) return;
        if (!items || items.length === 0) {
            container.innerHTML = '<p class="mw-empty">' + t('Nothing here yet.') + '</p>';
            return;
        }
        container.innerHTML = items.map(function(item) {
            var fig = item.figure || {};
            var img = fig.image && fig.image.url ? '<img src="' + esc(fig.image.url) + '" alt="">' : '<div class="mw-space-thumb-empty"></div>';
            return '<a class="mw-space-item" href="/figure/' + esc(fig.slug) + '/">' + img + '<span>' + esc(fig.name || fig.nameEn || fig.slug) + '</span></a>';
        }).join('');
    }

    function renderCommentList(container, comments) {
        if (!container) return;
        if (!comments || comments.length === 0) {
            container.innerHTML = '<p class="mw-empty">' + t('No comments yet.') + '</p>';
            return;
        }
        container.innerHTML = comments.map(function(comment) {
            var user = comment.user || {};
            var figure = comment.figure || null;
            var figureLink = figure ? '<a href="/figure/' + esc(figure.slug) + '/">' + esc(figure.name || figure.slug) + '</a>' : '';
            return '<article class="mw-comment"><div class="mw-comment-meta"><strong>' + esc(user.displayName || 'ModelWiki user') + '</strong><span>' + esc(new Date(comment.createdAt).toLocaleString()) + '</span>' + figureLink + '</div><p>' + esc(comment.body) + '</p></article>';
        }).join('');
    }

    function initAccountPage() {
        var page = document.querySelector('[data-mw-account-page]');
        if (!page) return;
        var authPanel = page.querySelector('[data-mw-auth-panel]');
        var space = page.querySelector('[data-mw-space]');
        var logout = page.querySelector('[data-mw-logout]');
        var loginForm = page.querySelector('[data-mw-login-form]');
        var registerForm = page.querySelector('[data-mw-register-form]');
        var tabs = page.querySelectorAll('[data-mw-auth-tab]');
        var views = page.querySelectorAll('[data-mw-auth-view]');
        var passwordInput = page.querySelector('[data-mw-password-input]');
        var passwordBar = page.querySelector('[data-mw-password-bar]');
        var passwordLabel = page.querySelector('[data-mw-password-label]');
        var registerSubmit = page.querySelector('[data-mw-register-submit]');

        function activateAuthTab(name) {
            tabs.forEach(function(tab) {
                var active = tab.getAttribute('data-mw-auth-tab') === name;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            views.forEach(function(view) {
                view.classList.toggle('active', view.getAttribute('data-mw-auth-view') === name);
            });
        }

        function passwordState(value) {
            var passed = 0;
            Object.keys(passwordChecks).forEach(function(key) {
                if (passwordChecks[key](value)) passed += 1;
            });
            return { passed: passed, valid: passed === Object.keys(passwordChecks).length };
        }

        function updatePasswordMeter() {
            if (!registerForm || !passwordInput) return false;
            var value = passwordInput.value || '';
            var state = passwordState(value);
            Object.keys(passwordChecks).forEach(function(key) {
                var rule = page.querySelector('[data-mw-password-rule="' + key + '"]');
                if (rule) rule.classList.toggle('valid', passwordChecks[key](value));
            });
            if (passwordBar) {
                passwordBar.style.width = (state.passed * 25) + '%';
                passwordBar.setAttribute('data-score', String(state.passed));
            }
            if (passwordLabel) {
                passwordLabel.textContent = state.valid ? t('Password meets the rules') : state.passed >= 2 ? t('Almost there') : t('Password needs work');
            }
            var confirm = registerForm.elements.confirmPassword ? registerForm.elements.confirmPassword.value : '';
            var matched = Boolean(value) && value === confirm;
            if (registerSubmit) registerSubmit.disabled = !(state.valid && matched);
            return state.valid && matched;
        }

        function showMessage(selector, message, isError) {
            var el = page.querySelector(selector);
            if (!el) return;
            el.textContent = message || '';
            el.classList.toggle('error', !!isError);
        }

        function loadSpace() {
            if (!getToken()) {
                authPanel.hidden = false;
                space.hidden = true;
                if (logout) logout.hidden = true;
                return;
            }
            apiFetch('/me/space').then(function(resp) {
                var data = resp.data || {};
                authPanel.hidden = true;
                space.hidden = false;
                if (logout) logout.hidden = false;
                page.querySelector('[data-mw-space-name]').textContent = data.user.displayName || 'ModelWiki user';
                page.querySelector('[data-mw-space-email]').textContent = data.user.email || '';
                renderSpaceItems(page.querySelector('[data-mw-favorites]'), data.favorites || []);
                renderSpaceItems(page.querySelector('[data-mw-likes]'), data.likes || []);
                renderCommentList(page.querySelector('[data-mw-my-comments]'), data.comments || []);
            }).catch(function() {
                clearSession();
                authPanel.hidden = false;
                space.hidden = true;
                if (logout) logout.hidden = true;
            });
        }

        if (loginForm) {
            loginForm.addEventListener('submit', function(e) {
                e.preventDefault();
                var body = {
                    username: loginForm.elements.username.value.trim(),
                    password: loginForm.elements.password.value
                };
                showMessage('[data-mw-login-message]', t('Signing in...'), false);
                apiFetch('/auth/login', { method: 'POST', body: body }).then(function(resp) {
                    setSession(resp.data.token, resp.data.user);
                    loginForm.reset();
                    showMessage('[data-mw-login-message]', '', false);
                    window.location.href = '/';
                }).catch(function(err) {
                    showMessage('[data-mw-login-message]', err.message || t('Login failed'), true);
                });
            });
        }

        if (registerForm) {
            if (passwordInput) passwordInput.addEventListener('input', updatePasswordMeter);
            if (registerForm.elements.confirmPassword) registerForm.elements.confirmPassword.addEventListener('input', updatePasswordMeter);
            updatePasswordMeter();

            registerForm.addEventListener('submit', function(e) {
                e.preventDefault();
                if (!updatePasswordMeter()) {
                    showMessage('[data-mw-register-message]', t('Please meet all password rules and confirm the password.'), true);
                    return;
                }
                var body = {
                    displayName: registerForm.elements.displayName.value.trim(),
                    email: registerForm.elements.email.value.trim(),
                    password: registerForm.elements.password.value,
                    website: registerForm.elements.website ? registerForm.elements.website.value : ''
                };
                showMessage('[data-mw-register-message]', t('Creating account...'), false);
                apiFetch('/auth/register', { method: 'POST', body: body }).then(function(resp) {
                    registerForm.reset();
                    updatePasswordMeter();
                    showMessage('[data-mw-register-message]', resp.message || t('Registration received. Please check your email and activate the account before logging in.'), false);
                }).catch(function(err) {
                    showMessage('[data-mw-register-message]', err.message || t('Registration failed'), true);
                });
            });
        }

        tabs.forEach(function(tab) {
            tab.addEventListener('click', function() {
                activateAuthTab(tab.getAttribute('data-mw-auth-tab'));
            });
        });

        if (logout) {
            logout.addEventListener('click', function() {
                clearSession();
                loadSpace();
            });
        }

        loadSpace();
    }

    function initFigureSocial() {
        var panel = document.querySelector('[data-mw-figure-social]');
        if (!panel) return;
        var slug = panel.getAttribute('data-slug');
        var likeBtn = panel.querySelector('[data-mw-like]');
        var favBtn = panel.querySelector('[data-mw-favorite]');
        var likeCount = panel.querySelector('[data-mw-like-count]');
        var favCount = panel.querySelector('[data-mw-favorite-count]');
        var state = { liked: false, favorited: false, likes: 0, favorites: 0 };

        function render() {
            if (likeCount) likeCount.textContent = String(state.likes);
            if (favCount) favCount.textContent = String(state.favorites);
            if (likeBtn) likeBtn.classList.toggle('active', state.liked);
            if (favBtn) favBtn.classList.toggle('active', state.favorited);
        }

        function load() {
            apiFetch('/figures/' + encodeURIComponent(slug) + '/social').then(function(resp) {
                var data = resp.data || {};
                state.likes = (data.counts && data.counts.likes) || 0;
                state.favorites = (data.counts && data.counts.favorites) || 0;
                state.liked = !!(data.viewer && data.viewer.liked);
                state.favorited = !!(data.viewer && data.viewer.favorited);
                render();
            }).catch(function() {});
        }

        if (likeBtn) {
            likeBtn.addEventListener('click', function() {
                if (!requireLogin()) return;
                if (likeBtn.disabled) return;
                likeBtn.disabled = true;
                var next = !state.liked;
                apiFetch('/figures/' + encodeURIComponent(slug) + '/like', { method: next ? 'POST' : 'DELETE' }).then(function() {
                    state.liked = next;
                    state.likes += next ? 1 : -1;
                    if (state.likes < 0) state.likes = 0;
                    render();
                }).catch(function() {}).finally(function() {
                    likeBtn.disabled = false;
                });
            });
        }

        if (favBtn) {
            favBtn.addEventListener('click', function() {
                if (!requireLogin()) return;
                if (favBtn.disabled) return;
                favBtn.disabled = true;
                var next = !state.favorited;
                apiFetch('/figures/' + encodeURIComponent(slug) + '/favorite', { method: next ? 'POST' : 'DELETE' }).then(function() {
                    state.favorited = next;
                    state.favorites += next ? 1 : -1;
                    if (state.favorites < 0) state.favorites = 0;
                    render();
                }).catch(function() {}).finally(function() {
                    favBtn.disabled = false;
                });
            });
        }

        load();
    }

    function initComments() {
        var root = document.querySelector('[data-mw-comments]');
        if (!root) return;
        var slug = root.getAttribute('data-slug');
        var form = root.querySelector('[data-mw-comment-form]');
        var list = root.querySelector('[data-mw-comment-list]');
        var count = root.querySelector('[data-mw-comment-count]');
        var msg = root.querySelector('[data-mw-comment-message]');

        function setMsg(text, isError) {
            if (!msg) return;
            msg.textContent = text || '';
            msg.classList.toggle('error', !!isError);
        }

        function loadComments() {
            apiFetch('/figures/' + encodeURIComponent(slug) + '/comments').then(function(resp) {
                var comments = resp.data || [];
                if (count) count.textContent = String(comments.length);
                renderCommentList(list, comments);
            }).catch(function() {});
        }

        if (form) {
            form.addEventListener('submit', function(e) {
                e.preventDefault();
                if (!requireLogin()) return;
                var body = form.elements.body.value.trim();
                if (!body) {
                    setMsg(t('Please write a comment first.'), true);
                    return;
                }
                setMsg(t('Posting...'), false);
                apiFetch('/figures/' + encodeURIComponent(slug) + '/comments', { method: 'POST', body: { body: body } }).then(function() {
                    form.reset();
                    setMsg('', false);
                    loadComments();
                }).catch(function(err) {
                    setMsg(err.message || t('Could not post comment'), true);
                });
            });
        }

        loadComments();
    }

    updateAccountLinks();
    initAccountPage();
    initFigureSocial();
    initComments();
})();

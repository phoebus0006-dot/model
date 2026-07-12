/**
 * ModelWiki 管理后台 JavaScript
 * ============================
 *
 * 单页应用 (SPA)，操作：
 *   - 用户认证（登录/注册/登出）
 *   - 用户管理（添加/删除/权限变更）
 *   - 爬虫控制（触发 MFC 数据抓取）
 *   - 缓存管理
 *   - 系统信息查看
 *
 * 依赖：
 *   - 后端 Auth API: POST /auth/register, POST /auth/login, GET /auth/me
 *   - 后端 Admin API: /admin/users, /admin/import/mfc, /admin/cache
 *
 * 安全：
 *   - JWT token 存储在 localStorage
 *   - 所有 API 请求通过 Authorization header 发送 token
 *
 * @package ModelWiki
 * @since   2.0.0
 * @version 3.7.0
 */
var MW_ADMIN = MW_ADMIN || {};
(function(){
    var API_BASE = window.API_BASE;
    var HOME_URL = window.HOME_URL;

    var SECTIONS = [
        {id:'dashboard',label:'Dashboard',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'},
        {id:'figures',label:'Figures',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>'},
        {id:'review',label:'Review Queue',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'},
        {id:'import',label:'Data Import',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/></svg>'},
        {id:'crawler',label:'Crawler Control',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>'},
        {id:'cache',label:'Cache',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg>'},
        {id:'users',label:'Users',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'}
    ];

    var state = {
        token: sessionStorage.getItem('mw_admin_token') || null,
        user: JSON.parse(sessionStorage.getItem('mw_admin_user') || 'null'),
        activeSection: 'dashboard',
        stats: null,
        figures: [],
        figuresMeta: null,
        figuresSearch: '',
        figuresPage: 1,
        reviewItems: [],
        reviewStatus: 'pending',
        reviewDetail: null,
        reviewDetailLoading: false,
        users: [],
        importStatus: null,
        alerts: [],
        loading: {}
    };

    function api(endpoint, method, body, withAuth){
        var opts = {
            method: method || 'GET',
            headers: {'Content-Type': 'application/json'}
        };
        if(withAuth !== false && state.token){
            opts.headers['Authorization'] = 'Bearer ' + state.token;
        }
        if(body){
            opts.body = JSON.stringify(body);
        }
        return fetch(API_BASE + endpoint, opts).then(function(r){
            if(r.status === 401){
                logout();
                throw new Error('Session expired');
            }
            return r.json();
        });
    }

    function logout(){
        state.token = null;
        state.user = null;
        sessionStorage.removeItem('mw_admin_token');
        sessionStorage.removeItem('mw_admin_user');
        render();
    }

    function addAlert(type, message){
        var alertId = Date.now();
        state.alerts.push({type:type, message:message, id:alertId});
        render();
        setTimeout(function(){
            state.alerts = state.alerts.filter(function(a){ return a.id !== alertId; });
            render();
        }, 4000);
    }

    function setLoading(key, val){
        state.loading[key] = val;
        render();
    }

    function switchSection(id){
        state.activeSection = id;
        render();
        if(id === 'dashboard') loadStats();
        if(id === 'figures') loadFigures();
        if(id === 'review') loadReviewItems();
        if(id === 'users') loadUsers();
        if(id === 'import') loadImportStatus();
        closeMobileSidebar();
    }

    function loadStats(){
        setLoading('stats', true);
        api('/admin/stats').then(function(r){
            if(r.success) state.stats = r.data;
        }).catch(function(){}).then(function(){
            setLoading('stats', false);
        });
    }

    function loadFigures(){
        setLoading('figures', true);
        var params = '?page=' + state.figuresPage + '&perPage=20';
        if(state.figuresSearch) params += '&search=' + encodeURIComponent(state.figuresSearch);
        api('/figures' + params, 'GET', null, false).then(function(r){
            if(r.success){
                state.figures = r.data || [];
                state.figuresMeta = r.meta || null;
            }
        }).catch(function(){}).then(function(){
            setLoading('figures', false);
        });
    }

    function loadReviewItems(){
        setLoading('review', true);
        var params = '?limit=80';
        if(state.reviewStatus) params += '&status=' + encodeURIComponent(state.reviewStatus);
        api('/admin/review/items' + params).then(function(r){
            if(r.success) state.reviewItems = r.data || [];
        }).catch(function(){}).then(function(){
            setLoading('review', false);
        });
    }

    function loadReviewDetail(id){
        var found = null;
        for(var i = 0; i < state.reviewItems.length; i++){
            if(state.reviewItems[i].id === id){
                found = state.reviewItems[i];
                break;
            }
        }
        if(found){
            state.reviewDetail = found;
            setLoading('reviewDetail', false);
            render();
            return;
        }
        setLoading('reviewDetail', true);
        api('/admin/review/items?status=all').then(function(r){
            if(r.success){
                var items = r.data || [];
                for(var i = 0; i < items.length; i++){
                    if(items[i].id === id){
                        state.reviewDetail = items[i];
                        break;
                    }
                }
            }
        }).catch(function(){}).then(function(){
            setLoading('reviewDetail', false);
            render();
        });
    }

    function renderReviewDetail(){
        var item = state.reviewDetail;
        if(!item) return '<div class="admin-modal-overlay"><div class="admin-modal"><div class="admin-empty"><p>Item not found</p><button class="admin-btn admin-btn-sm" id="review-detail-close">Close</button></div></div></div>';
        var notes = (item.notes || '').split('\n').filter(Boolean).map(function(n){
            return '<div style="padding:4px 0;font-size:.8125rem;color:var(--mw-text-secondary);border-bottom:1px solid var(--mw-border-light)">'+esc(n)+'</div>';
        }).join('');
        var payload = item.payload || {};
        var candidateHtml = '<pre style="font-size:.75rem;max-height:300px;overflow:auto;background:var(--mw-bg-alt);padding:12px;border-radius:6px;white-space:pre-wrap">'+esc(JSON.stringify(payload, null, 2))+'</pre>';
        var imagesHtml = '';
        if(payload.images && Array.isArray(payload.images)){
            imagesHtml = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">';
            payload.images.forEach(function(img){
                var src = '/api/v1/admin/review/image-proxy?url=' + encodeURIComponent(img.url || img.source || '');
                imagesHtml += '<div style="width:120px;text-align:center">' +
                    '<img src="'+esc(src)+'" alt="" style="width:120px;height:120px;object-fit:cover;border-radius:6px;background:var(--mw-bg-alt)" onerror="this.style.display=\'none\'">' +
                    '<div style="font-size:.6875rem;color:var(--mw-text-tertiary);overflow:hidden;text-overflow:ellipsis">'+esc(img.alt || '')+'</div></div>';
            });
            imagesHtml += '</div>';
        }
        return '<div class="admin-modal-overlay">' +
            '<div class="admin-modal" style="max-width:800px;max-height:90vh;overflow-y:auto">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
                    '<h3 style="font-size:1rem">Review Detail: '+esc(item.title || item.id)+'</h3>' +
                    '<button class="admin-btn admin-btn-sm" id="review-detail-close">✕</button>' +
                '</div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">' +
                    '<div><strong>Type</strong><br><span class="admin-badge admin-badge-queued">'+esc(item.type)+'</span></div>' +
                    '<div><strong>Status</strong><br><span class="admin-badge admin-badge-active">'+esc(item.status)+'</span></div>' +
                    '<div><strong>Source</strong><br>'+esc(item.source || item.automation?.provider || '-')+'</div>' +
                    '<div><strong>Created</strong><br>'+formatDate(item.createdAt)+'</div>' +
                    (item.figureSlug ? '<div><strong>Target Figure</strong><br><a href="'+HOME_URL+'figure/'+esc(item.figureSlug)+'/" target="_blank">'+esc(item.figureSlug)+'</a></div>' : '') +
                    (item.figureId ? '<div><strong>Figure ID</strong><br>'+esc(String(item.figureId))+'</div>' : '') +
                    (item.riskType ? '<div style="grid-column:1/-1"><strong>Risk Type</strong><br>'+esc(item.riskType)+'</div>' : '') +
                '</div>' +
                '<div style="margin-bottom:16px"><strong>Candidate Data</strong></div>' +
                '<div style="margin-bottom:16px">'+candidateHtml+'</div>' +
                (imagesHtml ? '<div style="margin-bottom:16px"><strong>Candidate Images</strong>'+imagesHtml+'</div>' : '') +
                (notes ? '<div style="margin-bottom:16px"><strong>Event History</strong><div style="margin-top:8px;max-height:200px;overflow-y:auto">'+notes+'</div></div>' : '') +
                '<div style="display:flex;gap:8px;border-top:1px solid var(--mw-border);padding-top:16px">' +
                    '<button class="admin-btn admin-btn-success admin-btn-sm" data-review-action="'+esc(item.id)+'" data-review-status="approved">Apply</button> ' +
                    '<button class="admin-btn admin-btn-sm" data-review-action="'+esc(item.id)+'" data-review-status="needs_changes">Needs Changes</button> ' +
                    '<button class="admin-btn admin-btn-danger admin-btn-sm" data-review-action="'+esc(item.id)+'" data-review-status="rejected">Reject</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function loadUsers(){
        setLoading('users', true);
        api('/admin/users').then(function(r){
            if(r.success) state.users = r.data || [];
        }).catch(function(){}).then(function(){
            setLoading('users', false);
        });
    }

    function loadImportStatus(){
        setLoading('importStatus', true);
        api('/admin/import/status').then(function(r){
            if(r.success) state.importStatus = r.data;
        }).catch(function(){}).then(function(){
            setLoading('importStatus', false);
        });
    }

    function handleLogin(e){
        e.preventDefault();
        var email = document.getElementById('login-email').value;
        var password = document.getElementById('login-password').value;
        if(!email || !password) return;
        setLoading('login', true);
        api('/auth/login', 'POST', {email:email, password:password}, false).then(function(r){
            if(r.success){
                state.token = r.data.token;
                state.user = r.data.user;
                sessionStorage.setItem('mw_admin_token', r.data.token);
                sessionStorage.setItem('mw_admin_user', JSON.stringify(r.data.user));
                loadStats();
                render();
            } else {
                addAlert('error', r.error?.message || r.error?.code || 'Login failed');
            }
        }).catch(function(err){
            addAlert('error', err.message || 'Login failed');
        }).then(function(){
            setLoading('login', false);
        });
    }

    function handleMfcImport(){
        var input = document.getElementById('mfc-ids');
        var ids = input.value.split(',').map(function(s){return parseInt(s.trim(),10);}).filter(function(n){return !isNaN(n) && n > 0;});
        if(ids.length === 0){
            addAlert('warning', 'Please enter valid MFC item IDs');
            return;
        }
        setLoading('mfcImport', true);
        var body = ids.length === 1 ? {itemId: ids[0]} : {itemIds: ids};
        api('/admin/import/mfc', 'POST', body).then(function(r){
            if(r.success){
                addAlert('success', 'MFC import triggered: ' + r.data.total + ' item(s)');
                input.value = '';
                loadImportStatus();
            } else {
                addAlert('error', r.error?.message || r.error?.code || 'Import failed');
            }
        }).catch(function(err){
            addAlert('error', err.message || 'Import failed');
        }).then(function(){
            setLoading('mfcImport', false);
        });
    }

    function handleBatchImport(){
        var textarea = document.getElementById('batch-json');
        var raw = textarea.value.trim();
        if(!raw){
            addAlert('warning', 'Please enter JSON batch data');
            return;
        }
        var parsed;
        try{
            parsed = JSON.parse(raw);
        } catch(e){
            addAlert('error', 'Invalid JSON: ' + e.message);
            return;
        }
        var figures = Array.isArray(parsed) ? parsed : (parsed.figures || []);
        if(figures.length === 0){
            addAlert('warning', 'No figures found in JSON data');
            return;
        }
        setLoading('batchImport', true);
        api('/admin/figures/batch', 'POST', {figures: figures}).then(function(r){
            if(r.success){
                addAlert('success', 'Batch import: ' + r.data.total + ' figure(s) processed');
                textarea.value = '';
            } else {
                addAlert('error', r.error?.message || r.error?.code || 'Batch import failed');
            }
        }).catch(function(err){
            addAlert('error', err.message || 'Batch import failed');
        }).then(function(){
            setLoading('batchImport', false);
        });
    }

    function handleCachePurge(){
        if(!confirm('Are you sure you want to purge all cache?')) return;
        setLoading('cachePurge', true);
        api('/admin/cache/purge', 'POST', {purgeAll: true}).then(function(r){
            if(r.success){
                addAlert('success', 'Cache purged successfully');
            } else {
                addAlert('error', 'Cache purge failed');
            }
        }).catch(function(err){
            addAlert('error', err.message || 'Cache purge failed');
        }).then(function(){
            setLoading('cachePurge', false);
        });
    }

    function handleDeleteFigure(id){
        if(!confirm('Delete this figure? This action cannot be undone.')) return;
        api('/figures/' + id, 'DELETE').then(function(r){
            if(r.success){
                addAlert('success', 'Figure deleted');
                loadFigures();
            } else {
                addAlert('error', 'Delete failed');
            }
        }).catch(function(err){
            addAlert('error', err.message || 'Delete failed');
        });
    }

    function handleReviewStatus(id, action){
        var endpoint = '/admin/review/items/' + encodeURIComponent(id);
        var actionMap = {
            'approved':      {name: 'approve_image',   endpoint: endpoint + '/apply', method: 'POST', body: {}},
            'applied':       {name: 'applied',          endpoint: endpoint + '/apply', method: 'POST', body: {}},
            'rejected':      {name: 'reject_image',    endpoint: endpoint + '/action', method: 'POST', body: {action: 'reject_image'}},
            'needs_changes': {name: 'request_refetch', endpoint: endpoint + '/action', method: 'POST', body: {action: 'request_refetch'}},
            'resolved':      {name: 'mark_detail_ok',  endpoint: endpoint + '/action', method: 'POST', body: {action: 'mark_detail_ok'}},
            'keep_pending':  {name: 'keep_pending',    endpoint: endpoint + '/action', method: 'POST', body: {action: 'keep_pending'}},
        };
        var mapped = actionMap[action] || actionMap.resolved;
        api(mapped.endpoint, mapped.method, mapped.body).then(function(r){
            if(r.success){
                addAlert('success', 'Review ' + mapped.name + ' OK');
                loadReviewItems();
            } else {
                addAlert('error', r.error?.message || r.error?.code || 'Review action failed');
            }
        }).catch(function(err){
            addAlert('error', err.message || 'Review action failed');
        });
    }

    function handleCrawlerTrigger(mode){
        setLoading('crawler_' + mode, true);
        if(mode === 'search'){
            var q = document.getElementById('crawler-search-query');
            if(!q || !q.value.trim()){
                addAlert('warning', 'Please enter a search query');
                setLoading('crawler_' + mode, false);
                return;
            }
        }
        addAlert('info', 'Crawler "' + mode + '" command sent. Check server logs for progress.');
        setLoading('crawler_' + mode, false);
    }

    function handleUpdateUser(id, field, value){
        var body = {};
        body[field] = value;
        api('/admin/users/' + id, 'PUT', body).then(function(r){
            if(r.success){
                addAlert('success', 'User updated');
                loadUsers();
            } else {
                addAlert('error', 'Update failed');
            }
        }).catch(function(err){
            addAlert('error', err.message || 'Update failed');
        });
    }

    function closeMobileSidebar(){
        var sidebar = document.querySelector('.admin-sidebar');
        var overlay = document.querySelector('.admin-overlay');
        if(sidebar) sidebar.classList.remove('open');
        if(overlay) overlay.classList.remove('open');
    }

    function openMobileSidebar(){
        var sidebar = document.querySelector('.admin-sidebar');
        var overlay = document.querySelector('.admin-overlay');
        if(sidebar) sidebar.classList.add('open');
        if(overlay) overlay.classList.add('open');
    }

    function toggleTheme(){
        var html = document.documentElement;
        var current = html.getAttribute('data-theme') || 'light';
        var next = current === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', next);
        document.cookie = 'mw_theme=' + next + ';path=/;max-age=31536000';
    }

    function esc(s){
        if(s == null) return '';
        var d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    function formatNum(n){
        if(n == null) return '0';
        return Number(n).toLocaleString();
    }

    function formatDate(d){
        if(!d) return '-';
        return new Date(d).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'});
    }

    function formatPrice(jpy){
        if(jpy == null) return '-';
        return '¥' + Number(jpy).toLocaleString();
    }

    function renderAlerts(){
        if(state.alerts.length === 0) return '';
        return state.alerts.map(function(a){
            return '<div class="admin-alert admin-alert-'+a.type+'">'+esc(a.message)+'</div>';
        }).join('');
    }

    function renderSpinner(){
        return '<div class="admin-spinner"></div>';
    }

    function renderLoading(){
        return '<div class="admin-loading"><div class="admin-spinner admin-spinner-lg"></div></div>';
    }

    function renderLogin(){
        return '<div class="admin-login-wrapper">' +
            '<div class="admin-login-card admin-animate">' +
                '<div class="admin-login-logo">ModelWiki</div>' +
                '<div class="admin-login-subtitle">Admin Dashboard</div>' +
                renderAlerts() +
                '<form onsubmit="return false;" id="login-form">' +
                    '<div class="admin-form-group">' +
                        '<label class="admin-form-label">Email</label>' +
                        '<input type="email" id="login-email" class="admin-form-input" placeholder="admin@example.com" required>' +
                    '</div>' +
                    '<div class="admin-form-group">' +
                        '<label class="admin-form-label">Password</label>' +
                        '<div style="position:relative">' +
                            '<input type="password" id="login-password" class="admin-form-input" placeholder="Enter password" required style="padding-right:40px">' +
                            '<button type="button" id="login-toggle-pw" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--mw-text-tertiary);cursor:pointer;padding:4px" tabindex="-1">' +
                                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
                            '</button>' +
                        '</div>' +
                    '</div>' +
                    '<button type="submit" class="admin-btn admin-btn-primary admin-btn-block" id="login-btn"' + (state.loading.login ? ' disabled' : '') + '>' +
                        (state.loading.login ? renderSpinner() : 'Sign In') +
                    '</button>' +
                '</form>' +
            '</div>' +
        '</div>';
    }

    function renderSidebar(){
        var navItems = SECTIONS.map(function(s){
            return '<button class="admin-nav-item' + (state.activeSection === s.id ? ' active' : '') + '" data-section="'+s.id+'">' +
                s.icon + '<span>'+s.label+'</span></button>';
        }).join('');

        var userInitial = state.user ? (state.user.displayName || state.user.email || 'A').charAt(0).toUpperCase() : 'A';
        var userName = state.user ? (state.user.displayName || state.user.email) : '';
        var userRole = state.user ? state.user.role : '';

        return '<aside class="admin-sidebar">' +
            '<div class="admin-sidebar-brand">' +
                '<a href="'+HOME_URL+'">ModelWiki</a>' +
                '<button class="admin-sidebar-theme" onclick="window._mwAdmin.toggleTheme()" title="Toggle theme">' +
                    '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>' +
                    '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' +
                '</button>' +
            '</div>' +
            '<nav class="admin-sidebar-nav">' +
                '<div class="admin-nav-section">Management</div>' +
                navItems +
            '</nav>' +
            '<div class="admin-sidebar-footer">' +
                '<div class="admin-user-info">' +
                    '<div class="admin-user-avatar">'+userInitial+'</div>' +
                    '<div class="admin-user-details">' +
                        '<div class="admin-user-name">'+esc(userName)+'</div>' +
                        '<div class="admin-user-role">'+esc(userRole)+'</div>' +
                    '</div>' +
                    '<button class="admin-logout-btn" onclick="window._mwAdmin.logout()" title="Sign out">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>' +
                    '</button>' +
                '</div>' +
            '</div>' +
        '</aside>';
    }

    function renderDashboard(){
        if(state.loading.stats && !state.stats){
            return renderLoading();
        }
        if(!state.stats) return '<div class="admin-empty"><p>No stats available</p></div>';

        var c = state.stats.counts || {};
        var statsHtml = '<div class="admin-stats-grid admin-animate">' +
            renderStatCard('Figures', c.figures, 'figures', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>') +
            renderStatCard('Manufacturers', c.manufacturers, 'manufacturers', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>') +
            renderStatCard('Series', c.series, 'series', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>') +
            renderStatCard('Users', c.users, 'users', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>') +
        '</div>';

        var recentHtml = '';
        if(state.stats.recentFigures && state.stats.recentFigures.length > 0){
            recentHtml = '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">Recent Figures</div></div><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Name</th><th>Slug</th><th>Added</th></tr></thead><tbody>';
            state.stats.recentFigures.forEach(function(f){
                recentHtml += '<tr><td><a href="'+HOME_URL+'figure/'+esc(f.slug)+'/">'+esc(f.name || f.nameEn)+'</a></td><td style="font-family:var(--mw-font-mono);font-size:.8125rem;color:var(--mw-text-secondary)">'+esc(f.slug)+'</td><td>'+formatDate(f.createdAt)+'</td></tr>';
            });
            recentHtml += '</tbody></table></div></div>';
        }

        var upcomingHtml = '';
        if(state.stats.upcomingReleases && state.stats.upcomingReleases.length > 0){
            upcomingHtml = '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">Upcoming Releases</div></div><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Name</th><th>Release Date</th><th>Price</th></tr></thead><tbody>';
            state.stats.upcomingReleases.forEach(function(f){
                upcomingHtml += '<tr><td><a href="'+HOME_URL+'figure/'+esc(f.slug)+'/">'+esc(f.name || f.nameEn)+'</a></td><td>'+formatDate(f.releaseDate)+'</td><td>'+formatPrice(f.priceJpy)+'</td></tr>';
            });
            upcomingHtml += '</tbody></table></div></div>';
        }

        var topMfgHtml = '';
        if(state.stats.topManufacturers && state.stats.topManufacturers.length > 0){
            topMfgHtml = '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">Top Manufacturers</div></div><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Manufacturer</th><th>Figures</th></tr></thead><tbody>';
            state.stats.topManufacturers.forEach(function(m){
                topMfgHtml += '<tr><td><a href="'+HOME_URL+'manufacturer/'+esc(m.slug)+'/">'+esc(m.name)+'</a></td><td>'+formatNum(m._count?.figures)+'</td></tr>';
            });
            topMfgHtml += '</tbody></table></div></div>';
        }

        var moreStats = '<div class="admin-stats-grid admin-animate" style="grid-template-columns:repeat(4,1fr)">' +
            renderStatCard('Sculptors', c.sculptors, 'manufacturers', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>') +
            renderStatCard('Categories', c.categories, 'series', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>') +
            renderStatCard('Characters', c.characters, 'users', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>') +
            renderStatCard('Images', c.images, 'figures', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>') +
        '</div>';

        return statsHtml + moreStats + recentHtml + upcomingHtml + topMfgHtml;
    }

    function renderStatCard(label, value, iconClass, iconSvg){
        return '<div class="admin-stat-card">' +
            '<div class="admin-stat-icon '+iconClass+'">'+iconSvg+'</div>' +
            '<div class="admin-stat-value">'+formatNum(value)+'</div>' +
            '<div class="admin-stat-label">'+label+'</div>' +
        '</div>';
    }

    function renderFigures(){
        var content = '<div class="admin-search-bar">' +
            '<input type="text" class="admin-search-input" id="figures-search" placeholder="Search figures..." value="'+esc(state.figuresSearch)+'">' +
            '<button class="admin-btn admin-btn-primary admin-btn-sm" id="figures-search-btn">Search</button>' +
        '</div>';

        if(state.loading.figures && state.figures.length === 0){
            return content + renderLoading();
        }

        if(state.figures.length === 0){
            return content + '<div class="admin-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg><p>No figures found</p></div>';
        }

        content += '<div class="admin-card admin-animate"><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th></th><th>Name</th><th>Manufacturer</th><th>Scale</th><th>Price</th><th>Release</th><th>Actions</th></tr></thead><tbody>';

        state.figures.forEach(function(f){
            var thumb = '';
            if(f.images && f.images.length > 0){
                thumb = '<img class="admin-figure-thumb" src="'+esc(f.images[0].url || f.images[0])+'" alt="" loading="lazy">';
            } else {
                thumb = '<div class="admin-figure-thumb" style="display:flex;align-items:center;justify-content:center;font-size:.75rem;color:var(--mw-text-tertiary)">N/A</div>';
            }
            var mfg = f.manufacturer ? (f.manufacturer.name || '') : '';
            content += '<tr>' +
                '<td>'+thumb+'</td>' +
                '<td><a href="'+HOME_URL+'figure/'+esc(f.slug)+'/">'+esc(f.name || f.nameEn || f.slug)+'</a></td>' +
                '<td>'+esc(mfg)+'</td>' +
                '<td>'+esc(f.scale || '-')+'</td>' +
                '<td>'+formatPrice(f.priceJpy)+'</td>' +
                '<td>'+formatDate(f.releaseDate)+'</td>' +
                '<td><button class="admin-btn admin-btn-danger admin-btn-sm" data-delete-figure="'+f.id+'">Delete</button></td>' +
            '</tr>';
        });

        content += '</tbody></table></div>';

        if(state.figuresMeta && state.figuresMeta.totalPages > 1){
            content += '<div class="admin-card-footer"><div style="font-size:.8125rem;color:var(--mw-text-secondary)">'+formatNum(state.figuresMeta.total)+' figures</div><div class="admin-pagination">';
            if(state.figuresPage > 1){
                content += '<button class="admin-page-btn" data-figures-page="'+(state.figuresPage-1)+'">&larr;</button>';
            }
            var start = Math.max(1, state.figuresPage - 2);
            var end = Math.min(state.figuresMeta.totalPages, state.figuresPage + 2);
            for(var p = start; p <= end; p++){
                content += '<button class="admin-page-btn'+(p === state.figuresPage ? ' active' : '')+'" data-figures-page="'+p+'">'+p+'</button>';
            }
            if(state.figuresPage < state.figuresMeta.totalPages){
                content += '<button class="admin-page-btn" data-figures-page="'+(state.figuresPage+1)+'">&rarr;</button>';
            }
            content += '</div></div>';
        }

        content += '</div>';
        return content;
    }


    function compactPayload(value){
        if(Array.isArray(value)) return value.map(compactPayload);
        if(value && typeof value === 'object'){
            var out = {};
            Object.keys(value).forEach(function(k){
                if(k === 'contentBase64'){
                    out[k] = '[base64 omitted]';
                } else if(k === 'processedImages' && Array.isArray(value[k])){
                    out[k] = value[k].map(function(img){
                        var clone = compactPayload(img);
                        if(clone && typeof clone === 'object') clone.contentBase64 = '[base64 omitted]';
                        return clone;
                    });
                } else {
                    out[k] = compactPayload(value[k]);
                }
            });
            return out;
        }
        return value;
    }

    function payloadPreviewText(payload, limit){
        try { return JSON.stringify(compactPayload(payload)).slice(0, limit || 260); }
        catch(e){ return String(payload || '').slice(0, limit || 260); }
    }
    function renderReview(){
        var tabs = [
            ['pending', 'Pending'],
            ['needs_changes', 'Needs Changes'],
            ['approved', 'Approved'],
            ['rejected', 'Rejected'],
            ['applied', 'Applied'],
            ['failed', 'Failed'],
            ['resolved', 'Resolved']
        ];
        var content = '<div class="admin-search-bar" style="justify-content:space-between">' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
                tabs.map(function(t){
                    return '<button class="admin-btn admin-btn-sm'+(state.reviewStatus === t[0] ? ' admin-btn-primary' : '')+'" data-review-filter="'+t[0]+'">'+t[1]+'</button>';
                }).join('') +
            '</div>' +
            '<button class="admin-btn admin-btn-sm" id="review-refresh-btn">Refresh</button>' +
        '</div>';

        if(state.loading.review && state.reviewItems.length === 0){
            return content + renderLoading();
        }

        if(state.reviewItems.length === 0){
            return content + '<div class="admin-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><p>No review items</p></div>';
        }

        content += '<div class="admin-card admin-animate"><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Type</th><th>Title</th><th>Confidence</th><th>Candidate</th><th>Source</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
        state.reviewItems.forEach(function(item){
            var payload = item.payload || {};
            var candidate = '';
            if(item.type === 'jan_match'){
                candidate = '<div style="font-size:.875rem">' +
                    '<strong>'+esc(payload.janCode || '-')+'</strong>' +
                    '<div style="color:var(--mw-text-secondary);max-width:360px;white-space:normal">'+esc(payload.hobbySearchName || '')+'</div>' +
                    '<div style="color:var(--mw-text-tertiary)">HS #'+esc(payload.hobbySearchId || '-')+'</div>' +
                '</div>';
            } else if(item.type === 'rewrite'){
                candidate = '<div style="max-width:420px;white-space:normal;color:var(--mw-text-secondary)">'+esc((payload.summaryMd || payload.contentMd || '').slice(0, 240))+'</div>';
            } else if(item.type === 'figure_import'){
                candidate = '<div style="font-size:.875rem">' +
                    '<strong>'+esc(payload.name || payload.slug || '-')+'</strong>' +
                    '<div style="color:var(--mw-text-secondary)">JAN: '+esc(payload.janCode || '-')+'</div>' +
                '</div>';
            } else if(item.type === 'image' || item.type === 'image_review'){
                var imgSrc = item.figureSlug ? '/api/v1/admin/review/image-proxy?url=' + encodeURIComponent(payload.source || '') : '';
                candidate = '<div style="display:flex;align-items:center;gap:8px">';
                if(payload.source) candidate += '<img src="'+esc(imgSrc)+'" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:var(--mw-bg-alt)" onerror="this.style.display=\'none\'">';
                candidate += '<span style="font-size:.75rem;color:var(--mw-text-secondary)">'+esc(payload.source || payload.url || '')+'</span></div>';
            } else {
                candidate = '<code style="font-size:.75rem;white-space:normal">'+esc(payloadPreviewText(payload, 260))+'</code>';
            }
            var figureLink = item.figureSlug ? '<div><a href="'+HOME_URL+'figure/'+esc(item.figureSlug)+'/">'+esc(item.figureSlug)+'</a></div>' : '';
            var confidence = item.confidence == null ? '-' : Math.round(Number(item.confidence) * 100) + '%';
            var canApply = item.type === 'jan_match' || item.type === 'rewrite' || item.type === 'figure_import' || item.type === 'image';
            var statusBadge = 'admin-badge-' + (item.status === 'pending' ? 'queued' : item.status === 'approved' ? 'active' : item.status === 'rejected' ? 'error' : item.status === 'applied' || item.status === 'resolved' ? 'completed' : item.status === 'failed' ? 'error' : 'queued');
            content += '<tr>' +
                '<td><span class="admin-badge admin-badge-queued">'+esc(item.type)+'</span></td>' +
                '<td><strong>'+esc(item.title)+'</strong>'+figureLink+'<div style="color:var(--mw-text-tertiary);font-size:.75rem">'+formatDate(item.createdAt)+'</div></td>' +
                '<td>'+confidence+'</td>' +
                '<td>'+candidate+'</td>' +
                '<td>'+esc(item.source || item.automation?.provider || '-')+'</td>' +
                '<td><span class="admin-badge '+statusBadge+'">'+esc(item.status)+'</span></td>' +
                '<td style="white-space:nowrap">';
            if(item.status === 'pending' || item.status === 'needs_changes'){
                content += '<button class="admin-btn admin-btn-success admin-btn-sm" data-review-action="'+esc(item.id)+'" data-review-status="'+(canApply ? 'approved' : 'resolved')+'">'+(canApply ? 'Apply' : 'Resolve')+'</button> ' +
                    '<button class="admin-btn admin-btn-sm" data-review-action="'+esc(item.id)+'" data-review-status="needs_changes">Needs Changes</button> ' +
                    '<button class="admin-btn admin-btn-danger admin-btn-sm" data-review-action="'+esc(item.id)+'" data-review-status="rejected">Reject</button>';
            } else if(item.status === 'approved'){
                content += '<button class="admin-btn admin-btn-primary admin-btn-sm" data-review-action="'+esc(item.id)+'" data-review-status="approved">Apply Now</button>';
            } else {
                content += '<span style="color:var(--mw-text-tertiary);font-size:.8125rem">—</span>';
            }
            content += ' <button class="admin-btn admin-btn-sm admin-btn-outline" data-review-detail="'+esc(item.id)+'">Detail</button>';
            content += '</td></tr>';
        });
        content += '</tbody></table></div></div>';

        return content;
    }

    function renderImport(){
        var content = '<div class="admin-import-grid admin-animate">' +
            '<div class="admin-card">' +
                '<div class="admin-card-header"><div class="admin-card-title">MFC Import</div></div>' +
                '<div class="admin-card-body">' +
                    '<div class="admin-form-group">' +
                        '<label class="admin-form-label">MFC Item IDs</label>' +
                        '<input type="text" id="mfc-ids" class="admin-form-input" placeholder="e.g. 123456, 789012, 345678">' +
                    '</div>' +
                    '<button class="admin-btn admin-btn-primary" id="mfc-import-btn"' + (state.loading.mfcImport ? ' disabled' : '') + '>' +
                        (state.loading.mfcImport ? renderSpinner() : 'Import from MFC') +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="admin-card">' +
                '<div class="admin-card-header"><div class="admin-card-title">Batch Import</div></div>' +
                '<div class="admin-card-body">' +
                    '<div class="admin-form-group">' +
                        '<label class="admin-form-label">JSON Data</label>' +
                        '<textarea id="batch-json" class="admin-form-textarea" placeholder=\'{"figures":[{"slug":"example-fig","name":"Example Figure","nameEn":"Example Figure","scale":"1/7","priceJpy":15000}]\'></textarea>' +
                    '</div>' +
                    '<button class="admin-btn admin-btn-primary" id="batch-import-btn"' + (state.loading.batchImport ? ' disabled' : '') + '>' +
                        (state.loading.batchImport ? renderSpinner() : 'Batch Import') +
                    '</button>' +
                '</div>' +
            '</div>' +
        '</div>';

        content += '<div class="admin-card admin-animate" style="margin-top:24px">' +
            '<div class="admin-card-header"><div class="admin-card-title">Import Queue Status</div>' +
            '<button class="admin-btn admin-btn-sm" id="refresh-import-status">Refresh</button></div>' +
            '<div class="admin-card-body">';

        if(state.loading.importStatus && !state.importStatus){
            content += renderLoading();
        } else if(state.importStatus){
            var s = state.importStatus;
            content += '<dl class="admin-import-status">' +
                '<dt>Queue Length</dt><dd>'+formatNum(s.queueLength)+'</dd>' +
                '<dt>Processing</dt><dd>'+(s.isProcessing ? '<span class="admin-badge admin-badge-queued">Yes</span> ' + esc(s.currentJob?.itemId || '') : '<span class="admin-badge admin-badge-completed">Idle</span>')+'</dd>' +
            '</dl>';

            if(s.recentImports && s.recentImports.length > 0){
                content += '<div style="margin-top:16px"><h4 style="font-family:var(--mw-font-body);font-size:.8125rem;font-weight:600;text-transform:uppercase;letter-spacing:0;color:var(--mw-text-secondary);margin-bottom:8px">Recent Imports</h4>';
                s.recentImports.forEach(function(r){
                    var badgeClass = r.status === 'completed' || r.status === 'created' ? 'completed' : r.status === 'error' ? 'error' : 'queued';
                    content += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:.875rem"><span class="admin-badge admin-badge-'+badgeClass+'">'+esc(r.status)+'</span> <span style="color:var(--mw-text-secondary)">Item #'+esc(r.itemId)+'</span></div>';
                });
                content += '</div>';
            }
        } else {
            content += '<div class="admin-empty"><p>No import status available</p></div>';
        }

        content += '</div></div>';
        return content;
    }

    function renderCrawler(){
        var content = '<div class="admin-crawler-grid admin-animate">' +
            '<div class="admin-crawler-card">' +
                '<h4>Kuro - Latest</h4>' +
                '<p>Import latest figures from Kuro</p>' +
                '<button class="admin-btn admin-btn-primary admin-btn-sm" id="crawler-kuro-latest"' + (state.loading.crawler_kuro_latest ? ' disabled' : '') + '>' +
                    (state.loading.crawler_kuro_latest ? renderSpinner() : 'Run') +
                '</button>' +
            '</div>' +
            '<div class="admin-crawler-card">' +
                '<h4>Kuro - Trending</h4>' +
                '<p>Import trending figures from Kuro</p>' +
                '<button class="admin-btn admin-btn-primary admin-btn-sm" id="crawler-kuro-trending"' + (state.loading.crawler_kuro_trending ? ' disabled' : '') + '>' +
                    (state.loading.crawler_kuro_trending ? renderSpinner() : 'Run') +
                '</button>' +
            '</div>' +
            '<div class="admin-crawler-card">' +
                '<h4>Kuro - Releases</h4>' +
                '<p>Import new releases from Kuro</p>' +
                '<button class="admin-btn admin-btn-primary admin-btn-sm" id="crawler-kuro-releases"' + (state.loading.crawler_kuro_releases ? ' disabled' : '') + '>' +
                    (state.loading.crawler_kuro_releases ? renderSpinner() : 'Run') +
                '</button>' +
            '</div>' +
        '</div>';

        content += '<div class="admin-card admin-animate">' +
            '<div class="admin-card-header"><div class="admin-card-title">AmiAmi Search</div></div>' +
            '<div class="admin-card-body">' +
                '<div class="admin-search-bar">' +
                    '<input type="text" class="admin-search-input" id="crawler-search-query" placeholder="Search AmiAmi...">' +
                    '<button class="admin-btn admin-btn-primary admin-btn-sm" id="crawler-search"' + (state.loading.crawler_search ? ' disabled' : '') + '>' +
                        (state.loading.crawler_search ? renderSpinner() : 'Search & Import') +
                    '</button>' +
                '</div>' +
            '</div>' +
        '</div>';

        content += '<div class="admin-card admin-animate">' +
            '<div class="admin-card-header"><div class="admin-card-title">Crawler Info</div></div>' +
            '<div class="admin-card-body">' +
                '<div class="admin-alert admin-alert-info">The crawler runs as a Python script on the server. Triggering these actions will queue import jobs. Check the Import section for queue status.</div>' +
            '</div>' +
        '</div>';

        return content;
    }

    function renderCache(){
        return '<div class="admin-card admin-animate">' +
            '<div class="admin-card-header"><div class="admin-card-title">Cache Management</div></div>' +
            '<div class="admin-card-body">' +
                '<div class="admin-alert admin-alert-warning">Purging cache will clear all cached API responses. The cache will rebuild as requests come in.</div>' +
                '<button class="admin-btn admin-btn-danger" id="cache-purge-btn"' + (state.loading.cachePurge ? ' disabled' : '') + '>' +
                    (state.loading.cachePurge ? renderSpinner() : 'Purge All Cache') +
                '</button>' +
            '</div>' +
        '</div>';
    }

    function renderUsers(){
        if(state.loading.users && state.users.length === 0){
            return renderLoading();
        }

        if(state.users.length === 0){
            return '<div class="admin-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><p>No users found</p></div>';
        }

        var content = '<div class="admin-card admin-animate"><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>Email</th><th>Display Name</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead><tbody>';

        state.users.forEach(function(u){
            var knownRoles = {admin:1, editor:1, viewer:1};
            var roleBadge = knownRoles[u.role] ? ('admin-badge-' + u.role) : 'admin-badge-viewer';
            var statusBadge = u.isActive ? 'admin-badge-active' : 'admin-badge-inactive';
            var statusText = u.isActive ? 'Active' : 'Inactive';
            content += '<tr>' +
                '<td>'+esc(u.email)+'</td>' +
                '<td>'+esc(u.displayName || '-')+'</td>' +
                '<td><span class="admin-badge '+roleBadge+'">'+esc(u.role)+'</span></td>' +
                '<td><span class="admin-badge '+statusBadge+'">'+statusText+'</span></td>' +
                '<td>'+formatDate(u.createdAt)+'</td>' +
                '<td>' +
                    '<select class="admin-form-input" style="width:auto;padding:4px 8px;font-size:.8125rem" data-user-role="'+u.id+'">' +
                        '<option value="admin"'+(u.role==='admin'?' selected':'')+'>Admin</option>' +
                        '<option value="editor"'+(u.role==='editor'?' selected':'')+'>Editor</option>' +
                        '<option value="viewer"'+(u.role==='viewer'?' selected':'')+'>Viewer</option>' +
                    '</select>' +
                '</td>' +
            '</tr>';
        });

        content += '</tbody></table></div></div>';
        return content;
    }

    function renderApp(){
        if(!state.token){
            return renderLogin();
        }

        var modalHtml = '';
        if(state.reviewDetail){
            modalHtml = renderReviewDetail();
        }

        var sectionContent = '';
        switch(state.activeSection){
            case 'dashboard': sectionContent = renderDashboard(); break;
            case 'figures': sectionContent = renderFigures(); break;
            case 'review': sectionContent = renderReview(); break;
            case 'import': sectionContent = renderImport(); break;
            case 'crawler': sectionContent = renderCrawler(); break;
            case 'cache': sectionContent = renderCache(); break;
            case 'users': sectionContent = renderUsers(); break;
            default: sectionContent = renderDashboard();
        }

        var topbarTitle = SECTIONS.find(function(s){return s.id === state.activeSection;});
        topbarTitle = topbarTitle ? topbarTitle.label : 'Dashboard';

        return renderSidebar() +
            '<div class="admin-overlay" onclick="window._mwAdmin.closeMobileSidebar()"></div>' +
            '<div class="admin-main">' +
                '<div class="admin-topbar">' +
                    '<div style="display:flex;align-items:center;gap:12px">' +
                        '<button class="admin-mobile-toggle" onclick="window._mwAdmin.openMobileSidebar()">' +
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>' +
                        '</button>' +
                        '<div class="admin-topbar-title">'+topbarTitle+'</div>' +
                    '</div>' +
                    '<div class="admin-topbar-actions">' +
                        '<a href="'+HOME_URL+'" class="admin-btn admin-btn-sm" target="_blank">View Site</a>' +
                    '</div>' +
                '</div>' +
                '<div class="admin-content">' +
                    renderAlerts() +
                    sectionContent +
                '</div>' +
            '</div>' +
            modalHtml;
    }

    function render(){
        var app = document.getElementById('admin-app');
        app.innerHTML = renderApp();
        bindEvents();
    }

    function bindEvents(){
        var loginForm = document.getElementById('login-form');
        if(loginForm){
            loginForm.addEventListener('submit', handleLogin);
        }

        var togglePw = document.getElementById('login-toggle-pw');
        var pwInput = document.getElementById('login-password');
        if(togglePw && pwInput){
            togglePw.addEventListener('click', function(){
                var isPassword = pwInput.type === 'password';
                pwInput.type = isPassword ? 'text' : 'password';
                togglePw.innerHTML = isPassword
                    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
                    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            });
        }

        var navItems = document.querySelectorAll('.admin-nav-item[data-section]');
        navItems.forEach(function(btn){
            btn.addEventListener('click', function(){
                switchSection(this.getAttribute('data-section'));
            });
        });

        var searchBtn = document.getElementById('figures-search-btn');
        var searchInput = document.getElementById('figures-search');
        if(searchBtn){
            searchBtn.addEventListener('click', function(){
                state.figuresSearch = searchInput.value;
                state.figuresPage = 1;
                loadFigures();
            });
        }
        if(searchInput){
            searchInput.addEventListener('keydown', function(e){
                if(e.key === 'Enter'){
                    state.figuresSearch = searchInput.value;
                    state.figuresPage = 1;
                    loadFigures();
                }
            });
        }

        var deleteBtns = document.querySelectorAll('[data-delete-figure]');
        deleteBtns.forEach(function(btn){
            btn.addEventListener('click', function(){
                handleDeleteFigure(this.getAttribute('data-delete-figure'));
            });
        });

        var pageBtns = document.querySelectorAll('[data-figures-page]');
        pageBtns.forEach(function(btn){
            btn.addEventListener('click', function(){
                state.figuresPage = parseInt(this.getAttribute('data-figures-page'), 10);
                loadFigures();
            });
        });

        var reviewFilters = document.querySelectorAll('[data-review-filter]');
        reviewFilters.forEach(function(btn){
            btn.addEventListener('click', function(){
                state.reviewStatus = this.getAttribute('data-review-filter');
                loadReviewItems();
            });
        });

        var reviewRefresh = document.getElementById('review-refresh-btn');
        if(reviewRefresh) reviewRefresh.addEventListener('click', loadReviewItems);

        var reviewActions = document.querySelectorAll('[data-review-action]');
        reviewActions.forEach(function(btn){
            btn.addEventListener('click', function(){
                var id = this.getAttribute('data-review-action');
                var status = this.getAttribute('data-review-status');
                state.reviewDetail = null;
                handleReviewStatus(id, status);
            });
        });

        var reviewDetailBtns = document.querySelectorAll('[data-review-detail]');
        reviewDetailBtns.forEach(function(btn){
            btn.addEventListener('click', function(){
                var id = this.getAttribute('data-review-detail');
                loadReviewDetail(id);
            });
        });

        var reviewDetailClose = document.getElementById('review-detail-close');
        if(reviewDetailClose){
            reviewDetailClose.addEventListener('click', function(){
                state.reviewDetail = null;
                render();
            });
        }

        var mfcImportBtn = document.getElementById('mfc-import-btn');
        if(mfcImportBtn) mfcImportBtn.addEventListener('click', handleMfcImport);

        var batchImportBtn = document.getElementById('batch-import-btn');
        if(batchImportBtn) batchImportBtn.addEventListener('click', handleBatchImport);

        var refreshImportBtn = document.getElementById('refresh-import-status');
        if(refreshImportBtn) refreshImportBtn.addEventListener('click', loadImportStatus);

        var cachePurgeBtn = document.getElementById('cache-purge-btn');
        if(cachePurgeBtn) cachePurgeBtn.addEventListener('click', handleCachePurge);

        var crawlerLatest = document.getElementById('crawler-kuro-latest');
        if(crawlerLatest) crawlerLatest.addEventListener('click', function(){handleCrawlerTrigger('kuro-latest');});

        var crawlerTrending = document.getElementById('crawler-kuro-trending');
        if(crawlerTrending) crawlerTrending.addEventListener('click', function(){handleCrawlerTrigger('kuro-trending');});

        var crawlerReleases = document.getElementById('crawler-kuro-releases');
        if(crawlerReleases) crawlerReleases.addEventListener('click', function(){handleCrawlerTrigger('kuro-releases');});

        var crawlerSearch = document.getElementById('crawler-search');
        if(crawlerSearch) crawlerSearch.addEventListener('click', function(){handleCrawlerTrigger('search');});

        var userRoleSelects = document.querySelectorAll('[data-user-role]');
        userRoleSelects.forEach(function(sel){
            sel.addEventListener('change', function(){
                handleUpdateUser(this.getAttribute('data-user-role'), 'role', this.value);
            });
        });
    }

    window._mwAdmin = {
        logout: logout,
        toggleTheme: toggleTheme,
        closeMobileSidebar: closeMobileSidebar,
        openMobileSidebar: openMobileSidebar
    };

    render();

    if(state.token){
        api('/auth/me', 'GET', null, true).then(function(r){
            if(!r.success){
                logout();
            } else {
                state.user = r.data;
                sessionStorage.setItem('mw_admin_user', JSON.stringify(r.data));
                render();
                loadStats();
            }
        }).catch(function(){
            logout();
        });
    }
})();

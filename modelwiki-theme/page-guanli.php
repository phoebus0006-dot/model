<?php
// Allow standalone mode (MW_ADMIN_STANDALONE env var set by nginx /admin/ location)
// to bypass the ABSPATH guard, since /admin/ is served directly by PHP-FPM without WordPress loading.
if (!defined('ABSPATH') && empty($_SERVER['MW_ADMIN_STANDALONE']) && !getenv('MW_ADMIN_STANDALONE')) exit;
/**
 * 管理后台单页应用 (SPA)
 * ======================
 *
 * URL: /guanli/
 *
 * 这是一个纯客户端渲染的管理界面，PHP 只负责输出 HTML 骨架和 JSON 初始数据。
 * 所有 CRUD 操作通过 admin.js 调用 API 完成。
 *
 * 安全：
 *   - PHP 端只输出 HTML，不暴露敏感数据
 *   - 认证完全由 API 端处理（JWT token）
 *   - 支持独立模式（MW_ADMIN_STANDALONE 环境变量）用于本地开发
 *
 * @package ModelWiki
 * @since   2.0.0
 * @version 3.7.0
 */
$is_standalone = !empty($_SERVER['MW_ADMIN_STANDALONE']) || getenv('MW_ADMIN_STANDALONE');
if ($is_standalone) {
    // In standalone mode WordPress is NOT loaded, so provide minimal fallbacks for WP helper functions
    // used later in this template (esc_attr, esc_url, sanitize_text_field, get_template_directory_uri).
    if (!function_exists('esc_attr')) {
        function esc_attr($text) { return htmlspecialchars((string)$text, ENT_QUOTES, 'UTF-8'); }
    }
    if (!function_exists('esc_html')) {
        function esc_html($text) { return htmlspecialchars((string)$text, ENT_QUOTES, 'UTF-8'); }
    }
    if (!function_exists('esc_url')) {
        function esc_url($url) { return htmlspecialchars((string)$url, ENT_QUOTES, 'UTF-8'); }
    }
    if (!function_exists('sanitize_text_field')) {
        function sanitize_text_field($value) { return trim(strip_tags((string)$value)); }
    }
    if (!function_exists('get_template_directory_uri')) {
        function get_template_directory_uri() { return '/wp-content/themes/modelwiki'; }
    }
    $api_base = '/api/v1';
    $theme = isset($_COOKIE['mw_theme']) ? sanitize_text_field($_COOKIE['mw_theme']) : 'light';
    $home_url = '/';
} else {
    $mw_api_url = function_exists('get_option') ? get_option('mw_api_url', '/api/v1') : '/api/v1';
    if (strpos($mw_api_url, 'http://api:') === 0 || strpos($mw_api_url, 'http://127.') === 0) {
        $mw_api_url = '/api/v1';
    }
    $api_base = $mw_api_url;
    $theme = function_exists('get_theme_mod') ? esc_attr(get_theme_mod('mw_theme', 'light')) : 'light';
    $home_url = function_exists('home_url') ? home_url('/') : '/';
}
?>
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>ModelWiki 管理中心</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
    --mw-primary:#0F172A;
    --mw-primary-light:#1E293B;
    --mw-primary-lighter:#334155;
    --mw-accent:#E8553D;
    --mw-accent-hover:#D64429;
    --mw-accent-soft:rgba(232,85,61,0.08);
    --mw-bg:#FAFAF9;
    --mw-bg-alt:#F1F5F9;
    --mw-card:#FFFFFF;
    --mw-card-hover:#FEFEFE;
    --mw-text:#1E293B;
    --mw-text-secondary:#64748B;
    --mw-text-tertiary:#94A3B8;
    --mw-border:#E2E8F0;
    --mw-border-light:#F1F5F9;
    --mw-success:#10B981;
    --mw-success-soft:rgba(16,185,129,0.1);
    --mw-warning:#F59E0B;
    --mw-warning-soft:rgba(245,158,11,0.1);
    --mw-error:#EF4444;
    --mw-error-soft:rgba(239,68,68,0.1);
    --mw-shadow-sm:0 1px 2px rgba(15,23,42,0.04);
    --mw-shadow:0 4px 6px -1px rgba(15,23,42,0.06);
    --mw-shadow-lg:0 10px 15px -3px rgba(15,23,42,0.07);
    --mw-radius-sm:6px;--mw-radius:10px;--mw-radius-lg:16px;--mw-radius-full:9999px;
    --mw-transition:0.2s cubic-bezier(0.4,0,0.2,1);
    color-scheme:light dark
}
[data-theme="dark"]{
    --mw-bg:#0B0F1A;--mw-bg-alt:#111827;--mw-card:#1A1F2E;--mw-card-hover:#1E2435;
    --mw-text:#F1F5F9;--mw-text-secondary:#94A3B8;--mw-text-tertiary:#64748B;
    --mw-border:#1E293B;--mw-border-light:#1A1F2E;
    --mw-accent-soft:rgba(232,85,61,0.15);--mw-success-soft:rgba(16,185,129,0.15);
    --mw-warning-soft:rgba(245,158,11,0.15);--mw-error-soft:rgba(239,68,68,0.15);
    --mw-shadow-sm:0 1px 2px rgba(0,0,0,0.2);--mw-shadow:0 4px 6px -1px rgba(0,0,0,0.3)
}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
    font-size:1rem;line-height:1.6;color:var(--mw-text);background:var(--mw-bg);
    -webkit-font-smoothing:antialiased;transition:background var(--mw-transition),color var(--mw-transition)
}
a{color:var(--mw-accent);text-decoration:none}
a:hover{color:var(--mw-accent-hover)}
button{cursor:pointer;font-family:inherit}
input,select,textarea{font-family:inherit;font-size:inherit}
h1,h2,h3,h4{font-weight:600;line-height:1.2;color:var(--mw-text)}
h1{font-size:2rem}h3{font-size:1.25rem}

.admin-layout{display:flex;min-height:100vh}
.admin-sidebar{
    width:260px;background:var(--mw-primary);color:#fff;display:flex;flex-direction:column;
    position:fixed;top:0;left:0;bottom:0;z-index:50;transition:transform var(--mw-transition)
}
[data-theme="dark"] .admin-sidebar{background:var(--mw-card);border-right:1px solid var(--mw-border)}
.admin-sidebar-brand{
    padding:20px 24px;border-bottom:1px solid rgba(255,255,255,0.06);
    display:flex;align-items:center;justify-content:space-between
}
.admin-sidebar-brand a{font-size:1.25rem;font-weight:700;color:#fff}
.admin-sidebar-brand a:hover{opacity:.85}
.admin-sidebar-theme{
    background:none;border:1px solid rgba(255,255,255,0.1);border-radius:var(--mw-radius-sm);
    color:rgba(255,255,255,0.6);padding:6px;width:32px;height:32px;
    display:flex;align-items:center;justify-content:center
}
.admin-sidebar-theme:hover{color:#fff;background:rgba(255,255,255,0.08)}
.admin-sidebar-theme svg{width:16px;height:16px}
.admin-sidebar-theme .icon-moon{display:none}
[data-theme="dark"] .admin-sidebar-theme .icon-moon{display:block}
[data-theme="dark"] .admin-sidebar-theme .icon-sun{display:none}
.admin-sidebar-nav{flex:1;padding:12px;overflow-y:auto}
.admin-nav-section{
    font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;
    color:rgba(255,255,255,0.35);padding:16px 12px 8px
}
.admin-nav-item{
    display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--mw-radius-sm);
    color:rgba(255,255,255,0.65);font-size:.875rem;font-weight:500;
    transition:all var(--mw-transition);cursor:pointer;border:none;background:none;width:100%;text-align:left
}
.admin-nav-item:hover{color:#fff;background:rgba(255,255,255,0.08)}
.admin-nav-item.active{color:#fff;background:var(--mw-accent)}
.admin-nav-item svg{width:18px;height:18px;flex-shrink:0}
.admin-sidebar-footer{padding:16px;border-top:1px solid rgba(255,255,255,0.06)}
.admin-user-info{display:flex;align-items:center;gap:10px;padding:8px;border-radius:var(--mw-radius-sm)}
.admin-user-avatar{
    width:36px;height:36px;border-radius:var(--mw-radius-full);background:var(--mw-accent);
    display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.875rem;flex-shrink:0
}
.admin-user-details{flex:1;min-width:0}
.admin-user-name{font-size:.875rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.admin-user-role{font-size:.75rem;color:rgba(255,255,255,0.45)}
.admin-logout-btn{background:none;border:none;color:rgba(255,255,255,0.45);padding:6px;border-radius:var(--mw-radius-sm);display:flex}
.admin-logout-btn:hover{color:var(--mw-error)}
.admin-logout-btn svg{width:18px;height:18px}

.admin-main{flex:1;margin-left:260px;min-height:100vh}
.admin-topbar{
    height:64px;background:var(--mw-card);border-bottom:1px solid var(--mw-border);
    display:flex;align-items:center;justify-content:space-between;padding:0 32px;position:sticky;top:0;z-index:40
}
.admin-topbar-title{font-size:1.125rem;font-weight:600}
.admin-topbar-actions{display:flex;gap:12px}
.admin-mobile-toggle{display:none;background:none;border:none;color:var(--mw-text);padding:8px}
.admin-mobile-toggle svg{width:22px;height:22px}
.admin-content{padding:32px}

.admin-login-wrapper{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--mw-bg);padding:24px}
.admin-login-card{
    width:100%;max-width:420px;background:var(--mw-card);border:1px solid var(--mw-border);
    border-radius:var(--mw-radius-lg);padding:40px;box-shadow:var(--mw-shadow-lg)
}
.admin-login-logo{font-size:2rem;font-weight:700;text-align:center;margin-bottom:4px;color:var(--mw-text)}
.admin-login-subtitle{text-align:center;color:var(--mw-text-secondary);font-size:.875rem;margin-bottom:32px}
.admin-form-group{margin-bottom:20px}
.admin-form-label{
    display:block;font-size:.8125rem;font-weight:600;color:var(--mw-text-secondary);
    margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em
}
.admin-form-input-wrapper{position:relative}
.admin-form-input{
    width:100%;padding:10px 40px 10px 14px;border:1px solid var(--mw-border);border-radius:var(--mw-radius-sm);
    background:var(--mw-bg);color:var(--mw-text);font-size:.9375rem;outline:none;
    transition:border-color var(--mw-transition),box-shadow var(--mw-transition)
}
.admin-form-input.no-icon{padding-right:14px}
.admin-form-input:focus{border-color:var(--mw-accent);box-shadow:0 0 0 3px var(--mw-accent-soft)}
.admin-form-input.error{border-color:var(--mw-error);box-shadow:0 0 0 3px var(--mw-error-soft)}
.admin-password-toggle{
    position:absolute;right:8px;top:50%;transform:translateY(-50%);
    background:none;border:none;color:var(--mw-text-tertiary);padding:4px;
    display:flex;align-items:center;justify-content:center;border-radius:4px
}
.admin-password-toggle:hover{color:var(--mw-text-secondary);background:var(--mw-bg-alt)}
.admin-password-toggle svg{width:18px;height:18px}
.admin-form-textarea{
    width:100%;padding:10px 14px;border:1px solid var(--mw-border);border-radius:var(--mw-radius-sm);
    background:var(--mw-bg);color:var(--mw-text);font-size:.8125rem;font-family:monospace;
    line-height:1.5;min-height:160px;resize:vertical;outline:none
}
.admin-form-textarea:focus{border-color:var(--mw-accent);box-shadow:0 0 0 3px var(--mw-accent-soft)}
.admin-btn{
    display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;
    border-radius:var(--mw-radius-sm);font-size:.875rem;font-weight:600;border:1px solid var(--mw-border);
    background:var(--mw-card);color:var(--mw-text);transition:all var(--mw-transition);white-space:nowrap
}
.admin-btn:hover{background:var(--mw-bg-alt)}
.admin-btn:disabled{opacity:.5;cursor:not-allowed}
.admin-btn-primary{background:var(--mw-accent);color:#fff;border-color:var(--mw-accent)}
.admin-btn-primary:hover{background:var(--mw-accent-hover)}
.admin-btn-danger{background:var(--mw-error);color:#fff;border-color:var(--mw-error)}
.admin-btn-danger:hover{background:#DC2626}
.admin-btn-sm{padding:6px 12px;font-size:.8125rem}
.admin-btn-block{width:100%}

.admin-stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-bottom:32px}
.admin-stat-card{background:var(--mw-card);border:1px solid var(--mw-border);border-radius:var(--mw-radius);padding:24px}
.admin-stat-card[data-section-target]{cursor:pointer;transition:border-color var(--mw-transition),transform var(--mw-transition),box-shadow var(--mw-transition)}
.admin-stat-card[data-section-target]:hover{border-color:var(--mw-accent);transform:translateY(-2px);box-shadow:var(--mw-shadow)}
.admin-stat-icon{width:40px;height:40px;border-radius:var(--mw-radius-sm);display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.admin-stat-icon svg{width:20px;height:20px}
.admin-stat-icon.figures{background:var(--mw-accent-soft);color:var(--mw-accent)}
.admin-stat-icon.manufacturers{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-stat-icon.series{background:var(--mw-warning-soft);color:var(--mw-warning)}
.admin-stat-icon.users{background:rgba(99,102,241,0.1);color:#6366F1}
.admin-stat-value{font-size:2rem;font-weight:700;line-height:1;margin-bottom:4px}
.admin-stat-label{font-size:.8125rem;color:var(--mw-text-secondary);font-weight:500}

.admin-card{background:var(--mw-card);border:1px solid var(--mw-border);border-radius:var(--mw-radius);margin-bottom:24px;overflow:hidden}
.admin-card-header{padding:20px 24px;border-bottom:1px solid var(--mw-border);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.admin-card-title{font-size:1rem;font-weight:600}
.admin-card-body{padding:24px}
.admin-card-footer{padding:16px 24px;border-top:1px solid var(--mw-border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}

.admin-table{width:100%;border-collapse:collapse}
.admin-table th{
    text-align:left;padding:12px 16px;font-size:.75rem;font-weight:600;text-transform:uppercase;
    letter-spacing:0.06em;color:var(--mw-text-secondary);background:var(--mw-bg-alt);border-bottom:1px solid var(--mw-border)
}
.admin-table td{padding:12px 16px;font-size:.875rem;border-bottom:1px solid var(--mw-border-light)}
.admin-table tr:last-child td{border-bottom:none}
.admin-table tr:hover td{background:var(--mw-bg-alt)}

.admin-badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:var(--mw-radius-full);font-size:.75rem;font-weight:600}
.admin-badge-admin{background:var(--mw-accent-soft);color:var(--mw-accent)}
.admin-badge-editor{background:var(--mw-warning-soft);color:var(--mw-warning)}
.admin-badge-viewer,.admin-badge-active,.admin-badge-completed,.admin-badge-created{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-badge-inactive,.admin-badge-error{background:var(--mw-error-soft);color:var(--mw-error)}
.admin-badge-queued{background:var(--mw-warning-soft);color:var(--mw-warning)}

.admin-search-bar{display:flex;gap:8px;margin-bottom:20px}
.admin-search-input{
    flex:1;padding:8px 14px;border:1px solid var(--mw-border);border-radius:var(--mw-radius-sm);
    background:var(--mw-bg);color:var(--mw-text);font-size:.875rem;outline:none
}
.admin-search-input:focus{border-color:var(--mw-accent);box-shadow:0 0 0 3px var(--mw-accent-soft)}

.admin-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.admin-form-grid .span-2{grid-column:1/-1}
.admin-inline-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.admin-link-btn{border:0;background:none;color:var(--mw-accent);font:inherit;font-weight:600;padding:0;cursor:pointer;text-align:left}
.admin-link-btn:hover{color:var(--mw-accent-hover);text-decoration:underline}
.admin-subtle{font-size:.8125rem;color:var(--mw-text-secondary)}
.admin-editor-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:20px;flex-wrap:wrap}
.admin-kv{display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:.8125rem}
.admin-kv dt{color:var(--mw-text-tertiary);font-weight:600}
.admin-kv dd{color:var(--mw-text-secondary);word-break:break-word}
.admin-review-card{border:1px solid var(--mw-border);border-radius:var(--mw-radius-sm);padding:12px;background:var(--mw-bg)}
.admin-review-card + .admin-review-card{margin-top:8px}
.admin-review-title{font-size:.8125rem;font-weight:700;margin-bottom:8px;color:var(--mw-text)}
.admin-review-problems{margin-top:10px;padding:10px 12px;border:1px solid rgba(239,68,68,0.25);background:var(--mw-error-soft);border-radius:var(--mw-radius-sm);color:var(--mw-error);font-size:.8125rem}
.admin-review-problems ul{margin:6px 0 0 18px}
.admin-review-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--mw-radius-full);background:var(--mw-bg-alt);color:var(--mw-text-secondary);font-size:.75rem;font-weight:600;margin:2px 4px 2px 0}
.admin-review-list{margin:0;padding-left:18px;font-size:.8125rem;color:var(--mw-text-secondary)}
.admin-review-section{border:1px solid var(--mw-border);border-radius:var(--mw-radius-sm);padding:10px 12px;margin-top:8px;background:var(--mw-card)}
.admin-review-section:first-child{margin-top:0}
.admin-review-section-title{font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--mw-text-tertiary);margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--mw-border-light)}
.admin-review-section-body{font-size:.8125rem;color:var(--mw-text-secondary)}
.admin-review-section-body .admin-kv{grid-template-columns:110px 1fr}
.admin-review-section-current{border-left:3px solid var(--mw-accent)}
.admin-review-section-candidate{border-left:3px solid #6366F1}
.admin-review-section-evidence{border-left:3px solid var(--mw-text-tertiary)}
.admin-review-section-decision{border-left:3px solid var(--mw-success)}

.admin-spinner{width:20px;height:20px;border:2px solid var(--mw-border);border-top-color:var(--mw-accent);border-radius:50%;animation:admin-spin 0.6s linear infinite}
@keyframes admin-spin{to{transform:rotate(360deg)}}
.admin-spinner-lg{width:40px;height:40px;border-width:3px}
.admin-loading{display:flex;align-items:center;justify-content:center;padding:48px}

.admin-alert{padding:12px 16px;border-radius:var(--mw-radius-sm);font-size:.875rem;font-weight:500;margin-bottom:16px;display:flex;align-items:flex-start;gap:8px;animation:admin-fade-in 0.2s ease;word-break:break-word}
.admin-alert-success{background:var(--mw-success-soft);color:#065f46;border:1px solid rgba(16,185,129,0.2)}
.admin-alert-error{background:var(--mw-error-soft);color:#991b1b;border:1px solid rgba(239,68,68,0.2)}
.admin-alert-warning{background:var(--mw-warning-soft);color:#92400e;border:1px solid rgba(245,158,11,0.2)}
.admin-alert-info{background:rgba(99,102,241,0.1);color:#3730a3;border:1px solid rgba(99,102,241,0.2)}
[data-theme="dark"] .admin-alert-success{color:#6ee7b7}
[data-theme="dark"] .admin-alert-error{color:#fca5a5}
[data-theme="dark"] .admin-alert-warning{color:#fcd34d}
[data-theme="dark"] .admin-alert-info{color:#a5b4fc}
.admin-alert svg{flex-shrink:0;margin-top:1px}

.admin-empty{text-align:center;padding:48px 24px;color:var(--mw-text-tertiary)}
.admin-empty svg{width:48px;height:48px;margin-bottom:16px;opacity:.4}

.admin-figure-thumb{width:40px;height:40px;border-radius:var(--mw-radius-sm);object-fit:cover;background:var(--mw-bg-alt)}

.admin-pagination{display:flex;justify-content:center;gap:4px;margin-top:20px}
.admin-page-btn{
    min-width:32px;height:32px;padding:0 8px;border:1px solid var(--mw-border);
    border-radius:var(--mw-radius-sm);background:var(--mw-card);color:var(--mw-text-secondary);font-size:.8125rem;font-weight:500;cursor:pointer
}
.admin-page-btn:hover,.admin-page-btn.active{background:var(--mw-accent);color:#fff;border-color:var(--mw-accent)}

.admin-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:45}
.admin-overlay.open{display:block}

.admin-modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;align-items:center;justify-content:center;padding:16px}
.admin-modal-overlay.open{display:flex}
.admin-modal{
    background:var(--mw-card);border-radius:var(--mw-radius-lg);padding:32px;max-width:480px;width:100%;
    box-shadow:var(--mw-shadow-lg);max-height:90vh;overflow-y:auto
}
.admin-modal-title{font-size:1.125rem;font-weight:600;margin-bottom:20px}
.admin-modal-actions{display:flex;gap:12px;justify-content:flex-end;margin-top:24px}

.admin-idle-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center}
.admin-idle-overlay.show{display:flex}
.admin-idle-card{
    background:var(--mw-card);border-radius:var(--mw-radius-lg);padding:40px;
    text-align:center;max-width:400px;width:90%;box-shadow:var(--mw-shadow-lg)
}
.admin-idle-card h3{margin-bottom:12px}
.admin-idle-card p{color:var(--mw-text-secondary);margin-bottom:24px;font-size:.875rem}

@keyframes admin-fade-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.admin-animate{animation:admin-fade-in 0.3s ease both}

@media(max-width:1024px){
    .admin-stats-grid{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:768px){
    .admin-sidebar{transform:translateX(-100%)}.admin-sidebar.open{transform:translateX(0)}
    .admin-main{margin-left:0}.admin-mobile-toggle{display:flex}.admin-content{padding:20px}.admin-topbar{padding:0 16px}
    .admin-stats-grid{grid-template-columns:1fr 1fr}
    .admin-form-grid{grid-template-columns:1fr}.admin-kv{grid-template-columns:1fr}
    .admin-modal{padding:24px;max-width:100%}
}
@media(max-width:640px){
    .admin-stats-grid{grid-template-columns:1fr}.admin-table th,.admin-table td{padding:8px 12px}
}
</style>
</head>
<body>
<div id="admin-app"></div>
<div id="idle-overlay" class="admin-idle-overlay"><div class="admin-idle-card admin-animate"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--mw-warning)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="var(--mw-warning)" stroke="none"/></svg><h3>会话已超时</h3><p>由于长时间无操作，您已被自动退出登录</p><button class="admin-btn admin-btn-primary" data-resume-session>重新登录</button></div></div>
<script>
    window.MW_API_BASE = "<?php echo esc_js($api_base); ?>";
    window.MW_THEME = "<?php echo esc_js($theme); ?>";
    window.MW_HOME_URL = "<?php echo esc_js($home_url); ?>";


(function(){
    var API_BASE = window.MW_API_BASE || '/api/v1';
    var HOME_URL = '/';
    var IDLE_TIMEOUT = 30 * 60 * 1000;

    var SECTIONS = [
        {id:'dashboard',label:'仪表盘',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'},
        {id:'figures',label:'手办管理',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>'},
        {id:'categories',label:'分类编辑',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'},
        {id:'manufacturers',label:'制造商编辑',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>'},
        {id:'series',label:'系列编辑',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>'},
        {id:'sculptors',label:'原型师编辑',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4-8 4-8-4 8-4z"/><path d="M4 11l8 4 8-4"/><path d="M4 15l8 4 8-4"/></svg>'},
        {id:'characters',label:'角色编辑',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>'},
        {id:'review',label:'人工复核',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'},
        {id:'cache',label:'缓存管理',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg>'},
        {id:'users',label:'用户管理',icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>'}
    ];
    var ROLES = {admin:'管理员',editor:'编辑',viewer:'访客',user:'用户'};
    var ROLE_OPTIONS = [{v:'admin',l:'Admin'},{v:'editor',l:'Editor'},{v:'viewer',l:'Viewer'}];
    var ENTITY_CONFIG = {
        categories:{label:'分类',endpoint:'/categories',fields:[
            {name:'slug',label:'Slug',required:true},{name:'name',label:'名称',required:true},
            {name:'parentId',label:'父分类 ID',type:'number'},{name:'sortOrder',label:'排序',type:'number'}
        ]},
        manufacturers:{label:'制造商',endpoint:'/manufacturers',fields:[
            {name:'slug',label:'Slug',required:true},{name:'name',label:'名称',required:true},
            {name:'nameJp',label:'日文名'},{name:'nameEn',label:'英文名'},{name:'country',label:'国家/地区'},
            {name:'website',label:'官网'},{name:'description',label:'说明',type:'textarea',wide:true}
        ]},
        series:{label:'系列',endpoint:'/series',fields:[
            {name:'slug',label:'Slug',required:true},{name:'name',label:'名称',required:true},
            {name:'nameJp',label:'日文名'},{name:'nameEn',label:'英文名'},{name:'mediaType',label:'媒体类型'},
            {name:'description',label:'说明',type:'textarea',wide:true}
        ]},
        sculptors:{label:'原型师',endpoint:'/sculptors',fields:[
            {name:'slug',label:'Slug',required:true},{name:'name',label:'名称',required:true},
            {name:'nameJp',label:'日文名'},{name:'nameEn',label:'英文名'},{name:'alias',label:'别名（逗号分隔）',type:'array',wide:true},
            {name:'styleTags',label:'风格标签（逗号分隔）',type:'array',wide:true},{name:'description',label:'说明',type:'textarea',wide:true}
        ]},
        characters:{label:'角色',endpoint:'/characters',fields:[
            {name:'slug',label:'Slug',required:true},{name:'name',label:'名称',required:true},
            {name:'nameJp',label:'日文名'},{name:'nameEn',label:'英文名'},{name:'seriesId',label:'所属系列 ID',type:'number'},
            {name:'description',label:'说明',type:'textarea',wide:true}
        ]}
    };
    var STAT_TARGETS = {figures:'figures',manufacturers:'manufacturers',series:'series',sculptors:'sculptors',categories:'categories',characters:'characters',users:'users',images:'figures'};

    var state = {
        token: sessionStorage.getItem('mw_admin_token') || null,
        user: JSON.parse(sessionStorage.getItem('mw_admin_user') || 'null'),
        activeSection: 'dashboard',
        stats: null, figures: [], figuresMeta: null, figuresSearch: '', figuresPage: 1,
        figureEditSlug: null, figureEdit: null,
        entities: {}, entityMeta: {}, entityPage: {}, entitySearch: {}, editingEntity: null,
        options: {manufacturers:[], series:[], categories:[], sculptors:[], characters:[]},
        reviewItems: [], reviewStatus: 'pending', reviewPage: 1, reviewTotal: 0, reviewEditId: null, reviewEditTitle: '',
        users: [], alerts: [], loading: {},
        loginError: null, loginUsername: '',
        showModal: null, idleTimer: null, idleTriggered: false,
        keepPendingId: null, keepPendingReason: '',
        newUserForm: {username:'',password:'',role:'viewer'},
        // Phase 3: action safety — inflight dedup keyed by `${id}:${action}`
        inflight: {},
        // AbortController per inflight review action, aborted on page switch
        reviewActionControllers: typeof Map !== 'undefined' ? new Map() : {},
        // Object URL cache keyed by remote URL (reused across re-renders, revoked on leaving review)
        reviewObjectUrls: {}
    };

    function resetIdle(){ if(state.token && !state.idleTriggered){ clearTimeout(state.idleTimer); state.idleTimer = setTimeout(idleLogout, IDLE_TIMEOUT); } }

    function idleLogout(){
        state.idleTriggered = true;
        document.getElementById('idle-overlay').classList.add('show');
    }

    function resumeSession(){
        state.idleTriggered = false;
        state.token = null; state.user = null; state.loginError = null; state.loginUsername = '';
        sessionStorage.removeItem('mw_admin_token'); sessionStorage.removeItem('mw_admin_user');
        document.getElementById('idle-overlay').classList.remove('show');
        render();
    }

    function api(endpoint, method, body, withAuth, signal){
        var opts = {method: method || 'GET', headers: {}};
        if(body !== undefined && body !== null) opts.headers['Content-Type'] = 'application/json';
        if(withAuth !== false && state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
        if(body !== undefined && body !== null) opts.body = JSON.stringify(body);
        if(signal) opts.signal = signal;
        return fetch(API_BASE + endpoint, opts).then(function(r){
            if(r.status === 401 && withAuth !== false){ logout(); throw new Error('Session expired'); }
            return r.json();
        });
    }

    function logout(){
        clearTimeout(state.idleTimer);
        state.token = null; state.user = null; state.idleTriggered = false;
        sessionStorage.removeItem('mw_admin_token'); sessionStorage.removeItem('mw_admin_user');
        render();
    }

    function addAlert(type, message){
        var id = Date.now(); state.alerts.push({type:type, message:message, id:id}); render();
        setTimeout(function(){ state.alerts = state.alerts.filter(function(a){return a.id !== id;}); render(); }, 6000);
    }

    function setLoading(key, val){ state.loading[key] = val; render(); }

    function switchSection(id){
        // Phase 3: on leaving review, abort stale review action requests and revoke object URLs
        if(state.activeSection === 'review' && id !== 'review'){
            abortReviewActions();
            revokeReviewObjectUrls();
        }
        state.activeSection = id; state.editingEntity = null; state.figureEditSlug = null; state.figureEdit = null; state.reviewEditId = null; state.reviewEditTitle = ''; render();
        if(id === 'dashboard') loadStats(); if(id === 'figures') loadFigures();
        if(ENTITY_CONFIG[id]) loadEntity(id);
        if(id === 'review') loadReviewItems();
        if(id === 'users') loadUsers();
        closeMobileSidebar();
    }

    function loadStats(){ setLoading('stats',true); api('/admin/stats').then(function(r){ if(r.success) state.stats = r.data; }).catch(function(){}).then(function(){ setLoading('stats', false); }); }
    function loadFigures(){
        setLoading('figures',true); var params = '?page='+state.figuresPage+'&perPage=20';
        if(state.figuresSearch) params += '&search=' + encodeURIComponent(state.figuresSearch);
        api('/figures' + params, 'GET', null, false).then(function(r){ if(r.success){ state.figures = r.data || []; state.figuresMeta = r.meta || null; } }).catch(function(){}).then(function(){ setLoading('figures', false); });
    }
    function loadReviewItems(){
        setLoading('review', true);
        var limit = 50;
        var offset = Math.max(0, ((state.reviewPage || 1) - 1)) * limit;
        var params = '?limit=' + limit + '&offset=' + offset;
        if(state.reviewStatus) params += '&status=' + encodeURIComponent(state.reviewStatus);
        api('/admin/review/items' + params).then(function(r){
            if(r.success){
                state.reviewItems = r.data || [];
                if(Number.isFinite(Number(r.meta.total))){
                    state.reviewTotal = Number(r.meta.total);
                } else if(state.reviewStats && Number.isFinite(Number(state.reviewStats.total))){
                    state.reviewTotal = Number(state.reviewStats.total);
                } else {
                    state.reviewTotal = r.data ? r.data.length : 0;
                }
                // Image count shown as ... (no per-item API calls)
            } else addAlert('error', getErrorMessage(r, '复核队列加载失败'));
        }).catch(function(){ addAlert('error','复核队列加载失败'); }).then(function(){ setLoading('review', false); });
    }

    // Phase 3: action safety helpers — inflight dedup, AbortController, object URL lifecycle
    function reviewActionKey(id, action){ return String(id) + ':' + String(action); }
    function isReviewActionInflight(id, action){ return !!state.inflight[reviewActionKey(id, action)]; }
    function abortReviewActions(){
        if(state.reviewActionControllers && typeof state.reviewActionControllers.forEach === 'function'){
            state.reviewActionControllers.forEach(function(ctrl, key){
                try { if(ctrl && typeof ctrl.abort === 'function') ctrl.abort(); } catch(e){}
            });
            state.reviewActionControllers.clear();
        }
        state.inflight = {};
    }
    function revokeReviewObjectUrls(){
        if(state.reviewObjectUrls){
            Object.keys(state.reviewObjectUrls).forEach(function(remoteUrl){
                try { URL.revokeObjectURL(state.reviewObjectUrls[remoteUrl]); } catch(e){}
            });
        }
        state.reviewObjectUrls = {};
    }

    // Unified review action handler with: double-click guard, inflight dedup (id+action),
    // AbortController (aborted on page switch), API call (no local spoofing), local item refresh on success.
    function handleReviewAction(id, action, opts){
        opts = opts || {};
        if(!id || !action) return;
        // Inflight dedup: same id+action already in flight — do not re-send
        if(isReviewActionInflight(id, action)) return;
        // Double-click guard: disable all action buttons for this item
        state.inflight[reviewActionKey(id, action)] = true;
        setLoading('reviewAction_' + id, true);

        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        if(controller && state.reviewActionControllers && typeof state.reviewActionControllers.set === 'function'){
            state.reviewActionControllers.set(reviewActionKey(id, action), controller);
        }

        var endpoint = action === 'approve_image'
            ? '/admin/review/items/' + encodeURIComponent(id) + '/apply'
            : '/admin/review/items/' + encodeURIComponent(id) + '/action';
        var body = action === 'approve_image' ? {action:'approve_image'} : {action: action};
        if(opts.notes) body.notes = opts.notes;

        var signal = controller ? controller.signal : undefined;
        var aborted = false;

        api(endpoint, 'POST', body, true, signal).then(function(r){
            if(r && r.success){
                var successMsg = opts.successMsg || ({
                    approve_image: '图片已批准为主图',
                    reject_image: '已拒绝候选图',
                    keep_placeholder: '已保留占位图',
                    request_refetch: '已请求重抓',
                    keep_pending: '已标记为无法判断，保留待审状态',
                    mark_detail_ok: '已确认详情无误',
                    mark_needs_manual_edit: '已标记需人工编辑'
                })[action] || '操作成功';
                addAlert('success', successMsg);
                if(opts.onSuccess) opts.onSuccess();
                // Refresh the page data (no full image re-fetch — object URL cache persists)
                loadReviewItems();
            } else if(r && r.error && r.error.code === 'VALIDATION_ERROR' && action === 'mark_needs_manual_edit'){
                // Backend schema may not yet include mark_needs_manual_edit — surface a clear message
                addAlert('warning', '后端暂不支持该操作（mark_needs_manual_edit），等待集成 Agent 补充');
            } else {
                addAlert('error', getErrorMessage(r, '操作失败'));
            }
        }).catch(function(err){
            if(err && (err.name === 'AbortError' || aborted)){ aborted = true; return; } // stale request aborted — silent
            addAlert('error', '操作请求失败');
        }).then(function(){
            delete state.inflight[reviewActionKey(id, action)];
            if(state.reviewActionControllers && typeof state.reviewActionControllers.delete === 'function'){
                state.reviewActionControllers.delete(reviewActionKey(id, action));
            }
            if(opts.onFinally) opts.onFinally();
            setLoading('reviewAction_' + id, false);
        });
    }
    function loadUsers(){ setLoading('users',true); api('/admin/users').then(function(r){ if(r.success) state.users = r.data || []; }).catch(function(){}).then(function(){ setLoading('users', false); }); }
    function loadEntity(section){
        var cfg = ENTITY_CONFIG[section]; if(!cfg) return;
        var page = state.entityPage[section] || 1;
        var params = section === 'categories' ? '' : '?page='+page+'&perPage=50';
        setLoading('entity_' + section, true);
        api(cfg.endpoint + params, 'GET', null, false).then(function(r){
            if(!r.success){ addAlert('error', cfg.label + '加载失败'); return; }
            state.entities[section] = section === 'categories' ? flattenCategories(r.data || []) : (r.data || []);
            state.entityMeta[section] = r.meta || null;
        }).catch(function(){ addAlert('error', cfg.label + '加载失败'); }).then(function(){ setLoading('entity_' + section, false); });
    }

    function loadOptions(){
        return Promise.all([
            api('/manufacturers?page=1&perPage=100', 'GET', null, false).then(function(r){ if(r.success) state.options.manufacturers = r.data || []; }),
            api('/series?page=1&perPage=100', 'GET', null, false).then(function(r){ if(r.success) state.options.series = r.data || []; }),
            api('/categories', 'GET', null, false).then(function(r){ if(r.success) state.options.categories = flattenCategories(r.data || []); })
        ]).catch(function(){});
    }

    function getErrorMessage(r, fallback){
        if(r && r.error && r.error.message) return r.error.message;
        if(r && r.error && r.error.code){
            var codes = {
                'INVALID_CREDENTIALS':'用户名或密码错误','NO_PASSWORD':'该账号未设置密码',
                'UNAUTHORIZED':'请先登录','INVALID_TOKEN':'登录已过期，请重新登录',
                'USER_NOT_FOUND':'用户不存在','VALIDATION_ERROR':'输入数据格式不正确',
                'RATE_LIMITED':'请求过于频繁，请稍后再试','INTERNAL_ERROR':'服务器内部错误',
                'WRONG_PASSWORD':'当前密码错误','EMAIL_EXISTS':'邮箱已被使用',
                'INVALID_ID':'参数错误'
            };
            return codes[r.error.code] || fallback || '操作失败';
        }
        return fallback || '操作失败';
    }

    function togglePassword(inputId, iconId){
        var input = document.getElementById(inputId); var icon = document.getElementById(iconId);
        if(!input || !icon) return;
        var isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        icon.innerHTML = isPassword
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    }

    function handleLogin(e){
        e.preventDefault();
        var username = document.getElementById('login-username').value.trim();
        var password = document.getElementById('login-password').value;
        state.loginError = null; state.loginUsername = username;
        if(!username){ state.loginError = '请输入用户名'; render(); return; }
        if(!password){ state.loginError = '请输入密码'; render(); return; }
        setLoading('login', true);
        api('/auth/login', 'POST', {username:username, password:password}, false).then(function(r){
            if(r.success){
                state.token = r.data.token; state.user = r.data.user; state.loginError = null; state.loginUsername = '';
                sessionStorage.setItem('mw_admin_token', r.data.token); sessionStorage.setItem('mw_admin_user', JSON.stringify(r.data.user));
                resetIdle(); loadStats(); render();
            } else { state.loginError = getErrorMessage(r, '登录失败'); }
        }).catch(function(err){ state.loginError = '网络错误，请检查网络连接后重试'; }).then(function(){ setLoading('login', false); });
    }

    function handleChangePassword(){
        var cp = document.getElementById('current-password').value;
        var np = document.getElementById('new-password').value;
        var nc = document.getElementById('new-password-confirm').value;
        if(!cp){ addAlert('error','请输入当前密码'); return; }
        if(!np || np.length < 8){ addAlert('error','新密码至少8个字符'); return; }
        if(np !== nc){ addAlert('error','两次输入的新密码不一致'); return; }
        setLoading('changePwd', true);
        api('/auth/password', 'PUT', {currentPassword:cp, newPassword:np}).then(function(r){
            if(r.success){ addAlert('success','密码修改成功'); closeModal(); }
            else addAlert('error', getErrorMessage(r, '密码修改失败'));
        }).catch(function(){ addAlert('error','密码修改失败，请稍后重试'); }).then(function(){ setLoading('changePwd', false); });
    }

    function handleResetPassword(userId){
        var np = prompt('请输入新密码（至少8个字符）：');
        if(!np) return; if(np.length < 8){ addAlert('error','新密码至少8个字符'); return; }
        setLoading('resetPwd_' + userId, true);
        api('/admin/users/' + userId + '/password', 'PUT', {newPassword:np}).then(function(r){
            if(r.success) addAlert('success','密码已重置'); else addAlert('error', getErrorMessage(r, '密码重置失败'));
        }).catch(function(){ addAlert('error','密码重置失败'); }).then(function(){ setLoading('resetPwd_' + userId, false); });
    }

    function showModal(type){ state.showModal = type; render(); }
    function closeModal(){ state.showModal = null; render(); }

    function handleCachePurge(){
        if(!confirm('确定要清除所有 Redis 缓存吗？清除后页面首次加载可能变慢。')) return;
        setLoading('cachePurge', true);
        api('/admin/cache/purge', 'POST', {purgeAll: true}).then(function(r){
            if(r.success) addAlert('success','缓存已清除'); else addAlert('error','清除缓存失败');
        }).catch(function(){ addAlert('error','清除缓存失败'); }).then(function(){ setLoading('cachePurge', false); });
    }

    function openFigureEditor(slug, reviewId, reviewTitle){
        if(!slug) return;
        state.activeSection = 'figures';
        state.figureEditSlug = slug; state.figureEdit = null;
        state.reviewEditId = reviewId || null; state.reviewEditTitle = reviewTitle || '';
        render();
        setLoading('figureEdit', true);
        Promise.all([
            api('/figures/' + encodeURIComponent(slug), 'GET', null, false),
            loadOptions()
        ]).then(function(results){
            var r = results[0];
            if(r && r.success) state.figureEdit = r.data;
            else { state.figureEditSlug = null; addAlert('error', getErrorMessage(r, '手办详情加载失败')); }
        }).catch(function(){ state.figureEditSlug = null; addAlert('error','手办详情加载失败'); }).then(function(){ setLoading('figureEdit', false); });
    }

    function closeFigureEditor(){
        var fromReview = !!state.reviewEditId;
        state.figureEditSlug = null; state.figureEdit = null; state.reviewEditId = null; state.reviewEditTitle = '';
        if(fromReview){ state.activeSection = 'review'; loadReviewItems(); }
        else render();
    }

    function readNumberField(id, nullable){
        var el = document.getElementById(id); if(!el) return undefined;
        var raw = el.value.trim(); if(raw === '') return nullable ? null : undefined;
        var num = Number(raw); return Number.isFinite(num) ? Math.trunc(num) : undefined;
    }

    function readStringField(id, nullable){
        var el = document.getElementById(id); if(!el) return undefined;
        var raw = el.value.trim(); return raw === '' ? (nullable ? null : undefined) : raw;
    }

    function readFigureForm(){
        var body = {};
        ['slug','name','nameJp','nameEn','scale','material','janCode','productLine','hobbySearchId','mfcId','ageRating','amiamiId','hljId'].forEach(function(k){
            var v = readStringField('fig-' + k, k !== 'slug' && k !== 'name');
            if(v !== undefined) body[k] = v;
        });
        ['priceJpy','heightMm','weightG','manufacturerId','seriesId'].forEach(function(k){
            var v = readNumberField('fig-' + k, true);
            if(v !== undefined) body[k] = v;
        });
        var rd = readStringField('fig-releaseDate', true); if(rd !== undefined) body.releaseDate = rd;
        var catIds = [];
        document.querySelectorAll('[data-figure-category]:checked').forEach(function(cb){ catIds.push(Number(cb.value)); });
        if(document.querySelectorAll('[data-figure-category]').length > 0) body.categoryIds = catIds;
        return body;
    }

    function recheckReviewItem(id){
        if(!id) return Promise.resolve();
        setLoading('reviewAction_' + id, true);
        return api('/admin/review/items/' + encodeURIComponent(id) + '/recheck', 'POST', {}).then(function(r){
            if(r.success){
                state.activeSection = 'review';
                var item = r.data && r.data.item ? r.data.item : {};
                var problems = item.payload && Array.isArray(item.payload.reviewProblems) ? item.payload.reviewProblems : [];
                if(problems.length){
                    addAlert('warning','已保存并复检，仍有问题：' + problems.join('；'));
                } else {
                    addAlert('success','已保存并复检通过，系统已标注为已解决');
                }
                loadReviewItems();
            } else {
                addAlert('error', getErrorMessage(r, '复检失败'));
            }
        }).catch(function(){ addAlert('error','复检失败'); }).then(function(){ setLoading('reviewAction_' + id, false); });
    }

    function handleReviewEdit(id){
        if(!id) return;
        var item = state.reviewItems.find(function(row){ return String(row.id || '') === String(id); });
        if(!item){ addAlert('error','找不到复核项目'); return; }
        var slug = reviewFigureSlug(item);
        if(!slug){ addAlert('warning','这条复核项目缺少手办引用，暂时无法打开编辑器'); return; }
        openFigureEditor(slug, id, reviewFigureTitle(item));
    }

    function handleSaveFigure(){
        if(!state.figureEditSlug) return;
        var body = readFigureForm();
        if(!body.slug || !body.name){ addAlert('warning','Slug 和名称必填'); return; }
        var reviewId = state.reviewEditId;
        setLoading('saveFigure', true);
        api('/figures/' + encodeURIComponent(state.figureEditSlug), 'PUT', body).then(function(r){
            if(r.success){
                state.figureEditSlug = r.data.slug || body.slug;
                loadFigures();
                if(reviewId){
                    state.figureEditSlug = null; state.figureEdit = null; state.reviewEditId = null; state.reviewEditTitle = '';
                    state.activeSection = 'review';
                    return recheckReviewItem(reviewId);
                }
                addAlert('success','手办已保存');
                openFigureEditor(state.figureEditSlug);
            } else addAlert('error', getErrorMessage(r, '保存失败'));
        }).catch(function(){ addAlert('error','保存失败'); }).then(function(){ setLoading('saveFigure', false); });
    }

    function handleDeleteFigure(slug){
        if(!slug) return;
        if(!confirm('确定要删除手办 "'+slug+'" 吗？此操作会软删除该条数据。')) return;
        api('/figures/' + encodeURIComponent(slug), 'DELETE').then(function(r){
            if(r.success){ addAlert('success','已删除'); loadFigures(); } else addAlert('error', getErrorMessage(r, '删除失败'));
        }).catch(function(){ addAlert('error','删除失败'); });
    }

    function flattenCategories(items, depth, out){
        out = out || []; depth = depth || 0;
        (items || []).forEach(function(item){
            var clone = Object.assign({}, item); clone._depth = depth; out.push(clone);
            flattenCategories(item.children || [], depth + 1, out);
        });
        return out;
    }

    function openEntityEditor(section, slug){
        var cfg = ENTITY_CONFIG[section]; if(!cfg) return;
        state.editingEntity = {section:section, slug:slug || null, data:null}; render();
        if(!slug){
            state.editingEntity.data = {};
            render(); return;
        }
        setLoading('entityEdit_' + section, true);
        api(cfg.endpoint + '/' + encodeURIComponent(slug), 'GET', null, false).then(function(r){
            if(r.success) state.editingEntity = {section:section, slug:slug, data:r.data || {}};
            else { state.editingEntity = null; addAlert('error', getErrorMessage(r, cfg.label + '加载失败')); }
        }).catch(function(){ state.editingEntity = null; addAlert('error', cfg.label + '加载失败'); }).then(function(){ setLoading('entityEdit_' + section, false); });
    }

    function closeEntityEditor(){
        state.editingEntity = null; render();
    }

    function readEntityForm(section){
        var cfg = ENTITY_CONFIG[section], body = {};
        cfg.fields.forEach(function(field){
            var el = document.getElementById('entity-' + field.name); if(!el) return;
            var raw = el.value.trim();
            if(field.type === 'number'){
                if(raw !== '') body[field.name] = Number(raw);
            } else if(field.type === 'array'){
                body[field.name] = raw ? raw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
            } else {
                if(raw !== '' || field.required) body[field.name] = raw;
            }
        });
        return body;
    }

    function handleSaveEntity(){
        if(!state.editingEntity) return;
        var section = state.editingEntity.section, cfg = ENTITY_CONFIG[section], body = readEntityForm(section);
        if(!body.slug || !body.name){ addAlert('warning','Slug 和名称必填'); return; }
        var isNew = !state.editingEntity.slug;
        var endpoint = cfg.endpoint + (isNew ? '' : '/' + encodeURIComponent(state.editingEntity.slug));
        setLoading('saveEntity_' + section, true);
        api(endpoint, isNew ? 'POST' : 'PUT', body).then(function(r){
            if(r.success){
                addAlert('success', cfg.label + '已保存');
                state.editingEntity = null;
                loadEntity(section); loadStats();
            } else addAlert('error', getErrorMessage(r, '保存失败'));
        }).catch(function(){ addAlert('error','保存失败'); }).then(function(){ setLoading('saveEntity_' + section, false); });
    }

    function handleDeleteEntity(section, slug){
        var cfg = ENTITY_CONFIG[section]; if(!cfg || !slug) return;
        if(!confirm('确定要删除'+cfg.label+' "'+slug+'" 吗？如果已有手办关联，系统会拒绝删除。')) return;
        api(cfg.endpoint + '/' + encodeURIComponent(slug), 'DELETE').then(function(r){
            if(r.success){ addAlert('success', cfg.label + '已删除'); loadEntity(section); loadStats(); }
            else addAlert('error', getErrorMessage(r, '删除失败'));
        }).catch(function(){ addAlert('error','删除失败'); });
    }

    function handleUpdateUser(id, field, value){
        var body = {}; body[field] = value;
        api('/admin/users/' + id, 'PUT', body).then(function(r){
            if(r.success){ addAlert('success','已更新'); loadUsers(); } else addAlert('error', getErrorMessage(r, '更新失败'));
        }).catch(function(){ addAlert('error','更新失败'); });
    }

    function handleDeleteUser(id, name){
        if(!confirm('确定要永久删除用户 "'+name+'" 吗？\n\n此操作将硬删除该用户及所有关联数据（收藏等），不可撤销！')) return;
        setLoading('delUser_' + id, true);
        api('/admin/users/' + id, 'DELETE').then(function(r){
            if(r.success){ addAlert('success','用户已删除'); loadUsers(); } else addAlert('error', getErrorMessage(r, '删除失败'));
        }).catch(function(){ addAlert('error','删除失败'); }).then(function(){ setLoading('delUser_' + id, false); });
    }

    function handleCreateUser(){
        var f = state.newUserForm;
        if(!f.username){ addAlert('warning','请输入用户名'); return; }
        if(!f.password || f.password.length < 8){ addAlert('warning','密码至少8个字符'); return; }
        setLoading('createUser', true);
        api('/admin/users', 'POST', {username:f.username, password:f.password, role:f.role}).then(function(r){
            if(r.success){ addAlert('success','用户创建成功'); state.newUserForm = {username:'',password:'',role:'viewer'}; closeModal(); loadUsers(); }
            else addAlert('error', getErrorMessage(r, '创建失败'));
        }).catch(function(){ addAlert('error','创建失败，请稍后重试'); }).then(function(){ setLoading('createUser', false); });
    }

    function closeMobileSidebar(){
        var s = document.querySelector('.admin-sidebar'), o = document.querySelector('.admin-overlay');
        if(s) s.classList.remove('open'); if(o) o.classList.remove('open');
    }
    function openMobileSidebar(){
        var s = document.querySelector('.admin-sidebar'), o = document.querySelector('.admin-overlay');
        if(s) s.classList.add('open'); if(o) o.classList.add('open');
    }
    function toggleTheme(){
        var h = document.documentElement, c = h.getAttribute('data-theme') || 'light';
        h.setAttribute('data-theme', c === 'dark' ? 'light' : 'dark');
        document.cookie = 'mw_theme=' + (c === 'dark' ? 'light' : 'dark') + ';path=/;max-age=31536000;secure;samesite=strict';
    }

    function esc(s){ if(s == null) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
    function escAttr(s){ if(s == null) return ''; return String(s).replace(/[&<>"']/g, function(m){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]; }); }
    function formatNum(n){ return n == null ? '0' : Number(n).toLocaleString(); }
    function formatDate(d){ if(!d) return '-'; return new Date(d).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}); }
    function formatPrice(jpy){ return jpy == null ? '-' : '\u00A5' + Number(jpy).toLocaleString(); }
    function roleName(r){ return ROLES[r] || r || '用户'; }
    function reviewTypeName(t){
        var m = {jan_match:'JAN 匹配',figure_import:'爬虫入库',rewrite:'洗稿草稿',image:'图片质检',general:'通用'};
        return m[t] || t || '通用';
    }
    function reviewStatusName(s){
        var m = {pending:'待处理',approved:'已批准',rejected:'已拒绝',needs_changes:'需修改',resolved:'已解决'};
        return m[s] || s || '待处理';
    }
    function reviewBadgeClass(s){
        if(s === 'resolved' || s === 'approved') return 'admin-badge-active';
        if(s === 'rejected') return 'admin-badge-error';
        if(s === 'needs_changes') return 'admin-badge-queued';
        return 'admin-badge-queued';
    }
    function reviewRiskTypeName(t){
        var m = {
            image_suspicious_banner: '疑似横幅广告图',
            image_suspicious_thumbnail: '疑似缩略图',
            image_possible_user_photo: '疑似用户自拍',
            image_possible_collection_or_room: '疑似玩家房间/柜子/合集',
            image_wrong_subject: '图片主体不符',
            image_low_quality_fallback: '低质量回退图',
            image_restore_candidate: '备份恢复候选',
            image_missing: '缺图',
            image_low_count: '图片数量不足',
            detail_missing_description: '缺少商品描述',
            detail_sparse_specs: '规格字段稀疏',
            detail_conflict: '详情矛盾',
            category_uncertain: '分类不确定',
            general_risk: '一般风险',
        };
        return m[t] || t || '一般风险';
    }

    // Phase 1+2: canonical action display names (contract §4)
    function reviewActionName(a){
        var m = {
            approve_image: '批准候选图',
            reject_image: '拒绝候选图',
            keep_placeholder: '保留占位图',
            mark_detail_ok: '详情确认无误',
            mark_needs_manual_edit: '需人工编辑',
            request_refetch: '请求重抓',
            keep_pending: '保持待审',
            dismiss_stale: '标记已处理',
        };
        return m[a] || a || '';
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

    function shortText(value, max){
        if(value == null) return '-';
        var text = String(value).replace(/\s+/g, ' ').trim();
        max = max || 160;
        return text.length > max ? text.slice(0, max) + '...' : text;
    }

    function reviewFigureTitle(item){
        var cf = item.currentFigure || {};
        if(cf.title) return cf.title;
        var p = item.payload || {};
        var fig = p.figure || {};
        return p.figureTitle || p.figureName || fig.name || p.name || item.figureTitle || item.figureSlug || '未知手办';
    }

    function reviewFigureSlug(item){
        var cf = item.currentFigure || {};
        if(cf.slug) return cf.slug;
        var p = item.payload || {};
        var fig = p.figure || {};
        return item.figureSlug || p.figureSlug || fig.slug || p.slug || '';
    }

    function reviewProxyUrl(url){
        if(!url) return '';
        return API_BASE + '/admin/review/image-proxy?url=' + encodeURIComponent(url);
    }

    function loadReviewImage(imgEl, url){
        if(!imgEl || !url) return;
        // Phase 3: object URL lifecycle — cache per remote URL, reuse on re-render,
        // revoke only when leaving the review section (revokeReviewObjectUrls).
        // This ensures preview and lightbox share the SAME object URL (no mismatch).
        if(state.reviewObjectUrls[url]){
            imgEl.src = state.reviewObjectUrls[url];
            var link0 = imgEl.closest('a');
            if(link0){
                link0.style.display = '';
                link0.href = state.reviewObjectUrls[url];
                link0.setAttribute('data-review-lightbox', state.reviewObjectUrls[url]);
            }
            return;
        }
        var proxyUrl = API_BASE + '/admin/review/image-proxy?url=' + encodeURIComponent(url);
        fetch(proxyUrl, {headers: {'Authorization': 'Bearer ' + (state.token || '')}})
            .then(function(r){
                if(!r.ok) throw new Error('HTTP ' + r.status);
                return r.blob();
            })
            .then(function(blob){
                var objectUrl = URL.createObjectURL(blob);
                state.reviewObjectUrls[url] = objectUrl;
                imgEl.src = objectUrl;
                // Preview (<img src>) and lightbox (link href + data-review-lightbox)
                // MUST use the same objectUrl — never diverge (contract §11).
                var link = imgEl.closest('a');
                if(link) {
                    link.style.display = '';
                    link.href = objectUrl;
                    link.setAttribute('data-review-lightbox', objectUrl);
                }
            })
            .catch(function(){
                imgEl.style.display = 'none';
                var link = imgEl.closest('a');
                if(link){
                    var fb = link.querySelector('.proxy-fallback');
                    if(fb) fb.style.display = 'inline';
                }
            });
    }

    function reviewSourceText(item){
        var p = item.payload || {};
        var src = item.source || p.sourceName || p.source || p.provider || (item.automation && item.automation.provider) || '未知来源';
        var names = {
            'image-review-automation':'飞牛 NAS 图片质检',
            'image-review-apply-smoke-test':'图片复核流程测试',
            'db-audit':'数据库审计',
            'n8n':'n8n 自动流程',
            'hermes':'Hermes 自动流程'
        };
        var out = names[src] || src;
        var detail = [];
        if(item.automation && item.automation.workflow) detail.push('流程: ' + item.automation.workflow);
        if(p.model) detail.push('模型: ' + p.model);
        if(p.workflow) detail.push('流程: ' + p.workflow);
        if(p.runId) detail.push('运行: ' + p.runId);
        if(p.sourceUrl || p.url) detail.push(p.sourceUrl || p.url);
        return detail.length ? out + ' · ' + detail.join(' · ') : out;
    }

    function reviewKv(rows){
        var html = '<dl class="admin-kv">';
        rows.forEach(function(row){
            if(row[1] == null || row[1] === '') return;
            html += '<dt>'+esc(row[0])+'</dt><dd>'+esc(row[1])+'</dd>';
        });
        return html + '</dl>';
    }

    function reviewProblemsHtml(item){
        var p = item.payload || {};
        var problems = Array.isArray(p.reviewProblems) ? p.reviewProblems : [];
        if(!problems.length) return '';
        return '<div class="admin-review-problems"><strong>复检仍有问题</strong><ul>'+problems.map(function(problem){ return '<li>'+esc(problem)+'</li>'; }).join('')+'</ul></div>';
    }

    function sourcePills(items){
        if(!Array.isArray(items) || !items.length) return '';
        return '<div style="margin-top:8px">'+items.slice(0,4).map(function(img){ return '<span class="admin-review-pill">'+esc(shortText(img.source || img.url || img.sha256 || '候选图', 54))+'</span>'; }).join('')+'</div>';
    }

    function readablePayloadRows(payload){
        var labels = {slug:'Slug', janCode:'JAN', hobbySearchId:'HobbySearch', mfcId:'MFC', amiamiId:'AmiAmi', manufacturer:'制造商', manufacturerName:'制造商', scale:'比例', releaseDate:'发售日期', priceJpy:'价格', summary:'摘要', description:'说明', reason:'问题', issue:'问题', issueType:'问题类型', suggestion:'建议'};
        var rows = [];
        Object.keys(labels).forEach(function(k){
            if(payload[k] == null || payload[k] === '') return;
            rows.push([labels[k], shortText(payload[k], 180)]);
        });
        return rows;
    }

    function renderReviewSection(title, bodyHtml, cls){
        if(!bodyHtml) return '';
        return '<div class="admin-review-section' + (cls ? ' admin-review-section-' + cls : '') + '">' +
            '<div class="admin-review-section-title">' + esc(title) + '</div>' +
            '<div class="admin-review-section-body">' + bodyHtml + '</div></div>';
    }

    // Section 1: Original Evidence — frozen snapshot at creation time (item.originalEvidence / item.payload)
    function renderOriginalEvidence(item){
        var p = compactPayload(item.payload || {});
        var orig = item.originalEvidence || p.originalEvidence || {};
        var rows = [];
        if(item.type === 'image' || item.type === 'image_review'){
            if(orig.imageCount != null) rows.push(['原始图片数', orig.imageCount + ' 张']);
            else if(p.originalImageCount != null) rows.push(['原始图片数', p.originalImageCount + ' 张']);
            if(Array.isArray(orig.imageIds) && orig.imageIds.length) rows.push(['原始图片 ID', shortText(orig.imageIds.join(', '), 120)]);
            if(orig.primaryImageId != null) rows.push(['原始主图 ID', orig.primaryImageId]);
            if(orig.capturedAt) rows.push(['抓取时间', formatDate(orig.capturedAt)]);
            if(p.issue) rows.push(['问题', shortText(p.issue, 180)]);
            if(p.reason) rows.push(['原因', shortText(p.reason, 180)]);
            if(p.issueType) rows.push(['问题类型', p.issueType]);
            if(p.originalWidth != null || p.originalHeight != null) rows.push(['原始尺寸', (p.originalWidth||'-')+' x '+(p.originalHeight||'-')]);
        } else if(item.type === 'detail_review'){
            var snap = item.detailSnapshot || p.detailSnapshot || {};
            var specCount = snap.specCount || (snap.specs ? (Array.isArray(snap.specs) ? snap.specs.length : 0) : 0);
            var descLen = (snap.description || '').length;
            rows.push(['原始描述长度', descLen > 0 ? descLen + ' 字符' : '无描述']);
            rows.push(['原始规格数量', specCount > 0 ? specCount + ' 项' : '无规格']);
            if(snap.description){
                return reviewKv(rows) + '<div class="admin-subtle" style="margin-top:8px;padding:8px;background:var(--mw-warning-soft);border-radius:var(--mw-radius-sm);max-height:120px;overflow-y:auto"><strong>原始描述 (抓取证据)：</strong><br>'+esc(shortText(snap.description, 300))+'</div>';
            }
        } else if(item.type === 'figure_import'){
            var fig = p.figure || p;
            rows.push(['候选名称', fig.name || p.name]);
            rows.push(['Slug', fig.slug || p.slug]);
            rows.push(['制造商', fig.manufacturerName || p.manufacturer || p.manufacturerName]);
            rows.push(['来源链接', p.sourceUrl || p.url]);
            rows.push(['图片数', Array.isArray(fig.images || p.images) ? (fig.images || p.images).length + ' 张' : null]);
        } else if(item.type === 'jan_match'){
            rows.push(['JAN', p.janCode || p.jan]);
            rows.push(['匹配来源', p.source || p.provider || 'HobbySearch']);
            rows.push(['匹配结果', p.name || p.title || p.hobbySearchName || p.hobbySearchId]);
        } else if(item.type === 'rewrite'){
            rows.push(['洗稿摘要', shortText(p.summaryMd || p.summary || p.description || p.contentMd || p.content, 220)]);
            rows.push(['模型', p.model || (item.automation && item.automation.workflow)]);
            rows.push(['质量分', p.qualityScore == null ? null : p.qualityScore]);
        } else {
            rows = readablePayloadRows(p);
        }
        if(!rows.length) return '<div class="admin-subtle">无原始证据</div>';
        return reviewKv(rows);
    }

    // Section 2: Current State — live figure state from API (item.currentFigure / item.currentStateSnapshot)
    function renderCurrentState(item){
        var cf = item.currentFigure || {};
        var snap = item.currentStateSnapshot || {};
        var rows = [];
        // Current title (real, from API)
        var title = cf.title || snap.title || '';
        if(title) rows.push(['当前标题', shortText(title, 120)]);
        else if(cf.slug) rows.push(['Slug', cf.slug]);
        // Current real image count
        var imgCount = cf.imageCount != null ? cf.imageCount : (snap.imageCount != null ? snap.imageCount : null);
        if(imgCount != null) rows.push(['当前图片数', imgCount + ' 张']);
        if(item.type === 'detail_review'){
            var cfDetail = cf.detail || {};
            if(cfDetail.descriptionLength != null) rows.push(['当前描述长度', cfDetail.descriptionLength + ' 字符']);
            else if(snap.descriptionLength != null) rows.push(['当前描述长度', snap.descriptionLength + ' 字符']);
            if(cfDetail.validSpecCount != null) rows.push(['当前规格数', cfDetail.validSpecCount + ' 项']);
            else if(snap.validSpecCount != null) rows.push(['当前规格数', snap.validSpecCount + ' 项']);
            if(cfDetail.descriptionSnapshot){
                return reviewKv(rows) + '<div class="admin-subtle" style="margin-top:8px;padding:8px;background:var(--mw-bg-alt);border-radius:var(--mw-radius-sm);max-height:120px;overflow-y:auto"><strong>当前描述 (数据库)：</strong><br>'+esc(shortText(cfDetail.descriptionSnapshot, 300))+'</div>';
            }
        }
        // Current primary image thumbnail
        var primaryHtml = '';
        var primary = cf.primaryImage || snap.primaryImage || null;
        if(primary && (primary.apiUrl || primary.imageId)){
            var imgUrl = primary.apiUrl || (API_BASE + '/figures/images/' + primary.imageId);
            primaryHtml = '<div style="margin-top:8px"><div class="admin-subtle" style="margin-bottom:4px">当前主图</div><img src="'+escAttr(imgUrl)+'" style="max-height:120px;max-width:160px;object-fit:cover;border-radius:var(--mw-radius-sm);border:1px solid var(--mw-border)" alt="当前主图" onerror="this.style.display=\'none\'"></div>';
        }
        var problemsHtml = reviewProblemsHtml(item);
        if(!rows.length && !primaryHtml && !problemsHtml) return '<div class="admin-subtle">无当前状态</div>';
        return reviewKv(rows) + primaryHtml + problemsHtml;
    }

    // Section 3: Candidate — candidateImage source/url/width/height/imageId (contract §11 identity)
    function renderCandidate(item){
        var p = compactPayload(item.payload || {});
        if(item.type !== 'image' && item.type !== 'image_review'){
            // Non-image types: candidate = the proposed content summary
            if(item.type === 'detail_review'){
                return reviewKv([
                    ['风险类型', reviewRiskTypeName(item.riskType)],
                    ['风险原因', shortText(item.riskReason || '', 200)],
                    ['建议操作', item.suggestedAction ? reviewActionName(item.suggestedAction) : ''],
                ]);
            }
            return '<div class="admin-subtle">该类型无候选图</div>';
        }
        var cand = item.candidateImage || p.candidateImage || null;
        var candidates = p.candidates || p.candidateImages || p.processedImages || p.images || [];
        var riskName = reviewRiskTypeName(item.riskType);
        var rows = [
            ['风险类型', riskName],
            ['风险原因', shortText(item.riskReason || p.issue || p.issueType || p.reason || '需要人工确认', 200)],
            ['建议操作', item.suggestedAction ? reviewActionName(item.suggestedAction) : (p.suggestion || p.action || p.recommendation || '')],
            ['图片来源', cand ? (cand.source || cand.url || '') : (candidates.length > 0 ? candidates[0].source || candidates[0].url || '' : '')],
            ['尺寸', cand ? ((cand.width||'-')+' x '+(cand.height||'-')) : ''],
            ['候选图 ID', cand && cand.imageId ? String(cand.imageId) : (item.sourceId ? String(item.sourceId) : '')],
            ['指纹', item.evidenceFingerprint ? String(item.evidenceFingerprint).slice(0, 12) + '…' : ''],
        ];
        var html = reviewKv(rows);
        if(cand && cand.source){
            // Preview and lightbox MUST use the same candidate asset URL (contract §11).
            // loadReviewImage() sets both <img src> and link href to the same object URL.
            var proxyUrl = reviewProxyUrl(cand.url || cand.source);
            html += '<div style="margin:8px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start">';
            html += '<a href="'+escAttr(proxyUrl)+'" target="_blank" rel="noopener noreferrer" data-review-lightbox="'+escAttr(proxyUrl)+'" data-review-image-url="'+escAttr(cand.url || cand.source)+'" style="' + (cand.url || cand.source ? '' : 'display:none') + ';cursor:zoom-in"><img src="" style="max-height:180px;max-width:240px;object-fit:cover;border-radius:var(--mw-radius-sm);border:1px solid var(--mw-border)" alt="候选图"><span class="proxy-fallback" style="display:none;font-size:.75rem;color:var(--mw-text-secondary);padding:8px">点击查看候选图</span></a>';
            if(item.currentPublicImage && item.currentPublicImage.source){
                html += '<div style="opacity:0.7"><div class="admin-subtle" style="margin-bottom:4px">当前公开图</div><img src="'+escAttr(reviewProxyUrl(item.currentPublicImage.source))+'" style="max-height:120px;max-width:160px;object-fit:cover;border-radius:var(--mw-radius-sm);border:1px solid var(--mw-border)" alt="当前公开图" onerror="this.style.display=\'none\'"></div>';
            }
            html += '</div>';
        } else {
            html += sourcePills(candidates);
        }
        if(item.riskType && (item.riskType.indexOf('user_photo') >= 0 || item.riskType.indexOf('collection') >= 0 || item.riskType.indexOf('room') >= 0 || item.riskType.indexOf('banner') >= 0)){
            html += '<div class="admin-review-problems" style="border-color:rgba(245,158,11,0.35);background:var(--mw-warning-soft);color:#92400e"><strong>⚠ 疑似非商品图</strong><p>'+esc(item.riskReason || '系统标记为疑似非标准商品图，请人工确认是否可作为主图')+'</p></div>';
        }
        var sharedWarn = item.sharedCandidateWarning || p.sharedCandidateWarning;
        if(sharedWarn){
            html += '<div class="admin-review-problems" style="border-color:rgba(245,158,11,0.35);background:var(--mw-warning-soft);color:#92400e"><strong>⚠ 共享候选图片警示</strong>';
            if(sharedWarn.sharedCount != null) html += '<p>共享次数：'+esc(sharedWarn.sharedCount)+'</p>';
            if(sharedWarn.sharedFigureIds) html += '<p>共享手办 ID：'+esc(Array.isArray(sharedWarn.sharedFigureIds)?sharedWarn.sharedFigureIds.join(', '):sharedWarn.sharedFigureIds)+'</p>';
            if(sharedWarn.source) html += '<p>来源：'+esc(sharedWarn.source)+'</p>';
            if(sharedWarn.sourceId) html += '<p>来源 ID：'+esc(sharedWarn.sourceId)+'</p>';
            if(sharedWarn.url) html += '<p>图片 URL：<span style="word-break:break-all">'+esc(sharedWarn.url)+'</span></p>';
            html += '<p style="font-size:.75rem;margin-top:4px">警示仅作提示，不禁用批准操作</p></div>';
        }
        return html;
    }

    // Section 4: Decision History — lastAction, decisionReason, reviewerId, decisionAt (contract §6, §12)
    function renderDecisionHistory(item){
        var p = item.payload || {};
        var rows = [];
        var lastAction = item.lastAction || p.lastAction;
        if(lastAction) rows.push(['最后操作', reviewActionName(lastAction)]);
        var decisionReason = item.decisionReason || p.decisionReason;
        if(decisionReason) rows.push(['决定理由', shortText(decisionReason, 200)]);
        var reviewerId = item.reviewerId || p.reviewerId;
        if(reviewerId != null && reviewerId !== '') rows.push(['审核人 ID', String(reviewerId)]);
        var decisionAt = item.decisionAt || p.decisionAt;
        if(decisionAt) rows.push(['决定时间', formatDate(decisionAt)]);
        if(!rows.length) return '<div class="admin-subtle">无决定历史</div>';
        return reviewKv(rows);
    }

    function renderReviewCandidate(item){
        var html = '<div class="admin-review-card">';
        html += renderReviewSection('原始证据 / Original Evidence', renderOriginalEvidence(item), 'evidence');
        html += renderReviewSection('当前状态 / Current State', renderCurrentState(item), 'current');
        html += renderReviewSection('候选 / Candidate', renderCandidate(item), 'candidate');
        html += renderReviewSection('决定历史 / Decision History', renderDecisionHistory(item), 'decision');
        return html + '</div>';
    }

    function renderAlerts(){
        if(state.alerts.length === 0) return '';
        return state.alerts.map(function(a){
            var icon = a.type === 'success' ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' :
                a.type === 'error' ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' :
                a.type === 'warning' ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' :
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
            return '<div class="admin-alert admin-alert-'+a.type+'">'+icon+'<span>'+esc(a.message)+'</span></div>';
        }).join('');
    }

    function pwdInput(name, id, placeholder){
        return '<div class="admin-form-input-wrapper"><input type="password" id="'+id+'" class="admin-form-input" placeholder="'+placeholder+'" autocomplete="off"><button type="button" class="admin-password-toggle" data-toggle-password="'+id+'" data-toggle-icon="'+id+'-icon"><span id="'+id+'-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span></button></div>';
    }

    function renderSpinner(){ return '<div class="admin-spinner"></div>'; }
    function renderLoading(){ return '<div class="admin-loading"><div class="admin-spinner admin-spinner-lg"></div></div>'; }

    function renderModal(){
        if(!state.showModal) return '';
        if(state.showModal === 'changePassword'){
            return '<div class="admin-modal-overlay open" data-close-modal><div class="admin-modal admin-animate"><div class="admin-modal-title">修改密码</div><div class="admin-form-group"><label class="admin-form-label">当前密码</label>'+pwdInput('current-password','current-password','请输入当前密码')+'</div><div class="admin-form-group"><label class="admin-form-label">新密码</label>'+pwdInput('new-password','new-password','至少8个字符')+'</div><div class="admin-form-group"><label class="admin-form-label">确认新密码</label>'+pwdInput('new-password-confirm','new-password-confirm','再次输入新密码')+'</div><div class="admin-modal-actions"><button class="admin-btn" data-close-modal>取消</button><button class="admin-btn admin-btn-primary" id="change-pwd-btn"'+(state.loading.changePwd?' disabled':'')+'>'+(state.loading.changePwd?renderSpinner()+' 修改中...':'确认修改')+'</button></div></div></div>';
        }
        if(state.showModal === 'createUser'){
            var f = state.newUserForm;
            return '<div class="admin-modal-overlay open" data-close-modal><div class="admin-modal admin-animate"><div class="admin-modal-title">添加用户</div><div class="admin-form-group"><label class="admin-form-label">登录账号 (用户名) *</label><input type="text" id="nu-username" class="admin-form-input no-icon" placeholder="admin" value="'+esc(f.username || '')+'"></div><div class="admin-form-group"><label class="admin-form-label">密码 *</label>'+pwdInput('nu-password','nu-password','至少8个字符')+'</div><div class="admin-form-group"><label class="admin-form-label">角色</label><select id="nu-role" class="admin-form-input no-icon">'+ROLE_OPTIONS.map(function(o){return '<option value="'+o.v+'"'+(f.role===o.v?' selected':'')+'>'+o.l+'</option>';}).join('')+'</select></div><div class="admin-modal-actions"><button class="admin-btn" data-close-modal>取消</button><button class="admin-btn admin-btn-primary" id="create-user-btn"'+(state.loading.createUser?' disabled':'')+'>'+(state.loading.createUser?renderSpinner()+' 创建中...':'确认创建')+'</button></div></div></div>';
        }
        if(state.showModal === 'keepPending'){
            return '<div class="admin-modal-overlay open" data-close-modal><div class="admin-modal admin-animate" style="max-width:440px"><div class="admin-modal-title">无法判断</div><div class="admin-form-group"><label class="admin-form-label">无法判断的原因：</label><textarea id="kp-reason" class="admin-form-input" style="min-height:80px;resize:vertical" placeholder="请描述无法判断的原因">'+esc(state.keepPendingReason)+'</textarea></div><div class="admin-modal-actions"><button class="admin-btn" data-close-modal>取消</button><button class="admin-btn admin-btn-primary" id="kp-submit-btn"'+(state.loading.keepPending?' disabled':'')+'>'+(state.loading.keepPending?renderSpinner()+' 提交中...':'保持待审')+'</button></div></div></div>';
        }
        return '';
    }

    function renderLogin(){
        var errHtml = '';
        if(state.loginError){
            errHtml = '<div class="admin-alert admin-alert-error"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>'+esc(state.loginError)+'</span></div>';
        }
        var usernameCls = state.loginError && (!state.loginUsername) ? ' error' : '';
        return '<div class="admin-login-wrapper"><div class="admin-login-card admin-animate"><div class="admin-login-logo">ModelWiki</div><div class="admin-login-subtitle">管理中心 · 请登录以继续</div>'+errHtml+'<form id="login-form"><div class="admin-form-group"><label class="admin-form-label">用户名</label><input type="text" id="login-username" class="admin-form-input no-icon'+usernameCls+'" placeholder="请输入用户名" value="'+esc(state.loginUsername)+'" autocomplete="username" autofocus></div><div class="admin-form-group"><label class="admin-form-label">密码</label>'+pwdInput('login-password','login-password','请输入密码')+'</div><button type="submit" class="admin-btn admin-btn-primary admin-btn-block" id="login-btn"'+(state.loading.login?' disabled':'')+'>'+(state.loading.login?renderSpinner()+' 登录中...':'登 录')+'</button></form></div></div>';
    }

    function renderSidebar(){
        var navItems = SECTIONS.map(function(s){
            return '<button class="admin-nav-item'+(state.activeSection===s.id?' active':'')+'" data-section="'+s.id+'">'+s.icon+'<span>'+s.label+'</span></button>';
        }).join('');
        var ui = state.user ? (state.user.displayName || state.user.email || 'A').charAt(0).toUpperCase() : 'A';
        var un = state.user ? (state.user.displayName || state.user.email) : '';
        var ur = state.user ? roleName(state.user.role) : '';
        return '<aside class="admin-sidebar"><div class="admin-sidebar-brand"><a href="'+HOME_URL+'">ModelWiki</a><button class="admin-sidebar-theme" data-toggle-theme><svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2"/></svg><svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button></div><nav class="admin-sidebar-nav"><div class="admin-nav-section">管理功能</div>'+navItems+'</nav><div class="admin-sidebar-footer"><div class="admin-user-info"><div class="admin-user-avatar">'+ui+'</div><div class="admin-user-details"><div class="admin-user-name">'+esc(un)+'</div><div class="admin-user-role">'+esc(ur)+'</div></div><button class="admin-logout-btn" data-logout title="退出登录"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg></button></div></div></aside>';
    }

    function statLabelMap(){ return {figures:'手办总数',manufacturers:'制造商',series:'系列',sculptors:'原型师',categories:'分类',characters:'角色',users:'用户',images:'图片'}; }
    function statIcons(){ return {figures:'figures',manufacturers:'manufacturers',series:'series',sculptors:'manufacturers',categories:'series',characters:'users',images:'figures'}; }

    function renderDashboard(){
        if(state.loading.stats && !state.stats) return renderLoading();
        if(!state.stats) return '<div class="admin-empty"><p>暂无统计数据</p></div>';
        var c = state.stats.counts || {}, labels = statLabelMap(), icons = statIcons();
        var keys = ['figures','manufacturers','series','sculptors','categories','characters','users','images'];
        var html = '<div class="admin-stats-grid admin-animate">';
        keys.forEach(function(k){ html += statCard(labels[k], c[k], icons[k] || 'figures', STAT_TARGETS[k]); });
        html += '</div>';
        if(state.stats.recentFigures && state.stats.recentFigures.length > 0){
            html += '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">最近添加的 10 个手办</div></div><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>名称</th><th>添加时间</th></tr></thead><tbody>';
            state.stats.recentFigures.forEach(function(f){ html += '<tr><td><button class="admin-link-btn" data-edit-figure="'+esc(f.slug)+'">'+esc(f.name||f.nameEn||f.slug)+'</button></td><td>'+formatDate(f.createdAt)+'</td></tr>'; });
            html += '</tbody></table></div></div>';
        }
        return html;
    }
    function statCard(label, value, cls, target){
        var attr = target ? ' data-section-target="'+target+'"' : '';
        return '<div class="admin-stat-card"'+attr+'><div class="admin-stat-icon '+cls+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg></div><div class="admin-stat-value">'+formatNum(value)+'</div><div class="admin-stat-label">'+label+'</div></div>';
    }

    function dateInputValue(value){
        if(!value) return '';
        var d = new Date(value); if(isNaN(d.getTime())) return '';
        return d.toISOString().slice(0, 10);
    }

    function renderOptionList(items, selected){
        var html = '<option value="">未设置</option>';
        (items || []).forEach(function(item){
            var label = (item._depth ? Array(item._depth + 1).join('— ') : '') + (item.name || item.nameEn || item.slug);
            html += '<option value="'+esc(item.id)+'"'+(String(item.id)===String(selected)?' selected':'')+'>'+esc(label)+'</option>';
        });
        return html;
    }

    function figureInput(id, label, value, type){
        return '<div class="admin-form-group"><label class="admin-form-label">'+label+'</label><input type="'+(type||'text')+'" id="fig-'+id+'" class="admin-form-input no-icon" value="'+esc(value == null ? '' : value)+'"></div>';
    }

    function renderFigureEditor(){
        var backLabel = state.reviewEditId ? '返回复核队列' : '返回列表';
        var back = '<button class="admin-btn admin-btn-sm" id="figure-edit-back">'+backLabel+'</button>';
        if(state.loading.figureEdit && !state.figureEdit) return '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">编辑手办</div>'+back+'</div>'+renderLoading()+'</div>';
        var f = state.figureEdit || {};
        var currentCats = {};
        (f.categories || []).forEach(function(c){ var id = c.category ? c.category.id : c.id; if(id != null) currentCats[String(id)] = true; });
        var reviewContext = state.reviewEditId ? '<div class="admin-alert admin-alert-info"><span>来自复核：'+esc(state.reviewEditTitle || f.name || f.slug || '')+'。保存后会自动复检。</span></div>' : '';
        var html = '<div class="admin-card admin-animate"><div class="admin-card-header"><div><div class="admin-card-title">编辑手办</div><div class="admin-subtle">'+esc(f.slug || state.figureEditSlug || '')+'</div></div><div class="admin-inline-actions">'+back+'<a class="admin-btn admin-btn-sm" href="'+HOME_URL+'figure/'+esc(f.slug || state.figureEditSlug)+'/" target="_blank" rel="noopener noreferrer">前台查看</a></div></div><div class="admin-card-body">'+reviewContext;
        html += '<div class="admin-form-grid">';
        html += figureInput('slug','Slug *',f.slug || '');
        html += figureInput('name','名称 *',f.name || '');
        html += figureInput('nameJp','日文名',f.nameJp || '');
        html += figureInput('nameEn','英文名',f.nameEn || '');
        html += figureInput('scale','比例',f.scale || '');
        html += figureInput('material','材质',f.material || '');
        html += figureInput('priceJpy','日元价格',f.priceJpy,'number');
        html += figureInput('releaseDate','发售日期',dateInputValue(f.releaseDate),'date');
        html += figureInput('heightMm','高度 mm',f.heightMm,'number');
        html += figureInput('weightG','重量 g',f.weightG,'number');
        html += figureInput('janCode','JAN',f.janCode || '');
        html += figureInput('productLine','产品线',f.productLine || '');
        html += figureInput('mfcId','MFC ID',f.mfcId || '');
        html += figureInput('hobbySearchId','HobbySearch ID',f.hobbySearchId || '');
        html += figureInput('amiamiId','AmiAmi ID',f.amiamiId || '');
        html += figureInput('hljId','HLJ ID',f.hljId || '');
        html += '<div class="admin-form-group"><label class="admin-form-label">制造商</label><select id="fig-manufacturerId" class="admin-form-input no-icon">'+renderOptionList(state.options.manufacturers, f.manufacturerId || (f.manufacturer && f.manufacturer.id))+'</select></div>';
        html += '<div class="admin-form-group"><label class="admin-form-label">系列</label><select id="fig-seriesId" class="admin-form-input no-icon">'+renderOptionList(state.options.series, f.seriesId || (f.series && f.series.id))+'</select></div>';
        html += '<div class="admin-form-group span-2"><label class="admin-form-label">分类</label><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;max-height:180px;overflow:auto;border:1px solid var(--mw-border);border-radius:var(--mw-radius-sm);padding:12px;background:var(--mw-bg)">';
        (state.options.categories || []).forEach(function(cat){
            var label = (cat._depth ? Array(cat._depth + 1).join('— ') : '') + (cat.name || cat.slug);
            html += '<label class="admin-subtle" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-figure-category value="'+esc(cat.id)+'"'+(currentCats[String(cat.id)]?' checked':'')+'> <span>'+esc(label)+'</span></label>';
        });
        html += '</div></div>';
        if(f.images && f.images.length){
            html += '<div class="admin-form-group span-2"><label class="admin-form-label">图片概览</label><div class="admin-kv">';
            html += '<dt>数量</dt><dd>'+formatNum(f.images.length)+'</dd>';
            html += '<dt>首图</dt><dd>'+esc((f.images[0].width||'-')+' x '+(f.images[0].height||'-')+' · '+(f.images[0].source||'-'))+'</dd>';
            html += '</div></div>';
        }
        html += '</div><div class="admin-editor-actions"><button class="admin-btn" id="figure-edit-cancel">取消</button><button class="admin-btn admin-btn-primary" id="figure-save-btn"'+(state.loading.saveFigure?' disabled':'')+'>'+(state.loading.saveFigure?renderSpinner()+' 保存中...':(state.reviewEditId?'保存并复检':'保存手办'))+'</button></div></div></div>';
        return html;
    }

    function renderEntityField(field, data){
        var val = data && data[field.name];
        if(field.type === 'array') val = Array.isArray(val) ? val.join(', ') : (val || '');
        if(field.type === 'textarea'){
            return '<div class="admin-form-group '+(field.wide?'span-2':'')+'"><label class="admin-form-label">'+field.label+(field.required?' *':'')+'</label><textarea id="entity-'+field.name+'" class="admin-form-textarea">'+esc(val == null ? '' : val)+'</textarea></div>';
        }
        return '<div class="admin-form-group '+(field.wide?'span-2':'')+'"><label class="admin-form-label">'+field.label+(field.required?' *':'')+'</label><input type="'+(field.type === 'number' ? 'number' : 'text')+'" id="entity-'+field.name+'" class="admin-form-input no-icon" value="'+esc(val == null ? '' : val)+'"></div>';
    }

    function renderEntityEditor(){
        var edit = state.editingEntity, cfg = ENTITY_CONFIG[edit.section], data = edit.data || {};
        if(state.loading['entityEdit_' + edit.section] && !edit.data) return '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">'+cfg.label+'编辑</div><button class="admin-btn admin-btn-sm" id="entity-edit-back">返回列表</button></div>'+renderLoading()+'</div>';
        var html = '<div class="admin-card admin-animate"><div class="admin-card-header"><div><div class="admin-card-title">'+(edit.slug?'编辑':'新增')+cfg.label+'</div><div class="admin-subtle">'+esc(edit.slug || '新建记录')+'</div></div><button class="admin-btn admin-btn-sm" id="entity-edit-back">返回列表</button></div><div class="admin-card-body"><div class="admin-form-grid">';
        cfg.fields.forEach(function(field){ html += renderEntityField(field, data); });
        if(data._count && data._count.figures != null) html += '<div class="admin-form-group span-2"><div class="admin-subtle">关联手办：'+formatNum(data._count.figures)+'</div></div>';
        html += '</div><div class="admin-editor-actions"><button class="admin-btn" id="entity-edit-cancel">取消</button><button class="admin-btn admin-btn-primary" id="entity-save-btn"'+(state.loading['saveEntity_'+edit.section]?' disabled':'')+'>'+(state.loading['saveEntity_'+edit.section]?renderSpinner()+' 保存中...':'保存')+'</button></div></div></div>';
        return html;
    }

    function renderEntityManager(section){
        if(state.editingEntity && state.editingEntity.section === section) return renderEntityEditor();
        var cfg = ENTITY_CONFIG[section], search = (state.entitySearch[section] || '').toLowerCase();
        var items = (state.entities[section] || []).filter(function(item){
            if(!search) return true;
            return [item.name,item.nameJp,item.nameEn,item.slug].some(function(v){ return String(v || '').toLowerCase().indexOf(search) >= 0; });
        });
        var html = '<div class="admin-search-bar"><input type="text" class="admin-search-input" id="entity-search" placeholder="搜索'+cfg.label+'..." value="'+esc(state.entitySearch[section] || '')+'"><button class="admin-btn admin-btn-primary admin-btn-sm" id="entity-search-btn">搜索</button><button class="admin-btn admin-btn-sm" id="entity-add-btn">新增'+cfg.label+'</button></div>';
        if(state.loading['entity_' + section] && !state.entities[section]) return html + renderLoading();
        if(items.length === 0) return html + '<div class="admin-empty"><p>暂无'+cfg.label+'数据</p></div>';
        html += '<div class="admin-card admin-animate"><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>名称</th><th>Slug</th><th>关联手办</th><th>操作</th></tr></thead><tbody>';
        items.forEach(function(item){
            var name = (item._depth ? Array(item._depth + 1).join('— ') : '') + (item.name || item.nameEn || item.slug);
            var count = item._count && item._count.figures != null ? item._count.figures : '-';
            html += '<tr><td><button class="admin-link-btn" data-edit-entity="'+esc(section)+'" data-entity-slug="'+esc(item.slug)+'">'+esc(name)+'</button></td><td>'+esc(item.slug)+'</td><td>'+esc(count)+'</td><td><div class="admin-inline-actions"><button class="admin-btn admin-btn-sm" data-edit-entity="'+esc(section)+'" data-entity-slug="'+esc(item.slug)+'">编辑</button><button class="admin-btn admin-btn-danger admin-btn-sm" data-delete-entity="'+esc(section)+'" data-entity-slug="'+esc(item.slug)+'">删除</button></div></td></tr>';
        });
        html += '</tbody></table></div>';
        var meta = state.entityMeta[section];
        if(meta && meta.totalPages > 1){
            html += '<div class="admin-card-footer"><span>共 '+formatNum(meta.total)+' 条</span><div class="admin-pagination">';
            for(var p=1;p<=Math.min(meta.totalPages,7);p++){ html += '<button class="admin-page-btn'+(p===(state.entityPage[section]||1)?' active':'')+'" data-entity-page="'+p+'">'+p+'</button>'; }
            html += '</div></div>';
        }
        return html + '</div>';
    }

    function renderFigures(){
        if(state.figureEditSlug) return renderFigureEditor();
        var html = '<div class="admin-search-bar"><input type="text" class="admin-search-input" id="figures-search" placeholder="搜索手办名称..." value="'+esc(state.figuresSearch)+'"><button class="admin-btn admin-btn-primary admin-btn-sm" id="figures-search-btn">搜索</button></div>';
        if(state.loading.figures && state.figures.length === 0) return html + renderLoading();
        if(state.figures.length === 0) return html + '<div class="admin-empty"><p>未找到手办</p></div>';
        html += '<div class="admin-card admin-animate"><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>图片</th><th>名称</th><th>分类</th><th>制造商</th><th>图片数</th><th>操作</th></tr></thead><tbody>';
        state.figures.forEach(function(f){
            var mfg = f.manufacturer ? (f.manufacturer.name || '') : '';
            var imgs = f.images || [];
            var firstImg = imgs.length > 0 ? imgs[0] : null;
            var thumbHtml = firstImg && firstImg.thumbnailUrl
                ? '<img src="'+esc(firstImg.thumbnailUrl)+'" class="admin-figure-thumb" alt="" onerror="this.style.display=\'none\'">'
                : (firstImg && firstImg.url ? '<img src="'+esc(firstImg.url)+'" class="admin-figure-thumb" alt="" onerror="this.style.display=\'none\'">'
                    : '<div class="admin-figure-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--mw-bg-alt);color:var(--mw-text-tertiary);font-size:.625rem">无图</div>');
            var cats = (f.categories || []).map(function(c){ return (c.category || c).name || (c.category || c).slug || ''; }).join(', ');
            html += '<tr><td>'+thumbHtml+'</td><td><button class="admin-link-btn" data-edit-figure="'+esc(f.slug)+'">'+esc(f.name||f.nameEn||f.slug)+'</button><div class="admin-subtle">'+esc(f.slug)+'</div><div style="font-size:.6875rem;color:var(--mw-text-tertiary);margin-top:2px">ID: '+esc(f.id)+'</div></td><td><span style="font-size:.75rem">'+esc(cats||'-')+'</span></td><td>'+esc(mfg)+'</td><td><span style="font-size:.75rem">'+imgs.length+'</span></td><td><div class="admin-inline-actions"><button class="admin-btn admin-btn-sm" data-edit-figure="'+esc(f.slug)+'">编辑</button><a class="admin-btn admin-btn-sm" href="'+HOME_URL+'figure/'+esc(f.slug)+'/" target="_blank" rel="noopener noreferrer">前台</a><button class="admin-btn admin-btn-danger admin-btn-sm" data-delete-figure="'+esc(f.slug)+'">删除</button></div></td></tr>';
        });
        html += '</tbody></table></div>';
        if(state.figuresMeta && state.figuresMeta.totalPages > 1){
            html += '<div class="admin-card-footer"><span>共 '+formatNum(state.figuresMeta.total)+' 个手办</span><div class="admin-pagination">';
            for(var p=1;p<=Math.min(state.figuresMeta.totalPages,7);p++){ html += '<button class="admin-page-btn'+(p===state.figuresPage?' active':'')+'" data-figures-page="'+p+'">'+p+'</button>'; }
            html += '</div></div>';
        }
        return html + '</div>';
    }

    function renderReview(){
        var statuses = [
            {v:'',l:'全部'},
            {v:'pending',l:'待处理'},
            {v:'needs_changes',l:'需修改'},
            {v:'resolved',l:'已解决'}
        ];
        var html = '<div class="admin-card admin-animate"><div class="admin-card-header"><div><div class="admin-card-title">人工复核队列</div><div style="font-size:.8125rem;color:var(--mw-text-secondary);margin-top:4px">n8n / Hermes 可以通过 /api/v1/admin/review/items 提交洗稿草稿、爬虫候选和质检结果。</div></div><button class="admin-btn admin-btn-sm" id="review-refresh-btn">刷新</button></div><div class="admin-card-body"><div style="display:flex;gap:8px;flex-wrap:wrap">';
        statuses.forEach(function(s){
            html += '<button class="admin-btn admin-btn-sm'+(state.reviewStatus===s.v?' admin-btn-primary':'')+'" data-review-filter="'+esc(s.v)+'">'+s.l+'</button>';
        });
        html += '</div></div></div>';
        if(state.loading.review && state.reviewItems.length === 0) return html + renderLoading();
        if(state.reviewItems.length === 0) return html + '<div class="admin-empty"><p>暂无复核项目</p></div>';
        html += '<div class="admin-card admin-animate"><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>类型</th><th>状态</th><th>标题</th><th>置信度</th><th>候选内容</th><th>来源</th><th style="min-width:120px">操作</th></tr></thead><tbody>';
        state.reviewItems.forEach(function(item){
            var id = item.id || '';
            var confidence = item.confidence == null ? '-' : Math.round(Number(item.confidence) * 100) + '%';
            var src = reviewSourceText(item);
            var payload = renderReviewCandidate(item);
            var slug = reviewFigureSlug(item);
            var titleText = reviewFigureTitle(item);
            var title = slug ? '<a href="'+HOME_URL+'figure/'+esc(slug)+'/" target="_blank" rel="noopener noreferrer">'+esc(titleText)+'</a>' : esc(titleText);
            var status = '<span class="admin-badge '+reviewBadgeClass(item.status)+'">'+reviewStatusName(item.status)+'</span>';
            var source = '<div>'+esc(src)+'</div><div style="font-size:.75rem;color:var(--mw-text-tertiary);margin-top:4px">创建 '+formatDate(item.createdAt)+'</div>';
            if(item.notes) {
                var notes = String(item.notes).split('\n').pop() || '';
                source += '<div class="admin-subtle" style="margin-top:4px;white-space:normal;word-break:break-all">最后记录: '+esc(shortText(notes, 80))+'</div>';
            }
            if(item.payload && item.payload.lastActionAt) {
                source += '<div style="font-size:.75rem;color:var(--mw-text-tertiary);margin-top:2px">操作时间 '+formatDate(item.payload.lastActionAt)+'</div>';
            }
            // Phase 3: decision fields (lastAction, decisionReason, reviewerId, decisionAt) now shown
            // in the card's "决定历史 / Decision History" section — not duplicated here.
            var rowLoading = state.loading['reviewAction_' + id];
            var actions = '';
            if(item.type === 'image_review'){
                actions = '<div class="admin-inline-actions">' +
                    '<button class="admin-btn admin-btn-primary admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="approve_image"'+(rowLoading?' disabled':'')+'>批准候选</button>' +
                    '<button class="admin-btn admin-btn-danger admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="reject_image"'+(rowLoading?' disabled':'')+'>拒绝</button>' +
                    '<button class="admin-btn admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="keep_placeholder"'+(rowLoading?' disabled':'')+'>占位</button>' +
                    '<button class="admin-btn admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="request_refetch"'+(rowLoading?' disabled':'')+'>重抓</button>' +
                    '<button class="admin-btn admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="keep_pending"'+(rowLoading?' disabled':'')+'>无法判断</button>' +
                '</div>';
            } else if(item.type === 'detail_review'){
                // Phase 3: added mark_needs_manual_edit (7 actions total, contract §3)
                actions = '<div class="admin-inline-actions">' +
                    '<button class="admin-btn admin-btn-primary admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="mark_detail_ok"'+(rowLoading?' disabled':'')+'>详情OK</button>' +
                    '<button class="admin-btn admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="mark_needs_manual_edit"'+(rowLoading?' disabled':'')+'>需人工编辑</button>' +
                    '<button class="admin-btn admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="request_refetch"'+(rowLoading?' disabled':'')+'>重抓</button>' +
                    '<button class="admin-btn admin-btn-sm" data-review-id="'+esc(id)+'" data-review-action="keep_pending"'+(rowLoading?' disabled':'')+'>无法判断</button>' +
                '</div>';
            } else if(item.type === 'rewrite'){
                var canEdit = !!slug && !(item.type === 'figure_import' && !item.figureSlug);
                actions = canEdit
                    ? '<button class="admin-btn admin-btn-primary admin-btn-sm" data-review-id="'+esc(id)+'" data-review-edit="'+esc(id)+'"'+(rowLoading?' disabled':'')+'>'+(rowLoading?renderSpinner()+' 复检中':'编辑处理')+'</button>'
                    : '<span class="admin-subtle">缺少已入库手办</span>';
            } else {
                actions = '<span class="admin-subtle">—</span>';
            }
            html += '<tr><td><span class="admin-badge '+reviewBadgeClass(item.status)+'">'+reviewTypeName(item.type)+'</span></td><td>'+status+'</td><td>'+title+'</td><td>'+esc(confidence)+'</td><td>'+payload+'</td><td>'+source+'</td><td style="white-space:nowrap">'+actions+'</td></tr>';
        });
        var totalPages = state.reviewTotal > 0 ? Math.ceil(state.reviewTotal / 50) : 0;
        if(totalPages > 1){
            html += '<div class="admin-card-footer"><span>共 '+formatNum(state.reviewTotal)+' 条</span><div class="admin-pagination">';
            for(var p=1;p<=Math.min(totalPages,7);p++){ html += '<button class="admin-page-btn'+(p===state.reviewPage?' active':'')+'" data-review-page="'+p+'">'+p+'</button>'; }
            html += '</div></div>';
        }
        return html + '</tbody></table></div></div>';
    }
    function renderCache(){
        return '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">缓存管理</div></div><div class="admin-card-body"><div class="admin-alert admin-alert-warning"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>清除所有 Redis 缓存数据。清除后页面加载可能会变慢，缓存将自动重建。</span></div><button class="admin-btn admin-btn-danger" id="cache-purge-btn"'+(state.loading.cachePurge?' disabled':'')+'>'+(state.loading.cachePurge?renderSpinner()+' 清除中...':'清除全部缓存')+'</button></div></div>';
    }

    function renderUsers(){
        var header = '<div class="admin-card admin-animate"><div class="admin-card-header"><div class="admin-card-title">用户列表 ('+state.users.length+')</div><button class="admin-btn admin-btn-primary admin-btn-sm" id="add-user-btn">添加用户</button></div><div style="overflow-x:auto"><table class="admin-table"><thead><tr><th>登录账号 (用户名)</th><th>角色</th><th>状态</th><th style="min-width:180px">操作</th></tr></thead><tbody>';
        if(state.loading.users && state.users.length === 0) return renderLoading();
        if(state.users.length === 0) return header + '</tbody></table></div></div><div class="admin-empty"><p>暂无用户</p></div>';
        var html = header;
        state.users.forEach(function(u){
            var isSelf = state.user && String(state.user.id) === String(u.id);
            html += '<tr><td>'+esc(u.displayName||'-')+'</td><td><select class="admin-form-input no-icon" style="width:auto;padding:4px 8px;font-size:.8125rem" data-user-role="'+u.id+'">'+ROLE_OPTIONS.map(function(o){return '<option value="'+o.v+'"'+(u.role===o.v?' selected':'')+'>'+o.l+'</option>';}).join('')+'</select></td><td><span class="admin-badge admin-badge-'+(u.isActive?'active':'inactive')+'">'+(u.isActive?'正常':'禁用')+'</span></td><td style="white-space:nowrap"><button class="admin-btn admin-btn-sm" data-reset-password="'+u.id+'">重置密码</button>'+(isSelf?' <span class="admin-badge admin-badge-editor" style="margin-left:4px">当前</span>':' <button class="admin-btn admin-btn-danger admin-btn-sm" data-delete-user="'+u.id+'"        data-delete-user-name="'+esc(u.displayName||u.email)+'"'+(state.loading['delUser_'+u.id]?' disabled':'')+'>'+(state.loading['delUser_'+u.id]?renderSpinner()+' 删除中':'删除')+'</button>')+'</td></tr>';
        });
        return html + '</tbody></table></div></div>';
    }

    function renderApp(){
        if(!state.token) return renderLogin() + renderModal();
        var content;
        switch(state.activeSection){
            case 'dashboard': content = renderDashboard(); break;
            case 'figures': content = renderFigures(); break;
            case 'categories':
            case 'manufacturers':
            case 'series':
            case 'sculptors':
            case 'characters':
                content = renderEntityManager(state.activeSection); break;
            case 'review': content = renderReview(); break;
            case 'cache': content = renderCache(); break;
            case 'users': content = renderUsers(); break;
            default: content = renderDashboard();
        }
        var title = SECTIONS.find(function(s){return s.id===state.activeSection;});
        title = title ? title.label : '仪表盘';
        return renderSidebar() + '<div class="admin-overlay" data-close-mobile-sidebar></div><div class="admin-main"><div class="admin-topbar"><div style="display:flex;align-items:center;gap:12px"><button class="admin-mobile-toggle" data-open-mobile-sidebar><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg></button><div class="admin-topbar-title">'+title+'</div></div><div class="admin-topbar-actions"><button class="admin-btn admin-btn-sm" data-show-modal="changePassword">修改密码</button><a href="'+HOME_URL+'" class="admin-btn admin-btn-sm" target="_blank" rel="noopener noreferrer">查看网站</a></div></div><div class="admin-content">'+renderAlerts()+content+'</div></div>' + renderModal();
    }

    function render(){ var app = document.getElementById('admin-app'); if(app) app.innerHTML = renderApp(); bindEvents(); loadReviewImages(); }

    // Phase 3: re-render safe image loader. No per-URL "already loaded" guard —
    // loadReviewImage() caches the object URL in state.reviewObjectUrls and reuses
    // it, so re-render sets the same src without a duplicate network request.
    function loadReviewImages(){
        document.querySelectorAll('[data-review-image-url]').forEach(function(el){
            var url = el.getAttribute('data-review-image-url');
            if(!url) return;
            var img = el.querySelector('img');
            if(img) loadReviewImage(img, url);
        });
    }

    function bindEvents(){
        var lf = document.getElementById('login-form'); if(lf) lf.addEventListener('submit', handleLogin);
        var lp = document.getElementById('login-password'); if(lp) lp.addEventListener('keydown', function(e){ if(e.key==='Enter') handleLogin(e); });
        var lu = document.getElementById('login-username'); if(lu) lu.addEventListener('keydown', function(e){ if(e.key==='Enter') handleLogin(e); });

        document.querySelectorAll('.admin-nav-item[data-section]').forEach(function(b){ b.addEventListener('click', function(){ switchSection(this.getAttribute('data-section')); }); });
        document.querySelectorAll('[data-section-target]').forEach(function(b){ b.addEventListener('click', function(){ switchSection(this.getAttribute('data-section-target')); }); });

        var sb = document.getElementById('figures-search-btn'), si = document.getElementById('figures-search');
        if(sb) sb.addEventListener('click', function(){ state.figuresSearch = si.value; state.figuresPage = 1; loadFigures(); });
        if(si) si.addEventListener('keydown', function(e){ if(e.key==='Enter'){ state.figuresSearch = si.value; state.figuresPage = 1; loadFigures(); } });

        document.querySelectorAll('[data-edit-figure]').forEach(function(b){ b.addEventListener('click', function(){ openFigureEditor(this.getAttribute('data-edit-figure')); }); });
        document.querySelectorAll('[data-delete-figure]').forEach(function(b){ b.addEventListener('click', function(){ handleDeleteFigure(this.getAttribute('data-delete-figure')); }); });
        document.querySelectorAll('[data-figures-page]').forEach(function(b){ b.addEventListener('click', function(){ state.figuresPage = parseInt(this.getAttribute('data-figures-page'),10); loadFigures(); }); });
        var feb = document.getElementById('figure-edit-back'), fec = document.getElementById('figure-edit-cancel'), fsb = document.getElementById('figure-save-btn');
        if(feb) feb.addEventListener('click', closeFigureEditor);
        if(fec) fec.addEventListener('click', closeFigureEditor);
        if(fsb) fsb.addEventListener('click', handleSaveFigure);

        var esb = document.getElementById('entity-search-btn'), esi = document.getElementById('entity-search'), eab = document.getElementById('entity-add-btn');
        if(esb) esb.addEventListener('click', function(){ state.entitySearch[state.activeSection] = esi.value; render(); });
        if(esi) esi.addEventListener('keydown', function(e){ if(e.key==='Enter'){ state.entitySearch[state.activeSection] = esi.value; render(); } });
        if(eab) eab.addEventListener('click', function(){ openEntityEditor(state.activeSection, null); });
        document.querySelectorAll('[data-edit-entity]').forEach(function(b){ b.addEventListener('click', function(){ openEntityEditor(this.getAttribute('data-edit-entity'), this.getAttribute('data-entity-slug')); }); });
        document.querySelectorAll('[data-delete-entity]').forEach(function(b){ b.addEventListener('click', function(){ handleDeleteEntity(this.getAttribute('data-delete-entity'), this.getAttribute('data-entity-slug')); }); });
        document.querySelectorAll('[data-entity-page]').forEach(function(b){ b.addEventListener('click', function(){ state.entityPage[state.activeSection] = parseInt(this.getAttribute('data-entity-page'),10); loadEntity(state.activeSection); }); });
        var eeb = document.getElementById('entity-edit-back'), eec = document.getElementById('entity-edit-cancel'), esave = document.getElementById('entity-save-btn');
        if(eeb) eeb.addEventListener('click', closeEntityEditor);
        if(eec) eec.addEventListener('click', closeEntityEditor);
        if(esave) esave.addEventListener('click', handleSaveEntity);

        document.querySelectorAll('[data-review-filter]').forEach(function(b){
            b.addEventListener('click', function(){ state.reviewStatus = this.getAttribute('data-review-filter'); state.reviewPage = 1; loadReviewItems(); });
        });
        var rr = document.getElementById('review-refresh-btn'); if(rr) rr.addEventListener('click', loadReviewItems);
        document.querySelectorAll('[data-review-page]').forEach(function(b){
            b.addEventListener('click', function(){ state.reviewPage = parseInt(this.getAttribute('data-review-page'),10); loadReviewItems(); });
        });
        document.querySelectorAll('[data-review-edit]').forEach(function(b){
            b.addEventListener('click', function(){ handleReviewEdit(this.getAttribute('data-review-id')); });
        });
        document.querySelectorAll('[data-review-action]').forEach(function(b){
            b.addEventListener('click', function(){
                var id = this.getAttribute('data-review-id');
                var action = this.getAttribute('data-review-action');
                if(!id || !action) return;
                // Phase 3: double-click guard — if this (id,action) is already inflight, ignore
                if(isReviewActionInflight(id, action)) return;
                var confirmMsg = action === 'approve_image' ? '确定要批准该候选图片为主图吗？' :
                    action === 'reject_image' ? '确定拒绝该候选图吗？' :
                    action === 'keep_placeholder' ? '确定保留当前占位图吗？' :
                    action === 'mark_detail_ok' ? '确定该详情无误吗？' :
                    action === 'mark_needs_manual_edit' ? '确定标记为需人工编辑吗？' :
                    action === 'request_refetch' ? '确定请求爬虫重新抓取吗？' :
                    action === 'keep_pending' ? '标记为无法判断，保留待审状态吗？' : '';
                if(confirmMsg && !confirm(confirmMsg)) return;
                if(action === 'keep_pending'){
                    state.keepPendingId = id;
                    state.keepPendingReason = '';
                    state.showModal = 'keepPending';
                    render();
                    setTimeout(function(){
                        var ta = document.getElementById('kp-reason');
                        if(ta) ta.focus();
                    }, 50);
                    return;
                }
                // Unified handler: inflight dedup (id+action), AbortController (aborted on page switch),
                // button disabled during action, API call (no local spoofing), loadReviewItems() on success.
                handleReviewAction(id, action);
            });
            });

        var cp = document.getElementById('cache-purge-btn'); if(cp) cp.addEventListener('click', handleCachePurge);

        document.querySelectorAll('[data-user-role]').forEach(function(s){ s.addEventListener('change', function(){ handleUpdateUser(this.getAttribute('data-user-role'), 'role', this.value); }); });

        var cpb = document.getElementById('change-pwd-btn'); if(cpb) cpb.addEventListener('click', handleChangePassword);

        var cub = document.getElementById('create-user-btn'); if(cub) cub.addEventListener('click', handleCreateUser);
        var addUserBtn = document.getElementById('add-user-btn'); if(addUserBtn) addUserBtn.addEventListener('click', function(){ state.newUserForm = {username:'',password:'',role:'viewer'}; showModal('createUser'); });

        if(state.showModal === 'createUser'){
            ['username','password','role'].forEach(function(field){
                var el = document.getElementById('nu-'+field);
                if(el){
                    var eventType = (field==='role') ? 'change' : 'input';
                    el.addEventListener(eventType, function(e){
                        state.newUserForm[field] = field==='role' ? e.target.value : e.target.value || '';
                    });
                    if(field==='role') state.newUserForm.role = el.value;
                    else state.newUserForm[field] = el.value || '';
                }
            });
        }

        // Phase 3: keep_pending modal — re-bind after every render.
        // Uses handleReviewAction() for inflight dedup + AbortController + double-click guard.
        if(state.showModal === 'keepPending'){
            var kpBtn = document.getElementById('kp-submit-btn');
            if(kpBtn) kpBtn.addEventListener('click', function(){
                if(state.loading.keepPending) return; // double-click guard
                var reason = document.getElementById('kp-reason');
                var reasonVal = reason ? reason.value : '';
                var kid = state.keepPendingId;
                if(!kid) return;
                state.loading.keepPending = true;
                render();
                handleReviewAction(kid, 'keep_pending', {
                    notes: reasonVal,
                    onSuccess: function(){ state.showModal = null; },
                    onFinally: function(){ state.loading.keepPending = false; }
                });
            });
            var kpReason = document.getElementById('kp-reason');
            if(kpReason) kpReason.addEventListener('input', function(e){ state.keepPendingReason = e.target.value; });
        }

        // CSP-safe click delegation for data-* attributes
        document.addEventListener('click', function(e){
            var t = e.target;
            while(t && t !== document){
                if(t.hasAttribute('data-resume-session')){ resumeSession(); return; }
                if(t.hasAttribute('data-close-modal')){
                    if(t.classList.contains('admin-modal-overlay') && e.target !== t){ t = t.parentElement; continue; }
                    closeModal(); return;
                }
                if(t.hasAttribute('data-toggle-theme')){ toggleTheme(); return; }
                if(t.hasAttribute('data-logout')){ logout(); return; }
                if(t.hasAttribute('data-close-mobile-sidebar')){ closeMobileSidebar(); return; }
                if(t.hasAttribute('data-open-mobile-sidebar')){ openMobileSidebar(); return; }
                if(t.hasAttribute('data-show-modal')){ showModal(t.getAttribute('data-show-modal')); return; }
                if(t.hasAttribute('data-reset-password')){ handleResetPassword(t.getAttribute('data-reset-password')); return; }
                if(t.hasAttribute('data-delete-user')){
                    handleDeleteUser(t.getAttribute('data-delete-user'), t.getAttribute('data-delete-user-name'));
                    return;
                }
                if(t.hasAttribute('data-toggle-password')){
                    togglePassword(t.getAttribute('data-toggle-password'), t.getAttribute('data-toggle-icon'));
                    return;
                }
                if(t.hasAttribute('data-review-lightbox')){
                    window.open(t.getAttribute('data-review-lightbox'), '_blank');
                    return;
                }
                t = t.parentElement;
            }
        });
    }

    function loadSavedTheme(){
        var m = document.cookie.match(/(?:^|;\s*)mw_theme=([^;]*)/);
        if(m && m[1]) document.documentElement.setAttribute('data-theme', m[1]);
    }
    loadSavedTheme();

    window._mwAdmin = {
        logout: logout, toggleTheme: toggleTheme, togglePassword: togglePassword,
        closeMobileSidebar: closeMobileSidebar, openMobileSidebar: openMobileSidebar,
        showModal: showModal, closeModal: closeModal,
        handleResetPassword: handleResetPassword, handleDeleteUser: handleDeleteUser,
        resumeSession: resumeSession
    };

    render();

    if(state.token){
        api('/auth/me', 'GET', null, true).then(function(r){
            if(!r.success) logout();
            else { state.user = r.data; sessionStorage.setItem('mw_admin_user', JSON.stringify(r.data)); resetIdle(); render(); loadStats(); }
        }).catch(function(){ logout(); });
    }

    var idleEvents = 'mousemove keydown mousedown touchstart scroll'.split(' ');
    idleEvents.forEach(function(evt){ document.addEventListener(evt, function(){ resetIdle(); }, {passive: true}); });
    if(state.token) resetIdle();
})();
</script>
</body>
</html>
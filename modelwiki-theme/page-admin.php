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
?><!DOCTYPE html>
<html lang="en" data-theme="<?php echo esc_attr($theme); ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin &mdash; ModelWiki</title>
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
    --mw-shadow:0 4px 6px -1px rgba(15,23,42,0.06),0 2px 4px -2px rgba(15,23,42,0.04);
    --mw-shadow-lg:0 10px 15px -3px rgba(15,23,42,0.07),0 4px 6px -4px rgba(15,23,42,0.04);
    --mw-shadow-xl:0 20px 25px -5px rgba(15,23,42,0.07),0 8px 10px -6px rgba(15,23,42,0.03);
    --mw-radius-sm:6px;
    --mw-radius:10px;
    --mw-radius-lg:16px;
    --mw-radius-full:9999px;
    --mw-font-heading:'Playfair Display',Georgia,serif;
    --mw-font-body:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
    --mw-font-mono:'JetBrains Mono','Fira Code',monospace;
    --mw-transition:0.2s cubic-bezier(0.4,0,0.2,1);
    color-scheme:light dark
}
[data-theme="dark"]{
    --mw-bg:#0B0F1A;
    --mw-bg-alt:#111827;
    --mw-card:#1A1F2E;
    --mw-card-hover:#1E2435;
    --mw-text:#F1F5F9;
    --mw-text-secondary:#94A3B8;
    --mw-text-tertiary:#64748B;
    --mw-border:#1E293B;
    --mw-border-light:#1A1F2E;
    --mw-accent-soft:rgba(232,85,61,0.15);
    --mw-success-soft:rgba(16,185,129,0.15);
    --mw-warning-soft:rgba(245,158,11,0.15);
    --mw-error-soft:rgba(239,68,68,0.15);
    --mw-shadow-sm:0 1px 2px rgba(0,0,0,0.2);
    --mw-shadow:0 4px 6px -1px rgba(0,0,0,0.3),0 2px 4px -2px rgba(0,0,0,0.2);
    --mw-shadow-lg:0 10px 15px -3px rgba(0,0,0,0.35),0 4px 6px -4px rgba(0,0,0,0.2);
    --mw-shadow-xl:0 20px 25px -5px rgba(0,0,0,0.4),0 8px 10px -6px rgba(0,0,0,0.25)
}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{
    font-family:var(--mw-font-body);
    font-size:1rem;
    line-height:1.6;
    color:var(--mw-text);
    background:var(--mw-bg);
    -webkit-font-smoothing:antialiased;
    -moz-osx-font-smoothing:grayscale;
    transition:background var(--mw-transition),color var(--mw-transition)
}
a{color:var(--mw-accent);text-decoration:none;transition:color var(--mw-transition)}
a:hover{color:var(--mw-accent-hover)}
button{cursor:pointer;font-family:inherit}
input,select,textarea{font-family:inherit;font-size:inherit}
h1,h2,h3,h4,h5,h6{font-family:var(--mw-font-heading);font-weight:600;line-height:1.2;color:var(--mw-text)}
h1{font-size:2.5rem;letter-spacing:-0.02em}
h2{font-size:1.75rem;letter-spacing:-0.01em}
h3{font-size:1.375rem}
h4{font-size:1.125rem}

.admin-layout{display:flex;min-height:100vh}
.admin-sidebar{
    width:260px;
    background:var(--mw-primary);
    color:#fff;
    display:flex;
    flex-direction:column;
    position:fixed;
    top:0;
    left:0;
    bottom:0;
    z-index:50;
    transition:transform var(--mw-transition)
}
[data-theme="dark"] .admin-sidebar{background:var(--mw-card);border-right:1px solid var(--mw-border)}
.admin-sidebar-brand{
    padding:20px 24px;
    border-bottom:1px solid rgba(255,255,255,0.06);
    display:flex;
    align-items:center;
    justify-content:space-between
}
[data-theme="dark"] .admin-sidebar-brand{border-bottom-color:var(--mw-border)}
.admin-sidebar-brand a{
    font-family:var(--mw-font-heading);
    font-size:1.25rem;
    font-weight:700;
    color:#fff;
    letter-spacing:-0.02em
}
[data-theme="dark"] .admin-sidebar-brand a{color:var(--mw-text)}
.admin-sidebar-brand a:hover{opacity:.85;text-decoration:none;color:#fff}
[data-theme="dark"] .admin-sidebar-brand a:hover{color:var(--mw-text)}
.admin-sidebar-theme{
    background:none;
    border:1px solid rgba(255,255,255,0.1);
    border-radius:var(--mw-radius-sm);
    color:rgba(255,255,255,0.6);
    padding:6px;
    display:flex;
    align-items:center;
    justify-content:center;
    width:32px;
    height:32px
}
[data-theme="dark"] .admin-sidebar-theme{border-color:var(--mw-border);color:var(--mw-text-secondary)}
.admin-sidebar-theme:hover{color:#fff;background:rgba(255,255,255,0.08)}
[data-theme="dark"] .admin-sidebar-theme:hover{color:var(--mw-text);background:var(--mw-bg-alt)}
.admin-sidebar-theme svg{width:16px;height:16px}
.admin-sidebar-theme .icon-moon{display:none}
[data-theme="dark"] .admin-sidebar-theme .icon-moon{display:block}
[data-theme="dark"] .admin-sidebar-theme .icon-sun{display:none}
.admin-sidebar-nav{flex:1;padding:12px;overflow-y:auto}
.admin-nav-section{
    font-size:.6875rem;
    font-weight:600;
    text-transform:uppercase;
    letter-spacing:0.08em;
    color:rgba(255,255,255,0.35);
    padding:16px 12px 8px
}
[data-theme="dark"] .admin-nav-section{color:var(--mw-text-tertiary)}
.admin-nav-item{
    display:flex;
    align-items:center;
    gap:10px;
    padding:10px 12px;
    border-radius:var(--mw-radius-sm);
    color:rgba(255,255,255,0.65);
    font-size:.875rem;
    font-weight:500;
    transition:all var(--mw-transition);
    cursor:pointer;
    border:none;
    background:none;
    width:100%;
    text-align:left
}
[data-theme="dark"] .admin-nav-item{color:var(--mw-text-secondary)}
.admin-nav-item:hover{color:#fff;background:rgba(255,255,255,0.08)}
[data-theme="dark"] .admin-nav-item:hover{color:var(--mw-text);background:var(--mw-bg-alt)}
.admin-nav-item.active{color:#fff;background:rgba(232,85,61,0.9)}
[data-theme="dark"] .admin-nav-item.active{color:#fff;background:var(--mw-accent)}
.admin-nav-item svg{width:18px;height:18px;flex-shrink:0}
.admin-sidebar-footer{
    padding:16px;
    border-top:1px solid rgba(255,255,255,0.06)
}
[data-theme="dark"] .admin-sidebar-footer{border-top-color:var(--mw-border)}
.admin-user-info{
    display:flex;
    align-items:center;
    gap:10px;
    padding:8px;
    border-radius:var(--mw-radius-sm)
}
.admin-user-avatar{
    width:36px;
    height:36px;
    border-radius:var(--mw-radius-full);
    background:var(--mw-accent);
    display:flex;
    align-items:center;
    justify-content:center;
    color:#fff;
    font-weight:700;
    font-size:.875rem;
    flex-shrink:0
}
.admin-user-details{flex:1;min-width:0}
.admin-user-name{font-size:.875rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-theme="dark"] .admin-user-name{color:var(--mw-text)}
.admin-user-role{font-size:.75rem;color:rgba(255,255,255,0.45)}
[data-theme="dark"] .admin-user-role{color:var(--mw-text-tertiary)}
.admin-logout-btn{
    background:none;
    border:none;
    color:rgba(255,255,255,0.45);
    padding:6px;
    border-radius:var(--mw-radius-sm);
    display:flex;
    align-items:center;
    transition:all var(--mw-transition)
}
[data-theme="dark"] .admin-logout-btn{color:var(--mw-text-tertiary)}
.admin-logout-btn:hover{color:var(--mw-error);background:var(--mw-error-soft)}
.admin-logout-btn svg{width:18px;height:18px}

.admin-main{
    flex:1;
    margin-left:260px;
    min-height:100vh
}
.admin-topbar{
    height:64px;
    background:var(--mw-card);
    border-bottom:1px solid var(--mw-border);
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:0 32px;
    position:sticky;
    top:0;
    z-index:40
}
.admin-topbar-title{
    font-family:var(--mw-font-body);
    font-size:1.125rem;
    font-weight:600;
    color:var(--mw-text)
}
.admin-topbar-actions{display:flex;align-items:center;gap:12px}
.admin-mobile-toggle{
    display:none;
    background:none;
    border:none;
    color:var(--mw-text);
    padding:8px
}
.admin-mobile-toggle svg{width:22px;height:22px}
.admin-content{padding:32px}

.admin-login-wrapper{
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    background:var(--mw-bg);
    padding:24px
}
.admin-login-card{
    width:100%;
    max-width:400px;
    background:var(--mw-card);
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius-lg);
    padding:40px;
    box-shadow:var(--mw-shadow-lg)
}
.admin-login-logo{
    font-family:var(--mw-font-heading);
    font-size:1.75rem;
    font-weight:700;
    color:var(--mw-text);
    text-align:center;
    margin-bottom:8px
}
.admin-login-subtitle{
    text-align:center;
    color:var(--mw-text-secondary);
    font-size:.875rem;
    margin-bottom:32px
}
.admin-form-group{margin-bottom:20px}
.admin-form-label{
    display:block;
    font-size:.8125rem;
    font-weight:600;
    color:var(--mw-text-secondary);
    margin-bottom:6px;
    text-transform:uppercase;
    letter-spacing:0.04em
}
.admin-form-input{
    width:100%;
    padding:10px 14px;
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius-sm);
    background:var(--mw-bg);
    color:var(--mw-text);
    font-size:.9375rem;
    transition:all var(--mw-transition);
    outline:none
}
.admin-form-input:focus{
    border-color:var(--mw-accent);
    box-shadow:0 0 0 3px var(--mw-accent-soft)
}
.admin-form-input::placeholder{color:var(--mw-text-tertiary)}
.admin-form-textarea{
    width:100%;
    padding:10px 14px;
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius-sm);
    background:var(--mw-bg);
    color:var(--mw-text);
    font-size:.8125rem;
    font-family:var(--mw-font-mono);
    line-height:1.5;
    resize:vertical;
    min-height:160px;
    transition:all var(--mw-transition);
    outline:none
}
.admin-form-textarea:focus{
    border-color:var(--mw-accent);
    box-shadow:0 0 0 3px var(--mw-accent-soft)
}
.admin-btn{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    gap:8px;
    padding:10px 20px;
    border-radius:var(--mw-radius-sm);
    font-size:.875rem;
    font-weight:600;
    border:1px solid var(--mw-border);
    background:var(--mw-card);
    color:var(--mw-text);
    transition:all var(--mw-transition);
    cursor:pointer;
    white-space:nowrap
}
.admin-btn:hover{background:var(--mw-bg-alt)}
.admin-btn:disabled{opacity:.5;cursor:not-allowed}
.admin-btn-primary{background:var(--mw-accent);color:#fff;border-color:var(--mw-accent)}
.admin-btn-primary:hover{background:var(--mw-accent-hover);border-color:var(--mw-accent-hover)}
.admin-btn-primary:disabled{opacity:.5;cursor:not-allowed}
.admin-btn-danger{background:var(--mw-error);color:#fff;border-color:var(--mw-error)}
.admin-btn-danger:hover{background:#DC2626;border-color:#DC2626}
.admin-btn-success{background:var(--mw-success);color:#fff;border-color:var(--mw-success)}
.admin-btn-success:hover{background:#059669;border-color:#059669}
.admin-btn-sm{padding:6px 12px;font-size:.8125rem}
.admin-btn-block{width:100%}

.admin-stats-grid{
    display:grid;
    grid-template-columns:repeat(4,1fr);
    gap:20px;
    margin-bottom:32px
}
.admin-stat-card{
    background:var(--mw-card);
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius);
    padding:24px;
    transition:box-shadow var(--mw-transition)
}
.admin-stat-card:hover{box-shadow:var(--mw-shadow)}
.admin-stat-icon{
    width:40px;
    height:40px;
    border-radius:var(--mw-radius-sm);
    display:flex;
    align-items:center;
    justify-content:center;
    margin-bottom:16px
}
.admin-stat-icon svg{width:20px;height:20px}
.admin-stat-icon.figures{background:var(--mw-accent-soft);color:var(--mw-accent)}
.admin-stat-icon.manufacturers{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-stat-icon.series{background:var(--mw-warning-soft);color:var(--mw-warning)}
.admin-stat-icon.users{background:rgba(99,102,241,0.1);color:#6366F1}
.admin-stat-value{
    font-family:var(--mw-font-heading);
    font-size:2rem;
    font-weight:700;
    color:var(--mw-text);
    line-height:1;
    margin-bottom:4px;
    font-variant-numeric:tabular-nums
}
.admin-stat-label{font-size:.8125rem;color:var(--mw-text-secondary);font-weight:500}

.admin-card{
    background:var(--mw-card);
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius);
    margin-bottom:24px;
    overflow:hidden
}
.admin-card-header{
    padding:20px 24px;
    border-bottom:1px solid var(--mw-border);
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:16px
}
.admin-card-title{
    font-family:var(--mw-font-body);
    font-size:1rem;
    font-weight:600;
    color:var(--mw-text)
}
.admin-card-body{padding:24px}
.admin-card-footer{
    padding:16px 24px;
    border-top:1px solid var(--mw-border);
    display:flex;
    align-items:center;
    justify-content:space-between
}

.admin-table{width:100%;border-collapse:collapse}
.admin-table th{
    text-align:left;
    padding:12px 16px;
    font-size:.75rem;
    font-weight:600;
    text-transform:uppercase;
    letter-spacing:0.06em;
    color:var(--mw-text-secondary);
    background:var(--mw-bg-alt);
    border-bottom:1px solid var(--mw-border)
}
.admin-table td{
    padding:12px 16px;
    font-size:.875rem;
    color:var(--mw-text);
    border-bottom:1px solid var(--mw-border-light)
}
.admin-table tr:last-child td{border-bottom:none}
.admin-table tr:hover td{background:var(--mw-bg-alt)}

.admin-badge{
    display:inline-flex;
    align-items:center;
    padding:2px 10px;
    border-radius:var(--mw-radius-full);
    font-size:.75rem;
    font-weight:600;
    letter-spacing:0.02em
}
.admin-badge-admin{background:var(--mw-accent-soft);color:var(--mw-accent)}
.admin-badge-editor{background:var(--mw-warning-soft);color:var(--mw-warning)}
.admin-badge-viewer{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-badge-active{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-badge-inactive{background:var(--mw-error-soft);color:var(--mw-error)}
.admin-badge-queued{background:var(--mw-warning-soft);color:var(--mw-warning)}
.admin-badge-completed{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-badge-error{background:var(--mw-error-soft);color:var(--mw-error)}
.admin-badge-created{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-badge-skipped{background:var(--mw-bg-alt);color:var(--mw-text-secondary)}
.admin-badge-updated{background:rgba(99,102,241,0.1);color:#6366F1}

.admin-search-bar{
    display:flex;
    gap:8px;
    margin-bottom:20px
}
.admin-search-input{
    flex:1;
    padding:8px 14px;
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius-sm);
    background:var(--mw-bg);
    color:var(--mw-text);
    font-size:.875rem;
    outline:none;
    transition:all var(--mw-transition)
}
.admin-search-input:focus{border-color:var(--mw-accent);box-shadow:0 0 0 3px var(--mw-accent-soft)}
.admin-search-input::placeholder{color:var(--mw-text-tertiary)}

.admin-spinner{
    width:20px;
    height:20px;
    border:2px solid var(--mw-border);
    border-top-color:var(--mw-accent);
    border-radius:50%;
    animation:admin-spin 0.6s linear infinite
}
@keyframes admin-spin{to{transform:rotate(360deg)}}
.admin-spinner-lg{width:40px;height:40px;border-width:3px}

.admin-loading{
    display:flex;
    align-items:center;
    justify-content:center;
    padding:48px;
    color:var(--mw-text-tertiary)
}

.admin-alert{
    padding:12px 16px;
    border-radius:var(--mw-radius-sm);
    font-size:.875rem;
    font-weight:500;
    margin-bottom:16px;
    display:flex;
    align-items:center;
    gap:8px
}
.admin-alert-success{background:var(--mw-success-soft);color:var(--mw-success)}
.admin-alert-error{background:var(--mw-error-soft);color:var(--mw-error)}
.admin-alert-warning{background:var(--mw-warning-soft);color:var(--mw-warning)}
.admin-alert-info{background:rgba(99,102,241,0.1);color:#6366F1}

.admin-section{display:none}
.admin-section.active{display:block}

.admin-import-grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:24px
}
.admin-import-status{
    margin-top:16px;
    padding:16px;
    background:var(--mw-bg-alt);
    border-radius:var(--mw-radius-sm);
    font-size:.875rem
}
[data-theme="dark"] .admin-import-status{background:var(--mw-bg)}
.admin-import-status dt{font-weight:600;color:var(--mw-text);margin-bottom:4px}
.admin-import-status dd{color:var(--mw-text-secondary);margin-bottom:12px;margin-left:0}
.admin-import-status dd:last-child{margin-bottom:0}

.admin-crawler-grid{
    display:grid;
    grid-template-columns:repeat(3,1fr);
    gap:16px;
    margin-bottom:24px
}
.admin-crawler-card{
    background:var(--mw-card);
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius);
    padding:20px;
    text-align:center;
    transition:all var(--mw-transition)
}
.admin-crawler-card:hover{box-shadow:var(--mw-shadow)}
.admin-crawler-card h4{
    font-family:var(--mw-font-body);
    font-size:.9375rem;
    font-weight:600;
    margin-bottom:4px
}
.admin-crawler-card p{font-size:.8125rem;color:var(--mw-text-secondary);margin-bottom:16px}

.admin-empty{
    text-align:center;
    padding:48px 24px;
    color:var(--mw-text-tertiary)
}
.admin-empty svg{width:48px;height:48px;margin-bottom:16px;opacity:.4}
.admin-empty p{font-size:.9375rem}

.admin-figure-thumb{
    width:40px;
    height:40px;
    border-radius:var(--mw-radius-sm);
    object-fit:cover;
    background:var(--mw-bg-alt)
}

.admin-pagination{
    display:flex;
    align-items:center;
    justify-content:center;
    gap:4px;
    margin-top:20px
}
.admin-page-btn{
    display:flex;
    align-items:center;
    justify-content:center;
    min-width:32px;
    height:32px;
    padding:0 8px;
    border:1px solid var(--mw-border);
    border-radius:var(--mw-radius-sm);
    background:var(--mw-card);
    color:var(--mw-text-secondary);
    font-size:.8125rem;
    font-weight:500;
    cursor:pointer;
    transition:all var(--mw-transition)
}
.admin-page-btn:hover,.admin-page-btn.active{
    background:var(--mw-accent);
    color:#fff;
    border-color:var(--mw-accent)
}
.admin-page-btn:disabled{opacity:.4;cursor:not-allowed}

.admin-overlay{
    display:none;
    position:fixed;
    inset:0;
    background:rgba(0,0,0,0.5);
    z-index:45
}
.admin-overlay.open{display:block}
.admin-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;display:flex;align-items:center;justify-content:center;padding:20px}
.admin-modal{background:var(--mw-card,#fff);border-radius:var(--mw-radius-lg,12px);padding:24px;max-width:600px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.15);overflow-y:auto}
.admin-btn-outline{background:transparent;border:1px solid var(--mw-border,#e2e8f0);color:var(--mw-text,#1e293b)}
.admin-btn-outline:hover{background:var(--mw-bg-alt,#f1f5f9)}

@keyframes admin-fade-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.admin-animate{animation:admin-fade-in 0.3s ease both}

@media(max-width:1024px){
    .admin-stats-grid{grid-template-columns:repeat(2,1fr)}
    .admin-import-grid{grid-template-columns:1fr}
    .admin-crawler-grid{grid-template-columns:1fr 1fr}
}
@media(max-width:768px){
    .admin-sidebar{transform:translateX(-100%)}
    .admin-sidebar.open{transform:translateX(0)}
    .admin-main{margin-left:0}
    .admin-mobile-toggle{display:flex}
    .admin-content{padding:20px}
    .admin-topbar{padding:0 16px}
    .admin-stats-grid{grid-template-columns:1fr 1fr}
    .admin-crawler-grid{grid-template-columns:1fr}
}
@media(max-width:640px){
    .admin-stats-grid{grid-template-columns:1fr}
    .admin-table{font-size:.8125rem}
    .admin-table th,.admin-table td{padding:8px 12px}
}
    </style>
</head>
<body>

<div id="admin-app"><noscript><div style="padding:40px;text-align:center;color:red">JavaScript is disabled. Please enable JavaScript to use the admin panel.</div></noscript></div>

<script data-cfasync="false" nonce="<?php echo esc_attr($GLOBALS['mw_csp_nonce'] ?? ''); ?>">
window.API_BASE = <?php echo json_encode($api_base); ?>;
window.HOME_URL = <?php echo json_encode($home_url); ?>;
</script>
<script data-cfasync="false" src="<?php echo esc_url(get_template_directory_uri()); ?>/assets/js/admin.js"></script>
</body>
</html>
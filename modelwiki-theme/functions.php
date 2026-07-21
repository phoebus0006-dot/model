<?php
if (!defined('ABSPATH')) exit;

if (!defined('MW_API_URL')) {
    $env_api_url = getenv('MW_API_URL') ?: getenv('MODELWIKI_API_URL');
    define('MW_API_URL', $env_api_url ?: 'http://127.0.0.1:3000/api/v1');
}
define('MODELWIKI_THEME_VERSION', '2.7.7');

// Load i18n functions (mw_t, mw_lang, mw_price_eur, mw_lang_switcher)
require get_template_directory() . '/languages.php';

function mw_theme_setup() {
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    add_theme_support('html5', ['search-form', 'comment-form', 'gallery', 'caption']);
    register_nav_menus(['primary' => 'Primary Menu']);
}
add_action('after_setup_theme', 'mw_theme_setup');

remove_action('wp_head', 'print_emoji_detection_script', 7);
remove_action('wp_print_styles', 'print_emoji_styles');
remove_action('admin_print_scripts', 'print_emoji_detection_script');
remove_action('admin_print_styles', 'print_emoji_styles');

function mw_security_headers() {
    if (headers_sent() || is_admin()) return;

    if (!isset($GLOBALS['mw_csp_nonce'])) {
        $GLOBALS['mw_csp_nonce'] = bin2hex(random_bytes(16));
    }
    $nonce = $GLOBALS['mw_csp_nonce'];

    $csp = [
        "default-src 'self'",
        "script-src 'self' 'nonce-" . $nonce . "'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
        'upgrade-insecure-requests',
    ];

    header('Content-Security-Policy: ' . implode('; ', $csp));
    header('X-Frame-Options: SAMEORIGIN');
    $forwarded_proto = strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '');
    if (is_ssl() || $forwarded_proto === 'https') {
        header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    }
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('Cross-Origin-Resource-Policy: same-site');
    header('X-Permitted-Cross-Domain-Policies: none');
}
add_action('send_headers', 'mw_security_headers');

function mw_add_rewrite_rules() {
    add_rewrite_rule('^figure/([^/]+)/?$', 'index.php?figure_slug=$matches[1]', 'top');
    add_rewrite_rule('^series/([^/]+)/?$', 'index.php?series_slug=$matches[1]', 'top');
    add_rewrite_rule('^manufacturer/([^/]+)/?$', 'index.php?manufacturer_slug=$matches[1]', 'top');
    add_rewrite_rule('^sculptor/([^/]+)/?$', 'index.php?sculptor_slug=$matches[1]', 'top');
    add_rewrite_rule('^account/?$', 'index.php?mw_account=1', 'top');
}
add_action('init', 'mw_add_rewrite_rules');

function mw_add_query_vars($vars) {
    $vars[] = 'figure_slug';
    $vars[] = 'series_slug';
    $vars[] = 'manufacturer_slug';
    $vars[] = 'sculptor_slug';
    $vars[] = 'mw_account';
    return $vars;
}
add_filter('query_vars', 'mw_add_query_vars');

function mw_figure_template_include($template) {
    $figure_slug = get_query_var('figure_slug');
    if ($figure_slug) {
        $new_template = locate_template(['page-figure.php']);
        if ($new_template) return $new_template;
    }
    $series_slug = get_query_var('series_slug');
    if ($series_slug) {
        $new_template = locate_template(['page-series-list.php', 'page-series.php']);
        if ($new_template) return $new_template;
    }
    $manufacturer_slug = get_query_var('manufacturer_slug');
    if ($manufacturer_slug) {
        $new_template = locate_template(['page-manufacturer.php']);
        if ($new_template) return $new_template;
    }
    $sculptor_slug = get_query_var('sculptor_slug');
    if ($sculptor_slug) {
        $new_template = locate_template(['page-sculptor.php']);
        if ($new_template) return $new_template;
    }
    return $template;
}
add_filter('template_include', 'mw_figure_template_include');

function mw_theme_scripts() {
    $css_file = get_template_directory() . '/assets/css/main-v27.css';
    $js_file  = get_template_directory() . '/assets/js/main-v27.js';
    $css_ver  = file_exists($css_file) ? filemtime($css_file) : MODELWIKI_THEME_VERSION;
    $js_ver   = file_exists($js_file) ? filemtime($js_file) : MODELWIKI_THEME_VERSION;

    wp_enqueue_style('modelwiki-main', get_template_directory_uri() . '/assets/css/main-v27.css', [], $css_ver);
    wp_enqueue_script('modelwiki-main', get_template_directory_uri() . '/assets/js/main-v27.js', [], $js_ver, true);
}
add_action('wp_enqueue_scripts', 'mw_theme_scripts');

/**
 * Low-level API GET request with detailed diagnostic logging.
 * Logs network errors, HTTP response codes, latency (duration_ms), and invalid JSON payloads.
 */
function mw_api_get($endpoint, $params = []) {
    static $logged_errors = [];
    $url = MW_API_URL . $endpoint;
    if (!empty($params)) {
        $url .= '?' . http_build_query($params);
    }

    $start_time = microtime(true);
    $response = wp_remote_get($url, ['timeout' => 10]);
    $duration_ms = round((microtime(true) - $start_time) * 1000, 2);

    if (is_wp_error($response)) {
        $err_msg = $response->get_error_message();
        error_log(sprintf('[MW_API_ERROR] Endpoint: %s | Network Error: %s | Duration: %.2f ms', $endpoint, $err_msg, $duration_ms));
        return null;
    }

    $code = wp_remote_retrieve_response_code($response);
    if ($code !== 200) {
        if ($code !== 404) {
            error_log(sprintf('[MW_API_ERROR] Endpoint: %s | HTTP Code: %d | Duration: %.2f ms', $endpoint, $code, $duration_ms));
        }
        return null;
    }

    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    if (!is_array($data)) {
        error_log(sprintf('[MW_API_ERROR] Endpoint: %s | Invalid JSON Payload | Duration: %.2f ms', $endpoint, $duration_ms));
        return null;
    }

    return $data;
}

/**
 * Structured API fetch - returns {success, data, meta, body}.
 */
function mw_api_fetch($endpoint, $params = []) {
    $data = mw_api_get($endpoint, $params);
    if ($data === null) {
        return ['success' => false, 'data' => null, 'meta' => null, 'body' => null];
    }
    if (isset($data['success']) && $data['success'] === false) {
        return $data;
    }
    return [
        'success' => true,
        'data'    => $data['data'] ?? $data,
        'meta'    => $data['meta'] ?? null,
        'body'    => $data,
    ];
}

/**
 * Single-item API call.
 */
function mw_api_call($endpoint, $params = []) {
    $result = mw_api_fetch($endpoint, $params);
    if (!$result['success']) {
        return null;
    }
    return $result['data'];
}

function mw_api_post($endpoint, $body = []) {
    $url = MW_API_URL . $endpoint;
    $start_time = microtime(true);
    $response = wp_remote_post($url, [
        'timeout' => 10,
        'headers' => ['Content-Type' => 'application/json'],
        'body' => json_encode($body),
    ]);
    $duration_ms = round((microtime(true) - $start_time) * 1000, 2);

    if (is_wp_error($response)) {
        error_log(sprintf('[MW_API_ERROR] POST %s | Network Error: %s | Duration: %.2f ms', $endpoint, $response->get_error_message(), $duration_ms));
        return null;
    }
    $code = wp_remote_retrieve_response_code($response);
    if ($code >= 400) {
        error_log(sprintf('[MW_API_ERROR] POST %s | HTTP Code: %d | Duration: %.2f ms', $endpoint, $code, $duration_ms));
    }
    $res_body = wp_remote_retrieve_body($response);
    $data = json_decode($res_body, true);
    if (!is_array($data)) {
        error_log(sprintf('[MW_API_ERROR] POST %s | Invalid JSON Payload | Duration: %.2f ms', $endpoint, $duration_ms));
        return null;
    }
    return $data;
}

/**
 * Build image URL from API-returned image data.
 * Reconciled order: If an image has a valid local ID, build local API URL FIRST so valid local images are never hidden by diagnostic raw thumbnail URLs.
 */
function mw_image_url($url_or_image, $width = 400, $height = 0) {
    if (is_array($url_or_image)) {
        $img = $url_or_image;

        // Preferred: If local ID is valid, use local API URL directly!
        if (!empty($img['id']) && is_numeric($img['id']) && intval($img['id']) > 0) {
            return '/api/v1/figures/images/' . intval($img['id']);
        }

        // Already a local API path
        if (!empty($img['url']) && strpos($img['url'], '/api/v1/') === 0) {
            return $img['url'];
        }

        // Refuse diagnostic raw thumbnails if no valid local ID exists
        $url_fields = ['url', 'fullUrl', 'thumbnailUrl', 'sourceUrl', 'rawUrl'];
        foreach ($url_fields as $field) {
            if (!empty($img[$field]) && mw_is_thumbnail_url($img[$field])) {
                return '';
            }
        }

        $url = $img['url'] ?? '';
    } else {
        $url = $url_or_image;
    }

    if (empty($url)) return '';

    if (mw_is_thumbnail_url($url)) {
        return '';
    }

    if (strpos($url, '/api/v1/') === 0) {
        return $url;
    }

    $width = max(1, intval($width));
    $height = $height ? max(1, intval($height)) : intval($width * 4 / 3);
    return '/img/rs:fit:' . $width . ':' . $height . '/plain/' . $url;
}

function mw_is_thumbnail_url($url) {
    if (!is_string($url) || $url === '') return false;
    $decoded = urldecode($url);
    return strpos($decoded, '/upload/items/') !== false;
}

function mw_is_merch_figure($figure) {
    if (!is_array($figure)) return false;
    $merch_slugs = ['other-merch', 'plush', 'acrylic-stand', 'badge',
                    'tapestry-poster', 'apparel-accessory', 'home-living',
                    'stationery', 'book', 'model-car', 'trading-card', 'keychain'];
    $categories = $figure['categories'] ?? [];
    foreach ($categories as $cat) {
        $cat_data = $cat['category'] ?? $cat;
        $slug = $cat_data['slug'] ?? '';
        if (in_array($slug, $merch_slugs, true)) {
            return true;
        }
    }
    return false;
}

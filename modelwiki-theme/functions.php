<?php
if (!defined('ABSPATH')) exit;

define('MW_API_URL', 'http://api:3000/api/v1');
define('MODELWIKI_THEME_VERSION', '2.7.6');

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

    // Per-request CSP nonce for inline scripts (page-admin.php uses one inline <script>)
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
    add_rewrite_rule('^characters/?$', 'index.php?mw_characters=1', 'top');
    add_rewrite_rule('^character/([^/]+)/?$', 'index.php?character_slug=$matches[1]', 'top');
    add_rewrite_rule('^series/([^/]+)/?$', 'index.php?series_slug=$matches[1]', 'top');
    add_rewrite_rule('^manufacturer/([^/]+)/?$', 'index.php?manufacturer_slug=$matches[1]', 'top');
    add_rewrite_rule('^sculptor/([^/]+)/?$', 'index.php?sculptor_slug=$matches[1]', 'top');
    add_rewrite_rule('^account/?$', 'index.php?mw_account=1', 'top');
}
add_action('init', 'mw_add_rewrite_rules');

function mw_add_query_vars($vars) {
    $vars[] = 'figure_slug';
    $vars[] = 'character_slug';
    $vars[] = 'series_slug';
    $vars[] = 'manufacturer_slug';
    $vars[] = 'sculptor_slug';
    $vars[] = 'mw_characters';
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
    $character_slug = get_query_var('character_slug');
    if ($character_slug) {
        $new_template = locate_template(['page-character.php']);
        if ($new_template) return $new_template;
    }
    if (get_query_var('mw_characters')) {
        $new_template = locate_template(['page-characters.php']);
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
    $request_path = trim(parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '', '/');
    if (get_query_var('mw_account') || $request_path === 'account') {
        $new_template = locate_template(['page-account.php']);
        if ($new_template) return $new_template;
    }
    return $template;
}
add_filter('template_include', 'mw_figure_template_include');



function mw_theme_scripts() {
    wp_enqueue_style('modelwiki-style', get_stylesheet_uri(), [], MODELWIKI_THEME_VERSION);
    wp_enqueue_style('modelwiki-main', get_template_directory_uri() . '/assets/css/main-v27.css', [], MODELWIKI_THEME_VERSION);
    wp_enqueue_script('modelwiki-feature-flags', get_template_directory_uri() . '/assets/js/feature-flags.js', [], MODELWIKI_THEME_VERSION, true);
    wp_enqueue_script('modelwiki-api-client', get_template_directory_uri() . '/assets/js/api-client.js', ['modelwiki-feature-flags'], MODELWIKI_THEME_VERSION, true);
    wp_enqueue_script('modelwiki-main', get_template_directory_uri() . '/assets/js/main-v27.js', ['modelwiki-api-client'], MODELWIKI_THEME_VERSION, true);
}
add_action('wp_enqueue_scripts', 'mw_theme_scripts');

/**
 * Low-level API GET request.
 * Returns the full decoded JSON response (including 'data' and 'meta' keys).
 */
function mw_api_get($endpoint, $params = []) {
    static $logged_errors = [];
    $url = MW_API_URL . $endpoint;
    if (!empty($params)) {
        $url .= '?' . http_build_query($params);
    }
    $response = wp_remote_get($url, ['timeout' => 10]);
    if (is_wp_error($response)) {
        $err_key = $endpoint;
        $count = $logged_errors[$err_key] ?? 0;
        if ($count < 3) {
            error_log('MW API GET error: ' . $response->get_error_message());
            $logged_errors[$err_key] = $count + 1;
        }
        return null;
    }
    $code = wp_remote_retrieve_response_code($response);
    if ($code === 404) {
        return null; // silently return null for 404s
    }
    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    if (!is_array($data)) {
        return null;
    }
    return $data;
}

/**
 * Structured API fetch - returns {success, data, meta, body} for v3.7 templates.
 * Compatible with callers that check $result['success'] and $result['data'].
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
 * Single-item API call - returns only inner 'data' for v3.7 detail pages.
 * Used by page-figure.php for /figures/{slug} endpoint.
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
    $response = wp_remote_post($url, [
        'timeout' => 10,
        'headers' => ['Content-Type' => 'application/json'],
        'body' => json_encode($body),
    ]);
    if (is_wp_error($response)) return null;
    return json_decode(wp_remote_retrieve_body($response), true);
}

/**
 * Build image URL from API-returned image data.
 * - If the URL is already a local API path (/api/v1/...), return as-is.
 * - If the URL is an external URL (MFC, etc.), proxy via imgproxy.
 * - If an image array with 'id' is provided, build the local API URL.
 *
 * Safety (HARD CONSTRAINT, DATA_CONTRACT.md §1.4):
 * MFC /upload/items/ thumbnails are NEVER returned as displayable URLs.
 * They are diagnostic-only. This check runs FIRST, before any id-based URL
 * construction, so that an image object carrying both an `id` and a
 * diagnostic raw URL cannot bypass the filter. We inspect every URL-bearing
 * field the API may return (url, fullUrl, thumbnailUrl, sourceUrl, rawUrl).
 * If ANY of them is a /upload/items/ URL, we return '' and force a placeholder.
 */
function mw_image_url($url_or_image, $width = 400, $height = 0) {
    // Handle image array from API (with id, url, size fields)
    if (is_array($url_or_image)) {
        $img = $url_or_image;

        // HARD CONSTRAINT: scan every known URL-bearing field FIRST.
        // If any of them is an MFC diagnostic thumbnail, refuse to render
        // — even if a local image id is present. This prevents an image
        // record whose raw URL is /upload/items/ from being displayed via
        // its id while its source remains a forbidden thumbnail.
        $url_fields = ['url', 'fullUrl', 'thumbnailUrl', 'sourceUrl', 'rawUrl'];
        foreach ($url_fields as $field) {
            if (!empty($img[$field]) && mw_is_thumbnail_url($img[$field])) {
                return '';
            }
        }

        // If it has a URL that's already a local API path, use it directly
        if (!empty($img['url']) && strpos($img['url'], '/api/v1/') === 0) {
            return $img['url'];
        }
        // If it has an ID, build the local API URL (preferred — bypasses raw URL)
        if (!empty($img['id'])) {
            return '/api/v1/figures/images/' . intval($img['id']);
        }
        // Fallback to url field
        $url = $img['url'] ?? '';
    } else {
        $url = $url_or_image;
    }

    if (empty($url)) return '';

    // HARD CONSTRAINT (DATA_CONTRACT §1.4): MFC /upload/items/ thumbnails
    // must never be displayed as a normal image. Return empty so callers
    // render a placeholder instead.
    if (mw_is_thumbnail_url($url)) {
        return '';
    }

    // Already a local API path - return directly
    if (strpos($url, '/api/v1/') === 0) {
        return $url;
    }

    // External URL - proxy via imgproxy
    $width = max(1, intval($width));
    $height = $height ? max(1, intval($height)) : intval($width * 4 / 3);
    return '/img/rs:fit:' . $width . ':' . $height . '/plain/' . $url;
}

/**
 * Detect MFC /upload/items/ diagnostic thumbnail URLs.
 * These are listing-page thumbnails on MFC and must never be used as a
 * primary/gallery image (DATA_CONTRACT.md §1.4, CRAWLER_ACCEPTANCE_REPORT.md §4).
 */
function mw_is_thumbnail_url($url) {
    if (!is_string($url) || $url === '') return false;
    // Match both literal and urlencoded forms (e.g. %2Fupload%2Fitems%2F)
    $decoded = urldecode($url);
    return strpos($decoded, '/upload/items/') !== false;
}

/**
 * Determine whether a figure is a merchandise item based on its categories.
 *
 * Phase 1 contract (DATA_CONTRACT.md §1.3): product_kind / is_merch are NOT
 * persisted in DB and NOT returned by the API. We infer merch status from
 * category slugs only. Anything in the merch slug set is treated as merch;
 * anything else (pvc-figure, scale-figure, nendoroid, figma, action-figure,
 * plastic-model) is treated as figure.
 *
 * Once Phase 2+ Hermes migration lands product_kind on the API, this helper
 * can be upgraded to prefer $figure['productKind'] when present.
 */
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

/**
 * Clean a description for encyclopedic display.
 *
 * Per DATA_CONTRACT.md §1.5: strips purchase information, raw URLs, HTML
 * remnants, and excessive whitespace. Returns clean text or '' for empty.
 * This is a display-layer cleanup only — the DB value is not modified.
 */
function mw_clean_description($text) {
    if (empty($text)) return '';
    if (!is_string($text)) return '';

    // Strip HTML tags and entities
    $text = wp_strip_all_tags($text);
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');

    // Remove common purchase-information prefixes/sentences
    // (e.g. "Where to Purchase ■Good Smile Company Online Store")
    $text = preg_replace('/\bWhere to Purchase\b[^\n.]*/i', '', $text);
    $text = preg_replace('/\bPurchase\b\s*[■►•]?\s*[A-Z][^\n.]*/', '', $text);

    // Remove bare URLs (http/https/www)
    $text = preg_replace('#\bhttps?://\S+#i', '', $text);
    $text = preg_replace('#\bwww\.\S+#i', '', $text);

    // Collapse repeated whitespace and trim
    $text = preg_replace('/\s{2,}/u', ' ', $text);
    $text = trim($text);

    return $text;
}

/**
 * De-duplicate a list of figures by id (primary) and slug (fallback).
 *
 * Per Acceptance criteria: prevent the same figure from rendering multiple
 * cards when it appears under multiple categories or via multiple localized
 * joins. Preserves the input order (stable).
 */
function mw_dedup_figures($figures) {
    if (!is_array($figures)) return [];
    $seen = [];
    $out = [];
    foreach ($figures as $fig) {
        if (!is_array($fig)) continue;
        $key = !empty($fig['id']) ? 'id:' . $fig['id']
             : (!empty($fig['slug']) ? 'slug:' . $fig['slug'] : null);
        if ($key === null) {
            // No stable identifier — keep but do not dedup
            $out[] = $fig;
            continue;
        }
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $out[] = $fig;
    }
    return $out;
}

/**
 * Clean a Markdown text for encyclopedic display.
 *
 * Used for active_revision['contentMd'] before md_to_html() rendering.
 * Strips raw URLs (http/https/www), "Where to Purchase" sentences, and
 * purchase-shop文案 — but PRESERVES Markdown structure (headings, lists,
 * bold/italic, code blocks, links with label). Markdown links with a real
 * label are kept (the URL lives inside the Markdown syntax, not bare).
 *
 * This is display-layer only; the DB value is not modified.
 */
function mw_clean_markdown($text) {
    if (empty($text)) return '';
    if (!is_string($text)) return '';

    // Remove "Where to Purchase ..." sentences (case-insensitive)
    $text = preg_replace('/\bWhere to Purchase\b[^\n.]*/i', '', $text);

    // Protect Markdown links [label](url) before stripping bare URLs.
    // Without this, the bare-URL regex below would eat the URL inside
    // [label](https://...) and leave a broken "[label](" fragment.
    // We replace the whole link with a sentinel carrying an index, then
    // restore the original link after bare-URL removal.
    $links = [];
    $text = preg_replace_callback(
        '/\[([^\]]*)\]\((https?:\/\/[^)\s]+|www\.[^)\s]+)\)/i',
        function ($m) use (&$links) {
            $idx = count($links);
            $links[] = $m[0];
            return "\x00MDLINK" . $idx . "\x00";
        },
        $text
    );

    // Protect inline code spans (`...`) — URLs inside backticks should be
    // deleted too, but the backticks themselves must survive so we don't
    // leave dangling code-fence markers. We strip the URL content but keep
    // the backtick wrapper.
    $text = preg_replace_callback(
        '/`([^`]*?)(https?:\/\/\S+|www\.\S+)([^`]*?)`/',
        function ($m) {
            // Remove the URL inside the code span but keep the wrapper
            // and any surrounding text. Collapse double spaces left behind.
            $inner = $m[1] . $m[3];
            $inner = preg_replace('/\s{2,}/', ' ', $inner);
            $inner = trim($inner);
            return $inner === '' ? '' : '`' . $inner . '`';
        },
        $text
    );

    // Remove bare URLs (http/https/www) that remain outside Markdown links
    // and outside code spans. Markdown links are now protected by sentinels.
    $text = preg_replace('#\bhttps?://\S+#i', '', $text);
    $text = preg_replace('#\bwww\.\S+#i', '', $text);

    // Restore protected Markdown links
    $text = preg_replace_callback(
        '/\x00MDLINK(\d+)\x00/',
        function ($m) use (&$links) {
            return $links[(int)$m[1]] ?? '';
        },
        $text
    );

    // Collapse 3+ newlines (caused by removed sentences) into 2 newlines
    // so Markdown paragraph breaks remain valid
    $text = preg_replace('/\n{3,}/', "\n\n", $text);

    // Trim trailing whitespace per line and overall
    $text = preg_replace('/[ \t]+$/m', '', $text);
    $text = trim($text);

    return $text;
}

/**
 * Get the best available display name for an entity.
 * Tries: nameEn -> English from slug -> nameJp -> name (Chinese fallback)
 */
function mw_display_name($data) {
    if (!empty($data['nameEn'])) return $data['nameEn'];
    if (!empty($data['slug'])) return ucwords(str_replace('-', ' ', $data['slug']));
    if (!empty($data['nameJp'])) return $data['nameJp'];
    return $data['name'] ?? '';
}

/**
 * Simple Markdown-to-HTML converter.
 * Handles: headings, bold, italic, links, images, lists, code blocks.
 * Safely sanitizes URLs to prevent javascript: scheme injection.
 */
function md_to_html($text) {
    if (empty($text)) return '';

    $text = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');

    // Code blocks
    $text = preg_replace('/```(\w*)\n?(.*?)```/s', '<pre><code class="language-$1">$2</code></pre>', $text);

    // Inline code
    $text = preg_replace('/`([^`]+)`/', '<code>$1</code>', $text);

    // Headings
    $text = preg_replace('/^#### (.+)$/m', '<h4>$1</h4>', $text);
    $text = preg_replace('/^### (.+)$/m', '<h3>$1</h3>', $text);
    $text = preg_replace('/^## (.+)$/m', '<h2>$1</h2>', $text);
    $text = preg_replace('/^# (.+)$/m', '<h1>$1</h1>', $text);

    // Bold and italic
    $text = preg_replace('/\*\*\*(.+?)\*\*\*/', '<strong><em>$1</em></strong>', $text);
    $text = preg_replace('/\*\*(.+?)\*\*/', '<strong>$1</strong>', $text);
    $text = preg_replace('/\*(.+?)\*/', '<em>$1</em>', $text);

    // Images — sanitize URL via callback to block dangerous schemes
    $text = preg_replace_callback('/!\[([^\]]*)\]\(([^)]+)\)/', function($m) {
        $alt = $m[1];
        $url = mw_sanitize_url($m[2]);
        if (!$url) return '';
        return '<img src="' . $url . '" alt="' . $alt . '">';
    }, $text);

    // Links — sanitize URL via callback to block dangerous schemes
    $text = preg_replace_callback('/\[([^\]]+)\]\(([^)]+)\)/', function($m) {
        $label = $m[1];
        $url = mw_sanitize_url($m[2]);
        if (!$url) return $label;
        $safe_url = htmlspecialchars($url, ENT_QUOTES, 'UTF-8');
        return '<a href="' . $safe_url . '" rel="noopener noreferrer">' . $label . '</a>';
    }, $text);

    // Horizontal rule
    $text = preg_replace('/^---$/m', '<hr>', $text);

    // Unordered lists
    $text = preg_replace('/^- (.+)$/m', '<li>$1</li>', $text);
    $text = preg_replace('/(<li>.*<\/li>\n?)+/', '<ul>$0</ul>', $text);

    // Paragraphs
    $lines = explode("\n", $text);
    $output = [];
    foreach ($lines as $line) {
        $trimmed = trim($line);
        if (empty($trimmed)) {
            $output[] = '';
            continue;
        }
        if (preg_match('/^<(h[1-6]|ul|ol|li|pre|hr|img|blockquote)/', $trimmed)) {
            $output[] = $trimmed;
            continue;
        }
        $output[] = '<p>' . $trimmed . '</p>';
    }
    return implode("\n", $output);
}

/**
 * Sanitize a URL for safe use in href/src attributes.
 * Blocks javascript:, data:, vbscript: and other dangerous schemes.
 * Returns the cleaned URL or false if it's unsafe.
 */
function mw_sanitize_url($url) {
    $url = trim($url);
    if (empty($url)) return false;
    // Allow only http(s):// and absolute-relative paths; block javascript:, data:, vbscript: etc.
    if (preg_match('#^(https://|http://|/)#i', $url)) {
        return $url;
    }
    // Block all other schemes (javascript:, data:, vbscript:, etc.)
    return false;
}

require get_template_directory() . '/template-parts/figure-card.php';

<?php
/**
 * ModelWiki WordPress Theme Runtime Smoke Test Harness
 * Simulates WordPress runtime environment and executes theme templates for:
 *   1. / (index.php)
 *   2. /browse/ (page-browse.php)
 *   3. /search/ (page-search.php)
 *   4. /series/ (page-series-list.php / page-series.php)
 *   5. /account/ (page-account.php)
 *   6. /figure/test-figure (page-figure.php)
 */

if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
if (!defined('MW_API_URL')) define('MW_API_URL', 'http://127.0.0.1:3000/api/v1');

// Mock WordPress Core API Functions if WP Core is not bootstrapped in CLI
if (!function_exists('add_action')) { function add_action($hook, $callback, $priority = 10, $accepted_args = 1) {} }
if (!function_exists('add_filter')) { function add_filter($hook, $callback, $priority = 10, $accepted_args = 1) {} }
if (!function_exists('add_theme_support')) { function add_theme_support($feature, $options = []) {} }
if (!function_exists('register_nav_menus')) { function register_nav_menus($locations = []) {} }
if (!function_exists('remove_action')) { function remove_action($hook, $callback, $priority = 10) {} }
if (!function_exists('is_admin')) { function is_admin() { return false; } }
if (!function_exists('is_ssl')) { function is_ssl() { return false; } }
if (!function_exists('add_rewrite_rule')) { function add_rewrite_rule($regex, $query, $after = 'bottom') {} }
if (!function_exists('get_query_var')) {
    function get_query_var($var, $default = '') {
        return $GLOBALS['test_query_vars'][$var] ?? $default;
    }
}
if (!function_exists('locate_template')) {
    function locate_template($template_names, $load = false, $require_once = true) {
        foreach ((array)$template_names as $tpl) {
            $path = dirname(__DIR__) . '/' . $tpl;
            if (file_exists($path)) return $path;
        }
        return '';
    }
}
if (!function_exists('wp_enqueue_style')) { function wp_enqueue_style($handle, $src = '', $deps = [], $ver = false, $media = 'all') {} }
if (!function_exists('wp_enqueue_script')) { function wp_enqueue_script($handle, $src = '', $deps = [], $ver = false, $in_footer = false) {} }
if (!function_exists('get_template_directory')) { function get_template_directory() { return dirname(__DIR__); } }
if (!function_exists('get_template_directory_uri')) { function get_template_directory_uri() { return '/wp-content/themes/modelwiki'; } }
if (!function_exists('get_header')) {
    function get_header($name = null) {
        $file = dirname(__DIR__) . '/header.php';
        if (file_exists($file)) include $file;
    }
}
if (!function_exists('get_footer')) {
    function get_footer($name = null) {
        $file = dirname(__DIR__) . '/footer.php';
        if (file_exists($file)) include $file;
    }
}
if (!function_exists('wp_head')) { function wp_head() {} }
if (!function_exists('wp_footer')) { function wp_footer() {} }
if (!function_exists('body_class')) { function body_class($class = '') { echo 'class="test-class"'; } }
if (!function_exists('language_attributes')) { function language_attributes() { echo 'lang="zh-CN"'; } }
if (!function_exists('bloginfo')) { function bloginfo($show = '') { echo 'ModelWiki'; } }
if (!function_exists('wp_title')) { function wp_title() { return 'ModelWiki'; } }
if (!function_exists('esc_url')) { function esc_url($url) { return filter_var($url, FILTER_SANITIZE_URL); } }
if (!function_exists('esc_html')) { function esc_html($text) { return htmlspecialchars((string)$text, ENT_QUOTES, 'UTF-8'); } }
if (!function_exists('esc_attr')) { function esc_attr($text) { return htmlspecialchars((string)$text, ENT_QUOTES, 'UTF-8'); } }
if (!function_exists('get_search_query')) { function get_search_query() { return 'gundam'; } }
if (!function_exists('home_url')) { function home_url($path = '') { return 'https://www.phoebusstudio.com' . $path; } }
if (!function_exists('wp_remote_get')) {
    function wp_remote_get($url, $args = []) {
        // Mock Fastify response for local testing
        return [
            'response' => ['code' => 200],
            'body' => json_encode([
                'success' => true,
                'data' => [
                    ['id' => 1, 'slug' => 'test-figure', 'name' => 'Test Figure', 'images' => [['id' => 101]]]
                ],
                'meta' => ['total' => 1, 'page' => 1, 'perPage' => 24]
            ])
        ];
    }
}
if (!function_exists('is_wp_error')) { function is_wp_error($thing) { return false; } }
if (!function_exists('wp_remote_retrieve_response_code')) { function wp_remote_retrieve_response_code($response) { return $response['response']['code'] ?? 200; } }
if (!function_exists('wp_remote_retrieve_body')) { function wp_remote_retrieve_body($response) { return $response['body'] ?? ''; } }

// 1. Require main functions.php
require_once dirname(__DIR__) . '/functions.php';

$routes_to_test = [
    '/' => 'index.php',
    '/browse/' => 'page-browse.php',
    '/search/' => 'page-search.php',
    '/series/' => 'page-series-list.php',
    '/account/' => 'page-account.php',
    '/figure/test-figure' => 'page-figure.php',
];

echo "=== ModelWiki WordPress Theme Runtime Smoke Test ===\n";
$failed = 0;

foreach ($routes_to_test as $route => $file) {
    $target = dirname(__DIR__) . '/' . $file;
    if (!file_exists($target)) {
        echo "[FAIL] $route => $file (File not found!)\n";
        $failed++;
        continue;
    }

    $GLOBALS['test_query_vars'] = [];
    if ($route === '/account/') $GLOBALS['test_query_vars']['mw_account'] = '1';
    if ($route === '/figure/test-figure') $GLOBALS['test_query_vars']['figure_slug'] = 'test-figure';

    ob_start();
    try {
        include $target;
        $output = ob_get_clean();
        if (strlen($output) > 0) {
            echo "[VERIFIED] Route $route => Loaded $file (" . strlen($output) . " bytes)\n";
        } else {
            echo "[WARNING] Route $route => Loaded $file (0 bytes output)\n";
        }
    } catch (Throwable $e) {
        ob_end_clean();
        echo "[FAIL] Route $route => $file Threw Exception: " . $e->getMessage() . "\n";
        $failed++;
    }
}

if ($failed > 0) {
    echo "\nSmoke Test FAILED with $failed errors.\n";
    exit(1);
} else {
    echo "\nSmoke Test PASSED! All 6 routes loaded cleanly.\n";
    exit(0);
}

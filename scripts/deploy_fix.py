#!/usr/bin/env python3
"""ModelWiki Critical Fix Deployment Script v2"""
import os, subprocess, sys

THEME_SRC = "/home/ubuntu/modelwiki/docker/wordpress/wp-content/themes/modelwiki"
DOCKER_VOL = "/var/lib/docker/volumes/docker_wp_data/_data/wp-content/themes/modelwiki"
WP_CONTAINER = "mw-wordpress"
TMP = "/tmp/mw_fix"

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  WARN: {cmd[:80]}... => {r.stderr.strip()[:200]}")
    return r.stdout.strip()

def write_php(path, content):
    """Write PHP file with sudo via temp file"""
    tmp = f"{TMP}/{os.path.basename(path)}"
    os.makedirs(TMP, exist_ok=True)
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(content)
    run(f"sudo cp '{tmp}' '{path}' && sudo chown www-data:www-data '{path}'")
    print(f"  Written: {os.path.basename(path)}")

os.makedirs(TMP, exist_ok=True)

# ==================== Fix functions.php ====================
print("=== Fixing functions.php ===")

write_php(f"{THEME_SRC}/functions.php", r"""<?php
if (!defined('ABSPATH')) exit;

define('MW_API_URL', 'http://api:3000/api/v1');

// Load i18n functions (mw_t, mw_lang, mw_price_eur, mw_lang_switcher)
require get_template_directory() . '/languages.php';

function mw_theme_setup() {
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    add_theme_support('html5', ['search-form', 'comment-form', 'gallery', 'caption']);
    register_nav_menus(['primary' => 'Primary Menu']);
}
add_action('after_setup_theme', 'mw_theme_setup');

function mw_theme_scripts() {
    wp_enqueue_style('modelwiki-style', get_stylesheet_uri(), [], '2.0.1');
    wp_enqueue_style('modelwiki-main', get_template_directory_uri() . '/assets/css/main.css', [], '2.0.1');
    wp_enqueue_script('modelwiki-main', get_template_directory_uri() . '/assets/js/main.js', [], '2.0.1', true);
}
add_action('wp_enqueue_scripts', 'mw_theme_scripts');

/**
 * Low-level API GET request.
 * Returns the full decoded JSON response (including 'data' and 'meta' keys).
 */
function mw_api_get($endpoint, $params = []) {
    $url = MW_API_URL . $endpoint;
    if (!empty($params)) {
        $url .= '?' . http_build_query($params);
    }
    $response = wp_remote_get($url, ['timeout' => 10]);
    if (is_wp_error($response)) {
        error_log('MW API GET error (' . $endpoint . '): ' . $response->get_error_message());
        return null;
    }
    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
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

function mw_image_url($url, $width = 400, $height = 0) {
    if (empty($url)) return '';
    if (strpos($url, 'static.myfigurecollection.net') !== false ||
        strpos($url, 'myfigurecollection.net') !== false) {
        $height = $height ?: intval($width * 4 / 3);
        $options = "resize:fill:{$width}:{$height}:0";
        return '/img/unsafe/' . $options . '/plain/' . $url;
    }
    return $url;
}

/**
 * Simple Markdown-to-HTML converter.
 * Handles: headings, bold, italic, links, images, lists, code blocks.
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

    // Images
    $text = preg_replace('/!\[([^\]]*)\]\(([^)]+)\)/', '<img src="$2" alt="$1">', $text);

    // Links
    $text = preg_replace('/\[([^\]]+)\]\(([^)]+)\)/', '<a href="$2">$1</a>', $text);

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

require get_template_directory() . '/template-parts/figure-card.php';
""")

# ==================== Fix index.php ====================
print("=== Fixing index.php ===")

write_php(f"{THEME_SRC}/index.php", """<?php get_header(); ?>

<main class="mw-home">
    <section class="mw-hero">
        <h1>ModelWiki</h1>
        <p>The Refined Figure Encyclopedia &mdash; Discover, compare, and explore anime figures from around the world.</p>
        <form class="mw-search" action="<?php echo home_url('/search/'); ?>" method="get">
            <input type="text" name="q" placeholder="Search figures, series, manufacturers..." value="<?php echo esc_attr(get_query_var('q')); ?>">
            <button type="submit">Search</button>
        </form>
    </section>

    <div class="mw-container">
        <section class="mw-categories">
            <h2>Browse by Category</h2>
            <?php
            $categories_result = mw_api_get('/categories');
            $categories = isset($categories_result['data']) ? $categories_result['data'] : null;
            if ($categories): ?>
                <div class="mw-category-grid">
                    <?php foreach ($categories as $cat): ?>
                        <a href="<?php echo home_url('/browse/?category=' . $cat['slug']); ?>" class="mw-category-card">
                            <span class="mw-category-name"><?php echo esc_html($cat['name']); ?></span>
                            <span class="mw-category-count"><?php echo intval($cat['_count']['figures'] ?? 0); ?> figures</span>
                        </a>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </section>

        <section class="mw-latest">
            <h2>Latest Figures</h2>
            <?php
            $result = mw_api_get('/figures', array('perPage' => 12, 'sort' => 'release_date:desc'));
            $data = isset($result['data']) ? $result['data'] : null;
            if ($data): ?>
                <div class="mw-figure-grid">
                    <?php foreach ($data as $fig): ?>
                        <?php mw_render_figure_card($fig); ?>
                    <?php endforeach; ?>
                </div>
            <?php else: ?>
                <p class="mw-no-results">No figures available yet.</p>
            <?php endif; ?>
        </section>
    </div>
</main>

<?php get_footer(); ?>
""")

# ==================== Fix page-browse.php ====================
print("=== Fixing page-browse.php ===")

write_php(f"{THEME_SRC}/page-browse.php", """<?php
get_header();

$page = max(1, intval($_GET['page'] ?? 1));
$perPage = 24;
$sort = $_GET['sort'] ?? 'release_date:desc';
$params = array('page' => $page, 'perPage' => $perPage, 'sort' => $sort);

$filterParams = array('search', 'series', 'manufacturer', 'scale', 'year', 'category', 'sculptor', 'minPrice', 'maxPrice');
foreach ($filterParams as $key) {
    if (!empty($_GET[$key])) {
        $params[$key] = $_GET[$key];
    }
}

$result = mw_api_get('/figures', $params);
$data = isset($result['data']) ? $result['data'] : array();
$meta = isset($result['meta']) ? $result['meta'] : array('page' => 1, 'perPage' => $perPage, 'total' => 0, 'totalPages' => 0);

$categories_result = mw_api_get('/categories');
$categories = isset($categories_result['data']) ? $categories_result['data'] : array();
$series_result = mw_api_get('/series', array('perPage' => 100));
$series = isset($series_result['data']) ? $series_result['data'] : array();
$manufacturers_result = mw_api_get('/manufacturers', array('perPage' => 100));
$manufacturers = isset($manufacturers_result['data']) ? $manufacturers_result['data'] : array();

$currentSeries = isset($_GET['series']) ? $_GET['series'] : '';
$currentManufacturer = isset($_GET['manufacturer']) ? $_GET['manufacturer'] : '';
$currentCategory = isset($_GET['category']) ? $_GET['category'] : '';
$currentScale = isset($_GET['scale']) ? $_GET['scale'] : '';
$currentSearch = isset($_GET['search']) ? $_GET['search'] : '';
$currentMinPrice = isset($_GET['minPrice']) ? $_GET['minPrice'] : '';
$currentMaxPrice = isset($_GET['maxPrice']) ? $_GET['maxPrice'] : '';
?>

<main class="mw-browse mw-container">
    <div class="mw-browse-layout">
        <aside class="mw-browse-filters">
            <div class="mw-filters-header">
                <h2>Filters</h2>
                <a href="<?php echo home_url('/browse/'); ?>" class="mw-filters-reset">Reset</a>
            </div>
            <form class="mw-filters-form" method="get" action="<?php echo home_url('/browse/'); ?>">
                <div class="mw-filter-group">
                    <label for="filter-search">Search</label>
                    <input type="text" id="filter-search" name="search" value="<?php echo esc_attr($currentSearch); ?>" placeholder="Keyword...">
                </div>
                <div class="mw-filter-group">
                    <label for="filter-series">Series</label>
                    <select id="filter-series" name="series">
                        <option value="">All Series</option>
                        <?php foreach ($series as $s): ?>
                            <option value="<?php echo esc_attr($s['slug']); ?>" <?php selected($currentSeries, $s['slug']); ?>><?php echo esc_html($s['name']); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label for="filter-manufacturer">Manufacturer</label>
                    <select id="filter-manufacturer" name="manufacturer">
                        <option value="">All Manufacturers</option>
                        <?php foreach ($manufacturers as $m): ?>
                            <option value="<?php echo esc_attr($m['slug']); ?>" <?php selected($currentManufacturer, $m['slug']); ?>><?php echo esc_html($m['name']); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label for="filter-category">Category</label>
                    <select id="filter-category" name="category">
                        <option value="">All Categories</option>
                        <?php foreach ($categories as $cat): ?>
                            <option value="<?php echo esc_attr($cat['slug']); ?>" <?php selected($currentCategory, $cat['slug']); ?>><?php echo esc_html($cat['name']); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label for="filter-scale">Scale</label>
                    <select id="filter-scale" name="scale">
                        <option value="">All Scales</option>
                        <?php $scales = array('1/4', '1/6', '1/7', '1/8', '1/10', '1/12', 'Non-scale'); ?>
                        <?php foreach ($scales as $s): ?>
                            <option value="<?php echo esc_attr($s); ?>" <?php selected($currentScale, $s); ?>><?php echo esc_html($s); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label>Price Range (JPY)</label>
                    <div class="mw-price-range">
                        <input type="number" name="minPrice" placeholder="Min" value="<?php echo esc_attr($currentMinPrice); ?>">
                        <span class="mw-price-sep">-</span>
                        <input type="number" name="maxPrice" placeholder="Max" value="<?php echo esc_attr($currentMaxPrice); ?>">
                    </div>
                </div>
                <button type="submit" class="mw-filter-apply">Apply Filters</button>
            </form>
        </aside>
        <div class="mw-browse-results">
            <div class="mw-browse-toolbar">
                <p class="mw-browse-count"><?php echo number_format(intval($meta['total'])); ?> figures found</p>
                <div class="mw-browse-sort">
                    <label for="browse-sort">Sort:</label>
                    <select id="browse-sort" name="sort" onchange="document.getElementById('mw-browse-sort-form').submit()">
                        <option value="release_date:desc" <?php selected($sort, 'release_date:desc'); ?>>Newest</option>
                        <option value="release_date:asc" <?php selected($sort, 'release_date:asc'); ?>>Oldest</option>
                        <option value="price_jpy:asc" <?php selected($sort, 'price_jpy:asc'); ?>>Price: Low-High</option>
                        <option value="price_jpy:desc" <?php selected($sort, 'price_jpy:desc'); ?>>Price: High-Low</option>
                        <option value="name:asc" <?php selected($sort, 'name:asc'); ?>>Name: A-Z</option>
                        <option value="name:desc" <?php selected($sort, 'name:desc'); ?>>Name: Z-A</option>
                    </select>
                </div>
            </div>
            <form id="mw-browse-sort-form" method="get" action="<?php echo home_url('/browse/'); ?>" style="display:none;">
                <?php foreach ($filterParams as $key): ?>
                    <?php if (!empty($_GET[$key])): ?>
                        <input type="hidden" name="<?php echo esc_attr($key); ?>" value="<?php echo esc_attr($_GET[$key]); ?>">
                    <?php endif; ?>
                <?php endforeach; ?>
            </form>
            <?php if (!empty($data)): ?>
                <div class="mw-figure-grid">
                    <?php foreach ($data as $fig): ?>
                        <?php mw_render_figure_card($fig); ?>
                    <?php endforeach; ?>
                </div>
                <?php if (intval($meta['totalPages']) > 1): ?>
                <nav class="mw-pagination">
                    <?php for ($i = 1; $i <= intval($meta['totalPages']); $i++): ?>
                        <a href="<?php echo esc_url(add_query_arg('page', $i)); ?>" class="mw-page-link<?php echo $i === intval($meta['page']) ? ' active' : ''; ?>"><?php echo $i; ?></a>
                    <?php endfor; ?>
                </nav>
                <?php endif; ?>
            <?php else: ?>
                <p class="mw-no-results">No figures found matching your criteria.</p>
            <?php endif; ?>
        </div>
    </div>
</main>

<?php get_footer(); ?>
""")

# ==================== Sync to Docker volume ====================
print("=== Copying all theme files to Docker volume ===")

all_files = [
    "functions.php", "index.php", "page-browse.php", "page-search.php",
    "page-series.php", "page-manufacturers.php",
    "page-figure.php", "page-manufacturer.php", "page-series-list.php",
    "page-sculptor.php", "page-sculptors-list.php", "page-manufacturers-list.php",
    "archive-figure.php", "404.php", "header.php", "footer.php",
    "languages.php", "style.css",
]

for f in all_files:
    src = f"{THEME_SRC}/{f}"
    dst = f"{DOCKER_VOL}/{f}"
    run(f"sudo cp '{src}' '{dst}'")
    print(f"  Synced: {f}")

# ==================== Restart WordPress ====================
print("=== Restarting WordPress container ===")
result = run(f"docker restart {WP_CONTAINER}")
print(f"  Result: {result}")

print()
print("=" * 60)
print("DEPLOYMENT COMPLETE - Version 2.0.1")
print("=" * 60)
print("Fixes applied:")
print("  1. mw_api_get() returns full response (data + meta)")
print("  2. mw_api_fetch() added for v3.7 templates")
print("  3. mw_api_call() added for single-item endpoints")
print("  4. md_to_html() markdown converter added")
print("  5. languages.php now loaded from functions.php")
print("  6. index.php: categories properly unwrapped")
print("  7. page-browse.php: categories/series/manufacturers unwrapped")
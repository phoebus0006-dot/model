<?php
get_header();

$page = max(1, intval(get_query_var('paged') ?: ($_GET['paged'] ?? ($_GET['page'] ?? 1))));
if (!empty($_SERVER['REQUEST_URI']) && preg_match('~/browse/page/([0-9]+)/?~', $_SERVER['REQUEST_URI'], $matches)) {
    $page = max(1, intval($matches[1]));
}
$perPage = 24;
$allowedSorts = array('release_date:desc', 'release_date:asc', 'price_jpy:asc', 'price_jpy:desc', 'name:asc', 'name:desc');
$sort = $_GET['sort'] ?? 'release_date:desc';
if (!in_array($sort, $allowedSorts, true)) {
    $sort = 'release_date:desc';
}
$params = array('page' => $page, 'perPage' => $perPage, 'sort' => $sort, 'lang' => mw_lang());

$filterParams = array('search', 'series', 'manufacturer', 'scale', 'year', 'category', 'sculptor', 'minPrice', 'maxPrice');
foreach ($filterParams as $key) {
    if (!empty($_GET[$key])) {
        if ($key === 'minPrice' || $key === 'maxPrice') {
            $val = max(0, intval($_GET[$key]));
            if ($val > 0) $params[$key] = $val;
        } else {
            $params[$key] = sanitize_text_field($_GET[$key]);
        }
    }
}

$result = mw_api_get('/figures', $params) ?? [];
$data = $result['data'] ?? array();
$meta = $result['meta'] ?? array('page' => 1, 'perPage' => $perPage, 'total' => 0, 'totalPages' => 0);

$categories_result = mw_api_get('/categories') ?? [];
$categories = $categories_result['data'] ?? array();
$series_result = mw_api_get('/series', array('perPage' => 100)) ?? [];
$series = $series_result['data'] ?? array();
$manufacturers_result = mw_api_get('/manufacturers', array('perPage' => 100)) ?? [];
$manufacturers = $manufacturers_result['data'] ?? array();

$currentSeries = isset($_GET['series']) ? sanitize_text_field($_GET['series']) : '';
$currentManufacturer = isset($_GET['manufacturer']) ? sanitize_text_field($_GET['manufacturer']) : '';
$currentCategory = isset($_GET['category']) ? sanitize_text_field($_GET['category']) : '';
$currentScale = isset($_GET['scale']) ? sanitize_text_field($_GET['scale']) : '';
$currentSearch = isset($_GET['search']) ? sanitize_text_field($_GET['search']) : '';
$currentMinPrice = isset($_GET['minPrice']) ? max(0, intval($_GET['minPrice'])) : '';
$currentMaxPrice = isset($_GET['maxPrice']) ? max(0, intval($_GET['maxPrice'])) : '';
?>

<div class="mw-browse mw-container">
    <div class="mw-browse-layout">
        <aside class="mw-browse-filters">
            <div class="mw-filters-header">
                <h2><?php echo esc_html(mw_t('Filters')); ?></h2>
                <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/browse/'))); ?>" class="mw-filters-reset"><?php echo esc_html(mw_t('Clear filters')); ?></a>
            </div>
            <form class="mw-filters-form" method="get" action="<?php echo esc_url(home_url('/browse/')); ?>">
                <input type="hidden" name="lang" value="<?php echo esc_attr(mw_lang()); ?>">
                <div class="mw-filter-group">
                    <label for="filter-search"><?php echo esc_html(mw_t('Search')); ?></label>
                    <input type="text" id="filter-search" name="search" value="<?php echo esc_attr($currentSearch); ?>" placeholder="<?php echo esc_attr(mw_t('Search figures...')); ?>">
                </div>
                <div class="mw-filter-group">
                    <label for="filter-series"><?php echo esc_html(mw_t('Series')); ?></label>
                    <select id="filter-series" name="series">
                        <option value=""><?php echo esc_html(mw_t('All')); ?> <?php echo esc_html(mw_t('Series')); ?></option>
                        <?php foreach ($series as $s): ?>
                            <option value="<?php echo esc_attr($s['slug']); ?>" <?php selected($currentSeries, $s['slug']); ?>><?php echo esc_html(mw_display_name($s)); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label for="filter-manufacturer"><?php echo esc_html(mw_t('Manufacturer')); ?></label>
                    <select id="filter-manufacturer" name="manufacturer">
                        <option value=""><?php echo esc_html(mw_t('All')); ?> <?php echo esc_html(mw_t('Manufacturers')); ?></option>
                        <?php foreach ($manufacturers as $m): ?>
                            <option value="<?php echo esc_attr($m['slug']); ?>" <?php selected($currentManufacturer, $m['slug']); ?>><?php echo esc_html(mw_display_name($m)); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label for="filter-category"><?php echo esc_html(mw_t('Category')); ?></label>
                    <select id="filter-category" name="category">
                        <option value=""><?php echo esc_html(mw_t('All')); ?> <?php echo esc_html(mw_t('Categories')); ?></option>
                        <?php foreach ($categories as $cat): ?>
                            <option value="<?php echo esc_attr($cat['slug']); ?>" <?php selected($currentCategory, $cat['slug']); ?>><?php echo esc_html(mw_display_name($cat)); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label for="filter-scale"><?php echo esc_html(mw_t('Scale')); ?></label>
                    <select id="filter-scale" name="scale">
                        <option value=""><?php echo esc_html(mw_t('All')); ?></option>
                        <?php $scales = array('1/4', '1/6', '1/7', '1/8', '1/10', '1/12', 'Non-scale'); ?>
                        <?php foreach ($scales as $s): ?>
                            <option value="<?php echo esc_attr($s); ?>" <?php selected($currentScale, $s); ?>><?php echo esc_html($s); ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="mw-filter-group">
                    <label><?php echo esc_html(mw_t('Price')); ?> (JPY)</label>
                    <div class="mw-price-range">
                        <input type="number" name="minPrice" placeholder="Min" value="<?php echo esc_attr($currentMinPrice); ?>">
                        <span class="mw-price-sep">-</span>
                        <input type="number" name="maxPrice" placeholder="Max" value="<?php echo esc_attr($currentMaxPrice); ?>">
                    </div>
                </div>
                <button type="submit" class="mw-filter-apply"><?php echo esc_html(mw_t('Filters')); ?></button>
            </form>
        </aside>
        <div class="mw-browse-results">
            <div class="mw-browse-toolbar">
                <p class="mw-browse-count"><?php echo number_format(intval($meta['total'])); ?> <?php echo esc_html(mw_t('figures found')); ?></p>
                <div class="mw-browse-sort">
                    <label for="browse-sort"><?php echo esc_html(mw_t('Latest')); ?>:</label>
                    <select id="browse-sort" name="sort" onchange="var f=document.getElementById('mw-browse-sort-form');f.querySelector('input[name=sort]').value=this.value;f.submit();">
                        <option value="release_date:desc" <?php selected($sort, 'release_date:desc'); ?>><?php echo esc_html(mw_t('Latest')); ?></option>
                        <option value="release_date:asc" <?php selected($sort, 'release_date:asc'); ?>><?php echo esc_html(mw_t('Release Year')); ?></option>
                        <option value="price_jpy:asc" <?php selected($sort, 'price_jpy:asc'); ?>><?php echo esc_html(mw_t('Price ↑')); ?></option>
                        <option value="price_jpy:desc" <?php selected($sort, 'price_jpy:desc'); ?>><?php echo esc_html(mw_t('Price ↓')); ?></option>
                        <option value="name:asc" <?php selected($sort, 'name:asc'); ?>><?php echo esc_html(mw_t('A-Z')); ?></option>
                    </select>
                </div>
            </div>
            <form id="mw-browse-sort-form" method="get" action="<?php echo esc_url(home_url('/browse/')); ?>" style="display:none;">
                <input type="hidden" name="lang" value="<?php echo esc_attr(mw_lang()); ?>">
                <input type="hidden" name="sort" value="">
                <?php foreach ($filterParams as $key): ?>
                    <?php if (!empty($_GET[$key])): ?>
                        <input type="hidden" name="<?php echo esc_attr($key); ?>" value="<?php echo esc_attr(sanitize_text_field($_GET[$key])); ?>">
                    <?php endif; ?>
                <?php endforeach; ?>
            </form>
            <?php if (!empty($data)): ?>
                <?php
                // De-duplicate figures by id/slug to prevent the same figure
                // rendering multiple cards under multi-category / multi-localized joins
                $data = mw_dedup_figures($data);
                ?>
                <div class="mw-figure-grid">
                    <?php foreach ($data as $fig): ?>
                        <?php mw_render_figure_card($fig); ?>
                    <?php endforeach; ?>
                </div>
                <?php if (intval($meta['totalPages']) > 1): ?>
                <nav class="mw-pagination" aria-label="<?php echo esc_attr(mw_t('Pagination')); ?>">
                    <?php for ($i = 1; $i <= intval($meta['totalPages']); $i++): ?>
                        <?php
                        $paginationArgs = array('lang' => mw_lang());
                        foreach ($filterParams as $key) {
                            if (!empty($_GET[$key])) {
                                $paginationArgs[$key] = sanitize_text_field($_GET[$key]);
                            }
                        }
                        if (!empty($sort)) {
                            $paginationArgs['sort'] = $sort;
                        }
                        $pageBase = $i > 1 ? home_url('/browse/page/' . $i . '/') : home_url('/browse/');
                        ?>
                        <a href="<?php echo esc_url(add_query_arg($paginationArgs, $pageBase)); ?>" class="mw-page-link<?php echo $i === intval($meta['page']) ? ' active' : ''; ?>"><?php echo $i; ?></a>
                    <?php endfor; ?>
                </nav>
                <?php endif; ?>
            <?php else: ?>
                <p class="mw-no-results"><?php echo esc_html(mw_t('No figures found matching your filters.')); ?></p>
            <?php endif; ?>
        </div>
    </div>
</div>

<?php get_footer(); ?>

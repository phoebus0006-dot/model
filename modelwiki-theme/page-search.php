<?php
get_header();

$query = isset($_GET['q']) ? sanitize_text_field(trim($_GET['q'])) : '';
$allowedTypes = array('all', 'figure', 'series', 'manufacturer');
$type = isset($_GET['type']) ? sanitize_text_field($_GET['type']) : 'all';
if (!in_array($type, $allowedTypes, true)) {
    $type = 'all';
}
$results = null;

if (!empty($query)) {
    $results = mw_api_get('/search', array('q' => $query, 'type' => $type, 'perPage' => 24, 'lang' => mw_lang()));
}
?>

<div class="mw-search-page mw-container">
    <section class="mw-search-hero">
        <h1><?php echo esc_html(mw_t('Search')); ?></h1>
        <form class="mw-search" action="<?php echo esc_url(home_url('/search/')); ?>" method="get" role="search">
            <label for="mw-page-search-input" class="mw-sr-only"><?php echo esc_html(mw_t('Search figures, series, manufacturers...')); ?></label>
            <input type="text" id="mw-page-search-input" name="q" placeholder="<?php echo esc_attr(mw_t('Search figures, series, manufacturers...')); ?>" value="<?php echo esc_attr($query); ?>">
            <input type="hidden" name="lang" value="<?php echo esc_attr(mw_lang()); ?>">
            <button type="submit"><?php echo esc_html(mw_t('Search')); ?></button>
        </form>
    </section>

    <?php if (!empty($query)): ?>
        <?php if ($results && isset($results['data'])): ?>
            <?php $searchData = $results['data']; ?>
            <div class="mw-search-tabs">
                <a href="<?php echo esc_url(add_query_arg(array('q' => $query, 'type' => 'all', 'lang' => mw_lang()))); ?>" class="mw-search-tab<?php echo $type === 'all' ? ' active' : ''; ?>"><?php echo esc_html(sprintf(mw_t('All (%d)'), ($searchData['figures']['total'] ?? 0) + ($searchData['series']['total'] ?? 0) + ($searchData['manufacturers']['total'] ?? 0))); ?></a>
                <a href="<?php echo esc_url(add_query_arg(array('q' => $query, 'type' => 'figure', 'lang' => mw_lang()))); ?>" class="mw-search-tab<?php echo $type === 'figure' ? ' active' : ''; ?>"><?php echo esc_html(sprintf(mw_t('Figures (%d)'), $searchData['figures']['total'] ?? 0)); ?></a>
                <a href="<?php echo esc_url(add_query_arg(array('q' => $query, 'type' => 'series', 'lang' => mw_lang()))); ?>" class="mw-search-tab<?php echo $type === 'series' ? ' active' : ''; ?>"><?php echo esc_html(sprintf(mw_t('Series (%d)'), $searchData['series']['total'] ?? 0)); ?></a>
                <a href="<?php echo esc_url(add_query_arg(array('q' => $query, 'type' => 'manufacturer', 'lang' => mw_lang()))); ?>" class="mw-search-tab<?php echo $type === 'manufacturer' ? ' active' : ''; ?>"><?php echo esc_html(sprintf(mw_t('Manufacturers (%d)'), $searchData['manufacturers']['total'] ?? 0)); ?></a>
            </div>

            <?php if ($type === 'all' || $type === 'figure'): ?>
                <?php if (!empty($searchData['figures']['items'])): ?>
                    <?php
                    $figure_items = mw_dedup_figures($searchData['figures']['items']);
                    ?>
                    <section class="mw-search-section">
                        <h2><?php echo esc_html(sprintf(mw_t('Figures (%d)'), $searchData['figures']['total'] ?? 0)); ?></h2>
                        <div class="mw-figure-grid">
                            <?php foreach ($figure_items as $fig): ?>
                                <?php mw_render_figure_card($fig); ?>
                            <?php endforeach; ?>
                        </div>
                    </section>
                <?php endif; ?>
            <?php endif; ?>

            <?php if ($type === 'all' || $type === 'series'): ?>
                <?php if (!empty($searchData['series']['items'])): ?>
                    <section class="mw-search-section">
                        <h2><?php echo esc_html(mw_t('Series')); ?></h2>
                        <div class="mw-entity-grid">
                            <?php foreach ($searchData['series']['items'] as $item): ?>
                                <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/series/' . $item['slug'] . '/'))); ?>" class="mw-entity-card">
                                    <span class="mw-entity-name"><?php echo esc_html(mw_display_name($item)); ?></span>
                                    <span class="mw-entity-count"><?php echo intval($item['_count']['figures'] ?? 0); ?> <?php echo esc_html(mw_t('figures')); ?></span>
                                </a>
                            <?php endforeach; ?>
                        </div>
                    </section>
                <?php endif; ?>
            <?php endif; ?>

            <?php if ($type === 'all' || $type === 'manufacturer'): ?>
                <?php if (!empty($searchData['manufacturers']['items'])): ?>
                    <section class="mw-search-section">
                        <h2><?php echo esc_html(mw_t('Manufacturers')); ?></h2>
                        <div class="mw-entity-grid">
                            <?php foreach ($searchData['manufacturers']['items'] as $item): ?>
                                <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/manufacturer/' . $item['slug'] . '/'))); ?>" class="mw-entity-card">
                                    <span class="mw-entity-name"><?php echo esc_html(mw_display_name($item)); ?></span>
                                    <span class="mw-entity-count"><?php echo intval($item['_count']['figures'] ?? 0); ?> <?php echo esc_html(mw_t('figures')); ?></span>
                                </a>
                            <?php endforeach; ?>
                        </div>
                    </section>
                <?php endif; ?>
            <?php endif; ?>

            <?php if (
                empty($searchData['figures']['items']) &&
                empty($searchData['series']['items']) &&
                empty($searchData['manufacturers']['items'])
            ): ?>
                <p class="mw-no-results"><?php echo esc_html(mw_t('No results found for your search.')); ?></p>
            <?php endif; ?>
        <?php else: ?>
            <p class="mw-no-results"><?php echo esc_html(mw_t('No results found for your search.')); ?></p>
        <?php endif; ?>
    <?php else: ?>
        <p class="mw-no-results"><?php echo esc_html(mw_t('Enter a search term to find figures, series, and manufacturers.')); ?></p>
    <?php endif; ?>
</div>

<?php get_footer(); ?>

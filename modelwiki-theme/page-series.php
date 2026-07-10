<?php
get_header();

$page = max(1, intval($_GET['page'] ?? 1));
$perPage = 50;
$result = mw_api_get('/series', array('page' => $page, 'perPage' => $perPage, 'lang' => mw_lang()));
$series = isset($result['data']) ? $result['data'] : array();
$meta = isset($result['meta']) ? $result['meta'] : array('page' => 1, 'perPage' => $perPage, 'total' => 0, 'totalPages' => 0);
?>

<div class="mw-series-page mw-container">
    <h1><?php echo esc_html(mw_t('Series')); ?></h1>
    <p class="mw-page-desc"><?php echo esc_html(sprintf(mw_t('%s series total'), number_format(intval($meta['total'])))); ?></p>

    <?php if (!empty($series)): ?>
        <div class="mw-series-grid">
            <?php foreach ($series as $s): ?>
                <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/series/' . $s['slug'] . '/'))); ?>" class="mw-series-card">
                    <h4><?php echo esc_html(mw_display_name($s)); ?></h4>
                    <?php if (!empty($s['nameJp'])): ?>
                        <span class="mw-series-name-jp"><?php echo esc_html($s['nameJp']); ?></span>
                    <?php endif; ?>
                    <span class="mw-series-card-count"><?php echo intval($s['_count']['figures'] ?? 0); ?> <?php echo esc_html(mw_t('figures')); ?></span>
                </a>
            <?php endforeach; ?>
        </div>

        <?php if (intval($meta['totalPages']) > 1): ?>
        <nav class="mw-pagination" aria-label="<?php echo esc_attr(mw_t('Pagination')); ?>">
            <?php for ($i = 1; $i <= intval($meta['totalPages']); $i++): ?>
                <a href="<?php echo esc_url(add_query_arg(array('page' => $i, 'lang' => mw_lang()))); ?>" class="mw-page-link<?php echo $i === intval($meta['page']) ? ' active' : ''; ?>"><?php echo $i; ?></a>
            <?php endfor; ?>
        </nav>
        <?php endif; ?>
    <?php else: ?>
        <p class="mw-no-results"><?php echo esc_html(mw_t('No series found.')); ?></p>
    <?php endif; ?>
</div>

<?php get_footer(); ?>

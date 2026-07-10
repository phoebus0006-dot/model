<?php
/**
 * 制造商详情页
 * ============
 *
 * URL: /manufacturers/{slug}/
 *
 * 与 page-series.php 结构相同，替换为 manufacturer 数据源。
 *
 * @package ModelWiki
 * @since   3.0.0
 * @version 3.7.0
 */

$slug = get_query_var('manufacturer_slug');

$manufacturer_data = null;
if ($slug) {
    $response = mw_api_fetch('/manufacturers/' . urlencode($slug));
    if ($response['success']) $manufacturer_data = $response['data'];
}

if (!$manufacturer_data) {
    get_header();
    get_template_part('404-content');
    get_footer();
    return;
}

$page = max(1, intval(isset($_GET['page']) ? $_GET['page'] : 1));
$figures_result = mw_api_fetch('/manufacturers/' . urlencode($slug) . '/figures', ['perPage' => 24, 'page' => $page]);
$figures       = $figures_result['data'] ?? [];
$total_pages   = $figures_result['meta']['totalPages'] ?? 1;
$figure_count  = $manufacturer_data['_count']['figures'] ?? 0;

get_header();
?>

<article class="mw-entity-page">
    <div class="mw-container">
        <nav class="mw-breadcrumb" aria-label="<?php echo esc_attr(mw_t('Breadcrumb')); ?>">
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/'))); ?>"><?php echo esc_html(mw_t('Home')); ?></a>
            <span class="mw-breadcrumb-sep">/</span>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/manufacturers/'))); ?>"><?php echo esc_html(mw_t('Manufacturers')); ?></a>
            <span class="mw-breadcrumb-sep">/</span>
            <span><?php echo esc_html($manufacturer_data['nameEn'] ?? $manufacturer_data['name'] ?? ''); ?></span>
        </nav>

        <h1><?php echo esc_html($manufacturer_data['nameEn'] ?? $manufacturer_data['name'] ?? ''); ?></h1>
        <?php if (($manufacturer_data['nameJp'] ?? '') && ($manufacturer_data['nameJp'] ?? '') !== ($manufacturer_data['nameEn'] ?? '')): ?>
        <p class="mw-entity-original-name"><?php echo esc_html($manufacturer_data['nameJp']); ?></p>
        <?php endif; ?>
        <?php if (!empty($manufacturer_data['country'])): ?>
        <p class="mw-entity-meta"><?php echo esc_html($manufacturer_data['country']); ?></p>
        <?php endif; ?>
        <p class="mw-entity-count"><?php echo esc_html(sprintf(mw_t('%s figures'), $figure_count)); ?></p>

        <?php if (!empty($figures)): ?>
        <div class="mw-figure-grid">
            <?php foreach ($figures as $figure):
                mw_render_figure_card($figure);
            endforeach; ?>
        </div>

        <?php if ($total_pages > 1): ?>
        <nav class="mw-pagination" aria-label="<?php echo esc_attr(mw_t('Pagination')); ?>">
            <?php
            $lang = mw_lang();
            for ($p = 1; $p <= $total_pages; $p++):
                $url = add_query_arg(['lang' => $lang, 'page' => $p]);
            ?>
            <a href="<?php echo esc_url($url); ?>" class="mw-page-btn <?php echo $p === $page ? 'active' : ''; ?>"><?php echo esc_html($p); ?></a>
            <?php endfor; ?>
        </nav>
        <?php endif; ?>

        <?php else: ?>
        <p class="mw-empty"><?php echo esc_html(mw_t('No figures found for this manufacturer yet.')); ?></p>
        <?php endif; ?>
    </div>
</article>

<?php get_footer(); ?>
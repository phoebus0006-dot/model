<?php
if (!defined('ABSPATH')) exit;

$slug = get_query_var('character_slug');
$mw_lang = mw_lang();

$character_data = null;
if ($slug) {
    $response = mw_api_fetch('/characters/' . urlencode($slug), ['lang' => $mw_lang]);
    if ($response['success']) $character_data = $response['data'];
}

if (!$character_data) {
    get_header();
    get_template_part('404-content');
    get_footer();
    return;
}

$page = max(1, intval($_GET['page'] ?? 1));
$figures_result = mw_api_fetch('/characters/' . urlencode($slug) . '/figures', ['perPage' => 24, 'page' => $page, 'lang' => $mw_lang]);
$figures = $figures_result['data'] ?? [];
$total_pages = $figures_result['meta']['totalPages'] ?? 1;
$figure_count = $figures_result['meta']['total'] ?? ($character_data['_count']['figures'] ?? 0);

get_header();
?>

<article class="mw-entity-page">
    <div class="mw-container">
        <nav class="mw-breadcrumb" aria-label="<?php echo esc_attr(mw_t('Breadcrumb')); ?>">
            <a href="<?php echo esc_url(add_query_arg('lang', $mw_lang, home_url('/'))); ?>"><?php echo esc_html(mw_t('Home')); ?></a>
            <span class="mw-breadcrumb-sep">/</span>
            <a href="<?php echo esc_url(add_query_arg('lang', $mw_lang, home_url('/characters/'))); ?>"><?php echo esc_html(mw_t('Personnages')); ?></a>
            <span class="mw-breadcrumb-sep">/</span>
            <span><?php echo esc_html(mw_display_name($character_data)); ?></span>
        </nav>

        <h1><?php echo esc_html(mw_display_name($character_data)); ?></h1>
        <?php if (!empty($character_data['nameJp']) && $character_data['nameJp'] !== ($character_data['nameEn'] ?? '')): ?>
        <p class="mw-entity-original-name"><?php echo esc_html($character_data['nameJp']); ?></p>
        <?php endif; ?>
        <?php if (!empty($character_data['series'])): ?>
        <p class="mw-entity-meta">
            <a href="<?php echo esc_url(add_query_arg('lang', $mw_lang, home_url('/series/' . $character_data['series']['slug'] . '/'))); ?>"><?php echo esc_html(mw_display_name($character_data['series'])); ?></a>
        </p>
        <?php endif; ?>
        <p class="mw-entity-count"><?php echo esc_html(sprintf(mw_t('%s figures'), $figure_count)); ?></p>

        <section class="mw-search-section">
            <h2><?php echo esc_html(mw_t('Figures for this character')); ?></h2>

            <?php if (!empty($figures)): ?>
            <div class="mw-figure-grid">
                <?php foreach ($figures as $figure): ?>
                    <?php mw_render_figure_card($figure); ?>
                <?php endforeach; ?>
            </div>

            <?php if ($total_pages > 1): ?>
            <nav class="mw-pagination" aria-label="<?php echo esc_attr(mw_t('Pagination')); ?>">
                <?php for ($p = 1; $p <= intval($total_pages); $p++): ?>
                <a href="<?php echo esc_url(add_query_arg(['lang' => $mw_lang, 'page' => $p])); ?>" class="mw-page-btn <?php echo $p === $page ? 'active' : ''; ?>"><?php echo esc_html($p); ?></a>
                <?php endfor; ?>
            </nav>
            <?php endif; ?>

            <?php else: ?>
            <p class="mw-empty"><?php echo esc_html(mw_t('No figures found for this character yet.')); ?></p>
            <?php endif; ?>
        </section>
    </div>
</article>

<?php get_footer(); ?>

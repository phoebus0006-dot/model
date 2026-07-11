<?php
if (!defined('ABSPATH')) exit;

$mw_lang = mw_lang();
$page = max(1, intval($_GET['page'] ?? 1));
$per_page = 48;

$result = mw_api_fetch('/characters', ['page' => $page, 'perPage' => $per_page, 'lang' => $mw_lang]);
$characters = $result['data'] ?? [];
$meta = $result['meta'] ?? ['page' => $page, 'perPage' => $per_page, 'total' => 0, 'totalPages' => 0];

get_header();
?>

<section class="mw-list-page">
    <div class="mw-container">
        <h1><?php echo esc_html(mw_t('Personnages')); ?></h1>
        <p class="mw-list-count"><?php echo esc_html(sprintf(mw_t('Characters (%d)'), intval($meta['total'] ?? 0))); ?></p>

        <?php if (!empty($characters)): ?>
        <div class="mw-entity-grid">
            <?php foreach ($characters as $character): ?>
            <a href="<?php echo esc_url(add_query_arg('lang', $mw_lang, home_url('/character/' . $character['slug'] . '/'))); ?>" class="mw-entity-card">
                <span class="mw-entity-name"><?php echo esc_html(mw_display_name($character)); ?></span>
                <?php if (!empty($character['nameJp']) && $character['nameJp'] !== ($character['nameEn'] ?? '')): ?>
                <span class="mw-series-name-jp"><?php echo esc_html($character['nameJp']); ?></span>
                <?php endif; ?>
                <span class="mw-entity-count"><?php echo intval($character['_count']['figures'] ?? 0); ?> <?php echo esc_html(mw_t('figures')); ?></span>
            </a>
            <?php endforeach; ?>
        </div>

        <?php if (intval($meta['totalPages'] ?? 0) > 1): ?>
        <nav class="mw-pagination" aria-label="<?php echo esc_attr(mw_t('Pagination')); ?>">
            <?php for ($p = 1; $p <= intval($meta['totalPages']); $p++): ?>
            <a href="<?php echo esc_url(add_query_arg(['lang' => $mw_lang, 'page' => $p])); ?>" class="mw-page-btn <?php echo $p === intval($meta['page'] ?? $page) ? 'active' : ''; ?>"><?php echo esc_html($p); ?></a>
            <?php endfor; ?>
        </nav>
        <?php endif; ?>

        <?php else: ?>
        <p class="mw-empty"><?php echo esc_html(mw_t('No characters found.')); ?></p>
        <?php endif; ?>
    </div>
</section>

<?php get_footer(); ?>

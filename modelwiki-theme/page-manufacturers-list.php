<?php
/**
 * 制造商列表页
 * ============
 *
 * URL: /manufacturers/
 *
 * @package ModelWiki
 * @since   3.0.0
 * @version 3.7.0
 */

$mw_lang = mw_lang();
$page = max(1, intval(get_query_var('paged', 1)));
$per_page = 48;

$result = mw_api_fetch('/manufacturers', ['page' => $page, 'perPage' => $per_page]);
$manufacturers_list = $result['data'] ?? [];
$total_pages  = $result['meta']['totalPages'] ?? 1;
$total        = $result['meta']['total'] ?? 0;

get_header();
?>

<section class="mw-list-page">
    <div class="mw-container">
        <h1><?php echo esc_html(mw_t('Manufacturers')); ?></h1>
        <p class="mw-list-count"><?php echo esc_html(sprintf(mw_t('%s manufacturers total'), $total)); ?></p>

        <?php if (!empty($manufacturers_list)): ?>
        <div class="mw-manufacturer-tags" style="justify-content:flex-start;font-size:1rem">
            <?php foreach ($manufacturers_list as $m): ?>
            <a href="<?php echo esc_url(add_query_arg('lang', $mw_lang, home_url('/manufacturers/' . $m['slug'] . '/'))); ?>" class="mw-manufacturer-tag" style="font-size:1rem">
                <?php echo esc_html(mw_display_name($m)); ?>
                <span style="font-size:0.75rem;opacity:0.6;margin-left:4px"><?php echo esc_html($m['_count']['figures'] ?? 0); ?></span>
            </a>
            <?php endforeach; ?>
        </div>

        <?php if ($total_pages > 1): ?>
        <nav class="mw-pagination" aria-label="<?php echo esc_attr(mw_t('Pagination')); ?>">
            <?php if ($page > 1): ?>
            <a href="<?php echo esc_url(add_query_arg(['lang' => $mw_lang, 'paged' => $page - 1])); ?>" class="mw-page-btn">&larr;</a>
            <?php else: ?>
            <span class="mw-page-btn disabled">&larr;</span>
            <?php endif; ?>

            <?php
            $start = max(1, $page - 3);
            $end = min($total_pages, $page + 3);
            if ($start > 1) {
                echo '<a href="' . esc_url(add_query_arg(['lang' => $mw_lang, 'paged' => 1])) . '" class="mw-page-btn">1</a>';
                if ($start > 2) echo '<span class="mw-page-btn disabled">...</span>';
            }
            for ($p = $start; $p <= $end; $p++) {
                $active = $p === $page ? ' active' : '';
                echo '<a href="' . esc_url(add_query_arg(['lang' => $mw_lang, 'paged' => $p])) . '" class="mw-page-btn' . $active . '">' . $p . '</a>';
            }
            if ($end < $total_pages) {
                if ($end < $total_pages - 1) echo '<span class="mw-page-btn disabled">...</span>';
                echo '<a href="' . esc_url(add_query_arg(['lang' => $mw_lang, 'paged' => $total_pages])) . '" class="mw-page-btn">' . $total_pages . '</a>';
            }
            ?>

            <?php if ($page < $total_pages): ?>
            <a href="<?php echo esc_url(add_query_arg(['lang' => $mw_lang, 'paged' => $page + 1])); ?>" class="mw-page-btn">&rarr;</a>
            <?php else: ?>
            <span class="mw-page-btn disabled">&rarr;</span>
            <?php endif; ?>
        </nav>
        <?php endif; ?>

        <?php else: ?>
        <p class="mw-empty"><?php echo esc_html(mw_t('No manufacturers found.')); ?></p>
        <?php endif; ?>
    </div>
</section>

<?php get_footer(); ?>
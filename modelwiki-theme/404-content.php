<?php
/**
 * 404 内容片段（不含 header/footer）
 * 供详情页在数据不存在时通过 get_template_part('404-content') 调用。
 */
if (!defined('ABSPATH')) exit;
?>

<section class="mw-404">
    <h1>404</h1>
    <p><?php echo esc_html(mw_t('The page you are looking for does not exist.')); ?></p>
    <form class="mw-hero-search" action="<?php echo esc_url(home_url('/search/')); ?>" method="get">
        <input type="hidden" name="lang" value="<?php echo esc_attr(mw_lang()); ?>">
        <input type="text" name="q" placeholder="<?php echo esc_attr(mw_t('Try searching instead...')); ?>" aria-label="<?php echo esc_attr(mw_t('Search')); ?>">
        <button type="submit"><?php echo esc_html(mw_t('Search')); ?></button>
    </form>
    <div style="margin-top:2rem">
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/'))); ?>" class="mw-btn mw-btn-primary"><?php echo esc_html(mw_t('Back to Home')); ?></a>
    </div>
</section>

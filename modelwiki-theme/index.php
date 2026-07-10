<?php get_header(); ?>

<section class="mw-hero">
    <h1>ModelWiki</h1>
    <p><?php echo esc_html(mw_t('The Refined Figure Encyclopedia')); ?></p>
    <form class="mw-search" action="<?php echo esc_url(home_url('/search/')); ?>" method="get" role="search">
        <label for="mw-hero-search-input" class="mw-sr-only"><?php echo esc_html(mw_t('Search figures, series, manufacturers...')); ?></label>
        <input type="text" id="mw-hero-search-input" name="q" placeholder="<?php echo esc_attr(mw_t('Search figures, series, manufacturers...')); ?>" value="<?php echo esc_attr(get_query_var('q')); ?>">
        <input type="hidden" name="lang" value="<?php echo esc_attr(mw_lang()); ?>">
        <button type="submit"><?php echo esc_html(mw_t('Search')); ?></button>
    </form>
</section>

<div class="mw-container">
    <section class="mw-categories">
        <h2><?php echo esc_html(mw_t('Categories')); ?></h2>
        <?php
        $categories_result = mw_api_get('/categories');
        $categories = isset($categories_result['data']) ? $categories_result['data'] : null;
        if ($categories): ?>
            <div class="mw-category-grid">
                <?php foreach ($categories as $cat): ?>
                    <a href="<?php echo esc_url(add_query_arg(array('lang' => mw_lang(), 'category' => $cat['slug']), home_url('/browse/'))); ?>" class="mw-category-card">
                        <span class="mw-category-name"><?php echo esc_html(mw_t($cat['name'])); ?></span>
                        <span class="mw-category-count"><?php echo intval($cat['_count']['figures'] ?? 0); ?> <?php echo esc_html(mw_t('figures')); ?></span>
                    </a>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </section>

    <section class="mw-latest">
        <h2><?php echo esc_html(mw_t('Latest Releases')); ?></h2>
        <?php
        $result = mw_api_get('/figures', array('perPage' => 12, 'sort' => 'release_date:desc'));
        $data = isset($result['data']) ? $result['data'] : null;
        if ($data):
            $data = mw_dedup_figures($data);
        ?>
            <div class="mw-figure-grid">
                <?php foreach ($data as $fig): ?>
                    <?php mw_render_figure_card($fig); ?>
                <?php endforeach; ?>
            </div>
        <?php else: ?>
            <p class="mw-no-results"><?php echo esc_html(mw_t('No figures found.')); ?></p>
        <?php endif; ?>
    </section>
</div>

<?php get_footer(); ?>

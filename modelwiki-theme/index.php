<?php get_header(); ?>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [{
    "@type": "ListItem",
    "position": 1,
    "name": "Home",
    "item": "<?php echo esc_url(home_url('/')); ?>"
  }]
}
</script>

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

<div class="mw-container" data-mw-home>
  <section class="mw-categories">
    <h2><?php echo esc_html(mw_t('Categories')); ?></h2>
    <?php
    $categories_result = mw_api_get('/categories');
    $categories = isset($categories_result['data']) ? $categories_result['data'] : null;
    if ($categories):
    ?>
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

  <section class="mw-latest" data-mw-latest>
    <h2><?php echo esc_html(mw_t('Featured Figures')); ?></h2>

    <div class="mw-skeleton-grid" data-mw-skeleton>
      <?php for ($i = 0; $i < 12; $i++): ?>
      <div class="mw-skeleton-card">
        <div class="mw-skeleton-img"></div>
        <div class="mw-skeleton-text"></div>
        <div class="mw-skeleton-text mw-skeleton-text--short"></div>
      </div>
      <?php endfor; ?>
    </div>

    <div class="mw-empty-state" data-mw-empty style="display:none">
      <p><?php echo esc_html(mw_t('No figures found.')); ?></p>
    </div>

    <div class="mw-error-state" data-mw-error style="display:none">
      <p data-mw-error-msg><?php echo esc_html(mw_t('Failed to load figures.')); ?></p>
      <button class="mw-retry-btn" data-mw-retry type="button"><?php echo esc_html(mw_t('Retry')); ?></button>
    </div>

    <div class="mw-figure-grid" data-mw-grid style="display:none"></div>
  </section>

  <section class="mw-featured" data-mw-featured>
    <h2><?php echo esc_html(mw_t('Latest Releases')); ?></h2>

    <div class="mw-skeleton-grid" data-mw-featured-skeleton>
      <?php for ($i = 0; $i < 6; $i++): ?>
      <div class="mw-skeleton-card">
        <div class="mw-skeleton-img"></div>
        <div class="mw-skeleton-text"></div>
        <div class="mw-skeleton-text mw-skeleton-text--short"></div>
      </div>
      <?php endfor; ?>
    </div>

    <div class="mw-empty-state" data-mw-featured-empty style="display:none">
      <p><?php echo esc_html(mw_t('No figures found.')); ?></p>
    </div>

    <div class="mw-error-state" data-mw-featured-error style="display:none">
      <p data-mw-featured-error-msg><?php echo esc_html(mw_t('Failed to load figures.')); ?></p>
      <button class="mw-retry-btn" data-mw-featured-retry type="button"><?php echo esc_html(mw_t('Retry')); ?></button>
    </div>

    <div class="mw-figure-grid" data-mw-featured-grid style="display:none"></div>
  </section>
</div>

<script nonce="<?php echo esc_attr($GLOBALS['mw_csp_nonce'] ?? ''); ?>">
(function () {
  'use strict';

  var root = document.querySelector('[data-mw-home]');
  if (!root) return;

  var latestSection = root.querySelector('[data-mw-latest]');
  var featuredSection = root.querySelector('[data-mw-featured]');

  var skeleton = latestSection && latestSection.querySelector('[data-mw-skeleton]');
  var empty = latestSection && latestSection.querySelector('[data-mw-empty]');
  var errorEl = latestSection && latestSection.querySelector('[data-mw-error]');
  var errorMsg = errorEl && errorEl.querySelector('[data-mw-error-msg]');
  var retryBtn = errorEl && errorEl.querySelector('[data-mw-retry]');
  var grid = latestSection && latestSection.querySelector('[data-mw-grid]');

  var featSkeleton = featuredSection && featuredSection.querySelector('[data-mw-featured-skeleton]');
  var featEmpty = featuredSection && featuredSection.querySelector('[data-mw-featured-empty]');
  var featError = featuredSection && featuredSection.querySelector('[data-mw-featured-error]');
  var featErrorMsg = featError && featError.querySelector('[data-mw-featured-error-msg]');
  var featRetry = featError && featError.querySelector('[data-mw-featured-retry]');
  var featGrid = featuredSection && featuredSection.querySelector('[data-mw-featured-grid]');

  var api = window.ModelWikiAPI ? new window.ModelWikiAPI() : null;
  if (!api) return;

  var HOME_URL = '<?php echo esc_url(home_url('/')); ?>';

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[ch];
    });
  }

  function figureCardHtml(fig) {
    var img = fig.image;
    var imgUrl = img && img.url ? img.url : (img && img.id ? '/api/v1/figures/images/' + img.id : '');
    var title = fig.displayTitle || fig.name || fig.nameEn || fig.slug || '';
    var mfr = fig.manufacturer ? (fig.manufacturer.nameEn || fig.manufacturer.name || '') : '';
    var scale = fig.scale || '';
    var price = fig.priceJpy ? '&yen;' + Number(fig.priceJpy).toLocaleString() : '';
    var slug = fig.slug || '';
    var link = HOME_URL + 'figure/' + encodeURIComponent(slug) + '/';
    return '<a href="' + esc(link) + '" class="mw-figure-card">' +
      '<div class="mw-figure-card-img">' +
      (imgUrl ? '<img src="' + esc(imgUrl) + '" alt="' + esc(title) + '" loading="lazy">' : '<span class="mw-no-image-placeholder">No image</span>') +
      '</div>' +
      '<div class="mw-figure-card-info">' +
      '<h3>' + esc(title) + '</h3>' +
      (mfr ? '<span class="mw-figure-card-mfr">' + esc(mfr) + '</span>' : '') +
      (scale ? '<span class="mw-figure-card-scale">' + esc(scale) + '</span>' : '') +
      (price ? '<span class="mw-figure-card-price">' + price + '</span>' : '') +
      '</div></a>';
  }

  function renderFigureGrid(container, figures) {
    if (!container) return;
    if (!figures || figures.length === 0) {
      container.style.display = 'none';
      return false;
    }
    container.style.display = '';
    container.innerHTML = figures.map(figureCardHtml).join('');
    return true;
  }

  function setVisibility(el, show) {
    if (!el) return;
    el.style.display = show ? '' : 'none';
  }

  function loadLatest() {
    setVisibility(skeleton, true);
    setVisibility(empty, false);
    setVisibility(errorEl, false);
    setVisibility(grid, false);

    api.getFigures({ perPage: 12, sort: 'release_date:desc' }).then(function (state) {
      if (state.error) {
        setVisibility(skeleton, false);
        setVisibility(errorEl, true);
        if (errorMsg) errorMsg.textContent = state.error.message || 'Failed to load figures.';
        return;
      }
      setVisibility(skeleton, false);
      var hasData = renderFigureGrid(grid, state.data);
      if (!hasData) setVisibility(empty, true);
    });
  }

  function loadFeatured() {
    setVisibility(featSkeleton, true);
    setVisibility(featEmpty, false);
    setVisibility(featError, false);
    setVisibility(featGrid, false);

    api.getFigures({ perPage: 6, sort: 'release_date:desc', featured: true }).then(function (state) {
      if (state.error) {
        setVisibility(featSkeleton, false);
        setVisibility(featError, true);
        if (featErrorMsg) featErrorMsg.textContent = state.error.message || 'Failed to load figures.';
        return;
      }
      setVisibility(featSkeleton, false);
      var hasData = renderFigureGrid(featGrid, state.data);
      if (!hasData) setVisibility(featEmpty, true);
    });
  }

  if (retryBtn) retryBtn.addEventListener('click', loadLatest);
  if (featRetry) featRetry.addEventListener('click', loadFeatured);

  loadLatest();
  loadFeatured();
})();
</script>

<?php get_footer(); ?>

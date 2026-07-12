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

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "<?php echo esc_url(home_url('/')); ?>"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Browse",
      "item": "<?php echo esc_url(home_url('/browse/')); ?>"
    }
  ]
}
</script>

<div class="mw-browse mw-container">
  <div class="mw-browse-layout">
    <aside class="mw-browse-filters">
      <div class="mw-filters-header">
        <h2><?php echo esc_html(mw_t('Filters')); ?></h2>
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/browse/'))); ?>" class="mw-filters-reset"><?php echo esc_html(mw_t('Clear filters')); ?></a>
      </div>
      <form class="mw-filters-form" id="mw-browse-filter-form" method="get" action="<?php echo esc_url(home_url('/browse/')); ?>">
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

    <div class="mw-browse-results" data-mw-browse-results>
      <div class="mw-browse-toolbar">
        <p class="mw-browse-count" data-mw-browse-count><?php echo number_format(intval($meta['total'])); ?> <?php echo esc_html(mw_t('figures found')); ?></p>
        <div class="mw-browse-sort">
          <label for="browse-sort"><?php echo esc_html(mw_t('Latest')); ?>:</label>
          <select id="browse-sort" name="sort">
            <option value="release_date:desc" <?php selected($sort, 'release_date:desc'); ?>><?php echo esc_html(mw_t('Latest')); ?></option>
            <option value="release_date:asc" <?php selected($sort, 'release_date:asc'); ?>><?php echo esc_html(mw_t('Release Year')); ?></option>
            <option value="price_jpy:asc" <?php selected($sort, 'price_jpy:asc'); ?>><?php echo esc_html(mw_t('Price ↑')); ?></option>
            <option value="price_jpy:desc" <?php selected($sort, 'price_jpy:desc'); ?>><?php echo esc_html(mw_t('Price ↓')); ?></option>
            <option value="name:asc" <?php selected($sort, 'name:asc'); ?>><?php echo esc_html(mw_t('A-Z')); ?></option>
          </select>
        </div>
      </div>

      <div class="mw-skeleton-grid" data-mw-browse-skeleton>
        <?php for ($i = 0; $i < 12; $i++): ?>
        <div class="mw-skeleton-card">
          <div class="mw-skeleton-img"></div>
          <div class="mw-skeleton-text"></div>
          <div class="mw-skeleton-text mw-skeleton-text--short"></div>
        </div>
        <?php endfor; ?>
      </div>

      <div class="mw-empty-state" data-mw-browse-empty style="display:none">
        <p><?php echo esc_html(mw_t('No figures found matching your filters.')); ?></p>
      </div>

      <div class="mw-error-state" data-mw-browse-error style="display:none">
        <p data-mw-browse-error-msg><?php echo esc_html(mw_t('Failed to load figures.')); ?></p>
        <button class="mw-retry-btn" data-mw-browse-retry type="button"><?php echo esc_html(mw_t('Retry')); ?></button>
      </div>

      <div class="mw-figure-grid" data-mw-browse-grid style="display:none"></div>

      <nav class="mw-pagination" data-mw-browse-pagination style="display:none" aria-label="<?php echo esc_attr(mw_t('Pagination')); ?>"></nav>

      <?php if (!empty($data)): ?>
      <noscript>
        <?php $data = mw_dedup_figures($data); ?>
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
              if (!empty($_GET[$key])) $paginationArgs[$key] = sanitize_text_field($_GET[$key]);
          }
          if (!empty($sort)) $paginationArgs['sort'] = $sort;
          $pageBase = $i > 1 ? home_url('/browse/page/' . $i . '/') : home_url('/browse/');
          ?>
          <a href="<?php echo esc_url(add_query_arg($paginationArgs, $pageBase)); ?>" class="mw-page-link<?php echo $i === intval($meta['page']) ? ' active' : ''; ?>"><?php echo $i; ?></a>
          <?php endfor; ?>
        </nav>
        <?php endif; ?>
      </noscript>
      <?php endif; ?>
    </div>
  </div>
</div>

<script nonce="<?php echo esc_attr($GLOBALS['mw_csp_nonce'] ?? ''); ?>">
(function () {
  'use strict';

  var root = document.querySelector('[data-mw-browse-results]');
  if (!root) return;

  var api = window.ModelWikiAPI ? new window.ModelWikiAPI() : null;
  if (!api) return;

  var filterForm = document.getElementById('mw-browse-filter-form');
  var sortSelect = document.getElementById('browse-sort');
  var countEl = root.querySelector('[data-mw-browse-count]');
  var skeleton = root.querySelector('[data-mw-browse-skeleton]');
  var emptyEl = root.querySelector('[data-mw-browse-empty]');
  var errorEl = root.querySelector('[data-mw-browse-error]');
  var errorMsg = root.querySelector('[data-mw-browse-error-msg]');
  var retryBtn = root.querySelector('[data-mw-browse-retry]');
  var grid = root.querySelector('[data-mw-browse-grid]');
  var pagination = root.querySelector('[data-mw-browse-pagination]');

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

  function setVis(el, show) {
    if (!el) return;
    el.style.display = show ? '' : 'none';
  }

  function collectParams() {
    var params = {};
    if (!filterForm) return params;

    var fields = ['search', 'series', 'manufacturer', 'category', 'scale', 'sculptor', 'year', 'minPrice', 'maxPrice'];
    for (var i = 0; i < fields.length; i++) {
      var el = filterForm.elements[fields[i]];
      if (el) {
        var val = el.value.trim();
        if (val !== '') params[fields[i]] = val;
      }
    }
    if (sortSelect) params.sort = sortSelect.value;
    return params;
  }

  function paginationHtml(currentPage, totalPages) {
    if (totalPages <= 1) return '';
    var html = '';
    for (var i = 1; i <= totalPages; i++) {
      var cls = i === currentPage ? 'mw-page-link active' : 'mw-page-link';
      html += '<button class="' + cls + '" data-page="' + i + '" type="button">' + i + '</button>';
    }
    return html;
  }

  function loadBrowse(params) {
    if (!params) params = collectParams();
    params.perPage = 24;

    setVis(skeleton, true);
    setVis(emptyEl, false);
    setVis(errorEl, false);
    setVis(grid, false);
    setVis(pagination, false);

    api.getFigures(params).then(function (state) {
      if (state.error) {
        setVis(skeleton, false);
        setVis(errorEl, true);
        if (errorMsg) errorMsg.textContent = state.error.message || 'Failed to load figures.';
        return;
      }

      setVis(skeleton, false);

      var figures = state.data;
      if (!figures || figures.length === 0) {
        setVis(emptyEl, true);
        if (countEl) countEl.textContent = '0 figures found';
        return;
      }

      setVis(grid, true);
      grid.innerHTML = figures.map(figureCardHtml).join('');

      if (countEl) countEl.textContent = figures.length + ' figures found';

      // pagination (if meta available from state)
      if (state._meta && state._meta.totalPages > 1) {
        setVis(pagination, true);
        pagination.innerHTML = paginationHtml(state._meta.page, state._meta.totalPages);
        Array.prototype.forEach.call(pagination.querySelectorAll('[data-page]'), function (btn) {
          btn.addEventListener('click', function () {
            var pageParams = collectParams();
            pageParams.page = parseInt(this.getAttribute('data-page'), 10);
            loadBrowse(pageParams);
          });
        });
      }
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', function () { loadBrowse(); });
  }

  if (filterForm) {
    filterForm.addEventListener('submit', function (e) {
      e.preventDefault();
      loadBrowse();
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', function () {
      loadBrowse();
    });
  }

  // Attach pagination click handler via delegation for dynamic buttons
  if (pagination) {
    pagination.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-page]');
      if (btn) {
        var pageParams = collectParams();
        pageParams.page = parseInt(btn.getAttribute('data-page'), 10);
        loadBrowse(pageParams);
      }
    });
  }

  // Load initial data from URL params
  var initialParams = {};
  (function () {
    var urlParams = new URLSearchParams(window.location.search);
    var fields = ['search', 'series', 'manufacturer', 'category', 'scale', 'sculptor', 'year', 'minPrice', 'maxPrice', 'sort', 'page'];
    for (var i = 0; i < fields.length; i++) {
      var val = urlParams.get(fields[i]);
      if (val) initialParams[fields[i]] = val;
    }
  })();

  if (Object.keys(initialParams).length > 0) {
    loadBrowse(initialParams);
  }
})();
</script>

<?php get_footer(); ?>

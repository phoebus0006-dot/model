<?php
if (!defined('ABSPATH')) exit;

if (!function_exists('mw_render_figure_card')) {
function mw_render_figure_card($fig) {
    // HARD CONSTRAINT: never use MFC /upload/items/ thumbnails as card cover
    // (DATA_CONTRACT.md §1.4, CRAWLER_ACCEPTANCE_REPORT.md §4).
    //
    // The API may return either:
    //   - $fig['image']  : a single image object {id, url, size, fullUrl, ...}
    //   - $fig['images'] : an array of image objects
    //
    // mw_image_url() runs the safety check on ALL url/fullUrl/thumbnailUrl/
    // sourceUrl/rawUrl fields and returns '' if any is /upload/items/.
    // So passing $fig['image'] through mw_image_url() is sufficient; we do
    // NOT short-circuit on its presence.
    $image_url = '';

    // 1) Try the primary 'image' field first, but always through mw_image_url()
    //    so that an image object whose raw URL is /upload/items/ is rejected.
    if (!empty($fig['image'])) {
        $image_url = mw_image_url($fig['image']);
    }

    // 2) If 'image' was empty or rejected, scan 'images' for the first
    //    non-thumbnail entry (prefer thumb size, then any non-thumbnail).
    if (!$image_url && !empty($fig['images'])) {
        foreach ($fig['images'] as $img) {
            if (($img['size'] ?? '') === 'thumb') {
                $candidate = mw_image_url($img);
                if ($candidate) { $image_url = $candidate; break; }
            }
        }
        if (!$image_url) {
            foreach ($fig['images'] as $img) {
                $candidate = mw_image_url($img);
                if ($candidate) { $image_url = $candidate; break; }
            }
        }
    }
    // If everything was rejected, $image_url stays '' → placeholder

    $manufacturer = !empty($fig['manufacturer']) ? mw_display_name($fig['manufacturer']) : '';
    $scale = isset($fig['scale']) ? $fig['scale'] : '';
    $priceJpy = isset($fig['priceJpy']) ? $fig['priceJpy'] : 0;
    $releaseDate = isset($fig['releaseDate']) ? $fig['releaseDate'] : '';
    $is_merch = mw_is_merch_figure($fig);
    $is_preorder = $releaseDate && strtotime($releaseDate) > time();
    $display_title = $fig['displayTitle'] ?? mw_display_name($fig);
    ?>
    <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/figure/' . $fig['slug'] . '/'))); ?>" class="mw-figure-card<?php echo $is_merch ? ' mw-figure-card--merch' : ''; ?>">
        <div class="mw-figure-card-img">
            <?php if ($image_url): ?>
                <img src="<?php echo esc_url($image_url); ?>" alt="<?php echo esc_attr($display_title); ?>" loading="lazy">
            <?php else: ?>
                <span class="mw-no-image-placeholder"><?php echo esc_html(mw_t('No image')); ?></span>
            <?php endif; ?>
            <?php if ($is_preorder || $is_merch): ?>
            <div class="mw-figure-card-badges">
                <?php if ($is_preorder): ?>
                <span class="mw-figure-card-badge"><?php echo esc_html(mw_t('Pre-order')); ?></span>
                <?php endif; ?>
                <?php if ($is_merch): ?>
                <span class="mw-figure-card-badge mw-figure-card-badge--merch"><?php echo esc_html(mw_t('Merchandise')); ?></span>
                <?php endif; ?>
            </div>
            <?php endif; ?>
        </div>
        <div class="mw-figure-card-info">
            <h3><?php echo esc_html($display_title); ?></h3>
            <?php if ($manufacturer): ?><span class="mw-figure-card-mfr"><?php echo esc_html($manufacturer); ?></span><?php endif; ?>
            <?php if ($scale && !$is_merch): ?><span class="mw-figure-card-scale"><?php echo esc_html($scale); ?></span><?php endif; ?>
            <?php if ($priceJpy): ?><span class="mw-figure-card-price">&yen;<?php echo number_format(intval($priceJpy)); ?></span><?php endif; ?>
        </div>
    </a>
    <?php
}
}

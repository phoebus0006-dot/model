<?php
$figure = get_query_var('mw_figure_data');
if (!$figure) {
    $slug = get_query_var('figure_slug');
    if ($slug && function_exists('mw_api_call')) {
        $figure = mw_api_call('/figures/' . urlencode($slug), ['lang' => mw_lang()]);
    }
}

if (!$figure) {
    get_header();
    get_template_part('404-content');
    get_footer();
    return;
}

$active_revision = null;
if (!empty($figure['revisions'])) {
    foreach ($figure['revisions'] as $rev) {
        if ($rev['isActive']) {
            $active_revision = $rev;
            break;
        }
    }
}

$display_title = $figure['displayTitle'] ?? ($figure['name'] ?? '');
$original_title = $figure['originalTitle'] ?? ($figure['nameJp'] ?? '');
$display_description = $figure['displayDescription'] ?? ($figure['description'] ?? '');
$display_origin = $figure['displayOrigin'] ?? ($figure['origin'] ?? '');

get_header();
?>

<article class="mw-figure-detail">
    <div class="mw-container">
        <nav class="mw-breadcrumb" aria-label="<?php echo esc_attr(mw_t('Breadcrumb')); ?>">
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/'))); ?>"><?php echo esc_html(mw_t('Home')); ?></a>
            <span class="mw-breadcrumb-sep">/</span>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/browse/'))); ?>"><?php echo esc_html(mw_t('Figures')); ?></a>
            <?php if (!empty($figure['categories'])): ?>
            <?php $firstCat = $figure['categories'][0]['category'] ?? $figure['categories'][0]; ?>
            <span class="mw-breadcrumb-sep">/</span>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/browse/?category=' . urlencode($firstCat['slug'] ?? '')))); ?>"><?php echo esc_html($firstCat['name'] ?? ''); ?></a>
            <?php endif; ?>
            <span class="mw-breadcrumb-sep">/</span>
            <span><?php echo esc_html($display_title); ?></span>
        </nav>

        <div class="mw-figure-layout">
            <div class="mw-figure-gallery">
                <?php
                // HARD CONSTRAINT (DATA_CONTRACT.md §1.4): filter out MFC
                // /upload/items/ diagnostic thumbnails — they must never appear
                // in the detail-page gallery or as main image.
                $all_images = array_filter($figure['images'] ?? [], function($img) {
                    $url = $img['url'] ?? '';
                    return !mw_is_thumbnail_url($url);
                });

                // Separate filtered images by size for optimal display
                $detail_images = array_filter($all_images, function($img) { return ($img['size'] ?? '') === 'detail'; });
                $thumb_images  = array_filter($all_images, function($img) { return ($img['size'] ?? '') === 'thumb'; });
                $raw_images    = array_filter($all_images, function($img) { return ($img['size'] ?? '') === 'raw'; });

                // Use detail images for gallery, fall back to all non-thumbnail images
                $gallery_images = !empty($detail_images) ? array_values($detail_images) : array_values($all_images);
                $thumb_list = !empty($thumb_images) ? array_values($thumb_images) : $gallery_images;

                // Determine merch status (Phase 1: inferred from category slugs only)
                $is_merch = mw_is_merch_figure($figure);
                ?>
                <?php if (!empty($gallery_images)): ?>
                <?php
                $main_image = $gallery_images[0];
                $main_full = $main_image['fullUrl'] ?? ($main_image['url'] ?? $main_image);
                // Track B: low-quality MFC fallback thumbnails must not be stretched
                // to fill the large main image frame (256px -> blurry mess).
                $main_lowq = !empty($main_image['imageLowQuality']);
                $main_class = $main_lowq ? 'mw-gallery-main mw-gallery-main-lowq' : 'mw-gallery-main';
                $main_img_class = $main_lowq ? 'mw-main-image-lowq' : '';
                ?>
                <div class="<?php echo esc_attr($main_class); ?>">
                    <img src="<?php echo esc_url(mw_image_url($gallery_images[0])); ?>"
                         alt="<?php echo esc_attr($gallery_images[0]['alt'] ?? $display_title); ?>"
                         loading="eager"
                         fetchpriority="high"
                         class="<?php echo esc_attr($main_img_class); ?>"
                         data-full="<?php echo esc_url(mw_image_url($main_full)); ?>"
                         id="mw-main-image">
                    <?php if ($main_lowq): ?>
                    <span class="mw-gallery-lowq-badge"><?php echo esc_html(mw_t('Preview image (low quality)')); ?></span>
                    <?php endif; ?>
                </div>
                <?php if (count($gallery_images) > 1): ?>
                <div class="mw-gallery-thumbs">
                    <?php foreach ($gallery_images as $i => $img): ?>
                    <?php
                    $thumb_fallback = $thumb_list[$i] ?? $img;
                    $thumb_src = $img['thumbnailUrl'] ?? ($thumb_fallback['url'] ?? $thumb_fallback);
                    $full_src = $img['fullUrl'] ?? ($img['url'] ?? $img);
                    ?>
                    <button type="button" class="mw-gallery-thumb <?php echo $i === 0 ? 'active' : ''; ?>"
                            data-gallery-thumb
                            data-full="<?php echo esc_url(mw_image_url($full_src)); ?>"
                            data-alt="<?php echo esc_attr($img['alt'] ?? $display_title); ?>"
                            aria-label="<?php echo esc_attr(sprintf(mw_t('View image %d'), $i + 1)); ?>">
                        <img src="<?php echo esc_url(mw_image_url($thumb_src)); ?>" alt="" loading="lazy">
                    </button>
                    <?php endforeach; ?>
                </div>
                <?php endif; ?>
                <div class="mw-lightbox" id="mw-lightbox" role="dialog" aria-modal="true" aria-label="<?php echo esc_attr($display_title ?: 'Image preview'); ?>">
                    <button type="button" class="mw-lightbox-close" id="mw-lightbox-close" aria-label="<?php echo esc_attr(mw_t('Close image preview')); ?>">&times;</button>
                    <img src="" alt="" id="mw-lightbox-img">
                </div>
                <?php else: ?>
                <div class="mw-gallery-main" style="display:flex;align-items:center;justify-content:center;min-height:400px">
                    <span style="color:var(--mw-text-tertiary);font-size:.875rem"><?php echo esc_html(mw_t('No image available')); ?></span>
                </div>
                <?php endif; ?>
            </div>

            <div class="mw-figure-info">
                <h1 class="mw-figure-title"><?php echo esc_html($display_title); ?></h1>
                <?php if (!empty($original_title) && $original_title !== $display_title): ?>
                <p class="mw-figure-name-jp"><?php echo esc_html($original_title); ?></p>
                <?php endif; ?>

                <div class="mw-figure-tags">
                    <?php if (!empty($figure['categories'])): ?>
                        <?php foreach ($figure['categories'] as $cat): ?>
                        <?php $catData = $cat['category'] ?? $cat; ?>
                        <span class="mw-tag mw-tag-category"><?php echo esc_html($catData['name'] ?? ''); ?></span>
                        <?php endforeach; ?>
                    <?php endif; ?>
                    <?php if (!$is_merch && !empty($figure['scale'])): ?>
                    <span class="mw-tag mw-tag-scale"><?php echo esc_html($figure['scale']); ?></span>
                    <?php endif; ?>
                    <?php if (!$is_merch && !empty($figure['material'])): ?>
                    <span class="mw-tag mw-tag-material"><?php echo esc_html($figure['material']); ?></span>
                    <?php endif; ?>
                    <?php if ($is_merch): ?>
                    <span class="mw-tag mw-tag-merch"><?php echo esc_html(mw_t('Merchandise')); ?></span>
                    <?php endif; ?>
                </div>

                <div class="mw-figure-price-date">
                    <?php if (!empty($figure['priceJpy'])): ?>
                    <span class="mw-figure-price">&yen;<?php echo esc_html(number_format($figure['priceJpy'])); ?></span>
                    <?php endif; ?>
                    <?php if (!empty($figure['releaseDate'])): ?>
                    <span class="mw-figure-release"><?php echo esc_html(date_i18n(get_option('date_format'), strtotime($figure['releaseDate']))); ?></span>
                    <?php endif; ?>
                </div>

                <div class="mw-social-actions" data-mw-figure-social data-slug="<?php echo esc_attr($figure['slug'] ?? ''); ?>">
                    <button type="button" class="mw-social-btn" data-mw-like>Like <span data-mw-like-count>0</span></button>
                    <button type="button" class="mw-social-btn" data-mw-favorite>Favorite <span data-mw-favorite-count>0</span></button>
                </div>

                <?php
                // Per DATA_CONTRACT.md §1.5: clean description for encyclopedic display.
                // Strips purchase info, URLs, HTML remnants, excessive whitespace.
                $cleaned_description = mw_clean_description($display_description);
                ?>
                <?php if (!empty($cleaned_description)): ?>
                <p style="color:var(--mw-text-secondary);font-size:.9375rem;line-height:1.7;margin-bottom:var(--mw-space-5);"><?php echo esc_html($cleaned_description); ?></p>
                <?php endif; ?>

                <?php if (!empty($figure['manufacturer'])): ?>
                <div class="mw-meta-card">
                    <span class="mw-meta-card-label"><?php echo esc_html(mw_t('Maker')); ?></span>
                    <a href="<?php echo esc_url(home_url('/manufacturer/' . $figure['manufacturer']['slug'] . '/')); ?>">
                        <?php echo esc_html($figure['manufacturer']['name'] ?? $figure['manufacturer']['nameEn'] ?? ''); ?>
                    </a>
                </div>
                <?php endif; ?>

                <?php if (!empty($display_origin)): ?>
                <div class="mw-meta-card">
                    <span class="mw-meta-card-label"><?php echo esc_html(mw_t('Origin')); ?></span>
                    <span><?php echo esc_html($display_origin); ?></span>
                </div>
                <?php endif; ?>

                <?php if (!empty($figure['series'])): ?>
                <div class="mw-meta-card">
                    <span class="mw-meta-card-label"><?php echo esc_html(mw_t('Series')); ?></span>
                    <a href="<?php echo esc_url(home_url('/series/' . $figure['series']['slug'] . '/')); ?>">
                        <?php echo esc_html($figure['series']['name'] ?? $figure['series']['nameEn'] ?? ''); ?>
                    </a>
                </div>
                <?php endif; ?>

                <?php if (!empty($figure['sculptors'])): ?>
                <div class="mw-meta-card">
                    <span class="mw-meta-card-label"><?php echo esc_html(mw_t('Sculptor')); ?></span>
                    <?php foreach ($figure['sculptors'] as $i => $s): ?>
                        <?php if ($i > 0) echo ', '; ?>
                        <a href="<?php echo esc_url(home_url('/sculptor/' . $s['sculptor']['slug'] . '/')); ?>">
                            <?php echo esc_html($s['sculptor']['name'] ?? $s['sculptor']['nameEn'] ?? ''); ?>
                        </a>
                    <?php endforeach; ?>
                </div>
                <?php endif; ?>

                <?php if (!empty($figure['painter'])): ?>
                <div class="mw-meta-card">
                    <span class="mw-meta-card-label"><?php echo esc_html(mw_t('Painter')); ?></span>
                    <span><?php echo esc_html($figure['painter']); ?></span>
                </div>
                <?php endif; ?>

                <?php if (!empty($figure['characters'])): ?>
                <div class="mw-meta-card">
                    <span class="mw-meta-card-label"><?php echo esc_html(mw_t('Character')); ?></span>
                    <?php foreach ($figure['characters'] as $i => $c): ?>
                        <?php if ($i > 0) echo ', '; ?>
                        <?php
                        $character = $c['character'] ?? [];
                        $character_name = mw_display_name($character);
                        $character_url = !empty($character['slug'])
                            ? home_url('/character/' . $character['slug'] . '/')
                            : home_url('/browse/?search=' . urlencode($character_name));
                        ?>
                        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), $character_url)); ?>">
                            <?php echo esc_html($character_name); ?>
                        </a>
                    <?php endforeach; ?>
                </div>
                <?php endif; ?>

                <div class="mw-specs-card">
                    <h3><?php echo esc_html(mw_t('Specifications')); ?></h3>
                    <div class="mw-specs-list">
                        <?php
                        // Per Acceptance criteria: hide figure-specific spec fields on merch pages
                        // (scale/material/height/weight/ageRating). Keep universal fields.
                        $show_figure_specs = !$is_merch;
                        ?>
                        <?php if ($show_figure_specs && !empty($figure['scale'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Scale')); ?></span><span class="mw-specs-value"><?php echo esc_html($figure['scale']); ?></span></div>
                        <?php endif; ?>
                        <?php if ($show_figure_specs && !empty($figure['material'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Material')); ?></span><span class="mw-specs-value"><?php echo esc_html($figure['material']); ?></span></div>
                        <?php endif; ?>
                        <?php if ($show_figure_specs && !empty($figure['heightMm'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Height')); ?></span><span class="mw-specs-value"><?php echo esc_html(sprintf('~%dmm', intval($figure['heightMm']))); ?></span></div>
                        <?php endif; ?>
                        <?php if ($show_figure_specs && !empty($figure['weightG'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Weight')); ?></span><span class="mw-specs-value"><?php echo esc_html(sprintf('%dg', intval($figure['weightG']))); ?></span></div>
                        <?php endif; ?>
                        <?php if (!empty($figure['janCode'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('JAN')); ?></span><span class="mw-specs-value mw-mono"><?php echo esc_html($figure['janCode']); ?></span></div>
                        <?php endif; ?>
                        <?php if (!empty($figure['priceJpy'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Price')); ?></span><span class="mw-specs-value">&yen;<?php echo esc_html(number_format($figure['priceJpy'])); ?></span></div>
                        <?php endif; ?>
                        <?php if (!empty($display_origin)): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Origin')); ?></span><span class="mw-specs-value"><?php echo esc_html($display_origin); ?></span></div>
                        <?php endif; ?>
                        <?php if (!empty($figure['releaseDate'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Release Date')); ?></span><span class="mw-specs-value"><?php echo esc_html(date_i18n(get_option('date_format'), strtotime($figure['releaseDate']))); ?></span></div>
                        <?php endif; ?>
                        <?php if ($show_figure_specs && !empty($figure['painter'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Painter')); ?></span><span><?php echo esc_html($figure['painter']); ?></span></div>
                        <?php endif; ?>
                        <?php if ($show_figure_specs && !empty($figure['ageRating'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Age Rating')); ?></span><span><?php echo esc_html($figure['ageRating']); ?></span></div>
                        <?php endif; ?>
                        <?php if (!empty($figure['rerelease'])): ?>
                        <div class="mw-specs-item"><span class="mw-specs-label"><?php echo esc_html(mw_t('Re-release')); ?></span><span><?php echo $figure['rerelease'] ? esc_html(mw_t('Yes')) : esc_html(mw_t('No')); ?></span></div>
                        <?php endif; ?>
                    </div>
                </div>

                <?php if (!empty($figure['mfcId'])): ?>
                <div class="mw-meta-card">
                    <span class="mw-meta-card-label">MFC</span>
                    <a href="https://myfigurecollection.net/item/<?php echo esc_attr($figure['mfcId']); ?>" target="_blank" rel="noopener noreferrer">
                        #<?php echo esc_html($figure['mfcId']); ?> ↗
                    </a>
                </div>
                <?php endif; ?>

            </div>
        </div>

        <?php
        // Per DATA_CONTRACT.md §1.5: clean active_revision contentMd before
        // rendering. Strips raw URLs, "Where to Purchase" sentences, and
        // purchase-shop文案 — preserves Markdown structure (headings, lists,
        // bold/italic, code blocks). Display-layer only; DB not modified.
        $cleaned_content_md = $active_revision && !empty($active_revision['contentMd'])
            ? mw_clean_markdown($active_revision['contentMd'])
            : '';
        ?>
        <?php if (!empty($cleaned_content_md)): ?>
        <div class="mw-figure-content-section">
            <h2><?php echo esc_html(mw_t('About This Figure')); ?></h2>
            <div class="mw-figure-content">
                <?php echo wp_kses_post(md_to_html($cleaned_content_md)); ?>
            </div>
        </div>
        <?php endif; ?>

        <?php if (!empty($figure['parentId']) || !empty($figure['lineage']['descendants'] ?? null)): ?>
        <div class="mw-lineage">
            <h3><?php echo esc_html(mw_t('Version Lineage')); ?></h3>
            <ul class="mw-lineage-list">
                <?php if (!empty($figure['lineage']['ancestors'] ?? null)): ?>
                    <?php foreach ($figure['lineage']['ancestors'] as $anc): ?>
                    <li class="mw-lineage-item mw-lineage-ancestor">
                        <a href="<?php echo esc_url(home_url('/figure/' . $anc['slug'] . '/')); ?>"><?php echo esc_html($anc['name']); ?></a>
                        <?php if (!empty($anc['releaseDate'])): ?>
                        <span class="mw-lineage-date"><?php echo esc_html(date_i18n('M Y', strtotime($anc['releaseDate']))); ?></span>
                        <?php endif; ?>
                    </li>
                    <?php endforeach; ?>
                <?php endif; ?>
                <li class="mw-lineage-item mw-lineage-current">
                    <strong><?php echo esc_html($display_title); ?></strong>
                    <?php if (!empty($figure['releaseDate'])): ?>
                    <span class="mw-lineage-date"><?php echo esc_html(date_i18n('M Y', strtotime($figure['releaseDate']))); ?></span>
                    <?php endif; ?>
                </li>
                <?php if (!empty($figure['lineage']['descendants'] ?? null)): ?>
                    <?php foreach ($figure['lineage']['descendants'] as $desc): ?>
                    <li class="mw-lineage-item mw-lineage-descendant">
                        <a href="<?php echo esc_url(home_url('/figure/' . $desc['slug'] . '/')); ?>"><?php echo esc_html($desc['name']); ?></a>
                        <?php if (!empty($desc['releaseDate'])): ?>
                        <span class="mw-lineage-date"><?php echo esc_html(date_i18n('M Y', strtotime($desc['releaseDate']))); ?></span>
                        <?php endif; ?>
                    </li>
                    <?php endforeach; ?>
                <?php endif; ?>
            </ul>
        </div>
        <?php endif; ?>

        <section class="mw-comments" data-mw-comments data-slug="<?php echo esc_attr($figure['slug'] ?? ''); ?>">
            <div class="mw-comments-header">
                <h2><?php echo esc_html(mw_t('Comments')); ?></h2>
                <span data-mw-comment-count>0</span>
            </div>
            <form class="mw-comment-form" data-mw-comment-form>
                <textarea name="body" rows="4" maxlength="2000" placeholder="<?php echo esc_attr(mw_t('Share your thoughts about this figure...')); ?>"></textarea>
                <div class="mw-comment-form-footer">
                    <p class="mw-form-message" data-mw-comment-message></p>
                    <button type="submit" class="mw-social-btn mw-social-btn-primary"><?php echo esc_html(mw_t('Post comment')); ?></button>
                </div>
            </form>
            <div class="mw-comment-list" data-mw-comment-list></div>
        </section>

        <?php
        $related_figures = [];
        if (function_exists('mw_api_fetch') && !empty($figure['series']['slug'])) {
            $related_result = mw_api_fetch('/figures', ['series' => $figure['series']['slug'], 'perPage' => 6, 'sort' => 'release_date:desc', 'lang' => mw_lang()]);
            if ($related_result['success'] && is_array($related_result['data'])) {
                $related_figures = array_filter($related_result['data'], function($f) use ($figure) {
                    return ($f['id'] ?? null) !== ($figure['id'] ?? null);
                });
                // De-duplicate by id/slug in case of multi-localized joins
                $related_figures = mw_dedup_figures($related_figures);
            }
        }
        ?>
        <?php if (!empty($related_figures)): ?>
        <div class="mw-related">
            <h2><?php echo esc_html(mw_t('Related Figures')); ?></h2>
            <div class="mw-figure-grid">
                <?php foreach (array_slice($related_figures, 0, 5) as $rf): ?>
                    <?php mw_render_figure_card($rf); ?>
                <?php endforeach; ?>
            </div>
        </div>
        <?php endif; ?>
    </div>
</article>

<?php get_footer(); ?>

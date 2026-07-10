#!/usr/bin/env python3
"""Apply all audit fixes to ModelWiki theme."""
import os

THEME_DIR = '/home/ubuntu/modelwiki/docker/wordpress/wp-content/themes/modelwiki'

# ============================================================
# FIX 1: mw_render_figure_card() redeclared
# Wrap with if (!function_exists()) in figure-card.php
# ============================================================
def fix1():
    path = os.path.join(THEME_DIR, 'template-parts/figure-card.php')
    new_content = """<?php
if (!defined('ABSPATH')) exit;

if (!function_exists('mw_render_figure_card')) {
function mw_render_figure_card($fig) {
    $thumb = isset($fig['images'][0]['url']) ? $fig['images'][0]['url'] : '';
    $manufacturer = isset($fig['manufacturer']['name']) ? $fig['manufacturer']['name'] : '';
    $scale = isset($fig['scale']) ? $fig['scale'] : '';
    $priceJpy = isset($fig['priceJpy']) ? $fig['priceJpy'] : 0;
    $releaseDate = isset($fig['releaseDate']) ? $fig['releaseDate'] : '';
    ?>
    <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/figure/' . $fig['slug'] . '/'))); ?>" class="mw-figure-card">
        <div class="mw-figure-card-img">
            <?php if ($thumb): ?>
                <img src="<?php echo esc_url(mw_image_url($thumb)); ?>" alt="<?php echo esc_attr($fig['name'] ?? ''); ?>" loading="lazy">
            <?php else: ?>
                <span class="mw-no-image-placeholder"><?php echo esc_html(mw_t('No image')); ?></span>
            <?php endif; ?>
            <?php if ($releaseDate && strtotime($releaseDate) > time()): ?>
                <span class="mw-figure-card-badge"><?php echo esc_html(mw_t('Pre-order')); ?></span>
            <?php endif; ?>
        </div>
        <div class="mw-figure-card-info">
            <h3><?php echo esc_html($fig['name'] ?? ''); ?></h3>
            <?php if ($manufacturer): ?><span class="mw-figure-card-mfr"><?php echo esc_html($manufacturer); ?></span><?php endif; ?>
            <?php if ($scale): ?><span class="mw-figure-card-scale"><?php echo esc_html($scale); ?></span><?php endif; ?>
            <?php if ($priceJpy): ?><span class="mw-figure-card-price">&yen;<?php echo number_format(intval($priceJpy)); ?></span><?php endif; ?>
        </div>
    </a>
    <?php
}
}
"""
    with open(path, 'w') as f:
        f.write(new_content)
    print(f"FIX 1: Updated {path}")

# ============================================================
# FIX 2: page-admin.php accessible without WordPress
# Add ABSPATH check at the top
# ============================================================
def fix2():
    path = os.path.join(THEME_DIR, 'page-admin.php')
    with open(path, 'r') as f:
        content = f.read()
    if content.startswith('<?php\n'):
        content = '<?php\nif (!defined(\'ABSPATH\')) exit;\n' + content[6:]
    elif content.startswith('<?php\r\n'):
        content = '<?php\r\nif (!defined(\'ABSPATH\')) exit;\r\n' + content[8:]
    with open(path, 'w') as f:
        f.write(content)
    print(f"FIX 2: Added ABSPATH check to {path}")

# ============================================================
# FIX 3: Gallery thumbnails layout — improved CSS
# ============================================================
def fix3():
    path = os.path.join(THEME_DIR, 'assets/css/main.css')
    with open(path, 'r') as f:
        content = f.read()

    # Replace the existing .mw-gallery-thumb.active rule and add full gallery thumb styles
    old_thumb_active = '.mw-gallery-thumb.active{border-color:var(--mw-accent)}'
    new_gallery_css = """.mw-gallery-thumbs{display:flex;flex-direction:row;gap:.5rem;overflow-x:auto;padding:.5rem 0;scrollbar-width:thin;scrollbar-color:var(--mw-border) transparent}
.mw-gallery-thumbs::-webkit-scrollbar{height:4px}
.mw-gallery-thumbs::-webkit-scrollbar-track{background:transparent}
.mw-gallery-thumbs::-webkit-scrollbar-thumb{background:var(--mw-border);border-radius:2px}
.mw-gallery-thumb{width:72px;height:72px;object-fit:cover;border-radius:6px;border:2px solid var(--mw-border);cursor:pointer;transition:var(--mw-transition);flex-shrink:0;background:var(--mw-card);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.mw-gallery-thumb:hover{border-color:var(--mw-accent);box-shadow:0 2px 6px rgba(233,69,96,.2)}
.mw-gallery-thumb.active{border-color:var(--mw-accent);box-shadow:0 0 0 2px rgba(233,69,96,.3)}"""

    if old_thumb_active in content:
        content = content.replace(old_thumb_active, new_gallery_css)
        print("FIX 3: Replaced .mw-gallery-thumb.active with full gallery thumb CSS")
    else:
        print("FIX 3: WARNING - could not find .mw-gallery-thumb.active rule")

    with open(path, 'w') as f:
        f.write(content)

# ============================================================
# FIX 4: "Figure not found" errors flooding logs
# Rate-limit error logging in mw_api_get()
# ============================================================
def fix4():
    path = os.path.join(THEME_DIR, 'functions.php')
    with open(path, 'r') as f:
        content = f.read()

    old_func = """function mw_api_get($endpoint, $params = []) {
    $url = MW_API_URL . $endpoint;
    if (!empty($params)) {
        $url .= '?' . http_build_query($params);
    }
    $response = wp_remote_get($url, ['timeout' => 10]);
    if (is_wp_error($response)) {
        error_log('MW API GET error (' . $endpoint . '): ' . $response->get_error_message());
        return null;
    }
    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    return $data;
}"""

    new_func = """function mw_api_get($endpoint, $params = []) {
    static $logged_errors = [];
    $url = MW_API_URL . $endpoint;
    if (!empty($params)) {
        $url .= '?' . http_build_query($params);
    }
    $response = wp_remote_get($url, ['timeout' => 10]);
    if (is_wp_error($response)) {
        $err_key = $endpoint;
        if (!isset($logged_errors[$err_key])) {
            error_log('MW API GET error: ' . $response->get_error_message());
            $logged_errors[$err_key] = true;
        }
        return null;
    }
    $code = wp_remote_retrieve_response_code($response);
    if ($code === 404) {
        return null; // silently return null for 404s
    }
    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    return $data;
}"""

    if old_func in content:
        content = content.replace(old_func, new_func)
        print("FIX 4: Updated mw_api_get() with rate-limited error logging and 404 handling")
    else:
        print("FIX 4: WARNING - could not find exact mw_api_get() function text")

    with open(path, 'w') as f:
        f.write(content)

# ============================================================
# FIX 5: page-figure.php related figures — use mw_render_figure_card directly
# (Already done in the current file based on reading, but verify)
# ============================================================
def fix5():
    path = os.path.join(THEME_DIR, 'page-figure.php')
    with open(path, 'r') as f:
        content = f.read()

    old_pattern = """set_query_var('mw_figure', $rf);
                    get_template_part('template-parts/figure', 'card');"""

    if old_pattern in content:
        content = content.replace(old_pattern, '                    mw_render_figure_card($rf);')
        print("FIX 5: Replaced get_template_part with mw_render_figure_card in page-figure.php")
    else:
        # Check if already using mw_render_figure_card
        if 'mw_render_figure_card($rf)' in content:
            print("FIX 5: Already using mw_render_figure_card($rf) - no change needed")
        else:
            print("FIX 5: WARNING - could not find the pattern to replace")

    with open(path, 'w') as f:
        f.write(content)

# ============================================================
# FIX 6: Remove duplicate CSS rules
# Remove old rules from the middle section (lines 379-399)
# ============================================================
def fix6():
    path = os.path.join(THEME_DIR, 'assets/css/main.css')
    with open(path, 'r') as f:
        content = f.read()

    # The old duplicate rules to remove (they appear before the appended section)
    old_rules = """.mw-figure-detail{padding:2rem 0}
.mw-figure-header{margin-bottom:1.5rem}
.mw-figure-header h1{font-size:2rem;margin-bottom:.25rem;line-height:1.3}
.mw-figure-name-jp{color:var(--mw-text-light);font-size:1.1rem} 
.mw-figure-gallery{margin:1.5rem 0;display:grid;grid-template-columns:1fr;gap:.5rem}
.mw-gallery-item img{width:100%;border-radius:var(--mw-radius)} 
.mw-figure-content-layout{display:grid;grid-template-columns:1fr 320px;gap:2rem;margin-top:1.5rem}
.mw-figure-content{line-height:1.8;font-size:.95rem}
.mw-figure-sidebar .mw-figure-specs,
.mw-figure-sidebar .mw-figure-meta{
  background:var(--mw-card);
  border-radius:var(--mw-radius);
  padding:1.25rem;
  border:1px solid var(--mw-border);
  margin-bottom:1rem;
}
.mw-figure-specs h3,.mw-figure-meta h3{margin-bottom:.75rem;font-size:.95rem;font-weight:700}
.mw-figure-specs dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem .75rem;font-size:.9rem}
.mw-figure-specs dt{color:var(--mw-text-light)}

.mw-no-results{text-align:center;padding:3rem 1rem;color:var(--mw-text-light);font-size:1rem}"""

    # Try with various whitespace variations
    # First try exact match
    if old_rules in content:
        content = content.replace(old_rules, '')
        print("FIX 6: Removed duplicate CSS rules (exact match)")
    else:
        # Try line by line approach - find the block between .mw-entity-grid and .mw-cookie-banner
        lines = content.split('\n')
        start_idx = None
        end_idx = None
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith('.mw-figure-detail{padding'):
                start_idx = i
            if start_idx is not None and stripped.startswith('.mw-no-results{'):
                end_idx = i + 1
                break

        if start_idx is not None and end_idx is not None:
            # Remove lines from start_idx to end_idx
            lines = lines[:start_idx] + lines[end_idx:]
            content = '\n'.join(lines)
            print(f"FIX 6: Removed duplicate CSS rules (lines {start_idx+1}-{end_idx})")
        else:
            print(f"FIX 6: WARNING - could not find duplicate block (start={start_idx}, end={end_idx})")

    with open(path, 'w') as f:
        f.write(content)

# ============================================================
# FIX 7: Disable WordPress emoji scripts
# ============================================================
def fix7():
    path = os.path.join(THEME_DIR, 'functions.php')
    with open(path, 'r') as f:
        content = f.read()

    emoji_code = """remove_action('wp_head', 'print_emoji_detection_script', 7);
remove_action('wp_print_styles', 'print_emoji_styles');
remove_action('admin_print_scripts', 'print_emoji_detection_script');
remove_action('admin_print_styles', 'print_emoji_styles');
"""

    if 'print_emoji_detection_script' in content:
        print("FIX 7: Emoji removal already present - no change needed")
        return

    # Add after the theme setup function
    marker = "add_action('after_setup_theme', 'mw_theme_setup');"
    if marker in content:
        content = content.replace(marker, marker + '\n\n' + emoji_code)
        print("FIX 7: Added emoji script removal to functions.php")
    else:
        # Fallback: add before the require at the end
        content = content.rstrip() + '\n\n' + emoji_code
        print("FIX 7: Added emoji script removal at end of functions.php")

    with open(path, 'w') as f:
        f.write(content)

# ============================================================
# Bump version to 2.5.0
# ============================================================
def bump_version():
    # Update style.css
    style_path = os.path.join(THEME_DIR, 'style.css')
    with open(style_path, 'r') as f:
        content = f.read()
    content = content.replace('Version: 2.1.0', 'Version: 2.5.0')
    content = content.replace('Version: 2.4.0', 'Version: 2.5.0')
    with open(style_path, 'w') as f:
        f.write(content)
    print("Bumped style.css version to 2.5.0")

    # Update functions.php version references
    func_path = os.path.join(THEME_DIR, 'functions.php')
    with open(func_path, 'r') as f:
        content = f.read()
    content = content.replace("'2.4.0'", "'2.5.0'")
    with open(func_path, 'w') as f:
        f.write(content)
    print("Bumped functions.php version to 2.5.0")

if __name__ == '__main__':
    print("=" * 60)
    print("Applying ModelWiki audit fixes...")
    print("=" * 60)

    fix1()
    fix2()
    fix3()
    fix4()
    fix5()
    fix6()
    fix7()
    bump_version()

    print("=" * 60)
    print("All fixes applied!")
    print("=" * 60)

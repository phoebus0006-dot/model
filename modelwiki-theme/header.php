<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo('charset'); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="<?php echo esc_attr(mw_t('The Refined Figure Encyclopedia. A comprehensive database of anime figures, scale models, and collectibles with European minimalist design.')); ?>">
    <link rel="canonical" href="<?php echo esc_url(home_url($wp->request ? trailingslashit($wp->request) : '')); ?>">
    <?php wp_head(); ?>
    <script data-cfasync="false" nonce="<?php echo esc_attr($GLOBALS['mw_csp_nonce'] ?? ''); ?>">
    window.MW_I18N = <?php echo json_encode([
        'Personal Space' => mw_t('Personal Space'),
        'Log in' => mw_t('Log in'),
        'Nothing here yet.' => mw_t('Nothing here yet.'),
        'No comments yet.' => mw_t('No comments yet.'),
        'Signing in...' => mw_t('Signing in...'),
        'Login failed' => mw_t('Login failed'),
        'Please meet all password rules and confirm the password.' => mw_t('Please meet all password rules and confirm the password.'),
        'Creating account...' => mw_t('Creating account...'),
        'Registration received. Please check your email and activate the account before logging in.' => mw_t('Registration received. Please check your email and activate the account before logging in.'),
        'Registration failed' => mw_t('Registration failed'),
        'Password meets the rules' => mw_t('Password meets the rules'),
        'Almost there' => mw_t('Almost there'),
        'Password needs work' => mw_t('Password needs work'),
        'Please write a comment first.' => mw_t('Please write a comment first.'),
        'Posting...' => mw_t('Posting...'),
        'Could not post comment' => mw_t('Could not post comment'),
    ]); ?>;
    </script>
</head>
<body <?php body_class(); ?>>
<a href="#main-content" class="mw-skip-link"><?php echo esc_html(mw_t('Skip to content')); ?></a>
<header class="mw-header">
    <div class="mw-container">
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/'))); ?>" class="mw-logo" aria-label="<?php echo esc_attr(mw_t('ModelWiki Home')); ?>">ModelWiki</a>
        <nav class="mw-nav" aria-label="<?php echo esc_attr(mw_t('Primary Navigation')); ?>">
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/'))); ?>"><?php echo esc_html(mw_t('Home')); ?></a>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/browse/'))); ?>"><?php echo esc_html(mw_t('Figurines')); ?></a>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/characters/'))); ?>"><?php echo esc_html(mw_t('Personnages')); ?></a>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/search/'))); ?>"><?php echo esc_html(mw_t('Search')); ?></a>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/series/'))); ?>"><?php echo esc_html(mw_t('Series')); ?></a>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/manufacturers/'))); ?>"><?php echo esc_html(mw_t('Manufacturers')); ?></a>
        </nav>
        <div class="mw-header-actions">
            <form class="mw-header-search" action="<?php echo esc_url(home_url('/search/')); ?>" method="get" role="search">
                <label for="mw-header-search-input" class="mw-sr-only"><?php echo esc_html(mw_t('Site Search')); ?></label>
                <input type="text" id="mw-header-search-input" name="q" placeholder="<?php echo esc_attr(mw_t('Search figures...')); ?>" value="<?php echo esc_attr(get_query_var('q')); ?>">
                <input type="hidden" name="lang" value="<?php echo esc_attr(mw_lang()); ?>">
                <button type="submit"><?php echo esc_html(mw_t('Search')); ?></button>
            </form>
            <div class="mw-lang-switch">
                <?php
                $currentLang = mw_lang();
                $langs = array('en' => 'EN', 'fr' => 'FR', 'de' => 'DE', 'it' => 'IT');
                foreach ($langs as $code => $label):
                ?>
                    <a href="<?php echo esc_url(add_query_arg('lang', $code)); ?>" class="mw-lang-btn<?php echo $currentLang === $code ? ' active' : ''; ?>" hreflang="<?php echo esc_attr($code); ?>"><?php echo esc_html($label); ?></a>
                <?php endforeach; ?>
            </div>
            <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/account/'))); ?>" class="mw-account-chip" data-mw-account-link><?php echo esc_html(mw_t('Log in')); ?></a>
            <button class="mw-mobile-menu-btn" id="mw-mobile-menu-btn" aria-label="<?php echo esc_attr(mw_t('Open menu')); ?>">&#9776;</button>
        </div>
    </div>
    <nav class="mw-mobile-menu" id="mw-mobile-menu" aria-label="<?php echo esc_attr(mw_t('Mobile Navigation')); ?>">
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/'))); ?>"><?php echo esc_html(mw_t('Home')); ?></a>
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/browse/'))); ?>"><?php echo esc_html(mw_t('Figurines')); ?></a>
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/characters/'))); ?>"><?php echo esc_html(mw_t('Personnages')); ?></a>
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/search/'))); ?>"><?php echo esc_html(mw_t('Search')); ?></a>
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/series/'))); ?>"><?php echo esc_html(mw_t('Series')); ?></a>
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/manufacturers/'))); ?>"><?php echo esc_html(mw_t('Manufacturers')); ?></a>
        <a href="<?php echo esc_url(add_query_arg('lang', mw_lang(), home_url('/account/'))); ?>" data-mw-account-link><?php echo esc_html(mw_t('Log in')); ?></a>
    </nav>
</header>
<main id="main-content">

<?php
// Redirect to the canonical list page to avoid duplicate template confusion
wp_redirect(add_query_arg('lang', mw_lang(), home_url('/sculptors-list/')), 301);
exit;

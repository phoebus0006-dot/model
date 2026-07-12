<?php
status_header(200);
nocache_headers();
get_header();
?>

<section class="mw-account-page" data-mw-account-page>
    <div class="mw-container">
        <div class="mw-account-shell">
            <aside class="mw-account-intro">
                <p class="mw-eyebrow"><?php echo esc_html(mw_t('ModelWiki Account')); ?></p>
                <h1><?php echo esc_html(mw_t('Your personal figure shelf')); ?></h1>
                <p class="mw-account-lede"><?php echo esc_html(mw_t('Save figures, collect favorites, and keep your comments in one clean space.')); ?></p>
                <div class="mw-account-benefits">
                    <span><?php echo esc_html(mw_t('Favorites library')); ?></span>
                    <span><?php echo esc_html(mw_t('Likes and comments')); ?></span>
                    <span><?php echo esc_html(mw_t('Fast return from the header')); ?></span>
                </div>
            </aside>

            <div class="mw-auth-box" data-mw-auth-panel>
                <div class="mw-auth-tabs" role="tablist" aria-label="<?php echo esc_attr(mw_t('Account actions')); ?>">
                    <button type="button" class="active" data-mw-auth-tab="login" role="tab" aria-selected="true"><?php echo esc_html(mw_t('Log in')); ?></button>
                    <button type="button" data-mw-auth-tab="register" role="tab" aria-selected="false"><?php echo esc_html(mw_t('Create account')); ?></button>
                </div>

                <form class="mw-auth-form active" data-mw-login-form data-mw-auth-view="login">
                    <div class="mw-auth-heading">
                        <h2><?php echo esc_html(mw_t('Welcome back')); ?></h2>
                        <p><?php echo esc_html(mw_t('Log in and we will take you back to the homepage.')); ?></p>
                    </div>
                    <label>
                        <span><?php echo esc_html(mw_t('Username')); ?></span>
                        <input type="text" name="username" autocomplete="username" required>
                    </label>
                    <label>
                        <span><?php echo esc_html(mw_t('Password')); ?></span>
                        <input type="password" name="password" autocomplete="current-password" required>
                    </label>
                    <button type="submit" class="mw-social-btn mw-social-btn-primary mw-auth-submit"><?php echo esc_html(mw_t('Log in')); ?></button>
                    <p class="mw-form-message" data-mw-login-message></p>
                </form>

                <form class="mw-auth-form" data-mw-register-form data-mw-auth-view="register">
                    <div class="mw-auth-heading">
                        <h2><?php echo esc_html(mw_t('Create your account')); ?></h2>
                        <p><?php echo esc_html(mw_t('Register an account to save your favorite figures.')); ?></p>
                    </div>
                    <label>
                        <span><?php echo esc_html(mw_t('Username')); ?></span>
                        <input type="text" name="username" autocomplete="username" maxlength="40" required>
                    </label>
                    <label>
                        <span><?php echo esc_html(mw_t('Password')); ?></span>
                        <input type="password" name="password" autocomplete="new-password" minlength="8" maxlength="128" data-mw-password-input required>
                    </label>
                    <div class="mw-password-meter" aria-live="polite">
                        <div class="mw-password-track"><span data-mw-password-bar></span></div>
                        <strong data-mw-password-label><?php echo esc_html(mw_t('Enter a valid password')); ?></strong>
                    </div>
                    <ul class="mw-password-rules">
                        <li data-mw-password-rule="length"><?php echo esc_html(mw_t('At least 8 characters')); ?></li>
                        <li data-mw-password-rule="upper"><?php echo esc_html(mw_t('One uppercase letter')); ?></li>
                        <li data-mw-password-rule="lower"><?php echo esc_html(mw_t('One lowercase letter')); ?></li>
                        <li data-mw-password-rule="special"><?php echo esc_html(mw_t('One special character')); ?></li>
                    </ul>
                    <label>
                        <span><?php echo esc_html(mw_t('Confirm password')); ?></span>
                        <input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" maxlength="128" required>
                    </label>
                    <label class="mw-honeypot" aria-hidden="true" tabindex="-1">
                        <span><?php echo esc_html(mw_t('Website')); ?></span>
                        <input type="text" name="website" autocomplete="off" tabindex="-1">
                    </label>
                    <button type="submit" class="mw-social-btn mw-social-btn-primary mw-auth-submit" data-mw-register-submit disabled><?php echo esc_html(mw_t('Create account')); ?></button>
                    <p class="mw-form-message" data-mw-register-message></p>
                </form>
            </div>
        </div>

        <div class="mw-space" data-mw-space hidden>
            <div class="mw-space-profile">
                <div>
                    <p class="mw-eyebrow"><?php echo esc_html(mw_t('Personal Space')); ?></p>
                    <h2 data-mw-space-name></h2>
                    <p data-mw-space-email></p>
                </div>
                <button type="button" class="mw-social-btn mw-social-btn-muted" data-mw-logout><?php echo esc_html(mw_t('Log out')); ?></button>
            </div>

            <div class="mw-space-grid">
                <div class="mw-space-section">
                    <h2><?php echo esc_html(mw_t('Favorites')); ?></h2>
                    <div class="mw-space-list" data-mw-favorites></div>
                </div>

                <div class="mw-space-section">
                    <h2><?php echo esc_html(mw_t('Likes')); ?></h2>
                    <div class="mw-space-list" data-mw-likes></div>
                </div>

                <div class="mw-space-section mw-space-section-wide">
                    <h2><?php echo esc_html(mw_t('Comments')); ?></h2>
                    <div class="mw-comment-list" data-mw-my-comments></div>
                </div>
            </div>
        </div>
    </div>
</section>

<?php get_footer(); ?>

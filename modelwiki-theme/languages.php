<?php
/**
 * ModelWiki 多语言国际化系统
 * ========================
 *
 * 语言检测优先级：
 *   1. Cookie (mw_lang) — 用户手动切换后持久化
 *   2. Query 参数 (?lang=fr) — 首次访问通过 URL 传参
 *   3. 浏览器 Accept-Language — 自动检测
 *   4. 默认法语 (fr)
 *
 * 支持语言：fr(法语,默认), en(英语), de(德语), it(意大利语)
 *
 * 核心函数：
 *   mw_lang()        — 检测当前语言代码
 *   mw_t($key)       — 翻译单个 key，找不到原样返回
 *   mw_price_eur($jpy) — 日元转欧元（汇率 0.006）
 *   mw_lang_switcher() — 生成语言切换按钮 HTML
 *
 * 数据约定：
 *   - 翻译数组保存在 $GLOBALS['MW_TRANSLATIONS']
 *   - 每个翻译 key 必须在 4 种语言中都有对应值
 *   - mw_t() 使用 static 缓存，同一请求内不重复查找
 *
 * @package ModelWiki
 * @since   2.0.0
 * @version 3.7.0
 */

// ============================================================================
// 常量定义
// ============================================================================

/** 默认语言代码 */
define('MW_DEFAULT_LANG', 'fr');

/** 可用语言列表：代码 => 缩写标签 */
define('MW_LANGS', ['fr' => 'FR', 'en' => 'EN', 'de' => 'DE', 'it' => 'IT']);

/** 语言全名（用于 title 属性） */
define('MW_LANG_NAMES', [
    'fr' => 'Français',
    'en' => 'English',
    'de' => 'Deutsch',
    'it' => 'Italiano',
]);

/**
 * 日元转欧元汇率
 *
 * 未来可考虑通过 API 获取实时汇率。
 * 当前使用固定汇率 ≈ 0.006 (1 JPY ≈ 0.006 EUR)
 */
define('MW_EUR_RATE', 0.006);

// ============================================================================
// i18n 核心函数
// ============================================================================

/**
 * 检测当前用户语言
 *
 * 优先级：Cookie → URL 参数 → 浏览器设置 → 默认法语
 * 当通过 URL 参数检测到语言时，会同步写入 Cookie
 *
 * @return string 语言代码 (fr|en|de|it)
 */
function mw_lang() {
    // 1. URL 参数优先（用户通过语言按钮显式选择）
    $param = $_GET['lang'] ?? null;
    if ($param && isset(MW_LANGS[$param])) {
        $is_secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
        setcookie('mw_lang', $param, time() + 86400 * 365, '/', '', $is_secure, false);
        return $param;
    }

    // 2. Cookie 作为 fallback（之前选过的语言）
    $cookie = $_COOKIE['mw_lang'] ?? null;
    if ($cookie && isset(MW_LANGS[$cookie])) return $cookie;

    // 3. 浏览器 Accept-Language 头（取前两位）
    $browser = substr($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '', 0, 2);
    if ($browser && isset(MW_LANGS[$browser])) return $browser;

    // 4. 默认法语
    return MW_DEFAULT_LANG;
}

/**
 * 翻译字符串
 *
 * 使用 static 缓存避免同一请求中重复加载翻译数组。
 * 如果翻译 key 不存在，返回 key 本身（作为 fallback）。
 *
 * @param  string $key 翻译键名（英文）
 * @return string      翻译后的文本
 */
function mw_t($key) {
    static $t = null;
    if ($t === null) {
        $lang = mw_lang();
        // 如果当前语言没有翻译数组，使用默认法语
        $t = $GLOBALS['MW_TRANSLATIONS'][$lang] ?? $GLOBALS['MW_TRANSLATIONS'][MW_DEFAULT_LANG];
    }
    return $t[$key] ?? $key;
}

/**
 * 日元价格转欧元价格（HTML 格式）
 *
 * @param  int|null $jpy 日元价格（整数）
 * @return string       欧元价格 HTML（如 "€75,00"），输入 null 时返回空字符串
 */
function mw_price_eur($jpy) {
    if (!$jpy) return '';
    $eur = round($jpy * MW_EUR_RATE, 2);
    // number_format 使用 , 作为小数点，空格作为千位分隔
    return '&euro;' . number_format($eur, 2, ',', ' ');
}

/**
 * 生成语言切换按钮 HTML
 *
 * 当前激活的语言按钮会有 .active 类。
 * 每个按钮都是带 hreflang 属性（用于 SEO）的 <a> 标签。
 *
 * @return string HTML 代码
 */
function mw_lang_switcher() {
    $current = mw_lang();
    $html = '<div class="mw-lang-switcher">';
    foreach (MW_LANGS as $code => $label) {
        $active = $code === $current ? ' active' : '';
        $url = add_query_arg('lang', $code);
        $html .= '<a href="' . esc_url($url) . '" class="mw-lang-btn' . $active . '" hreflang="' . $code . '" title="' . esc_attr(MW_LANG_NAMES[$code]) . '">' . $label . '</a>';
    }
    $html .= '</div>';
    return $html;
}

// ============================================================================
// 翻译数据
// ============================================================================

/**
 * 全局翻译数组
 *
 * 结构: $MW_TRANSLATIONS[语言代码][翻译键] = 翻译值
 *
 * 命名约定：
 *   - 翻译键使用英文原文作为 key
 *   - sprintf 占位符使用 %s (字符串), %d (整数)
 *   - 每种语言必须包含所有 key
 */
$MW_TRANSLATIONS = [
    'fr' => [
        // 导航
        'Home' => 'Accueil',
        'Browse' => 'Explorer',
        'Figurines' => 'Figurines',
        'Personnages' => 'Personnages',
        'Series' => 'Séries',
        'Manufacturers' => 'Fabricants',
        'Sculptors' => 'Sculpteurs',
        'Search' => 'Rechercher',
        'Search figures...' => 'Rechercher des figurines...',
        // 首页
        'The Refined Figure Encyclopedia' => 'L\'Encyclopédie Raffinée des Figurines',
        // 元描述（用于 SEO）
        'The Refined Figure Encyclopedia. A comprehensive database of anime figures, scale models, and collectibles with European minimalist design.' => 'L\'Encyclopédie Raffinée des Figurines. Une base de données complète de figurines d\'anime, modèles réduits et objets de collection au design minimaliste européen.',
        'Latest Releases' => 'Nouveautés',
        'View all' => 'Voir tout',
        'Popular Series' => 'Séries Populaires',
        'figures' => 'figurines',
        // 卡片状态
        'No image' => 'Pas d\'image',
        'New' => 'Nouveau',
        'Pre-order' => 'Précommande',
        // 列表页
        'No figures found.' => 'Aucune figurine trouvée.',
        'All Figures' => 'Toutes les Figurines',
        'Categories' => 'Catégories',
        // 页脚
        'Legal' => 'Mentions Légales',
        'Privacy Policy' => 'Politique de Confidentialité',
        'Terms of Use' => 'Conditions d\'Utilisation',
        'Cookie Policy' => 'Politique de Cookies',
        'All rights reserved.' => 'Tous droits réservés.',
        'Data sources: MyFigureCollection, Manufacturer official sites.' => 'Sources de données : MyFigureCollection, sites officiels des fabricants.',
        'About' => 'À propos',
        // Cookie 横幅
        'We use cookies to improve your experience and analyze site traffic.' => 'Nous utilisons des cookies pour améliorer votre expérience et analyser le trafic.',
        'Accept' => 'Accepter',
        'Decline' => 'Refuser',
        // 可访问性
        'Skip to content' => 'Aller au contenu',
        'ModelWiki Home' => 'Accueil ModelWiki',
        'Primary Navigation' => 'Navigation Principale',
        'Site Search' => 'Recherche sur le site',
        'Toggle theme' => 'Changer le thème',
        'Open menu' => 'Ouvrir le menu',
        'Mobile Navigation' => 'Navigation Mobile',
        // 分类名称
        'Scale Figures' => 'Figurines à l\'Échelle',
        'Nendoroid' => 'Nendoroid',
        'Figma' => 'Figma',
        'Prize Figures' => 'Figurines à Gagner',
        'Resin Kits' => 'Kits Résine',
        'Action Figures' => 'Figurines d\'Action',
        // 筛选器
        'Category' => 'Catégorie',
        'Scale' => 'Échelle',
        'Manufacturer' => 'Fabricant',
        'Release Year' => 'Année de Sortie',
        'Latest' => 'Récents',
        'Price ↑' => 'Prix ↑',
        'Price ↓' => 'Prix ↓',
        'A-Z' => 'A-Z',
        'Filters' => 'Filtres',
        'Open filters' => 'Ouvrir les filtres',
        'Clear filters' => 'Effacer les filtres',
        'No figures found matching your filters.' => 'Aucune figurine ne correspond à vos filtres.',
        'figures found' => 'figurines trouvées',
        'Pagination' => 'Pagination',
        'Previous' => 'Précédent',
        'Next' => 'Suivant',
        '%s figures' => '%s figurines',
        // 详情页
        'Breadcrumb' => 'Fil d\'Ariane',
        'Maker' => 'Fabricant',
        'Sculptor' => 'Sculpteur',
        'Character' => 'Personnage',
        'Specifications' => 'Spécifications',
        'Price' => 'Prix',
        'Height' => 'Hauteur',
        'Weight' => 'Poids',
        'Material' => 'Matériau',
        'JAN' => 'JAN',
        'mm' => 'mm',
        'g' => 'g',
        'About This Figure' => 'À Propos de cette Figurine',
        'Version Lineage' => 'Historique des Versions',
        'Related Figures' => 'Figurines Associées',
        // 搜索页
        'Search: %s' => 'Recherche : %s',
        'Search figures, series, manufacturers...' => 'Rechercher figurines, séries, fabricants...',
        'All (%d)' => 'Tout (%d)',
        'Figures (%d)' => 'Figurines (%d)',
        'Series (%d)' => 'Séries (%d)',
        'Manufacturers (%d)' => 'Fabricants (%d)',
        'Characters (%d)' => 'Personnages (%d)',
        'No results found for your search.' => 'Aucun résultat pour votre recherche.',
        'Try different keywords or browse by category.' => 'Essayez d\'autres mots-clés ou parcourez par catégorie.',
        'Enter a search term to find figures, series, and manufacturers.' => 'Saisissez un terme pour trouver des figurines, séries et fabricants.',
        // 实体详情页
        'No image available' => 'Aucune image disponible',
        'Figures in this series' => 'Figurines dans cette série',
        'Figures by this manufacturer' => 'Figurines de ce fabricant',
        'Works by this sculptor' => 'Œuvres de ce sculpteur',
        'No figures found for this series yet.' => 'Aucune figurine trouvée pour cette série.',
        'No figures found for this manufacturer yet.' => 'Aucune figurine trouvée pour ce fabricant.',
        'No figures found for this sculptor yet.' => 'Aucune figurine trouvée pour ce sculpteur.',
        'Figures for this character' => 'Figurines pour ce personnage',
        'No figures found for this character yet.' => 'Aucune figurine trouvée pour ce personnage pour le moment.',
        'View image %d' => 'Voir l\'image %d',
        // 列表页统计
        '%s series total' => '%s séries au total',
        '%s manufacturers total' => '%s fabricants au total',
        '%s sculptors total' => '%s sculpteurs au total',
        'No series found.' => 'Aucune série trouvée.',
        'No manufacturers found.' => 'Aucun fabricant trouvé.',
        'No sculptors found.' => 'Aucun sculpteur trouvé.',
        'No characters found.' => 'Aucun personnage trouvé.',
        // 404 页面
        'The page you are looking for does not exist.' => 'La page que vous recherchez n\'existe pas.',
        'Try searching instead...' => 'Essayez de rechercher...',
        'Back to Home' => 'Retour à l\'accueil',
        // 详情页补充
        'Figures' => 'Figurines',
        'Origin' => 'Origine',
        'Release Date' => 'Date de sortie',
        'Painter' => 'Peintre',
        'Age Rating' => 'Classification',
        'Re-release' => 'Réédition',
        'Yes' => 'Oui',
        'No' => 'Non',
        'Close image preview' => 'Fermer l\'aperçu de l\'image',
        'Post comment' => 'Publier le commentaire',
        'Share your thoughts about this figure...' => 'Partagez vos impressions sur cette figurine...',
        // 账户页
        'ModelWiki Account' => 'Compte ModelWiki',
        'Your personal figure shelf' => 'Votre étagère personnelle de figurines',
        'Save figures, collect favorites, and keep your comments in one clean space.' => 'Enregistrez des figurines, collectionnez vos favoris et gardez vos commentaires au même endroit.',
        'Favorites library' => 'Bibliothèque de favoris',
        'Likes and comments' => 'J\'aime et commentaires',
        'Fast return from the header' => 'Accès rapide depuis l\'en-tête',
        'Account actions' => 'Actions du compte',
        'Log in' => 'Se connecter',
        'Create account' => 'Créer un compte',
        'Welcome back' => 'Bon retour',
        'Log in and we will take you back to the homepage.' => 'Connectez-vous et nous vous ramènerons à la page d\'accueil.',
        'Email or display name' => 'E-mail ou nom d\'affichage',
        'Create your account' => 'Créez votre compte',
        'After registration, open the activation email before logging in.' => 'Après l\'inscription, ouvrez l\'e-mail d\'activation avant de vous connecter.',
        'Display name' => 'Nom d\'affichage',
        'Email' => 'E-mail',
        'Password' => 'Mot de passe',
        'Enter a valid password' => 'Saisissez un mot de passe valide',
        'At least 8 characters' => 'Au moins 8 caractères',
        'One uppercase letter' => 'Une lettre majuscule',
        'One lowercase letter' => 'Une lettre minuscule',
        'One special character' => 'Un caractère spécial',
        'Confirm password' => 'Confirmer le mot de passe',
        'Website' => 'Site web',
        'Personal Space' => 'Espace personnel',
        'Log out' => 'Se déconnecter',
        'Favorites' => 'Favoris',
        'Likes' => 'J\'aime',
        'Comments' => 'Commentaires',
        // JS i18n
        'Nothing here yet.' => 'Rien ici pour l\'instant.',
        'No comments yet.' => 'Aucun commentaire pour l\'instant.',
        'Signing in...' => 'Connexion...',
        'Login failed' => 'Échec de la connexion',
        'Please meet all password rules and confirm the password.' => 'Veuillez respecter toutes les règles de mot de passe et confirmer le mot de passe.',
        'Creating account...' => 'Création du compte...',
        'Registration received. Please check your email and activate the account before logging in.' => 'Inscription reçue. Veuillez vérifier votre e-mail et activer le compte avant de vous connecter.',
        'Registration failed' => 'Échec de l\'inscription',
        'Password meets the rules' => 'Le mot de passe respecte les règles',
        'Almost there' => 'Presque là',
        'Password needs work' => 'Le mot de passe doit être amélioré',
        'Please write a comment first.' => 'Veuillez d\'abord écrire un commentaire.',
        'Posting...' => 'Publication...',
        'Could not post comment' => 'Impossible de publier le commentaire',
    ],
    'en' => [
        'Home' => 'Home',
        'Browse' => 'Browse',
        'Figurines' => 'Figurines',
        'Personnages' => 'Characters',
        'Series' => 'Series',
        'Manufacturers' => 'Manufacturers',
        'Sculptors' => 'Sculptors',
        'Search' => 'Search',
        'Search figures...' => 'Search figures...',
        'The Refined Figure Encyclopedia' => 'The Refined Figure Encyclopedia',
        'The Refined Figure Encyclopedia. A comprehensive database of anime figures, scale models, and collectibles with European minimalist design.' => 'The Refined Figure Encyclopedia. A comprehensive database of anime figures, scale models, and collectibles with European minimalist design.',
        'Latest Releases' => 'Latest Releases',
        'View all' => 'View all',
        'Popular Series' => 'Popular Series',
        'figures' => 'figures',
        'No image' => 'No image',
        'New' => 'New',
        'Pre-order' => 'Pre-order',
        'No figures found.' => 'No figures found.',
        'All Figures' => 'All Figures',
        'Categories' => 'Categories',
        'Legal' => 'Legal',
        'Privacy Policy' => 'Privacy Policy',
        'Terms of Use' => 'Terms of Use',
        'Cookie Policy' => 'Cookie Policy',
        'All rights reserved.' => 'All rights reserved.',
        'Data sources: MyFigureCollection, Manufacturer official sites.' => 'Data sources: MyFigureCollection, Manufacturer official sites.',
        'About' => 'About',
        'We use cookies to improve your experience and analyze site traffic.' => 'We use cookies to improve your experience and analyze site traffic.',
        'Accept' => 'Accept',
        'Decline' => 'Decline',
        'Skip to content' => 'Skip to content',
        'ModelWiki Home' => 'ModelWiki Home',
        'Primary Navigation' => 'Primary Navigation',
        'Site Search' => 'Site Search',
        'Toggle theme' => 'Toggle theme',
        'Open menu' => 'Open menu',
        'Mobile Navigation' => 'Mobile Navigation',
        'Scale Figures' => 'Scale Figures',
        'Nendoroid' => 'Nendoroid',
        'Figma' => 'Figma',
        'Prize Figures' => 'Prize Figures',
        'Resin Kits' => 'Resin Kits',
        'Action Figures' => 'Action Figures',
        'Category' => 'Category',
        'Scale' => 'Scale',
        'Manufacturer' => 'Manufacturer',
        'Release Year' => 'Release Year',
        'Latest' => 'Latest',
        'Price ↑' => 'Price ↑',
        'Price ↓' => 'Price ↓',
        'A-Z' => 'A-Z',
        'Filters' => 'Filters',
        'Open filters' => 'Open filters',
        'Clear filters' => 'Clear filters',
        'No figures found matching your filters.' => 'No figures found matching your filters.',
        'figures found' => 'figures found',
        'Pagination' => 'Pagination',
        'Previous' => 'Previous',
        'Next' => 'Next',
        '%s figures' => '%s figures',
        'Breadcrumb' => 'Breadcrumb',
        'Maker' => 'Maker',
        'Sculptor' => 'Sculptor',
        'Character' => 'Character',
        'Specifications' => 'Specifications',
        'Price' => 'Price',
        'Height' => 'Height',
        'Weight' => 'Weight',
        'Material' => 'Material',
        'JAN' => 'JAN',
        'mm' => 'mm',
        'g' => 'g',
        'About This Figure' => 'About This Figure',
        'Version Lineage' => 'Version Lineage',
        'Related Figures' => 'Related Figures',
        'Search: %s' => 'Search: %s',
        'Search figures, series, manufacturers...' => 'Search figures, series, manufacturers...',
        'All (%d)' => 'All (%d)',
        'Figures (%d)' => 'Figures (%d)',
        'Series (%d)' => 'Series (%d)',
        'Manufacturers (%d)' => 'Manufacturers (%d)',
        'Characters (%d)' => 'Characters (%d)',
        'No results found for your search.' => 'No results found for your search.',
        'Try different keywords or browse by category.' => 'Try different keywords or browse by category.',
        'Enter a search term to find figures, series, and manufacturers.' => 'Enter a search term to find figures, series, and manufacturers.',
        'No image available' => 'No image available',
        'Figures in this series' => 'Figures in this series',
        'Figures by this manufacturer' => 'Figures by this manufacturer',
        'Works by this sculptor' => 'Works by this sculptor',
        'No figures found for this series yet.' => 'No figures found for this series yet.',
        'No figures found for this manufacturer yet.' => 'No figures found for this manufacturer yet.',
        'No figures found for this sculptor yet.' => 'No figures found for this sculptor yet.',
        'Figures for this character' => 'Figures for this character',
        'No figures found for this character yet.' => 'No figures found for this character yet.',
        'View image %d' => 'View image %d',
        '%s series total' => '%s series total',
        '%s manufacturers total' => '%s manufacturers total',
        '%s sculptors total' => '%s sculptors total',
        'No series found.' => 'No series found.',
        'No manufacturers found.' => 'No manufacturers found.',
        'No sculptors found.' => 'No sculptors found.',
        'No characters found.' => 'No characters found.',
        'The page you are looking for does not exist.' => 'The page you are looking for does not exist.',
        'Try searching instead...' => 'Try searching instead...',
        'Back to Home' => 'Back to Home',
        // 详情页补充
        'Figures' => 'Figures',
        'Origin' => 'Origin',
        'Release Date' => 'Release Date',
        'Painter' => 'Painter',
        'Age Rating' => 'Age Rating',
        'Re-release' => 'Re-release',
        'Yes' => 'Yes',
        'No' => 'No',
        'Close image preview' => 'Close image preview',
        'Post comment' => 'Post comment',
        'Share your thoughts about this figure...' => 'Share your thoughts about this figure...',
        // 账户页
        'ModelWiki Account' => 'ModelWiki Account',
        'Your personal figure shelf' => 'Your personal figure shelf',
        'Save figures, collect favorites, and keep your comments in one clean space.' => 'Save figures, collect favorites, and keep your comments in one clean space.',
        'Favorites library' => 'Favorites library',
        'Likes and comments' => 'Likes and comments',
        'Fast return from the header' => 'Fast return from the header',
        'Account actions' => 'Account actions',
        'Log in' => 'Log in',
        'Create account' => 'Create account',
        'Welcome back' => 'Welcome back',
        'Log in and we will take you back to the homepage.' => 'Log in and we will take you back to the homepage.',
        'Email or display name' => 'Email or display name',
        'Create your account' => 'Create your account',
        'After registration, open the activation email before logging in.' => 'After registration, open the activation email before logging in.',
        'Display name' => 'Display name',
        'Email' => 'Email',
        'Password' => 'Password',
        'Enter a valid password' => 'Enter a valid password',
        'At least 8 characters' => 'At least 8 characters',
        'One uppercase letter' => 'One uppercase letter',
        'One lowercase letter' => 'One lowercase letter',
        'One special character' => 'One special character',
        'Confirm password' => 'Confirm password',
        'Website' => 'Website',
        'Personal Space' => 'Personal Space',
        'Log out' => 'Log out',
        'Favorites' => 'Favorites',
        'Likes' => 'Likes',
        'Comments' => 'Comments',
        // JS i18n
        'Nothing here yet.' => 'Nothing here yet.',
        'No comments yet.' => 'No comments yet.',
        'Signing in...' => 'Signing in...',
        'Login failed' => 'Login failed',
        'Please meet all password rules and confirm the password.' => 'Please meet all password rules and confirm the password.',
        'Creating account...' => 'Creating account...',
        'Registration received. Please check your email and activate the account before logging in.' => 'Registration received. Please check your email and activate the account before logging in.',
        'Registration failed' => 'Registration failed',
        'Password meets the rules' => 'Password meets the rules',
        'Almost there' => 'Almost there',
        'Password needs work' => 'Password needs work',
        'Please write a comment first.' => 'Please write a comment first.',
        'Posting...' => 'Posting...',
        'Could not post comment' => 'Could not post comment',
    ],
    'de' => [
        'Home' => 'Startseite',
        'Browse' => 'Durchsuchen',
        'Figurines' => 'Figuren',
        'Personnages' => 'Charaktere',
        'Series' => 'Serien',
        'Manufacturers' => 'Hersteller',
        'Sculptors' => 'Bildhauer',
        'Search' => 'Suche',
        'Search figures...' => 'Figuren suchen...',
        'The Refined Figure Encyclopedia' => 'Die Verfeinerte Figuren-Enzyklopädie',
        'The Refined Figure Encyclopedia. A comprehensive database of anime figures, scale models, and collectibles with European minimalist design.' => 'Die verfeinerte Figuren-Enzyklopädie. Eine umfassende Datenbank für Anime-Figuren, Maßstabmodelle und Sammlerstücke mit europäischem, minimalistischen Design.',
        'Latest Releases' => 'Neueste Veröffentlichungen',
        'View all' => 'Alle anzeigen',
        'Popular Series' => 'Beliebte Serien',
        'figures' => 'Figuren',
        'No image' => 'Kein Bild',
        'New' => 'Neu',
        'Pre-order' => 'Vorbestellung',
        'No figures found.' => 'Keine Figuren gefunden.',
        'All Figures' => 'Alle Figuren',
        'Categories' => 'Kategorien',
        'Legal' => 'Rechtliches',
        'Privacy Policy' => 'Datenschutzerklärung',
        'Terms of Use' => 'Nutzungsbedingungen',
        'Cookie Policy' => 'Cookie-Richtlinie',
        'All rights reserved.' => 'Alle Rechte vorbehalten.',
        'Data sources: MyFigureCollection, Manufacturer official sites.' => 'Datenquellen: MyFigureCollection, offizielle Herstellerseiten.',
        'About' => 'Über',
        'We use cookies to improve your experience and analyze site traffic.' => 'Wir verwenden Cookies, um Ihre Erfahrung zu verbessern und den Datenverkehr zu analysieren.',
        'Accept' => 'Akzeptieren',
        'Decline' => 'Ablehnen',
        'Skip to content' => 'Zum Inhalt springen',
        'ModelWiki Home' => 'ModelWiki Startseite',
        'Primary Navigation' => 'Hauptnavigation',
        'Site Search' => 'Seitensuche',
        'Toggle theme' => 'Design wechseln',
        'Open menu' => 'Menü öffnen',
        'Mobile Navigation' => 'Mobile Navigation',
        'Scale Figures' => 'Maßstabsfiguren',
        'Nendoroid' => 'Nendoroid',
        'Figma' => 'Figma',
        'Prize Figures' => 'Preisfiguren',
        'Resin Kits' => 'Harz-Kits',
        'Action Figures' => 'Action-Figuren',
        'Category' => 'Kategorie',
        'Scale' => 'Maßstab',
        'Manufacturer' => 'Hersteller',
        'Release Year' => 'Erscheinungsjahr',
        'Latest' => 'Neueste',
        'Price ↑' => 'Preis ↑',
        'Price ↓' => 'Preis ↓',
        'A-Z' => 'A-Z',
        'Filters' => 'Filter',
        'Open filters' => 'Filter öffnen',
        'Clear filters' => 'Filter löschen',
        'No figures found matching your filters.' => 'Keine Figuren entsprechen Ihren Filtern.',
        'figures found' => 'Figuren gefunden',
        'Pagination' => 'Seitennummerierung',
        'Previous' => 'Zurück',
        'Next' => 'Weiter',
        '%s figures' => '%s Figuren',
        'Breadcrumb' => 'Brotkrumen',
        'Maker' => 'Hersteller',
        'Sculptor' => 'Bildhauer',
        'Character' => 'Charakter',
        'Specifications' => 'Spezifikationen',
        'Price' => 'Preis',
        'Height' => 'Höhe',
        'Weight' => 'Gewicht',
        'Material' => 'Material',
        'JAN' => 'JAN',
        'mm' => 'mm',
        'g' => 'g',
        'About This Figure' => 'Über diese Figur',
        'Version Lineage' => 'Versionsgeschichte',
        'Related Figures' => 'Ähnliche Figuren',
        'Search: %s' => 'Suche: %s',
        'Search figures, series, manufacturers...' => 'Figuren, Serien, Hersteller suchen...',
        'All (%d)' => 'Alle (%d)',
        'Figures (%d)' => 'Figuren (%d)',
        'Series (%d)' => 'Serien (%d)',
        'Manufacturers (%d)' => 'Hersteller (%d)',
        'Characters (%d)' => 'Charaktere (%d)',
        'No results found for your search.' => 'Keine Ergebnisse für Ihre Suche gefunden.',
        'Try different keywords or browse by category.' => 'Versuchen Sie andere Stichwörter oder durchsuchen Sie nach Kategorie.',
        'Enter a search term to find figures, series, and manufacturers.' => 'Geben Sie einen Suchbegriff ein, um Figuren, Serien und Hersteller zu finden.',
        'No image available' => 'Kein Bild verfügbar',
        'Figures in this series' => 'Figuren in dieser Serie',
        'Figures by this manufacturer' => 'Figuren dieses Herstellers',
        'Works by this sculptor' => 'Werke dieses Bildhauers',
        'No figures found for this series yet.' => 'Keine Figuren in dieser Serie gefunden.',
        'No figures found for this manufacturer yet.' => 'Keine Figuren dieses Herstellers gefunden.',
        'No figures found for this sculptor yet.' => 'Keine Werke dieses Bildhauers gefunden.',
        'Figures for this character' => 'Figuren für diesen Charakter',
        'No figures found for this character yet.' => 'Noch keine Figuren für diesen Charakter gefunden.',
        'View image %d' => 'Bild %d ansehen',
        '%s series total' => '%s Serien insgesamt',
        '%s manufacturers total' => '%s Hersteller insgesamt',
        '%s sculptors total' => '%s Bildhauer insgesamt',
        'No series found.' => 'Keine Serien gefunden.',
        'No manufacturers found.' => 'Keine Hersteller gefunden.',
        'No sculptors found.' => 'Keine Bildhauer gefunden.',
        'No characters found.' => 'Keine Charaktere gefunden.',
        'The page you are looking for does not exist.' => 'Die gesuchte Seite existiert nicht.',
        'Try searching instead...' => 'Versuchen Sie stattdessen zu suchen...',
        'Back to Home' => 'Zurück zur Startseite',
        // 详情页补充
        'Figures' => 'Figuren',
        'Origin' => 'Herkunft',
        'Release Date' => 'Veröffentlichungsdatum',
        'Painter' => 'Maler',
        'Age Rating' => 'Altersfreigabe',
        'Re-release' => 'Wiederveröffentlichung',
        'Yes' => 'Ja',
        'No' => 'Nein',
        'Close image preview' => 'Bildvorschau schließen',
        'Post comment' => 'Kommentar veröffentlichen',
        'Share your thoughts about this figure...' => 'Teilen Sie Ihre Gedanken zu dieser Figur...',
        // 账户页
        'ModelWiki Account' => 'ModelWiki Konto',
        'Your personal figure shelf' => 'Ihre persönliche Figuren-Sammlung',
        'Save figures, collect favorites, and keep your comments in one clean space.' => 'Speichern Sie Figuren, sammeln Sie Favoriten und bewahren Sie Ihre Kommentare an einem Ort auf.',
        'Favorites library' => 'Favoriten-Bibliothek',
        'Likes and comments' => 'Likes und Kommentare',
        'Fast return from the header' => 'Schneller Zugriff über den Header',
        'Account actions' => 'Kontoaktionen',
        'Log in' => 'Anmelden',
        'Create account' => 'Konto erstellen',
        'Welcome back' => 'Willkommen zurück',
        'Log in and we will take you back to the homepage.' => 'Melden Sie sich an und wir bringen Sie zurück zur Startseite.',
        'Email or display name' => 'E-Mail oder Anzeigename',
        'Create your account' => 'Erstellen Sie Ihr Konto',
        'After registration, open the activation email before logging in.' => 'Öffnen Sie nach der Registrierung die Aktivierungs-E-Mail, bevor Sie sich anmelden.',
        'Display name' => 'Anzeigename',
        'Email' => 'E-Mail',
        'Password' => 'Passwort',
        'Enter a valid password' => 'Geben Sie ein gültiges Passwort ein',
        'At least 8 characters' => 'Mindestens 8 Zeichen',
        'One uppercase letter' => 'Ein Großbuchstabe',
        'One lowercase letter' => 'Ein Kleinbuchstabe',
        'One special character' => 'Ein Sonderzeichen',
        'Confirm password' => 'Passwort bestätigen',
        'Website' => 'Website',
        'Personal Space' => 'Persönlicher Bereich',
        'Log out' => 'Abmelden',
        'Favorites' => 'Favoriten',
        'Likes' => 'Likes',
        'Comments' => 'Kommentare',
        // JS i18n
        'Nothing here yet.' => 'Noch nichts hier.',
        'No comments yet.' => 'Noch keine Kommentare.',
        'Signing in...' => 'Anmeldung...',
        'Login failed' => 'Anmeldung fehlgeschlagen',
        'Please meet all password rules and confirm the password.' => 'Bitte erfüllen Sie alle Passwortregeln und bestätigen Sie das Passwort.',
        'Creating account...' => 'Konto wird erstellt...',
        'Registration received. Please check your email and activate the account before logging in.' => 'Registrierung erhalten. Bitte prüfen Sie Ihre E-Mail und aktivieren Sie das Konto, bevor Sie sich anmelden.',
        'Registration failed' => 'Registrierung fehlgeschlagen',
        'Password meets the rules' => 'Passwort erfüllt die Regeln',
        'Almost there' => 'Fast geschafft',
        'Password needs work' => 'Passwort muss verbessert werden',
        'Please write a comment first.' => 'Bitte schreiben Sie zuerst einen Kommentar.',
        'Posting...' => 'Wird veröffentlicht...',
        'Could not post comment' => 'Kommentar konnte nicht veröffentlicht werden',
    ],
    'it' => [
        'Home' => 'Home',
        'Browse' => 'Sfoglia',
        'Figurines' => 'Figurine',
        'Personnages' => 'Personaggi',
        'Series' => 'Serie',
        'Manufacturers' => 'Produttori',
        'Sculptors' => 'Scultori',
        'Search' => 'Cerca',
        'Search figures...' => 'Cerca figurine...',
        'The Refined Figure Encyclopedia' => 'L\'Enciclopedia Raffinata delle Figurine',
        'The Refined Figure Encyclopedia. A comprehensive database of anime figures, scale models, and collectibles with European minimalist design.' => 'L\'Enciclopedia Raffinata delle Figurine. Un database completo di figure anime, modelli in scala e oggetti da collezione con design minimalista europeo.',
        'Latest Releases' => 'Ultime Uscite',
        'View all' => 'Vedi tutto',
        'Popular Series' => 'Serie Popolari',
        'figures' => 'figurine',
        'No image' => 'Nessuna immagine',
        'New' => 'Nuovo',
        'Pre-order' => 'Preordine',
        'No figures found.' => 'Nessuna figurina trovata.',
        'All Figures' => 'Tutte le Figurine',
        'Categories' => 'Categorie',
        'Legal' => 'Note Legali',
        'Privacy Policy' => 'Informativa sulla Privacy',
        'Terms of Use' => 'Termini di Utilizzo',
        'Cookie Policy' => 'Politica sui Cookie',
        'All rights reserved.' => 'Tutti i diritti riservati.',
        'Data sources: MyFigureCollection, Manufacturer official sites.' => 'Fonti dati: MyFigureCollection, siti ufficiali dei produttori.',
        'About' => 'Informazioni',
        'We use cookies to improve your experience and analyze site traffic.' => 'Utilizziamo i cookie per migliorare la tua esperienza e analizzare il traffico.',
        'Accept' => 'Accetta',
        'Decline' => 'Rifiuta',
        'Skip to content' => 'Vai al contenuto',
        'ModelWiki Home' => 'Home ModelWiki',
        'Primary Navigation' => 'Navigazione Principale',
        'Site Search' => 'Ricerca nel sito',
        'Toggle theme' => 'Cambia tema',
        'Open menu' => 'Apri menu',
        'Mobile Navigation' => 'Navigazione Mobile',
        'Scale Figures' => 'Figure in Scala',
        'Nendoroid' => 'Nendoroid',
        'Figma' => 'Figma',
        'Prize Figures' => 'Figure Premio',
        'Resin Kits' => 'Kit in Resina',
        'Action Figures' => 'Action Figure',
        'Category' => 'Categoria',
        'Scale' => 'Scala',
        'Manufacturer' => 'Produttore',
        'Release Year' => 'Anno di Uscita',
        'Latest' => 'Recenti',
        'Price ↑' => 'Prezzo ↑',
        'Price ↓' => 'Prezzo ↓',
        'A-Z' => 'A-Z',
        'Filters' => 'Filtri',
        'Open filters' => 'Apri filtri',
        'Clear filters' => 'Cancella filtri',
        'No figures found matching your filters.' => 'Nessuna figurina corrisponde ai filtri.',
        'figures found' => 'figurine trovate',
        'Pagination' => 'Paginazione',
        'Previous' => 'Precedente',
        'Next' => 'Successivo',
        '%s figures' => '%s figurine',
        'Breadcrumb' => 'Navigazione',
        'Maker' => 'Produttore',
        'Sculptor' => 'Scultore',
        'Character' => 'Personaggio',
        'Specifications' => 'Specifiche',
        'Price' => 'Prezzo',
        'Height' => 'Altezza',
        'Weight' => 'Peso',
        'Material' => 'Materiale',
        'JAN' => 'JAN',
        'mm' => 'mm',
        'g' => 'g',
        'About This Figure' => 'Informazioni su questa Figura',
        'Version Lineage' => 'Cronologia Versioni',
        'Related Figures' => 'Figure Correlate',
        'Search: %s' => 'Cerca: %s',
        'Search figures, series, manufacturers...' => 'Cerca figurine, serie, produttori...',
        'All (%d)' => 'Tutti (%d)',
        'Figures (%d)' => 'Figure (%d)',
        'Series (%d)' => 'Serie (%d)',
        'Manufacturers (%d)' => 'Produttori (%d)',
        'Characters (%d)' => 'Personaggi (%d)',
        'No results found for your search.' => 'Nessun risultato per la tua ricerca.',
        'Try different keywords or browse by category.' => 'Prova altre parole chiave o sfoglia per categoria.',
        'Enter a search term to find figures, series, and manufacturers.' => 'Inserisci un termine per trovare figurine, serie e produttori.',
        'No image available' => 'Nessuna immagine disponibile',
        'Figures in this series' => 'Figure in questa serie',
        'Figures by this manufacturer' => 'Figure di questo produttore',
        'Works by this sculptor' => 'Opere di questo scultore',
        'No figures found for this series yet.' => 'Nessuna figura trovata per questa serie.',
        'No figures found for this manufacturer yet.' => 'Nessuna figura trovata per questo produttore.',
        'No figures found for this sculptor yet.' => 'Nessuna figura trovata per questo scultore.',
        'Figures for this character' => 'Figure per questo personaggio',
        'No figures found for this character yet.' => 'Nessuna figura trovata per questo personaggio.',
        'View image %d' => 'Vedi immagine %d',
        '%s series total' => '%s serie in totale',
        '%s manufacturers total' => '%s produttori in totale',
        '%s sculptors total' => '%s scultori in totale',
        'No series found.' => 'Nessuna serie trovata.',
        'No manufacturers found.' => 'Nessun produttore trovato.',
        'No sculptors found.' => 'Nessuno scultore trovato.',
        'No characters found.' => 'Nessun personaggio trovato.',
        'The page you are looking for does not exist.' => 'La pagina che stai cercando non esiste.',
        'Try searching instead...' => 'Prova a cercare...',
        'Back to Home' => 'Torna alla Home',
        // 详情页补充
        'Figures' => 'Figurine',
        'Origin' => 'Origine',
        'Release Date' => 'Data di uscita',
        'Painter' => 'Pittore',
        'Age Rating' => 'Classificazione',
        'Re-release' => 'Riedizione',
        'Yes' => 'Sì',
        'No' => 'No',
        'Close image preview' => 'Chiudi anteprima immagine',
        'Post comment' => 'Pubblica commento',
        'Share your thoughts about this figure...' => 'Condividi le tue impressioni su questa figurina...',
        // 账户页
        'ModelWiki Account' => 'Account ModelWiki',
        'Your personal figure shelf' => 'La tua raccolta personale di figurine',
        'Save figures, collect favorites, and keep your comments in one clean space.' => 'Salva figurine, raccogli i preferiti e tieni i tuoi commenti in uno spazio unico.',
        'Favorites library' => 'Libreria preferiti',
        'Likes and comments' => 'Mi piace e commenti',
        'Fast return from the header' => 'Accesso rapido dall\'intestazione',
        'Account actions' => 'Azioni account',
        'Log in' => 'Accedi',
        'Create account' => 'Crea account',
        'Welcome back' => 'Bentornato',
        'Log in and we will take you back to the homepage.' => 'Accedi e ti riporteremo alla home page.',
        'Email or display name' => 'Email o nome visualizzato',
        'Create your account' => 'Crea il tuo account',
        'After registration, open the activation email before logging in.' => 'Dopo la registrazione, apri l\'email di attivazione prima di accedere.',
        'Display name' => 'Nome visualizzato',
        'Email' => 'Email',
        'Password' => 'Password',
        'Enter a valid password' => 'Inserisci una password valida',
        'At least 8 characters' => 'Almeno 8 caratteri',
        'One uppercase letter' => 'Una lettera maiuscola',
        'One lowercase letter' => 'Una lettera minuscola',
        'One special character' => 'Un carattere speciale',
        'Confirm password' => 'Conferma password',
        'Website' => 'Sito web',
        'Personal Space' => 'Spazio personale',
        'Log out' => 'Esci',
        'Favorites' => 'Preferiti',
        'Likes' => 'Mi piace',
        'Comments' => 'Commenti',
        // JS i18n
        'Nothing here yet.' => 'Niente qui per ora.',
        'No comments yet.' => 'Nessun commento per ora.',
        'Signing in...' => 'Accesso in corso...',
        'Login failed' => 'Accesso fallito',
        'Please meet all password rules and confirm the password.' => 'Si prega di rispettare tutte le regole della password e confermare la password.',
        'Creating account...' => 'Creazione account...',
        'Registration received. Please check your email and activate the account before logging in.' => 'Registrazione ricevuta. Controlla la tua email e attiva l\'account prima di accedere.',
        'Registration failed' => 'Registrazione fallita',
        'Password meets the rules' => 'La password rispetta le regole',
        'Almost there' => 'Quasi fatto',
        'Password needs work' => 'La password necessita di miglioramenti',
        'Please write a comment first.' => 'Scrivi prima un commento.',
        'Posting...' => 'Pubblicazione...',
        'Could not post comment' => 'Impossibile pubblicare il commento',
    ],
];

// ============================================================================
// WordPress 翻译函数兼容层（可选的 polyfill）
// ============================================================================

/**
 * 如果主题环境没有加载 WordPress 翻译函数，提供 polyfill。
 * 这些函数允许模板使用标准的 _e() / __() 函数，它们会自动委托给 mw_t()。
 */

if (!function_exists('_e')) {
    function _e($key) { echo mw_t($key); }
}
if (!function_exists('__')) {
    function __($key, $domain = '') { return mw_t($key); }
}
if (!function_exists('esc_html_e')) {
    function esc_html_e($key, $domain = '') { echo esc_html(mw_t($key)); }
}
if (!function_exists('esc_attr_e')) {
    function esc_attr_e($key, $domain = '') { echo esc_attr(mw_t($key)); }
}

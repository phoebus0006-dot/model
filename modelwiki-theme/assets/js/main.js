(function(){
    'use strict';

    // Cookie banner
    var cookieBanner = document.getElementById('mw-cookie-banner');
    var cookieAccept = document.getElementById('mw-cookie-accept');
    if (cookieBanner && cookieAccept) {
        if (!localStorage.getItem('mw-cookie-accepted')) {
            cookieBanner.style.display = 'flex';
        }
        cookieAccept.addEventListener('click', function() {
            localStorage.setItem('mw-cookie-accepted', '1');
            cookieBanner.style.display = 'none';
        });
    }

    // Mobile menu toggle
    var menuBtn = document.getElementById('mw-mobile-menu-btn');
    var mobileMenu = document.getElementById('mw-mobile-menu');
    if (menuBtn && mobileMenu) {
        menuBtn.addEventListener('click', function() {
            var isOpen = mobileMenu.classList.contains('open');
            if (isOpen) {
                mobileMenu.classList.remove('open');
                menuBtn.textContent = '\u2630';
            } else {
                mobileMenu.classList.add('open');
                menuBtn.textContent = '\u2715';
            }
        });
    }

    // Gallery thumbnail click - swap main image
    var mainImage = document.getElementById('gallery-main-img') || document.getElementById('mw-main-image');
    var thumbs = document.querySelectorAll('[data-gallery-thumb]');
    if (mainImage && thumbs.length > 0) {
        thumbs.forEach(function(thumb) {
            thumb.addEventListener('click', function() {
                var fullSrc = this.getAttribute('data-full') || this.getAttribute('data-src');
                if (fullSrc) {
                    mainImage.src = fullSrc;
                    var altAttr = this.getAttribute('data-alt');
                    if (altAttr) mainImage.alt = altAttr;
                    thumbs.forEach(function(t) { t.classList.remove('active'); });
                    this.classList.add('active');
                }
            });
        });
    }

    // Lightbox
    var lightbox = document.getElementById('mw-lightbox');
    var lightboxImg = document.getElementById('mw-lightbox-img');
    var lightboxClose = document.getElementById('mw-lightbox-close');
    if (lightbox && lightboxImg) {
        if (mainImage) {
            mainImage.style.cursor = 'zoom-in';
            mainImage.addEventListener('click', function() {
                lightboxImg.src = this.src;
                lightboxImg.alt = this.alt;
                lightbox.classList.add('open');
                document.body.style.overflow = 'hidden';
            });
        }
        if (lightboxClose) {
            lightboxClose.addEventListener('click', function() {
                lightbox.classList.remove('open');
                document.body.style.overflow = '';
            });
        }
        lightbox.addEventListener('click', function(e) {
            if (e.target === lightbox) {
                lightbox.classList.remove('open');
                document.body.style.overflow = '';
            }
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && lightbox.classList.contains('open')) {
                lightbox.classList.remove('open');
                document.body.style.overflow = '';
            }
        });
    }
})();

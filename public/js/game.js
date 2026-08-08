'use strict';

/*
 * =========================================================
 * STENQ GAMES — GAME DETAIL PAGE
 * PROFESYONEL / STABİL SÜRÜM
 * =========================================================
 *
 * Bu dosya:
 * - URL'den Steam App ID okur
 * - Backend API'den oyun detayını çeker
 * - Oyun bilgilerini render eder
 * - Steam mağaza bağlantısı oluşturur
 * - Screenshot galerisi oluşturur
 * - Screenshot modalını yönetir
 * - Klavye kontrollerini destekler
 * - Fiyat ve indirim bilgilerini gösterir
 * - Metacritic bilgisini gösterir
 * - Sistem gereksinimlerini gösterir
 * - Loading / Error durumlarını yönetir
 * - XSS açısından kullanıcı/API verilerini güvenli işler
 * - Bozuk görseller için fallback kullanır
 * =========================================================
 */

// ==================== DOM ELEMENTS ====================
const DOM = {
    loadingContainer: document.getElementById('loadingContainer'),
    errorContainer: document.getElementById('errorContainer'),
    gameDetail: document.getElementById('gameDetail'),
    screenshotModal: document.getElementById('screenshotModal')
};

// ==================== GLOBAL STATE ====================
let currentScreenshots = [];
let currentScreenshotIndex = 0;
let isLoading = false;

// ==================== CONSTANTS ====================
const API_TIMEOUT = 15000;

const DEFAULT_GAME_IMAGE = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
    '<rect width="1280" height="720" fill="#0B1120"/>' +
    '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="42">STENQ GAMES</text>' +
    '</svg>'
);

// ==================== SECURITY / STRING UTILITIES ====================

/**
 * HTML escape.
 * API'den gelen normal metinlerin HTML içine güvenli şekilde yerleştirilmesini sağlar.
 * @param {*} value
 * @returns {string}
 */
function escapeHTML(value) {
    if (value === null || value === undefined) {
        return '';
    }

    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * HTML attribute escape.
 * @param {*} value
 * @returns {string}
 */
function escapeAttribute(value) {
    return escapeHTML(value);
}

/**
 * Metni normalize eder.
 * @param {*} text
 * @returns {string}
 */
function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

/**
 * Güvenli URL kontrolü.
 * Sadece HTTP / HTTPS / data:image URL'lerine izin verir.
 * @param {*} value
 * @param {string} fallback
 * @returns {string}
 */
function safeImageURL(value, fallback) {
    const fallbackURL = fallback || DEFAULT_GAME_IMAGE;

    if (!value) {
        return fallbackURL;
    }

    const url = String(value).trim();

    if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('data:image/')) {
        return url;
    }

    return fallbackURL;
}

/**
 * Normal HTTP/HTTPS URL oluşturur.
 * @param {*} value
 * @returns {string}
 */
function safeHTTPURL(value) {
    if (!value) {
        return '';
    }

    try {
        const url = new URL(String(value), window.location.origin);

        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return url.href;
        }
    } catch (error) {
        console.warn('Geçersiz URL:', value);
    }

    return '';
}

/**
 * Backend tarafından HTML olarak gönderilen oyun açıklamasını temizler.
 * Tehlikeli script / iframe / object / embed elementlerini kaldırır.
 * @param {*} description
 * @returns {string}
 */
function sanitizeDescription(description) {
    if (!description) {
        return '';
    }

    let html = String(description);

    // Tehlikeli elementleri kaldır
    html = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
        .replace(/<embed\b[^>]*>/gi, '')
        .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
        .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
        .replace(/javascript\s*:/gi, '');

    return html;
}

// ==================== CURRENCY FORMATTING ====================

/**
 * USD formatı.
 * @param {*} value
 * @returns {string}
 */
function formatUSD(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return '$0.00';
    }

    return `$${number.toFixed(2)}`;
}

/**
 * Oyun fiyat HTML'i.
 * @param {object|null} price
 * @returns {string}
 */
function formatPrice(price) {
    if (!price || typeof price !== 'object') {
        return '<span class="price-final">Fiyat bilgisi yok</span>';
    }

    if (Boolean(price.isFree)) {
        return '<span class="price-free">ÜCRETSİZ</span>';
    }

    const finalPrice = Number(price.final);
    const initialPrice = Number(price.initial);
    const discount = Number(price.discount || 0);

    if (!Number.isFinite(finalPrice) || finalPrice < 0) {
        return '<span class="price-final">Fiyat bilgisi yok</span>';
    }

    const finalText = formatUSD(finalPrice);

    const hasOriginalPrice =
        Number.isFinite(initialPrice) &&
        initialPrice > finalPrice &&
        Number.isFinite(discount) &&
        discount > 0;

    if (hasOriginalPrice) {
        return (
            '<div class="price-info">' +
            '<span class="discount-badge">-%' + Math.round(discount) + '</span>' +
            '<span class="price-original">' + formatUSD(initialPrice) + '</span>' +
            '</div>' +
            '<span class="price-final">' + finalText + '</span>'
        );
    }

    return '<span class="price-final">' + finalText + '</span>';
}

// ==================== METACRITIC ====================

/**
 * Metacritic skor rengi.
 * @param {*} score
 * @returns {string}
 */
function getMetacriticColor(score) {
    const value = Number(score);

    if (!Number.isFinite(value) || value <= 0) {
        return '#64748B';
    }

    if (value >= 80) {
        return '#10B981';
    }

    if (value >= 60) {
        return '#F59E0B';
    }

    if (value >= 40) {
        return '#D97706';
    }

    return '#EF4444';
}

/**
 * Metacritic label.
 * @param {*} score
 * @returns {string}
 */
function getMetacriticLabel(score) {
    const value = Number(score);

    if (!Number.isFinite(value) || value <= 0) {
        return '-';
    }

    return String(Math.round(value));
}

// ==================== PLATFORM NAMES ====================

/**
 * Platform adını döndürür.
 * @param {*} platform
 * @returns {string}
 */
function getPlatformName(platform) {
    const names = {
        windows: '🖥️ Windows',
        mac: '🍎 macOS',
        linux: '🐧 Linux'
    };

    const key = String(platform || '').toLowerCase();

    return names[key] || platform;
}

// ==================== RELEASE DATE ====================

/**
 * Steam çıkış tarihini Türkçe formatlar.
 * @param {*} date
 * @returns {string}
 */
function formatReleaseDate(date) {
    if (!date) {
        return 'Belirtilmemiş';
    }

    const raw = String(date).trim();

    // Steam bazen "Coming Soon" benzeri değerler gönderebilir
    if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw)) {
        return escapeHTML(raw);
    }

    const parsed = new Date(raw);

    if (Number.isNaN(parsed.getTime())) {
        return escapeHTML(raw);
    }

    return parsed.toLocaleDateString('tr-TR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// ==================== DEAL LABELS ====================

/**
 * İndirim etiketini oluşturur.
 * @param {object|null} price
 * @returns {string}
 */
function getDealLabel(price) {
    if (!price || typeof price !== 'object') {
        return '';
    }

    if (Boolean(price.isFree)) {
        return '<span class="deal-tag free-tag">🎁 ÜCRETSİZ</span>';
    }

    const discount = Number(price.discount || 0);

    if (!Number.isFinite(discount) || discount <= 0) {
        return '';
    }

    if (discount >= 70) {
        return '<span class="deal-tag hot-deal">🔥 FIRSAT</span>';
    }

    if (discount >= 40) {
        return '<span class="deal-tag warm-deal">⚡ İYİ FIRSAT</span>';
    }

    return '<span class="deal-tag">💸 İNDİRİM</span>';
}

// ==================== URL / GAME ID ====================

/**
 * URL'den Steam App ID'yi alır.
 * Örnek: detail.html?id=1091500
 * @returns {number|null}
 */
function getGameId() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');

    if (!id) {
        return null;
    }

    // Sadece rakamlara izin ver
    if (!/^\d+$/.test(id.trim())) {
        return null;
    }

    const numericId = Number(id);

    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        return null;
    }

    return numericId;
}

// ==================== API COMMUNICATION ====================

/**
 * Timeout destekli fetch.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options) {
    const fetchOptions = options || {};
    const controller = new AbortController();

    const timeout = setTimeout(function () {
        controller.abort();
    }, API_TIMEOUT);

    try {
        return await fetch(url, Object.assign({}, fetchOptions, { signal: controller.signal }));
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Backend'den oyun detayını getirir.
 * Endpoint: GET /api/game/:id
 * @param {number} gameId
 */
async function fetchGameDetail(gameId) {
    if (!gameId) {
        showError();
        return;
    }

    if (isLoading) {
        return;
    }

    isLoading = true;
    showLoading();

    try {
        const response = await fetchWithTimeout(
            '/api/game/' + encodeURIComponent(gameId),
            {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                },
                cache: 'no-store'
            }
        );

        if (!response.ok) {
            throw new Error('HTTP ' + response.status + ': ' + (response.statusText || 'API hatası'));
        }

        const data = await response.json();

        if (!data || data.success === false || !data.game) {
            throw new Error(data && data.error ? data.error : 'Oyun bulunamadı.');
        }

        renderGameDetail(data.game);

    } catch (error) {
        console.error('❌ Oyun detay hatası:', error);
        showError(error);
    } finally {
        isLoading = false;
    }
}

// ==================== GAME DETAIL RENDER ====================

/**
 * Oyun detayını ekrana basar.
 * @param {object} game
 */
function renderGameDetail(game) {
    if (!DOM.gameDetail) {
        console.error('❌ #gameDetail elementi bulunamadı.');
        return;
    }

    if (!game || typeof game !== 'object') {
        showError(new Error('Geçersiz oyun verisi.'));
        return;
    }

    // UI state
    if (DOM.loadingContainer) {
        DOM.loadingContainer.style.display = 'none';
    }

    if (DOM.errorContainer) {
        DOM.errorContainer.style.display = 'none';
    }

    DOM.gameDetail.style.display = 'block';

    // ==================== BASIC DATA ====================
    const gameId = Number(game.id);
    const rawGameName = game.name || 'Bilinmeyen Oyun';
    const gameName = escapeHTML(rawGameName);
    document.title = rawGameName + ' - STENQ GAMES';

    // ==================== METACRITIC ====================
    const metacritic = Number(game.metacritic);
    const hasMetacritic = Number.isFinite(metacritic) && metacritic > 0;
    const mcColor = getMetacriticColor(metacritic);
    const mcLabel = getMetacriticLabel(metacritic);

    // ==================== PLATFORMS ====================
    const platforms = Array.isArray(game.platforms) && game.platforms.length > 0
        ? game.platforms.filter(Boolean).map(getPlatformName).map(escapeHTML).join(', ')
        : 'Belirtilmemiş';

    // ==================== GENRES ====================
    const genres = Array.isArray(game.genres) && game.genres.length > 0
        ? game.genres.filter(Boolean).map(escapeHTML).join(', ')
        : 'Belirtilmemiş';

    // ==================== DEVELOPERS ====================
    const developers = Array.isArray(game.developers) && game.developers.length > 0
        ? game.developers.filter(Boolean).map(escapeHTML).join(', ')
        : 'Belirtilmemiş';

    // ==================== PUBLISHERS ====================
    const publishers = Array.isArray(game.publishers) && game.publishers.length > 0
        ? game.publishers.filter(Boolean).map(escapeHTML).join(', ')
        : 'Belirtilmemiş';

    // ==================== RELEASE DATE ====================
    const releaseDate = formatReleaseDate(game.releaseDate);

    // ==================== IMAGES ====================
    const background = safeImageURL(game.background || game.image, DEFAULT_GAME_IMAGE);
    const headerImage = safeImageURL(game.image || game.background, DEFAULT_GAME_IMAGE);

    // ==================== SCREENSHOTS ====================
    currentScreenshots = Array.isArray(game.screenshots)
        ? game.screenshots
            .filter(Boolean)
            .map(function (item) {
                if (typeof item === 'string') {
                    return item;
                }
                if (item && typeof item === 'object') {
                    return item.path_full || item.path || item.url || item.image || '';
                }
                return '';
            })
            .filter(Boolean)
            .map(function (url) {
                return safeImageURL(url, '');
            })
            .filter(Boolean)
        : [];

    currentScreenshotIndex = 0;

    // ==================== PRICE ====================
    const priceHTML = formatPrice(game.price);
    const dealLabelHTML = getDealLabel(game.price);

    // ==================== DESCRIPTION ====================
    const descriptionHTML = sanitizeDescription(game.description);

    // ==================== STEAM URL ====================
    let steamURL = '';
    if (Number.isSafeInteger(gameId) && gameId > 0) {
        steamURL = 'https://store.steampowered.com/app/' + encodeURIComponent(gameId) + '/';
    }

    // ==================== BUILD HTML ====================
    var html = '';

    // HEADER
    html += '<div class="game-detail-header">';
    html += '<img class="game-detail-background" src="' + escapeAttribute(background) + '" alt="' + gameName + '" loading="eager" decoding="async" onerror="this.onerror=null;this.src=\'' + escapeAttribute(DEFAULT_GAME_IMAGE) + '\';">';
    html += '<div class="game-detail-header-overlay">';
    html += '<div class="game-detail-header-content">';
    html += '<h1 class="game-detail-title">' + gameName + '</h1>';
    html += '<div class="game-detail-meta">';

    if (hasMetacritic) {
        html += '<div class="game-rating" style="color:' + mcColor + ';" title="Metacritic skoru">⭐ Metacritic: <strong>' + mcLabel + '</strong></div>';
    }

    html += '<div class="detail-price-container">';
    html += '<div class="detail-main-price">' + priceHTML + '</div>';

    if (dealLabelHTML) {
        html += '<div class="game-card-deal-info">' + dealLabelHTML + '</div>';
    }

    html += '</div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    // INFO GRID
    html += '<div class="game-detail-info-grid">';

    // Sol kart - Oyun Bilgileri
    html += '<div class="info-card">';
    html += '<h3>📋 Oyun Bilgileri</h3>';

    html += '<div class="info-item"><span class="info-label">Geliştirici</span><span class="info-value">' + developers + '</span></div>';
    html += '<div class="info-item"><span class="info-label">Yayıncı</span><span class="info-value">' + publishers + '</span></div>';
    html += '<div class="info-item"><span class="info-label">Çıkış Tarihi</span><span class="info-value">' + releaseDate + '</span></div>';
    html += '<div class="info-item"><span class="info-label">Platformlar</span><span class="info-value">' + platforms + '</span></div>';
    html += '<div class="info-item"><span class="info-label">Tür</span><span class="info-value">' + genres + '</span></div>';

    html += '</div>';

    // Sağ kart - Değerlendirme & Fiyat
    html += '<div class="info-card">';
    html += '<h3>⭐ Değerlendirme & Fiyat</h3>';

    if (hasMetacritic) {
        html += '<div class="info-item"><span class="info-label">Metacritic</span><span class="info-value" style="color:' + mcColor + ';">' + mcLabel + '/100</span></div>';
    }

    html += '<div class="info-item"><span class="info-label">Güncel Fiyat</span><span class="info-value">' + priceHTML + '</span></div>';
    html += '<div class="info-item"><span class="info-label">Mağaza</span><span class="info-value">Steam</span></div>';
    html += '<div class="info-item"><span class="info-label">Para Birimi</span><span class="info-value">USD ($)</span></div>';

    html += '</div>';
    html += '</div>';

    // SCREENSHOTS
    if (currentScreenshots.length > 0) {
        html += '<div class="screenshots-section">';
        html += '<div class="section-heading">';
        html += '<h3>📸 Ekran Görüntüleri</h3>';
        html += '<span class="section-count">' + currentScreenshots.length + ' görüntü</span>';
        html += '</div>';
        html += '<div class="screenshots-grid">';

        for (var i = 0; i < Math.min(currentScreenshots.length, 12); i++) {
            var safeURL = safeImageURL(currentScreenshots[i], '');

            if (safeURL) {
                html += '<div class="screenshot-item" data-index="' + i + '" role="button" tabindex="0" aria-label="Ekran görüntüsü ' + (i + 1) + '">';
                html += '<img src="' + escapeAttribute(safeURL) + '" alt="' + gameName + ' ekran görüntüsü ' + (i + 1) + '" loading="lazy" decoding="async" onerror="this.parentElement.style.display=\'none\';">';
                html += '</div>';
            }
        }

        html += '</div>';
        html += '</div>';
    }

    // STEAM STORE
    if (steamURL) {
        html += '<div class="stores-section">';
        html += '<div class="section-heading">';
        html += '<h3>💰 Steam Mağazası</h3>';
        html += '<span class="section-count">Güncel fiyat</span>';
        html += '</div>';
        html += '<div class="store-card">';
        html += '<div class="store-info">';
        html += '<span class="store-name">Steam</span>';
        html += '<div class="store-price-info">' + priceHTML + '</div>';
        html += '</div>';
        html += '<a href="' + escapeAttribute(steamURL) + '" target="_blank" rel="noopener noreferrer" class="store-button" aria-label="' + gameName + ' Steam mağaza sayfasını aç">Steam\'e Git →</a>';
        html += '</div>';
        html += '</div>';
    }

    // SYSTEM REQUIREMENTS
    var minimum = game.requirements && typeof game.requirements.minimum === 'string' ? game.requirements.minimum.trim() : '';
    var recommended = game.requirements && typeof game.requirements.recommended === 'string' ? game.requirements.recommended.trim() : '';

    if (minimum || recommended) {
        html += '<div class="requirements-section">';
        html += '<div class="section-heading">';
        html += '<h3>💻 Sistem Gereksinimleri</h3>';
        html += '</div>';
        html += '<div class="requirements-grid">';

        if (minimum) {
            html += '<div class="requirement-card">';
            html += '<h4>⚡ Minimum</h4>';
            html += '<div class="requirement-content">' + sanitizeDescription(minimum) + '</div>';
            html += '</div>';
        }

        if (recommended) {
            html += '<div class="requirement-card">';
            html += '<h4>🚀 Önerilen</h4>';
            html += '<div class="requirement-content">' + sanitizeDescription(recommended) + '</div>';
            html += '</div>';
        }

        html += '</div>';
        html += '</div>';
    }

    // DESCRIPTION
    if (descriptionHTML) {
        html += '<div class="description-section">';
        html += '<div class="section-heading">';
        html += '<h3>📖 Oyun Hakkında</h3>';
        html += '</div>';
        html += '<div class="game-description">' + descriptionHTML + '</div>';
        html += '</div>';
    }

    // RENDER
    DOM.gameDetail.innerHTML = html;

    // EVENTS
    attachScreenshotListeners();
}

// ==================== SCREENSHOT EVENTS ====================

/**
 * Screenshot eventlerini bağlar.
 */
function attachScreenshotListeners() {
    if (!DOM.gameDetail) {
        return;
    }

    var screenshotItems = DOM.gameDetail.querySelectorAll('.screenshot-item');

    for (var i = 0; i < screenshotItems.length; i++) {
        (function (item) {
            var openFromItem = function () {
                var index = parseInt(item.dataset.index, 10);

                if (Number.isInteger(index) && index >= 0 && index < currentScreenshots.length) {
                    openScreenshotModal(index);
                }
            };

            item.addEventListener('click', openFromItem);

            item.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openFromItem();
                }
            });
        })(screenshotItems[i]);
    }
}

// ==================== SCREENSHOT MODAL ====================

/**
 * Modal içeriğini günceller.
 */
function updateScreenshotModal() {
    if (!DOM.screenshotModal || currentScreenshots.length === 0) {
        return;
    }

    var image = DOM.screenshotModal.querySelector('.modal-image');
    var counter = DOM.screenshotModal.querySelector('.modal-counter');
    var currentImage = currentScreenshots[currentScreenshotIndex];

    if (image && currentImage) {
        image.src = safeImageURL(currentImage, DEFAULT_GAME_IMAGE);
        image.alt = 'Ekran görüntüsü ' + (currentScreenshotIndex + 1);

        image.onerror = function () {
            image.onerror = null;
            image.src = DEFAULT_GAME_IMAGE;
        };
    }

    if (counter) {
        counter.textContent = (currentScreenshotIndex + 1) + ' / ' + currentScreenshots.length;
    }
}

/**
 * Screenshot modalını açar.
 * @param {number} index
 */
function openScreenshotModal(index) {
    if (!DOM.screenshotModal || currentScreenshots.length === 0) {
        return;
    }

    if (!Number.isInteger(index) || index < 0 || index >= currentScreenshots.length) {
        return;
    }

    currentScreenshotIndex = index;

    DOM.screenshotModal.style.display = 'flex';
    DOM.screenshotModal.setAttribute('aria-hidden', 'false');

    // Body scroll'u kilitle
    document.body.style.overflow = 'hidden';

    updateScreenshotModal();

    var closeButton = DOM.screenshotModal.querySelector('.modal-close');

    if (closeButton) {
        setTimeout(function () {
            closeButton.focus();
        }, 50);
    }
}

/**
 * Modalı kapatır.
 */
function closeModal() {
    if (!DOM.screenshotModal) {
        return;
    }

    DOM.screenshotModal.style.display = 'none';
    DOM.screenshotModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
}

/**
 * Sonraki screenshot.
 */
function nextScreenshot() {
    if (currentScreenshots.length === 0) {
        return;
    }

    currentScreenshotIndex = (currentScreenshotIndex + 1) % currentScreenshots.length;
    updateScreenshotModal();
}

/**
 * Önceki screenshot.
 */
function prevScreenshot() {
    if (currentScreenshots.length === 0) {
        return;
    }

    currentScreenshotIndex = (currentScreenshotIndex - 1 + currentScreenshots.length) % currentScreenshots.length;
    updateScreenshotModal();
}

// ==================== MODAL EVENTS ====================

function initializeModalEvents() {
    if (!DOM.screenshotModal) {
        return;
    }

    var closeButton = DOM.screenshotModal.querySelector('.modal-close');
    var nextButton = DOM.screenshotModal.querySelector('.modal-next');
    var prevButton = DOM.screenshotModal.querySelector('.modal-prev');

    if (closeButton) {
        closeButton.addEventListener('click', closeModal);
    }

    if (nextButton) {
        nextButton.addEventListener('click', function (event) {
            event.stopPropagation();
            nextScreenshot();
        });
    }

    if (prevButton) {
        prevButton.addEventListener('click', function (event) {
            event.stopPropagation();
            prevScreenshot();
        });
    }

    // Modal arka planına tıklayınca kapat
    DOM.screenshotModal.addEventListener('click', function (event) {
        if (event.target === DOM.screenshotModal) {
            closeModal();
        }
    });
}

// ==================== KEYBOARD EVENTS ====================

function initializeKeyboardEvents() {
    document.addEventListener('keydown', function (event) {
        if (!DOM.screenshotModal || DOM.screenshotModal.style.display !== 'flex') {
            return;
        }

        switch (event.key) {
            case 'Escape':
                event.preventDefault();
                closeModal();
                break;

            case 'ArrowRight':
                event.preventDefault();
                nextScreenshot();
                break;

            case 'ArrowLeft':
                event.preventDefault();
                prevScreenshot();
                break;
        }
    });
}

// ==================== UI STATE MANAGEMENT ====================

/**
 * Loading ekranı.
 */
function showLoading() {
    if (DOM.loadingContainer) {
        DOM.loadingContainer.style.display = 'block';
    }

    if (DOM.errorContainer) {
        DOM.errorContainer.style.display = 'none';
    }

    if (DOM.gameDetail) {
        DOM.gameDetail.style.display = 'none';
    }
}

/**
 * Error ekranı.
 * @param {Error|null} error
 */
function showError(error) {
    if (DOM.loadingContainer) {
        DOM.loadingContainer.style.display = 'none';
    }

    if (DOM.gameDetail) {
        DOM.gameDetail.style.display = 'none';
    }

    if (DOM.errorContainer) {
        DOM.errorContainer.style.display = 'block';

        var errorMessage = DOM.errorContainer.querySelector('.error-message');

        if (errorMessage) {
            errorMessage.textContent = (error && error.message) ? error.message : 'Oyun bilgileri alınamadı.';
        }
    }
}

// ==================== INITIALIZATION ====================

/**
 * Sayfayı başlatır.
 */
async function init() {
    console.log('🎮 STENQ GAMES - Detay sayfası başlatılıyor...');

    initializeModalEvents();
    initializeKeyboardEvents();

    var gameId = getGameId();

    if (!gameId) {
        console.error('❌ Geçersiz Steam App ID.');
        showError(new Error('Geçersiz oyun ID.'));
        return;
    }

    console.log('🔍 Steam App ID: ' + gameId);

    await fetchGameDetail(gameId);
}

// ==================== DOM READY ====================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

// ==================== DEBUG EXPORT ====================

if (typeof window !== 'undefined') {
    window.STENQ_DETAIL = {
        DOM: DOM,

        get currentScreenshots() {
            return currentScreenshots;
        },

        get currentScreenshotIndex() {
            return currentScreenshotIndex;
        },

        getGameId: getGameId,
        fetchGameDetail: fetchGameDetail,
        renderGameDetail: renderGameDetail,
        openScreenshotModal: openScreenshotModal,
        closeModal: closeModal,
        nextScreenshot: nextScreenshot,
        prevScreenshot: prevScreenshot,
        formatPrice: formatPrice,
        getDealLabel: getDealLabel,
        escapeHTML: escapeHTML
    };
}
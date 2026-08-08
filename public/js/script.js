'use strict';

/*
 * =========================================================
 * STENQ GAMES - ANA SAYFA SCRIPT (FULL VERSION)
 * =========================================================
 * 
 * Bu dosya:
 * - Oyun listesini API'den çeker
 * - Popülerlik sıralamasını korur
 * - Kategorileri yönetir
 * - Arama sistemini yönetir
 * - Pagination sistemini yönetir
 * - Oyun kartlarını oluşturur
 * - USD fiyatlarını gösterir
 * - İndirim / fırsat rozetlerini gösterir
 * - Oyun detay sayfasına yönlendirir
 * - Metacritic renk skalasını uygular
 * - AAA oyun rozetini gösterir
 * - Klavye kısayollarını yönetir
 * - Scroll to top butonunu yönetir
 * - Header scroll durumunu takip eder
 * - Error / Loading / No Results durumlarını yönetir
 * - Retry mekanizmasını yönetir
 * - Görsel yükleme hatalarını yakalar
 * - Kart tıklama ve buton etkileşimlerini yönetir
 *
 * Server.js ile tamamen uyumludur.
 * =========================================================
 */

// ==================== CONFIGURATION ====================
const CONFIG = {
    gamesPerPage: 40,
    apiBase: '/api',
    searchDelay: 400,
    scrollThreshold: 500,
    maxCategories: 14,
    apiRetryCount: 3,
    apiRetryDelay: 1000,
    imageLazyLoadOffset: 200,
    animationDuration: 300
};

// ==================== GLOBAL STATE ====================
const state = {
    allGames: [],
    filteredGames: [],
    currentPage: 1,
    totalPages: 1,
    totalGames: 0,
    search: '',
    category: '',
    loading: false,
    initialized: false,
    errorCount: 0,
    lastFetchTime: null,
    activeRequests: 0
};

// ==================== DOM ELEMENT REFERENCES ====================
const DOM = {
    gamesGrid: document.getElementById('gamesGrid'),
    loading: document.getElementById('loadingContainer'),
    error: document.getElementById('errorContainer'),
    noResults: document.getElementById('noResults'),
    pagination: document.getElementById('pagination'),
    paginationContainer: document.getElementById('paginationContainer'),
    paginationInfo: document.getElementById('paginationInfo'),
    search: document.getElementById('searchInput'),
    searchClear: document.getElementById('searchClear'),
    suggestions: document.getElementById('searchSuggestions'),
    categoryNav: document.getElementById('categoryNav'),
    retry: document.getElementById('retryButton'),
    scrollTop: document.getElementById('scrollToTop'),
    header: document.getElementById('header')
};

// ==================== CATEGORY DISPLAY NAMES ====================
const CATEGORY_NAMES = {
    '': '🎮 Tümü',
    populer: '🔥 Popüler',
    'buyuk-indirim': '💸 Büyük İndirim',
    ucretsiz: '🎁 Ücretsiz',
    aksiyon: '🎯 Aksiyon',
    macera: '🗺️ Macera',
    rpg: '⚔️ RPG',
    strateji: '🏰 Strateji',
    korku: '👻 Korku',
    'acik-dunya': '🌍 Açık Dünya',
    'spor-yaris': '🏎️ Spor & Yarış',
    'cok-oyunculu': '👥 Çok Oyunculu',
    bagimsiz: '🎨 Bağımsız',
    hayatta: '🌲 Hayatta Kalma',
    hikaye: '📖 Hikaye',
    'tum-firsatlar': '🎮 Tüm Fırsatlar'
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * HTML escape - XSS koruması
 * @param {string|null|undefined} value - Escape edilecek değer
 * @returns {string} Escape edilmiş string
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
 * String normalize - Arama ve karşılaştırma için
 * @param {string} text - Normalize edilecek metin
 * @returns {string} Normalize edilmiş metin
 */
function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

/**
 * USD para formatı
 * @param {number} value - Formatlanacak değer
 * @returns {string} Formatlanmış USD string
 */
function formatUSD(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return '$0.00';
    }

    return `$${number.toFixed(2)}`;
}

/**
 * Tam sayı yüzde formatı
 * @param {number} value - Yüzde değeri
 * @returns {number} Tam sayı yüzde
 */
function formatDiscount(value) {
    const discount = Math.round(Number(value || 0));
    return Math.max(0, Math.min(100, discount));
}

// ==================== PRICE FORMATTING ====================

/**
 * Fiyat HTML'i oluştur
 * @param {object} price - Price objesi
 * @param {number} price.final - İndirimli fiyat
 * @param {number} price.initial - Orijinal fiyat
 * @param {number} price.discount - İndirim yüzdesi
 * @param {boolean} price.isFree - Ücretsiz mi?
 * @returns {string} Fiyat HTML'i
 */
function formatPrice(price) {
    // Price objesi yoksa
    if (!price) {
        return `<span class="price-final price-unavailable">Fiyat bilgisi yok</span>`;
    }

    // Ücretsiz oyun
    if (Boolean(price.isFree)) {
        return `
            <div class="price-info">
                <span class="discount-badge free-badge">%100</span>
                <span class="price-free">ÜCRETSİZ</span>
            </div>`;
    }

    const finalPrice = Number(price.final);
    const initialPrice = Number(price.initial);
    const discount = Number(price.discount || 0);

    // Geçersiz fiyat
    if (!Number.isFinite(finalPrice) || finalPrice < 0) {
        return `<span class="price-final price-unavailable">Fiyat bilgisi yok</span>`;
    }

    // Gerçek indirim kontrolü
    const hasRealDiscount = discount > 0 && Number.isFinite(initialPrice) && initialPrice > finalPrice;

    if (hasRealDiscount) {
        return `
            <div class="price-info">
                <span class="discount-badge">-${formatDiscount(discount)}%</span>
                <span class="price-original">${formatUSD(initialPrice)}</span>
            </div>
            <span class="price-final">${formatUSD(finalPrice)}</span>`;
    }

    // Normal fiyat
    return `<span class="price-final">${formatUSD(finalPrice)}</span>`;
}

// ==================== METACRITIC COLOR SCALE ====================

/**
 * Metacritic skoruna göre renk döndür
 * @param {number} score - Metacritic skoru
 * @returns {string} HEX renk kodu
 */
function getMetacriticColor(score) {
    const value = Number(score);

    if (!Number.isFinite(value) || value <= 0) {
        return '#64748B'; // Slate-400 (gri)
    }

    if (value >= 80) {
        return '#10B981'; // Emerald-500 (yeşil)
    }

    if (value >= 60) {
        return '#F59E0B'; // Amber-500 (sarı)
    }

    if (value >= 40) {
        return '#D97706'; // Amber-600 (turuncu)
    }

    return '#EF4444'; // Red-500 (kırmızı)
}

/**
 * Metacritic skor etiketi
 * @param {number} score - Metacritic skoru
 * @returns {string} Metacritic etiket metni
 */
function getMetacriticLabel(score) {
    const value = Number(score);

    if (!Number.isFinite(value) || value <= 0) {
        return '-';
    }

    return String(value);
}

// ==================== API COMMUNICATION ====================

/**
 * Backend API'ye istek at
 * @param {string} endpoint - API endpoint'i
 * @param {number} retryCount - Kaçıncı deneme
 * @returns {Promise<object>} API yanıtı
 */
async function fetchFromAPI(endpoint, retryCount = 0) {
    state.activeRequests++;

    try {
        const response = await fetch(`${CONFIG.apiBase}${endpoint}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (!data || data.success === false) {
            throw new Error(data?.error || 'API yanıt vermedi.');
        }

        state.errorCount = 0;
        state.lastFetchTime = Date.now();

        return data;
    } catch (error) {
        state.errorCount++;

        // Retry mekanizması
        if (retryCount < CONFIG.apiRetryCount) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.apiRetryDelay));
            return fetchFromAPI(endpoint, retryCount + 1);
        }

        throw error;
    } finally {
        state.activeRequests--;
    }
}

// ==================== GAME FETCHING ====================

/**
 * Oyunları API'den getir
 * @param {number} page - Sayfa numarası
 * @param {string} search - Arama terimi
 * @param {string} category - Kategori ID'si
 */
async function fetchGames(page = 1, search = '', category = '') {
    // Aynı anda birden fazla istek engelle
    if (state.loading) {
        console.warn('Fetch already in progress, skipping...');
        return;
    }

    state.loading = true;
    state.search = String(search || '').trim();
    state.category = String(category || '').trim();

    showLoading();

    try {
        const params = new URLSearchParams();
        params.set('page', String(Math.max(1, page)));
        params.set('limit', String(CONFIG.gamesPerPage));

        if (state.search) {
            params.set('search', state.search);
        }

        if (state.category) {
            params.set('category', state.category);
        }

        const data = await fetchFromAPI(`/games?${params.toString()}`);

        // Oyunları kaydet
        state.allGames = Array.isArray(data.games) ? data.games : [];
        state.filteredGames = [...state.allGames];

        // Pagination bilgilerini kaydet
        const pagination = data.pagination || {};
        state.currentPage = Number(pagination.currentPage) || 1;
        state.totalPages = Number(pagination.totalPages) || 1;
        state.totalGames = Number(pagination.totalGames) || 0;

        state.loading = false;
        state.initialized = true;

        // Sonuç kontrolü
        if (state.allGames.length === 0) {
            showNoResults();

            if (Array.isArray(data.categories)) {
                renderCategories(data.categories);
            }

            return;
        }

        // Oyun kartlarını render et
        renderGames(state.allGames);

        // Sayfalama render et
        renderPagination(pagination);

        // Kategorileri render et
        if (Array.isArray(data.categories)) {
            renderCategories(data.categories);
        }

        console.log(`✅ ${state.allGames.length} oyun yüklendi (Sayfa ${state.currentPage}/${state.totalPages})`);

    } catch (error) {
        console.error('❌ STENQ GAMES - Oyunlar yüklenemedi:', error.message);
        state.loading = false;
        showError();
    }
}

// ==================== CATEGORY MANAGEMENT ====================

/**
 * Kategorileri render et
 * @param {Array} categories - Kategori listesi
 */
function renderCategories(categories) {
    if (!DOM.categoryNav) {
        console.warn('categoryNav elementi bulunamadı.');
        return;
    }

    let container = DOM.categoryNav.querySelector('.category-scroll');

    // category-scroll yoksa doğrudan categoryNav kullan
    if (!container) {
        container = DOM.categoryNav;
    }

    container.innerHTML = '';

    // "Tümü" butonu
    const allButton = createCategoryButton('', CATEGORY_NAMES[''], state.totalGames);
    allButton.classList.toggle('active', state.category === '');
    allButton.addEventListener('click', () => selectCategory(''));
    container.appendChild(allButton);

    // Diğer kategoriler
    if (Array.isArray(categories)) {
        categories.slice(0, CONFIG.maxCategories).forEach(category => {
            if (!category || !category.id) {
                return;
            }

            const categoryId = String(category.id);
            const categoryName = CATEGORY_NAMES[categoryId] || category.name || categoryId;
            const count = Number(category.count || 0);

            const button = createCategoryButton(categoryId, categoryName, count);
            button.classList.toggle('active', state.category === categoryId);
            button.addEventListener('click', () => selectCategory(categoryId));
            container.appendChild(button);
        });
    }
}

/**
 * Kategori butonu oluştur
 * @param {string} id - Kategori ID'si
 * @param {string} name - Kategori adı
 * @param {number} count - Kategori oyun sayısı
 * @returns {HTMLButtonElement} Kategori butonu
 */
function createCategoryButton(id, name, count) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-btn';
    button.dataset.categoryId = id;
    button.innerHTML = `${escapeHTML(name)} <small>(${count})</small>`;
    button.title = `${name} kategorisindeki oyunları göster (${count} oyun)`;
    button.setAttribute('aria-label', `${name} kategorisi (${count} oyun)`);

    return button;
}

/**
 * Kategori seçimi
 * @param {string} categoryId - Seçilen kategori ID'si
 */
function selectCategory(categoryId) {
    const selected = String(categoryId || '');

    // Aynı kategoriye tekrar tıklanırsa "Tümü"ne dön
    state.category = state.category === selected ? '' : selected;

    // Arama ve sayfa durumunu sıfırla
    state.search = '';
    state.currentPage = 1;

    if (DOM.search) {
        DOM.search.value = '';
    }

    if (DOM.searchClear) {
        DOM.searchClear.style.display = 'none';
    }

    if (DOM.suggestions) {
        DOM.suggestions.style.display = 'none';
    }

    fetchGames(1, '', state.category);
}

// ==================== GAME CARD RENDERING ====================

/**
 * Oyun kartlarını render et
 * @param {Array} games - Oyun listesi
 */
function renderGames(games) {
    if (!DOM.gamesGrid) {
        console.warn('gamesGrid elementi bulunamadı.');
        return;
    }

    hideStates();
    DOM.gamesGrid.innerHTML = '';
    DOM.gamesGrid.style.display = 'grid';

    if (!Array.isArray(games) || games.length === 0) {
        showNoResults();
        return;
    }

    // Document fragment ile performanslı render
    const fragment = document.createDocumentFragment();

    games.forEach(game => {
        if (!game) return;

        const card = createGameCard(game);
        if (card) {
            fragment.appendChild(card);
        }
    });

    DOM.gamesGrid.appendChild(fragment);
}

/**
 * Oyun kartı oluştur
 * @param {object} game - Oyun verisi
 * @returns {HTMLElement|null} Oyun kartı elementi
 */
function createGameCard(game) {
    // Oyun ID'si
    const gameId = Number(game.id || game.steamAppID || 0);

    if (!Number.isFinite(gameId) || gameId <= 0) {
        console.warn('Geçersiz oyun ID:', game);
        return null;
    }

    // Oyun adı
    const gameName = game.name || game.title || 'Bilinmeyen Oyun';

    // Oyun görseli
    const gameImage = game.image || game.capsule || '';

    // Metacritic
    const metacritic = Number(game.metacritic || 0);
    const metacriticLabel = getMetacriticLabel(metacritic);
    const metacriticColor = getMetacriticColor(metacritic);

    // Türler
    const genres = Array.isArray(game.genres) ? game.genres :
                   Array.isArray(game.categories) ? game.categories : [];

    // Fiyat
    const price = game.price || null;
    const isFree = Boolean(game.isFree || price?.isFree);
    const discount = Number(price?.discount ?? game.discount ?? game.savings ?? 0);

    // AAA
    const isAAA = Boolean(game.isAAA);

    // Kart oluştur
    const card = document.createElement('article');
    card.className = 'game-card';
    card.dataset.gameId = String(gameId);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${gameName} - Detayları gör`);

    // Görsel HTML
    const imageHTML = gameImage
        ? `<img src="${escapeHTML(gameImage)}" alt="${escapeHTML(gameName)}" class="game-card-image" loading="lazy" draggable="false">`
        : `<div class="game-card-image-placeholder">🎮</div>`;

    // Fırsat rozeti HTML
    let dealBadgeHTML = '';
    if (isFree) {
        dealBadgeHTML = `
            <span class="deal-label free-deal-label">🎁 FIRSAT</span>
            <span class="discount-overlay free-overlay">ÜCRETSİZ</span>`;
    } else if (discount > 0) {
        dealBadgeHTML = `
            <span class="deal-label">🔥 FIRSAT</span>
            <span class="discount-overlay">-${formatDiscount(discount)}%</span>`;
    }

    // Metacritic HTML
    const metacriticHTML = `
        <div class="game-rating" style="color:${metacriticColor};" title="Metacritic puanı: ${metacriticLabel}">
            ⭐ ${metacriticLabel}
        </div>`;

    // AAA rozeti HTML
    const aaaBadgeHTML = isAAA ? `<span class="aaa-badge" title="AAA Oyun">AAA</span>` : '';

    // Tür etiketleri HTML
    let genresHTML = '';
    if (genres.length > 0) {
        genresHTML = genres
            .slice(0, 3)
            .map(genre => `<span class="genre-tag">${escapeHTML(genre)}</span>`)
            .join('');
    }

    // Fiyat HTML
    const priceHTML = formatPrice(price);

    // Kart içeriği
    card.innerHTML = `
        <div class="game-card-image-container">
            ${imageHTML}
            ${dealBadgeHTML}
        </div>
        <div class="game-card-body">
            <h3 class="game-card-title" title="${escapeHTML(gameName)}">${escapeHTML(gameName)}</h3>
            <div class="game-card-meta">
                ${metacriticHTML}
                ${aaaBadgeHTML}
            </div>
            <div class="game-genres">${genresHTML}</div>
            <div class="game-card-price">
                <div class="card-price-area">${priceHTML}</div>
                <button class="detail-button" type="button" aria-label="${gameName} detaylarını gör">İncele →</button>
            </div>
        </div>`;

    // Görsel hata yakalama
    const image = card.querySelector('.game-card-image');
    if (image) {
        image.addEventListener('error', () => {
            const placeholder = document.createElement('div');
            placeholder.className = 'game-card-image-placeholder';
            placeholder.textContent = '🎮';
            image.replaceWith(placeholder);
        }, { once: true });
    }

    // Detay sayfasına yönlendirme
    const goToDetail = () => {
        if (!Number.isFinite(gameId) || gameId <= 0) {
            console.warn('Geçersiz Steam App ID:', gameId);
            return;
        }

        window.location.href = `/game.html?id=${encodeURIComponent(gameId)}`;
    };

    // Kart tıklama
    card.addEventListener('click', (event) => {
        if (event.target.closest('.detail-button')) return;
        goToDetail();
    });

    // Enter tuşu ile kart tıklama (erişilebilirlik)
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            goToDetail();
        }
    });

    // Detay butonu tıklama
    const detailButton = card.querySelector('.detail-button');
    if (detailButton) {
        detailButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            goToDetail();
        });
    }

    return card;
}

// ==================== PAGINATION ====================

/**
 * Sayfalama render et
 * @param {object} paginationData - Pagination verisi
 */
function renderPagination(paginationData) {
    if (!DOM.pagination || !DOM.paginationContainer) return;

    if (!paginationData || Number(paginationData.totalPages) <= 1) {
        DOM.paginationContainer.style.display = 'none';
        return;
    }

    DOM.paginationContainer.style.display = 'block';

    const currentPage = Number(paginationData.currentPage) || 1;
    const totalPages = Number(paginationData.totalPages) || 1;
    const totalGames = Number(paginationData.totalGames) || 0;

    // Pagination bilgi metni
    if (DOM.paginationInfo) {
        DOM.paginationInfo.textContent = `Toplam ${totalGames.toLocaleString('tr-TR')} oyun • Sayfa ${currentPage}/${totalPages}`;
    }

    DOM.pagination.innerHTML = '';

    // Önceki sayfa butonu
    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'pagination-button';
    prevButton.textContent = '‹';
    prevButton.disabled = currentPage <= 1;
    prevButton.setAttribute('aria-label', 'Önceki sayfa');
    prevButton.addEventListener('click', () => {
        if (currentPage <= 1 || state.loading) return;
        fetchGames(currentPage - 1, state.search, state.category);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    DOM.pagination.appendChild(prevButton);

    // Sayfa numaraları
    const pageNumbers = getPageNumbers(currentPage, totalPages);
    pageNumbers.forEach(page => {
        if (page === '...') {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'pagination-ellipsis';
            ellipsis.textContent = '...';
            ellipsis.setAttribute('aria-hidden', 'true');
            DOM.pagination.appendChild(ellipsis);
            return;
        }

        const pageButton = document.createElement('button');
        pageButton.type = 'button';
        pageButton.className = `pagination-button${page === currentPage ? ' active' : ''}`;
        pageButton.textContent = String(page);
        pageButton.setAttribute('aria-label', `Sayfa ${page}`);

        if (page === currentPage) {
            pageButton.setAttribute('aria-current', 'page');
        } else {
            pageButton.addEventListener('click', () => {
                if (state.loading) return;
                fetchGames(page, state.search, state.category);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        }

        DOM.pagination.appendChild(pageButton);
    });

    // Sonraki sayfa butonu
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'pagination-button';
    nextButton.textContent = '›';
    nextButton.disabled = currentPage >= totalPages;
    nextButton.setAttribute('aria-label', 'Sonraki sayfa');
    nextButton.addEventListener('click', () => {
        if (currentPage >= totalPages || state.loading) return;
        fetchGames(currentPage + 1, state.search, state.category);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    DOM.pagination.appendChild(nextButton);
}

/**
 * Sayfa numaralarını hesapla
 * @param {number} current - Geçerli sayfa
 * @param {number} total - Toplam sayfa
 * @returns {Array} Sayfa numaraları dizisi
 */
function getPageNumbers(current, total) {
    current = Math.max(1, Number(current) || 1);
    total = Math.max(1, Number(total) || 1);

    if (total <= 7) {
        return Array.from({ length: total }, (_, index) => index + 1);
    }

    const pages = [1];

    if (current > 3) {
        pages.push('...');
    }

    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);

    for (let page = start; page <= end; page++) {
        pages.push(page);
    }

    if (current < total - 2) {
        pages.push('...');
    }

    pages.push(total);

    return pages;
}

// ==================== SEARCH SYSTEM ====================

let searchTimer = null;

/**
 * Arama sistemini kur
 */
function setupSearch() {
    if (!DOM.search) return;

    // Input olayı - debounce ile
    DOM.search.addEventListener('input', () => {
        const value = DOM.search.value.trim();

        if (DOM.searchClear) {
            DOM.searchClear.style.display = value ? 'flex' : 'none';
        }

        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.search = value;
            state.category = '';
            fetchGames(1, value, '');
        }, CONFIG.searchDelay);
    });

    // Klavye olayları
    DOM.search.addEventListener('keydown', (event) => {
        // Enter
        if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(searchTimer);

            const value = DOM.search.value.trim();
            state.search = value;
            state.category = '';
            fetchGames(1, value, '');
        }

        // Escape
        if (event.key === 'Escape') {
            event.preventDefault();
            clearTimeout(searchTimer);

            DOM.search.value = '';
            if (DOM.searchClear) DOM.searchClear.style.display = 'none';
            state.search = '';
            fetchGames(1, '', state.category);
        }
    });
}

/**
 * Arama temizleme butonunu kur
 */
function setupSearchClear() {
    if (!DOM.searchClear) return;

    DOM.searchClear.addEventListener('click', () => {
        clearTimeout(searchTimer);

        if (DOM.search) {
            DOM.search.value = '';
            DOM.search.focus();
        }

        state.search = '';
        DOM.searchClear.style.display = 'none';
        fetchGames(1, '', state.category);
    });
}

// ==================== UI STATE MANAGEMENT ====================

/**
 * Tüm durumları gizle, oyun grid'ini göster
 */
function hideStates() {
    if (DOM.gamesGrid) DOM.gamesGrid.style.display = 'grid';
    if (DOM.loading) DOM.loading.style.display = 'none';
    if (DOM.error) DOM.error.style.display = 'none';
    if (DOM.noResults) DOM.noResults.style.display = 'none';
}

/**
 * Loading durumunu göster
 */
function showLoading() {
    if (DOM.gamesGrid) DOM.gamesGrid.style.display = 'none';
    if (DOM.loading) DOM.loading.style.display = 'block';
    if (DOM.error) DOM.error.style.display = 'none';
    if (DOM.noResults) DOM.noResults.style.display = 'none';
    if (DOM.paginationContainer) DOM.paginationContainer.style.display = 'none';
}

/**
 * Hata durumunu göster
 */
function showError() {
    if (DOM.gamesGrid) DOM.gamesGrid.style.display = 'none';
    if (DOM.loading) DOM.loading.style.display = 'none';
    if (DOM.error) DOM.error.style.display = 'block';
    if (DOM.noResults) DOM.noResults.style.display = 'none';
    if (DOM.paginationContainer) DOM.paginationContainer.style.display = 'none';
}

/**
 * Sonuç bulunamadı durumunu göster
 */
function showNoResults() {
    if (DOM.gamesGrid) DOM.gamesGrid.style.display = 'none';
    if (DOM.loading) DOM.loading.style.display = 'none';
    if (DOM.error) DOM.error.style.display = 'none';
    if (DOM.noResults) DOM.noResults.style.display = 'block';
    if (DOM.paginationContainer) DOM.paginationContainer.style.display = 'none';
}

// ==================== EVENT SETUP ====================

/**
 * Retry butonunu kur
 */
function setupRetry() {
    if (!DOM.retry) return;

    DOM.retry.addEventListener('click', () => {
        if (state.loading) return;
        state.errorCount = 0;
        fetchGames(1, state.search, state.category);
    });
}

/**
 * Scroll to top butonunu kur
 */
function setupScrollToTop() {
    if (!DOM.scrollTop) return;

    window.addEventListener('scroll', () => {
        const shouldShow = window.scrollY > CONFIG.scrollThreshold;
        DOM.scrollTop.style.display = shouldShow ? 'flex' : 'none';

        if (DOM.header) {
            DOM.header.classList.toggle('scrolled', window.scrollY > 10);
        }
    }, { passive: true });

    DOM.scrollTop.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

/**
 * Klavye kısayollarını kur
 */
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        const target = event.target;
        const isTypingField = target instanceof HTMLInputElement ||
                              target instanceof HTMLTextAreaElement ||
                              target instanceof HTMLSelectElement ||
                              target.isContentEditable;

        // "/" -> aramaya odaklan
        if (event.key === '/' && !isTypingField && DOM.search) {
            event.preventDefault();
            DOM.search.focus();
            DOM.search.select();
        }

        // Ctrl+K -> arama temizle
        if (event.key === 'k' && event.ctrlKey && !isTypingField) {
            event.preventDefault();
            if (DOM.search) DOM.search.value = '';
            state.search = '';
            fetchGames(1, '', state.category);
        }
    });
}

// ==================== INITIALIZATION ====================

/**
 * Uygulamayı başlat
 */
function init() {
    console.log('🎮 STENQ GAMES başlatılıyor...');
    console.log(`📋 Konfigürasyon: Sayfa başına ${CONFIG.gamesPerPage} oyun, API: ${CONFIG.apiBase}`);
    console.log(`⏱️  Arama gecikmesi: ${CONFIG.searchDelay}ms, Retry: ${CONFIG.apiRetryCount} deneme`);

    setupSearch();
    setupSearchClear();
    setupRetry();
    setupScrollToTop();
    setupKeyboardShortcuts();

    showLoading();
    fetchGames(1, '', '');

    console.log('✅ STENQ GAMES hazır!');
}

// ==================== DOM READY ====================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

// ==================== EXPORT FOR DEBUG ====================
// Geliştirme ortamında state'i incelemek için
if (typeof window !== 'undefined') {
    window.__STENQ_STATE__ = state;
    window.__STENQ_DOM__ = DOM;
    window.__STENQ_CONFIG__ = CONFIG;
}
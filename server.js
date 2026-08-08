'use strict';

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
    PORT,
    CHEAPSHARK_API: 'https://www.cheapshark.com/api/1.0',
    STEAM_API: 'https://store.steampowered.com/api',
    GAMES_PER_PAGE: 40,
    DEAL_PAGES: 5,
    DEAL_PAGE_SIZE: 60,
    DEAL_SORT_STRATEGIES: ['Deal Rating', 'Savings'],
    FRANCHISE_PAGE_SIZE: 10,
    CACHE_TIME: 30 * 60 * 1000,
    RATE_LIMIT_DELAY: 2000
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CACHE ====================
const cache = new Map();

function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() - item.time > CONFIG.CACHE_TIME) {
        cache.delete(key);
        return null;
    }
    return item.data;
}

function setCache(key, data) {
    cache.set(key, { data, time: Date.now() });
}

// ==================== GLOBAL STATE ====================
let allDealsCache = null;
let loadingDeals = false;

// ==================== HELPERS ====================
function normalize(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

// ==================== BLOCKED WORDS ====================
const BLOCKED_WORDS = [
    'soundtrack', 'season pass', 'expansion pass', 'dlc', 'add-on', 'addon',
    'bundle', 'pack', 'starter pack', 'supporter pack', 'currency', 'coins',
    'points', 'credits', 'wallpaper', 'avatar', 'cosmetic', 'upgrade', 'demo',
    'digital deluxe', 'deluxe edition', 'ultimate edition', 'gold edition',
    'complete edition', "collector's edition", 'collector edition',
    'game of the year edition', 'goty edition', 'premium edition',
    'special edition', 'anniversary edition', 'definitive edition',
    'enhanced edition'
];

function isBlockedProduct(title) {
    const name = normalize(title);
    if (!name) return true;
    return BLOCKED_WORDS.some(word => name.includes(normalize(word)));
}

function hasSteamID(deal) {
    const id = Number(deal && deal.steamAppID ? deal.steamAppID : 0);
    return Number.isFinite(id) && id > 0;
}

function isRealGame(deal) {
    if (!deal) return false;
    if (!deal.title) return false;
    if (!hasSteamID(deal)) return false;
    if (isBlockedProduct(deal.title)) return false;
    return normalize(deal.title).length >= 2;
}

// ==================== AAA GAMES ====================
const AAA_GAMES = [
    'grand theft auto', 'gta', 'red dead redemption', 'cyberpunk 2077',
    'the witcher 3', 'the witcher', 'elden ring', 'dark souls', 'sekiro',
    'god of war', 'spider-man', 'spiderman', 'horizon', 'resident evil',
    'assassin creed', "assassin's creed", 'assassins creed', 'far cry',
    'doom', 'battlefield', 'call of duty', 'counter-strike', 'counter strike',
    'rainbow six', 'destiny', 'forza horizon', 'forza motorsport',
    'need for speed', 'f1', 'nba 2k', 'tekken', 'mortal kombat',
    'baldurs gate', "baldur's gate", 'baldur gate', 'fallout', 'skyrim',
    'monster hunter', 'final fantasy', 'persona', 'yakuza', 'terraria',
    'stardew valley', 'hollow knight', 'hades', 'subnautica', 'rust', 'ark',
    'valheim', 'palworld', 'phasmophobia', 'it takes two', 'a way out',
    'hogwarts legacy', 'star wars', 'marvel', 'batman', 'borderlands',
    'diablo', 'dead space', 'silent hill', 'uncharted', 'the last of us',
    'death stranding', 'metro', 'mass effect', 'dragon age', 'watch dogs',
    'hitman', 'metal gear', 'devil may cry', 'street fighter', 'monster hunter'
];

function isAAA(game) {
    const title = normalize((game && game.name) ? game.name : (game && game.title ? game.title : ''));
    return AAA_GAMES.some(name => title.includes(normalize(name)));
}

// ==================== CATEGORIES ====================
function detectCategories(title) {
    const text = normalize(title);
    const result = [];

    const rules = {
        aksiyon: ['doom', 'devil may cry', 'bayonetta', 'metal gear', 'resident evil', 'assassin', 'batman', 'spider-man', 'spiderman', 'god of war', 'hitman', 'sekiro', 'dark souls', 'elden ring', 'borderlands', 'far cry', 'call of duty', 'battlefield', 'destiny', 'warframe', 'tekken', 'mortal kombat', 'shooter'],
        macera: ['tomb raider', 'uncharted', 'life is strange', 'walking dead', 'firewatch', 'stray', 'subnautica', 'outer wilds', 'death stranding', 'little nightmares', 'adventure', 'quest'],
        rpg: ['witcher', 'baldur', 'elder scrolls', 'skyrim', 'fallout', 'elden ring', 'dark souls', 'dragon age', 'mass effect', 'persona', 'final fantasy', 'yakuza', 'cyberpunk', 'diablo', 'monster hunter', 'path of exile', 'dragon', 'rpg'],
        strateji: ['civilization', 'total war', 'age of empires', 'xcom', 'stellaris', 'crusader kings', 'company of heroes', 'starcraft', 'warhammer', 'strategy', 'tactics'],
        korku: ['resident evil', 'outlast', 'amnesia', 'dead space', 'silent hill', 'phasmophobia', 'alien isolation', 'evil within', 'visage', 'horror', 'zombie'],
        'spor-yaris': ['forza', 'need for speed', 'dirt', 'assetto corsa', 'f1', 'beamng', 'wreckfest', 'the crew', 'racing', 'nba', 'fifa', 'football', 'soccer', 'tennis', 'golf', 'wwe'],
        'acik-dunya': ['grand theft auto', 'gta', 'red dead redemption', 'cyberpunk', 'assassin', 'far cry', 'watch dogs', 'skyrim', 'fallout', 'elden ring', 'open world', 'sandbox'],
        'cok-oyunculu': ['counter-strike', 'counter strike', 'valorant', 'rainbow six', 'overwatch', 'apex', 'destiny', 'warframe', 'phasmophobia', 'rust', 'sea of thieves', 'it takes two', 'a way out', 'online', 'multiplayer', 'co-op', 'coop'],
        bagimsiz: ['hades', 'hollow knight', 'celeste', 'undertale', 'stardew', 'terraria', 'dead cells', 'cuphead', 'limbo', 'inside', 'ori', 'slay the spire', 'indie'],
        hayatta: ['rust', 'ark', 'dayz', '7 days', 'subnautica', 'green hell', 'sons of the forest', 'the forest', 'raft', 'project zomboid', 'valheim', 'grounded', 'palworld', 'survival']
    };

    for (const category of Object.keys(rules)) {
        const keywords = rules[category];
        if (keywords.some(keyword => text.includes(normalize(keyword)))) {
            result.push(category);
        }
    }

    return result.length > 0 ? result : ['diger'];
}

// ==================== HTTP ====================
async function fetchJSON(url, options) {
    const fetchOptions = options || {};
    const response = await fetch(url, {
        method: fetchOptions.method || 'GET',
        headers: Object.assign({}, { 'Accept': 'application/json', 'User-Agent': 'STENQ-GAMES/3.0' }, fetchOptions.headers || {}),
        signal: fetchOptions.signal || undefined
    });

    if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' - ' + url);
    }

    return response.json();
}

// ==================== CHEAPSHARK ====================
async function fetchDealPage(page, sortBy) {
    const sort = sortBy || 'DealRating';

    // Rate limit koruması - HER İSTEK ARASINDA BEKLE
    await new Promise(function (resolve) {
        setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY);
    });

    const url = CONFIG.CHEAPSHARK_API + '/deals' +
        '?pageNumber=' + page +
        '&pageSize=' + CONFIG.DEAL_PAGE_SIZE +
        '&onSale=1' +
        '&sortBy=' + encodeURIComponent(sort) +
        '&desc=1';

    try {
        const data = await fetchJSON(url);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.warn('CheapShark sayfa ' + page + ' (' + sort + ') alinamadi: ' + error.message);
        return [];
    }
}

// ==================== FRANCHISE SEARCH ====================
const FRANCHISE_WATCHLIST = [
    'grand theft auto', 'red dead redemption', 'cyberpunk 2077',
    'the witcher 3', 'elden ring', 'dark souls', 'sekiro', 'god of war',
    "marvel's spider-man", 'horizon', 'resident evil', "assassin's creed",
    'far cry', 'doom', 'battlefield', 'call of duty', 'counter-strike',
    'rainbow six', 'destiny', 'forza', 'need for speed', 'nba 2k',
    'tekken', 'mortal kombat', "baldur's gate", 'fallout', 'skyrim',
    'monster hunter', 'final fantasy', 'hogwarts legacy', 'star wars',
    'borderlands', 'diablo', 'the last of us', 'death stranding', 'metro',
    'mass effect', 'hitman'
];

async function fetchDealsForTitle(title) {
    // Rate limit koruması
    await new Promise(function (resolve) {
        setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY);
    });

    const url = CONFIG.CHEAPSHARK_API + '/deals' +
        '?title=' + encodeURIComponent(title) +
        '&pageSize=' + CONFIG.FRANCHISE_PAGE_SIZE +
        '&onSale=1' +
        '&sortBy=DealRating' +
        '&desc=1';

    try {
        const data = await fetchJSON(url);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.warn('CheapShark title aramasi "' + title + '" basarisiz: ' + error.message);
        return [];
    }
}

// ==================== DEAL NORMALIZE ====================
function normalizeDeal(deal) {
    const saleUSD = toNumber(deal.salePrice);
    const normalUSD = toNumber(deal.normalPrice);
    const savings = toNumber(deal.savings);
    const steamAppID = Number(deal.steamAppID || 0);
    const metacritic = Number(deal.metacriticScore || deal.metacritic || 0);

    return {
        id: steamAppID,
        steamAppID: steamAppID,
        name: deal.title || 'Bilinmeyen Oyun',
        title: deal.title || 'Bilinmeyen Oyun',
        image: deal.thumb || '',
        capsule: deal.thumb || '',
        storeName: 'Steam',
        saleUSD: saleUSD,
        normalUSD: normalUSD,
        price: {
            final: saleUSD,
            initial: normalUSD,
            discount: Math.round(savings),
            isFree: saleUSD === 0
        },
        savings: savings,
        discount: Math.round(savings),
        dealRating: toNumber(deal.dealRating),
        metacritic: metacritic > 0 ? metacritic : null,
        dealID: deal.dealID || '',
        dealLink: deal.dealLink || '',
        dealEnds: deal.dealEnds || null,
        categories: detectCategories(deal.title),
        isFree: saleUSD === 0,
        isAAA: isAAA({ name: deal.title })
    };
}

// ==================== BASE GAME NAME ====================
function getBaseGameName(title) {
    let name = normalize(title);

    const removePatterns = [
        /\s*[-:]\s*deluxe.*$/i, /\s*[-:]\s*ultimate.*$/i,
        /\s*[-:]\s*gold.*$/i, /\s*[-:]\s*goty.*$/i,
        /\s*[-:]\s*game of the year.*$/i, /\s*[-:]\s*complete.*$/i,
        /\s*[-:]\s*definitive.*$/i, /\s+deluxe edition.*$/i,
        /\s+ultimate edition.*$/i, /\s+gold edition.*$/i,
        /\s+goty edition.*$/i, /\s+game of the year edition.*$/i,
        /\s+complete edition.*$/i, /\s+definitive edition.*$/i,
        /\s+enhanced edition.*$/i, /\s+premium edition.*$/i,
        /\s+special edition.*$/i, /\s+anniversary edition.*$/i
    ];

    for (var i = 0; i < removePatterns.length; i++) {
        name = name.replace(removePatterns[i], '');
    }

    return name.replace(/[^a-z0-9]+/g, '').trim();
}

// ==================== POPULARITY SCORE ====================
function getPopularityScore(game) {
    const title = normalize(game.title || game.name);
    const dealRating = toNumber(game.dealRating);
    const discount = toNumber(game.discount || game.savings);
    const metacritic = toNumber(game.metacritic);

    var score = 0;
    score += dealRating * 5;
    score += metacritic * 1.5;
    score += Math.min(discount, 80) * 0.7;

    if (game.isAAA || isAAA(game)) {
        score += 250;
    }

    const popularKeywords = [
        'grand theft auto', 'gta', 'red dead redemption', 'cyberpunk',
        'witcher', 'elden ring', 'dark souls', 'sekiro', 'god of war',
        'spider-man', 'spiderman', 'resident evil', 'assassin', 'far cry',
        'doom', 'battlefield', 'call of duty', 'counter-strike', 'counter strike',
        'rainbow six', 'forza', 'need for speed', 'f1', 'tekken', 'mortal kombat',
        'baldur', 'fallout', 'skyrim', 'monster hunter', 'final fantasy',
        'persona', 'hogwarts legacy', 'star wars', 'batman', 'hades',
        'hollow knight', 'stardew valley', 'terraria', 'subnautica', 'rust',
        'valheim', 'phasmophobia', 'it takes two'
    ];

    for (var j = 0; j < popularKeywords.length; j++) {
        if (title.includes(normalize(popularKeywords[j]))) {
            score += 150;
            break;
        }
    }

    return score;
}

// ==================== FETCH ALL DEALS ====================
async function fetchAllDeals() {
    if (loadingDeals) {
        return allDealsCache;
    }

    loadingDeals = true;
    console.log('🎮 STENQ GAMES katalogu hazirlaniyor...');

    try {
        const pagesPerStrategy = Math.ceil(CONFIG.DEAL_PAGES / CONFIG.DEAL_SORT_STRATEGIES.length);
        const bulkRequests = [];

        for (var s = 0; s < CONFIG.DEAL_SORT_STRATEGIES.length; s++) {
            var sortBy = CONFIG.DEAL_SORT_STRATEGIES[s];
            for (var p = 0; p < pagesPerStrategy; p++) {
                bulkRequests.push(fetchDealPage(p, sortBy));
            }
        }

        const franchiseRequests = FRANCHISE_WATCHLIST.map(function (title) {
            return fetchDealsForTitle(title);
        });

        const bulkResults = await Promise.all(bulkRequests);
        const franchiseResults = await Promise.all(franchiseRequests);

        const rawDeals = bulkResults.flat().concat(franchiseResults.flat());

        console.log('API RESULTS (toplam ham kayit): ' + rawDeals.length);

        const steamGames = rawDeals.filter(isRealGame);
        console.log('AFTER isRealGame FILTER: ' + steamGames.length);

        const unique = new Map();
        for (var d = 0; d < steamGames.length; d++) {
            var deal = steamGames[d];
            var steamID = Number(deal.steamAppID);

            if (!Number.isFinite(steamID) || steamID <= 0) continue;

            var existing = unique.get(steamID);
            if (!existing) {
                unique.set(steamID, deal);
                continue;
            }

            if (Number(deal.dealRating || 0) > Number(existing.dealRating || 0)) {
                unique.set(steamID, deal);
            }
        }

        console.log('AFTER STEAM-ID DEDUP: ' + unique.size);

        var games = Array.from(unique.values())
            .map(normalizeDeal)
            .filter(function (game) {
                return game.discount > 0 || game.isFree;
            });

        console.log('AFTER discount>0/isFree FILTER: ' + games.length);

        const baseNameMap = new Map();
        for (var g = 0; g < games.length; g++) {
            var game = games[g];
            var baseName = getBaseGameName(game.title);

            if (!baseName) continue;

            var existingGame = baseNameMap.get(baseName);
            if (!existingGame) {
                baseNameMap.set(baseName, game);
                continue;
            }

            if (game.isAAA && !existingGame.isAAA) {
                baseNameMap.set(baseName, game);
                continue;
            }

            if (getPopularityScore(game) > getPopularityScore(existingGame)) {
                baseNameMap.set(baseName, game);
            }
        }

        games = Array.from(baseNameMap.values());
        console.log('VISIBLE (nihai havuz): ' + games.length);

        games.sort(function (a, b) {
            return getPopularityScore(b) - getPopularityScore(a);
        });

        allDealsCache = games;

        var aaaCount = games.filter(function (game) {
            return game.isAAA;
        }).length;

        console.log('✅ ' + games.length + ' Steam oyunu hazir.');
        console.log('⭐ AAA oyun sayisi: ' + aaaCount);

        return games;

    } catch (error) {
        console.error('Katalog hatasi: ' + (error && error.message ? error.message : 'Bilinmeyen hata'));
        return allDealsCache || [];
    } finally {
        loadingDeals = false;
    }
}

// ==================== FILTER ====================
function filterGames(games, category) {
    if (!category || category === 'tum-firsatlar') return games;
    if (category === 'populer') return games.filter(function (game) { return getPopularityScore(game) >= 100; });
    if (category === 'buyuk-indirim') return games.filter(function (game) { return Number(game.discount || 0) >= 50; });
    if (category === 'ucretsiz') return games.filter(function (game) { return game.isFree; });
    return games.filter(function (game) { return game.categories && game.categories.includes(category); });
}

// ==================== CATEGORIES ====================
const CATEGORY_LIST = [
    ['populer', 'Popüler'],
    ['buyuk-indirim', 'Büyük İndirim'],
    ['ucretsiz', 'Ücretsiz'],
    ['aksiyon', 'Aksiyon'],
    ['macera', 'Macera'],
    ['rpg', 'RPG'],
    ['strateji', 'Strateji'],
    ['korku', 'Korku'],
    ['acik-dunya', 'Açık Dünya'],
    ['spor-yaris', 'Spor & Yarış'],
    ['cok-oyunculu', 'Çok Oyunculu'],
    ['bagimsiz', 'Bağımsız'],
    ['hayatta', 'Hayatta Kalma'],
    ['tum-firsatlar', 'Tüm Fırsatlar']
];

function getCategoryIcon(id) {
    const icons = {
        'populer': '🔥', 'buyuk-indirim': '💸', 'ucretsiz': '🎁',
        'aksiyon': '🎯', 'macera': '🗺️', 'rpg': '⚔️',
        'strateji': '🏰', 'korku': '👻', 'acik-dunya': '🌍',
        'spor-yaris': '🏎️', 'cok-oyunculu': '👥', 'bagimsiz': '🎨',
        'hayatta': '🌲', 'tum-firsatlar': '🎮'
    };
    return icons[id] || '🎮';
}

function buildCategories(games) {
    return CATEGORY_LIST.map(function (item) {
        var id = item[0];
        var name = item[1];
        return {
            id: id,
            name: getCategoryIcon(id) + ' ' + name,
            count: filterGames(games, id).length
        };
    });
}

// ==================== API - GAMES ====================
app.get('/api/games', async function (req, res) {
    try {
        if (!allDealsCache) {
            await fetchAllDeals();
        }

        var games = allDealsCache || [];
        var page = Math.max(1, parseInt(req.query.page, 10) || 1);
        var limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || CONFIG.GAMES_PER_PAGE));
        var search = normalize(req.query.search || '');
        var category = normalize(req.query.category || '');

        var filtered = filterGames(games, category);

        if (search) {
            filtered = filtered.filter(function (game) {
                return normalize(game.name).includes(search);
            });
        }

        filtered.sort(function (a, b) {
            return getPopularityScore(b) - getPopularityScore(a);
        });

        var totalGames = filtered.length;
        var totalPages = Math.max(1, Math.ceil(totalGames / limit));
        var currentPage = Math.min(page, totalPages);
        var start = (currentPage - 1) * limit;
        var pageGames = filtered.slice(start, start + limit);

        res.json({
            success: true,
            games: pageGames,
            pagination: {
                currentPage: currentPage,
                totalPages: totalPages,
                totalGames: totalGames,
                limit: limit,
                hasNext: currentPage < totalPages,
                hasPrev: currentPage > 1
            },
            categories: buildCategories(games),
            loading: false
        });
    } catch (error) {
        console.error('/api/games:', error);
        res.status(500).json({ success: false, error: 'Oyunlar yüklenirken hata oluştu.' });
    }
});

// ==================== API - SEARCH ====================
app.get('/api/search', async function (req, res) {
    try {
        var query = normalize(req.query.q || '');

        if (query.length < 2) {
            return res.json({ success: true, results: [] });
        }

        if (!allDealsCache) {
            await fetchAllDeals();
        }

        var results = (allDealsCache || [])
            .filter(function (game) {
                return normalize(game.name).includes(query);
            })
            .sort(function (a, b) {
                return getPopularityScore(b) - getPopularityScore(a);
            })
            .slice(0, 10)
            .map(function (game) {
                return {
                    id: game.steamAppID,
                    name: game.name,
                    image: game.image,
                    price: {
                        final: game.price.final,
                        initial: game.price.initial,
                        discount: game.price.discount,
                        isFree: game.price.isFree
                    },
                    metacritic: game.metacritic
                };
            });

        res.json({ success: true, results: results });
    } catch (error) {
        console.error('/api/search:', error);
        res.status(500).json({ success: false, results: [] });
    }
});

// ==================== API - GAME DETAIL ====================
app.get('/api/game/:id', async function (req, res) {
    var gameId = parseInt(req.params.id, 10);

    if (!Number.isFinite(gameId) || gameId <= 0) {
        return res.status(400).json({ success: false, error: 'Geçersiz Steam App ID.' });
    }

    var cacheKey = 'game-detail-' + gameId;
    var cached = getCache(cacheKey);

    if (cached) {
        return res.json(cached);
    }

    try {
        var steamURL = CONFIG.STEAM_API + '/appdetails' +
            '?appids=' + gameId +
            '&l=english' +
            '&cc=us';

        var steamData = await fetchJSON(steamURL);
        var entry = steamData && steamData[gameId] ? steamData[gameId] : null;

        if (!entry || !entry.success || !entry.data) {
            return res.status(404).json({ success: false, error: 'Steam oyunu bulunamadi.' });
        }

        var game = entry.data;
        var price = null;

        var cheapSharkGame = (allDealsCache || []).find(function (item) {
            return Number(item.steamAppID) === gameId;
        });

        if (cheapSharkGame && cheapSharkGame.price) {
            price = {
                isFree: Boolean(cheapSharkGame.price.isFree),
                final: toNumber(cheapSharkGame.price.final),
                initial: toNumber(cheapSharkGame.price.initial),
                discount: toNumber(cheapSharkGame.price.discount)
            };
        } else if (game.is_free) {
            price = { isFree: true, final: 0, initial: 0, discount: 100 };
        } else if (game.price_overview) {
            price = {
                isFree: false,
                final: toNumber(game.price_overview.final) / 100,
                initial: toNumber(game.price_overview.initial) / 100,
                discount: toNumber(game.price_overview.discount_percent)
            };
        }

        var screenshots = (game.screenshots || [])
            .map(function (screenshot) { return screenshot.path_full; })
            .filter(Boolean);

        var requirements = {
            minimum: (game.pc_requirements && game.pc_requirements.minimum) ? game.pc_requirements.minimum : '',
            recommended: (game.pc_requirements && game.pc_requirements.recommended) ? game.pc_requirements.recommended : ''
        };

        var stores = [];
        if (price) {
            stores.push({
                name: 'Steam',
                price: price.final,
                originalPrice: price.initial,
                discount: price.discount,
                url: 'https://store.steampowered.com/app/' + gameId + '/',
                isFree: Boolean(price.isFree)
            });
        }

        var response = {
            success: true,
            game: {
                id: game.steam_appid || gameId,
                name: game.name || 'Bilinmeyen Oyun',
                image: game.header_image || '',
                background: game.background_raw || '',
                description: game.detailed_description || game.short_description || '',
                shortDescription: game.short_description || '',
                price: price,
                isFree: Boolean(game.is_free),
                platforms: Object.entries(game.platforms || {})
                    .filter(function (entry) { return entry[1]; })
                    .map(function (entry) { return entry[0]; }),
                developers: game.developers || [],
                publishers: game.publishers || [],
                releaseDate: (game.release_date && game.release_date.date) ? game.release_date.date : '',
                genres: (game.genres || []).map(function (genre) { return genre.description; }),
                metacritic: (game.metacritic && game.metacritic.score) ? game.metacritic.score : null,
                recommendations: (game.recommendations && game.recommendations.total) ? game.recommendations.total : 0,
                screenshots: screenshots,
                requirements: requirements,
                stores: stores
            }
        };

        setCache(cacheKey, response);
        res.json(response);
    } catch (error) {
        console.error('/api/game/' + gameId + ':', error.message);
        res.status(500).json({ success: false, error: 'Oyun detaylari yuklenemedi.' });
    }
});

// ==================== STATUS ====================
app.get('/api/status', function (req, res) {
    res.json({
        success: true,
        games: allDealsCache ? allDealsCache.length : 0,
        currency: 'USD',
        loading: loadingDeals,
        serverTime: new Date().toISOString()
    });
});

// ==================== FRONTEND ====================
app.use(function (req, res, next) {
    if (req.path.startsWith('/api/')) {
        return next();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== SERVER ====================
app.listen(CONFIG.PORT, async function () {
    console.log('====================================');
    console.log('🎮 STENQ GAMES');
    console.log('====================================');
    console.log('🌐 http://localhost:' + CONFIG.PORT);
    console.log('💵 Para birimi: USD ($)');
    console.log('📦 Steam oyunlari hazirlaniyor...');

    await fetchAllDeals();

    console.log('🚀 STENQ GAMES hazir!');
    console.log('🎮 ' + (allDealsCache ? allDealsCache.length : 0) + ' oyun');
    console.log('====================================');

    setInterval(async function () {
        console.log('🔄 Oyunlar ve fiyatlar guncelleniyor...');
        allDealsCache = null;

        var keys = Array.from(cache.keys());
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].startsWith('game-detail-')) {
                cache.delete(keys[i]);
            }
        }

        await fetchAllDeals();
        console.log('✅ Guncelleme tamamlandi.');
    }, CONFIG.CACHE_TIME);
});
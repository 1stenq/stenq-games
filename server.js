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

async function fetchDealPage(page) {
    // Rate limit koruması
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const url = `${CONFIG.CHEAPSHARK_API}/deals?pageNumber=${page}&pageSize=${CONFIG.DEAL_PAGE_SIZE}&onSale=1&sortBy=DealRating&desc=1`;
    try {
        const data = await fetchJSON(url);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.warn('CheapShark sayfa ' + page + ' alinamadi: ' + error.message);
        return [];
    }
}

const CONFIG = {
    PORT,

    CHEAPSHARK_API:
        'https://www.cheapshark.com/api/1.0',

    STEAM_API:
        'https://store.steampowered.com/api',

    GAMES_PER_PAGE: 40,

    // Toplam bütçe AYNI kalıyor (20 sayfa x 60 kayıt).
    // Tek farkla: artık tek sıralamaya değil, iki farklı
    // stratejiye bölünüyor. "Deal Rating" tarihi en iyi
    // fiyata yakınlığı, "Savings" ise ham indirim yüzdesini
    // baz alır. İkisi birlikte, AAA oyunların sadece
    // DealRating'i düşük diye havuz dışında kalmasını önler.
    DEAL_PAGES: 5,
    DEAL_PAGE_SIZE: 60,
    DEAL_SORT_STRATEGIES: ['Deal Rating', 'Savings'],

    // Bilinen serilerin GERÇEKTEN indirimde olup olmadığını
    // CheapShark'ın "title" parametresiyle doğrudan sorar.
    // Bulunamazsa hiçbir şey eklenmez - sahte veri yok.
    FRANCHISE_PAGE_SIZE: 10,

    // 30 dakika
    CACHE_TIME: 30 * 60 * 1000
};
app.use(cors());
app.use(express.json());

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);


// =====================================================
// CACHE
// =====================================================

const cache = new Map();

function getCache(key) {
    const item = cache.get(key);

    if (!item) {
        return null;
    }

    if (
        Date.now() - item.time >
        CONFIG.CACHE_TIME
    ) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function setCache(key, data) {
    cache.set(key, {
        data,
        time: Date.now()
    });
}


// =====================================================
// GLOBAL STATE
// =====================================================

let allDealsCache = null;
let loadingDeals = false;


// =====================================================
// HELPERS
// =====================================================

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function toNumber(value) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : 0;
}


// =====================================================
// ENGELLENECEK ÜRÜNLER
// =====================================================

const BLOCKED_WORDS = [
    'soundtrack',

    'season pass',

    'expansion pass',

    'dlc',

    'add-on',
    'addon',

    'bundle',

    'pack',
    'starter pack',
    'supporter pack',

    'currency',
    'coins',
    'points',
    'credits',

    'wallpaper',
    'avatar',
    'cosmetic',

    'upgrade',

    'demo',

    'digital deluxe',
    'deluxe edition',

    'ultimate edition',

    'gold edition',

    'complete edition',

    "collector's edition",
    'collector edition',

    'game of the year edition',
    'goty edition',

    'premium edition',

    'special edition',

    'anniversary edition',

    'definitive edition',

    'enhanced edition'
];

function isBlockedProduct(title) {
    const name = normalize(title);

    if (!name) {
        return true;
    }

    return BLOCKED_WORDS.some(word =>
        name.includes(
            normalize(word)
        )
    );
}


// =====================================================
// STEAM ID
// =====================================================

function hasSteamID(deal) {
    const id = Number(
        deal?.steamAppID || 0
    );

    return (
        Number.isFinite(id) &&
        id > 0
    );
}


// =====================================================
// GERÇEK OYUN MU?
// =====================================================

function isRealGame(deal) {
    if (!deal) {
        return false;
    }

    if (!deal.title) {
        return false;
    }

    if (!hasSteamID(deal)) {
        return false;
    }

    if (
        isBlockedProduct(
            deal.title
        )
    ) {
        return false;
    }

    return (
        normalize(deal.title).length >= 2
    );
}


// =====================================================
// AAA / POPÜLER OYUNLAR
// =====================================================

const AAA_GAMES = [
    'grand theft auto',
    'gta',

    'red dead redemption',

    'cyberpunk 2077',

    'the witcher 3',
    'the witcher',

    'elden ring',

    'dark souls',

    'sekiro',

    'god of war',

    'spider-man',
    'spiderman',

    'horizon',

    'resident evil',

    'assassin creed',
    "assassin's creed",
    'assassins creed',

    'far cry',

    'doom',

    'battlefield',

    'call of duty',

    'counter-strike',
    'counter strike',

    'rainbow six',

    'destiny',

    'forza horizon',
    'forza motorsport',

    'need for speed',

    'f1',

    'nba 2k',

    'tekken',

    'mortal kombat',

    'baldurs gate',
    "baldur's gate",
    'baldur gate',

    'fallout',

    'skyrim',

    'monster hunter',

    'final fantasy',

    'persona',

    'yakuza',

    'terraria',

    'stardew valley',

    'hollow knight',

    'hades',

    'subnautica',

    'rust',

    'ark',

    'valheim',

    'palworld',

    'phasmophobia',

    'it takes two',

    'a way out',

    'hogwarts legacy',

    'star wars',

    'marvel',

    'batman',

    'borderlands',

    'diablo',

    'dead space',

    'silent hill',

    'uncharted',

    'the last of us',

    'death stranding',

    'metro',

    'mass effect',

    'dragon age',

    'watch dogs',

    'hitman',

    'metal gear',

    'devil may cry',

    'street fighter',

    'monster hunter'
];

function isAAA(game) {
    const title = normalize(
        game?.name ||
        game?.title
    );

    return AAA_GAMES.some(name =>
        title.includes(
            normalize(name)
        )
    );
}


// =====================================================
// KATEGORİLER
// =====================================================

function detectCategories(title) {
    const text = normalize(title);

    const result = [];

    const rules = {
        aksiyon: [
            'doom',
            'devil may cry',
            'bayonetta',
            'metal gear',
            'resident evil',
            'assassin',
            'batman',
            'spider-man',
            'spiderman',
            'god of war',
            'hitman',
            'sekiro',
            'dark souls',
            'elden ring',
            'borderlands',
            'far cry',
            'call of duty',
            'battlefield',
            'destiny',
            'warframe',
            'tekken',
            'mortal kombat',
            'shooter'
        ],

        macera: [
            'tomb raider',
            'uncharted',
            'life is strange',
            'walking dead',
            'firewatch',
            'stray',
            'subnautica',
            'outer wilds',
            'death stranding',
            'little nightmares',
            'adventure',
            'quest'
        ],

        rpg: [
            'witcher',
            'baldur',
            'elder scrolls',
            'skyrim',
            'fallout',
            'elden ring',
            'dark souls',
            'dragon age',
            'mass effect',
            'persona',
            'final fantasy',
            'yakuza',
            'cyberpunk',
            'diablo',
            'monster hunter',
            'path of exile',
            'dragon',
            'rpg'
        ],

        strateji: [
            'civilization',
            'total war',
            'age of empires',
            'xcom',
            'stellaris',
            'crusader kings',
            'company of heroes',
            'starcraft',
            'warhammer',
            'strategy',
            'tactics'
        ],

        korku: [
            'resident evil',
            'outlast',
            'amnesia',
            'dead space',
            'silent hill',
            'phasmophobia',
            'alien isolation',
            'evil within',
            'visage',
            'horror',
            'zombie'
        ],

        'spor-yaris': [
            'forza',
            'need for speed',
            'dirt',
            'assetto corsa',
            'f1',
            'beamng',
            'wreckfest',
            'the crew',
            'racing',
            'nba',
            'fifa',
            'football',
            'soccer',
            'tennis',
            'golf',
            'wwe'
        ],

        'acik-dunya': [
            'grand theft auto',
            'gta',
            'red dead redemption',
            'cyberpunk',
            'assassin',
            'far cry',
            'watch dogs',
            'skyrim',
            'fallout',
            'elden ring',
            'open world',
            'sandbox'
        ],

        'cok-oyunculu': [
            'counter-strike',
            'counter strike',
            'valorant',
            'rainbow six',
            'overwatch',
            'apex',
            'destiny',
            'warframe',
            'phasmophobia',
            'rust',
            'sea of thieves',
            'it takes two',
            'a way out',
            'online',
            'multiplayer',
            'co-op',
            'coop'
        ],

        bagimsiz: [
            'hades',
            'hollow knight',
            'celeste',
            'undertale',
            'stardew',
            'terraria',
            'dead cells',
            'cuphead',
            'limbo',
            'inside',
            'ori',
            'slay the spire',
            'indie'
        ],

        hayatta: [
            'rust',
            'ark',
            'dayz',
            '7 days',
            'subnautica',
            'green hell',
            'sons of the forest',
            'the forest',
            'raft',
            'project zomboid',
            'valheim',
            'grounded',
            'palworld',
            'survival'
        ]
    };

    for (
        const [category, keywords]
        of Object.entries(rules)
    ) {
        if (
            keywords.some(keyword =>
                text.includes(
                    normalize(keyword)
                )
            )
        ) {
            result.push(category);
        }
    }

    return result.length > 0
        ? result
        : ['diger'];
}


// =====================================================
// HTTP
// =====================================================

async function fetchJSON(
    url,
    options = {}
) {
    const response = await fetch(
        url,
        {
            ...options,

            headers: {
                Accept:
                    'application/json',

                'User-Agent':
                    'STENQ-GAMES/3.0',

                ...(options.headers || {})
            }
        }
    );

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} - ${url}`
        );
    }

    return response.json();
}


// =====================================================
// CHEAPSHARK
// =====================================================

async function fetchDealPage(page, sortBy = 'DealRating') {
    const url =
        `${CONFIG.CHEAPSHARK_API}/deals` +
        `?pageNumber=${page}` +
        `&pageSize=${CONFIG.DEAL_PAGE_SIZE}` +
        `&onSale=1` +
        `&sortBy=${encodeURIComponent(sortBy)}` +
        `&desc=1`;

    try {
        const data = await fetchJSON(url);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.warn(`CheapShark sayfa ${page} (${sortBy}) alınamadı:`, error.message);
        return [];
    }
}


// =====================================================
// BİLİNEN SERİLER İÇİN HEDEFLİ SORGU
// (CheapShark'ın "title" parametresi ile GERÇEK veri;
// hiçbir oyun/fiyat/rating uydurulmaz - sadece API'ye
// "bu isim indirimde mi?" diye sorulur)
// =====================================================

const FRANCHISE_WATCHLIST = [
    'grand theft auto',
    'red dead redemption',
    'cyberpunk 2077',
    'the witcher 3',
    'elden ring',
    'dark souls',
    'sekiro',
    'god of war',
    "marvel's spider-man",
    'horizon',
    'resident evil',
    "assassin's creed",
    'far cry',
    'doom',
    'battlefield',
    'call of duty',
    'counter-strike',
    'rainbow six',
    'destiny',
    'forza',
    'need for speed',
    'nba 2k',
    'tekken',
    'mortal kombat',
    "baldur's gate",
    'fallout',
    'skyrim',
    'monster hunter',
    'final fantasy',
    'hogwarts legacy',
    'star wars',
    'borderlands',
    'diablo',
    'the last of us',
    'death stranding',
    'metro',
    'mass effect',
    'hitman'
];

async function fetchDealsForTitle(title) {
    const url =
        `${CONFIG.CHEAPSHARK_API}/deals` +
        `?title=${encodeURIComponent(title)}` +
        `&pageSize=${CONFIG.FRANCHISE_PAGE_SIZE}` +
        `&onSale=1` +
        `&sortBy=DealRating` +
        `&desc=1`;

    try {
        const data = await fetchJSON(url);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.warn(`CheapShark title araması "${title}" başarısız:`, error.message);
        return [];
    }
}

// =====================================================
// DEAL NORMALIZE
// =====================================================

function normalizeDeal(deal) {
    const saleUSD =
        toNumber(
            deal.salePrice
        );

    const normalUSD =
        toNumber(
            deal.normalPrice
        );

    const savings =
        toNumber(
            deal.savings
        );

    const steamAppID =
        Number(
            deal.steamAppID || 0
        );

    const metacritic =
        Number(
            deal.metacriticScore ||
            deal.metacritic ||
            0
        );

    return {
        id: steamAppID,

        steamAppID,

        name:
            deal.title ||
            'Bilinmeyen Oyun',

        title:
            deal.title ||
            'Bilinmeyen Oyun',

        image:
            deal.thumb ||
            '',

        capsule:
            deal.thumb ||
            '',

        storeName:
            'Steam',

        // =================================================
        // USD
        // =================================================

        saleUSD,

        normalUSD,

        price: {
            final:
                saleUSD,

            initial:
                normalUSD,

            discount:
                Math.round(
                    savings
                ),

            isFree:
                saleUSD === 0
        },

        savings,

        discount:
            Math.round(
                savings
            ),

        dealRating:
            toNumber(
                deal.dealRating
            ),

        metacritic:
            metacritic > 0
                ? metacritic
                : null,

        dealID:
            deal.dealID ||
            '',

        dealLink:
            deal.dealLink ||
            '',

        dealEnds:
            deal.dealEnds ||
            null,

        categories:
            detectCategories(
                deal.title
            ),

        isFree:
            saleUSD === 0,

        isAAA:
            isAAA({
                name:
                    deal.title
            })
    };
}


// =====================================================
// AYNI OYUNUN EDITIONLARINI TEMİZLE
// =====================================================

function getBaseGameName(title) {
    let name =
        normalize(title);

    const removePatterns = [
        /\s*[-:]\s*deluxe.*$/i,
        /\s*[-:]\s*ultimate.*$/i,
        /\s*[-:]\s*gold.*$/i,
        /\s*[-:]\s*goty.*$/i,
        /\s*[-:]\s*game of the year.*$/i,
        /\s*[-:]\s*complete.*$/i,
        /\s*[-:]\s*definitive.*$/i,

        /\s+deluxe edition.*$/i,
        /\s+ultimate edition.*$/i,
        /\s+gold edition.*$/i,
        /\s+goty edition.*$/i,
        /\s+game of the year edition.*$/i,
        /\s+complete edition.*$/i,
        /\s+definitive edition.*$/i,
        /\s+enhanced edition.*$/i,
        /\s+premium edition.*$/i,
        /\s+special edition.*$/i,
        /\s+anniversary edition.*$/i
    ];

    for (
        const pattern
        of removePatterns
    ) {
        name =
            name.replace(
                pattern,
                ''
            );
    }

    return name
        .replace(
            /[^a-z0-9]+/g,
            ''
        )
        .trim();
}


// =====================================================
// POPÜLERLİK SKORU
// =====================================================

function getPopularityScore(game) {
    const title =
        normalize(
            game.title ||
            game.name
        );

    const dealRating =
        toNumber(
            game.dealRating
        );

    const discount =
        toNumber(
            game.discount ||
            game.savings
        );

    const metacritic =
        toNumber(
            game.metacritic
        );

    let score = 0;


    // =================================================
    // DEAL KALİTESİ
    // =================================================

    score +=
        dealRating * 5;


    // =================================================
    // METACRITIC
    // =================================================

    score +=
        metacritic * 1.5;


    // =================================================
    // İNDİRİM
    // =================================================

    score +=
        Math.min(
            discount,
            80
        ) * 0.7;


    // =================================================
    // AAA
    // =================================================

    if (
        game.isAAA ||
        isAAA(game)
    ) {
        score += 250;
    }


    // =================================================
    // ÇOK POPÜLER OYUNLAR
    // =================================================

    const popularKeywords = [
        'grand theft auto',
        'gta',

        'red dead redemption',

        'cyberpunk',

        'witcher',

        'elden ring',

        'dark souls',

        'sekiro',

        'god of war',

        'spider-man',
        'spiderman',

        'resident evil',

        'assassin',

        'far cry',

        'doom',

        'battlefield',

        'call of duty',

        'counter-strike',
        'counter strike',

        'rainbow six',

        'forza',

        'need for speed',

        'f1',

        'tekken',

        'mortal kombat',

        'baldur',

        'fallout',

        'skyrim',

        'monster hunter',

        'final fantasy',

        'persona',

        'hogwarts legacy',

        'star wars',

        'batman',

        'hades',

        'hollow knight',

        'stardew valley',

        'terraria',

        'subnautica',

        'rust',

        'valheim',

        'phasmophobia',

        'it takes two'
    ];

    for (
        const keyword
        of popularKeywords
    ) {
        if (
            title.includes(
                normalize(keyword)
            )
        ) {
            score += 150;
            break;
        }
    }

    return score;
}


// =====================================================
// TÜM OYUNLARI AL
// =====================================================

async function fetchAllDeals() {
    if (loadingDeals) {
        return allDealsCache;
    }

    loadingDeals = true;

    console.log('🎮 STENQ GAMES kataloğu hazırlanıyor...');

    try {
        // =================================================
        // 1) TOPLU ÇEKME — iki sıralama stratejisi aynı
        //    toplam sayfa bütçesine bölünüyor.
        // =================================================

        const pagesPerStrategy = Math.ceil(
            CONFIG.DEAL_PAGES / CONFIG.DEAL_SORT_STRATEGIES.length
        );

        const bulkRequests = [];

        for (const sortBy of CONFIG.DEAL_SORT_STRATEGIES) {
            for (let page = 0; page < pagesPerStrategy; page++) {
                bulkRequests.push(fetchDealPage(page, sortBy));
            }
        }

        // =================================================
        // 2) HEDEFLİ ÇEKME — bilinen serilerin gerçekten
        //    indirimde olup olmadığını doğrudan sorar.
        // =================================================

        const franchiseRequests = FRANCHISE_WATCHLIST.map(
            title => fetchDealsForTitle(title)
        );

        const [bulkResults, franchiseResults] = await Promise.all([
            Promise.all(bulkRequests),
            Promise.all(franchiseRequests)
        ]);

        const rawDeals = [
            ...bulkResults.flat(),
            ...franchiseResults.flat()
        ];

        console.log(`API RESULTS (toplam ham kayıt): ${rawDeals.length}`);

        // =================================================
        // GERÇEK OYUNLAR
        // =================================================

        const steamGames = rawDeals.filter(isRealGame);

        console.log(`AFTER isRealGame FILTER: ${steamGames.length}`);

        // =================================================
        // STEAM ID'YE GÖRE TEKİLLEŞTİR
        // =================================================

        const unique = new Map();

        for (const deal of steamGames) {
            const steamID = Number(deal.steamAppID);

            if (!Number.isFinite(steamID) || steamID <= 0) {
                continue;
            }

            const existing = unique.get(steamID);

            if (!existing) {
                unique.set(steamID, deal);
                continue;
            }

            if (Number(deal.dealRating || 0) > Number(existing.dealRating || 0)) {
                unique.set(steamID, deal);
            }
        }

        console.log(`AFTER STEAM-ID DEDUP: ${unique.size}`);

        // =================================================
        // NORMALIZE
        // =================================================

        let games = Array.from(unique.values())
            .map(normalizeDeal)
            .filter(game => game.discount > 0 || game.isFree);

        console.log(`AFTER discount>0/isFree FILTER: ${games.length}`);

        // =================================================
        // AYNI OYUNUN EDITIONLARINI TEMİZLE
        // =================================================

        const baseNameMap = new Map();

        for (const game of games) {
            const baseName = getBaseGameName(game.title);

            if (!baseName) {
                continue;
            }

            const existing = baseNameMap.get(baseName);

            if (!existing) {
                baseNameMap.set(baseName, game);
                continue;
            }

            if (game.isAAA && !existing.isAAA) {
                baseNameMap.set(baseName, game);
                continue;
            }

            if (getPopularityScore(game) > getPopularityScore(existing)) {
                baseNameMap.set(baseName, game);
            }
        }

        games = Array.from(baseNameMap.values());

        console.log(`VISIBLE (nihai havuz): ${games.length}`);

        // =================================================
        // POPÜLERLİĞE GÖRE SIRALA
        // =================================================

        games.sort((a, b) => getPopularityScore(b) - getPopularityScore(a));

        allDealsCache = games;

        console.log(`✅ ${games.length} Steam oyunu hazır.`);
        console.log(`⭐ AAA oyun sayısı: ${games.filter(game => game.isAAA).length}`);

        return games;

    } catch (error) {
        console.error('Katalog hatası:', error.message);
        return allDealsCache || [];

    } finally {
        loadingDeals = false;
    }
}

// =====================================================
// FİLTRE
// =====================================================

function filterGames(
    games,
    category
) {
    if (
        !category ||
        category ===
            'tum-firsatlar'
    ) {
        return games;
    }

    if (
        category ===
        'populer'
    ) {
        return games.filter(
            game =>
                getPopularityScore(
                    game
                ) >= 100
        );
    }

    if (
        category ===
        'buyuk-indirim'
    ) {
        return games.filter(
            game =>
                Number(
                    game.discount || 0
                ) >= 50
        );
    }

    if (
        category ===
        'ucretsiz'
    ) {
        return games.filter(
            game =>
                game.isFree
        );
    }

    return games.filter(
        game =>
            game.categories?.includes(
                category
            )
    );
}


// =====================================================
// KATEGORİLER
// =====================================================

const CATEGORY_LIST = [
    ['populer', 'Popüler'],

    [
        'buyuk-indirim',
        'Büyük İndirim'
    ],

    [
        'ucretsiz',
        'Ücretsiz'
    ],

    [
        'aksiyon',
        'Aksiyon'
    ],

    [
        'macera',
        'Macera'
    ],

    [
        'rpg',
        'RPG'
    ],

    [
        'strateji',
        'Strateji'
    ],

    [
        'korku',
        'Korku'
    ],

    [
        'acik-dunya',
        'Açık Dünya'
    ],

    [
        'spor-yaris',
        'Spor & Yarış'
    ],

    [
        'cok-oyunculu',
        'Çok Oyunculu'
    ],

    [
        'bagimsiz',
        'Bağımsız'
    ],

    [
        'hayatta',
        'Hayatta Kalma'
    ],

    [
        'tum-firsatlar',
        'Tüm Fırsatlar'
    ]
];

function getCategoryIcon(id) {
    const icons = {
        populer: '🔥',

        'buyuk-indirim':
            '💸',

        ucretsiz:
            '🎁',

        aksiyon:
            '🎯',

        macera:
            '🗺️',

        rpg:
            '⚔️',

        strateji:
            '🏰',

        korku:
            '👻',

        'acik-dunya':
            '🌍',

        'spor-yaris':
            '🏎️',

        'cok-oyunculu':
            '👥',

        bagimsiz:
            '🎨',

        hayatta:
            '🌲',

        'tum-firsatlar':
            '🎮'
    };

    return (
        icons[id] ||
        '🎮'
    );
}

function buildCategories(
    games
) {
    return CATEGORY_LIST.map(
        ([id, name]) => ({
            id,

            name:
                `${getCategoryIcon(id)} ${name}`,

            count:
                filterGames(
                    games,
                    id
                ).length
        })
    );
}


// =====================================================
// API - GAMES
// =====================================================

app.get(
    '/api/games',
    async (req, res) => {
        try {

            if (!allDealsCache) {
                await fetchAllDeals();
            }

            const games =
                allDealsCache ||
                [];


            const page =
                Math.max(
                    1,
                    parseInt(
                        req.query.page,
                        10
                    ) || 1
                );


            const limit =
                Math.min(
                    60,
                    Math.max(
                        1,
                        parseInt(
                            req.query.limit,
                            10
                        ) ||
                        CONFIG.GAMES_PER_PAGE
                    )
                );


            const search =
                normalize(
                    req.query.search ||
                        ''
                );


            const category =
                normalize(
                    req.query.category ||
                        ''
                );


            let filtered =
                filterGames(
                    games,
                    category
                );


            // =================================================
            // ARAMA
            // =================================================

            if (search) {
                filtered =
                    filtered.filter(
                        game =>
                            normalize(
                                game.name
                            ).includes(
                                search
                            )
                    );
            }


            // =================================================
            // HER ZAMAN POPÜLERLİK
            // =================================================

            filtered.sort(
                (a, b) =>
                    getPopularityScore(b) -
                    getPopularityScore(a)
            );


            const totalGames =
                filtered.length;


            const totalPages =
                Math.max(
                    1,
                    Math.ceil(
                        totalGames /
                            limit
                    )
                );


            const currentPage =
                Math.min(
                    page,
                    totalPages
                );


            const start =
                (
                    currentPage - 1
                ) * limit;


            const pageGames =
                filtered.slice(
                    start,
                    start + limit
                );


            res.json({
                success: true,

                games:
                    pageGames,

                pagination: {
                    currentPage,

                    totalPages,

                    totalGames,

                    limit,

                    hasNext:
                        currentPage <
                        totalPages,

                    hasPrev:
                        currentPage >
                        1
                },

                categories:
                    buildCategories(
                        games
                    ),

                loading: false
            });

        } catch (error) {

            console.error(
                '/api/games:',
                error
            );

            res.status(500)
                .json({
                    success: false,

                    error:
                        'Oyunlar yüklenirken hata oluştu.'
                });
        }
    }
);


// =====================================================
// API - SEARCH
// =====================================================

app.get(
    '/api/search',
    async (req, res) => {
        try {

            const query =
                normalize(
                    req.query.q ||
                        ''
                );


            if (
                query.length < 2
            ) {
                return res.json({
                    success: true,

                    results: []
                });
            }


            if (!allDealsCache) {
                await fetchAllDeals();
            }


            const results =
                (
                    allDealsCache ||
                    []
                )
                    .filter(
                        game =>
                            normalize(
                                game.name
                            ).includes(
                                query
                            )
                    )
                    .sort(
                        (a, b) =>
                            getPopularityScore(
                                b
                            ) -
                            getPopularityScore(
                                a
                            )
                    )
                    .slice(0, 10)
                    .map(
                        game => ({
                            id:
                                game.steamAppID,

                            name:
                                game.name,

                            image:
                                game.image,

                            price: {
                                final:
                                    game.price
                                        .final,

                                initial:
                                    game.price
                                        .initial,

                                discount:
                                    game.price
                                        .discount,

                                isFree:
                                    game.price
                                        .isFree
                            },

                            metacritic:
                                game.metacritic
                        })
                    );


            res.json({
                success: true,

                results
            });

        } catch (error) {

            console.error(
                '/api/search:',
                error
            );

            res.status(500)
                .json({
                    success: false,

                    results: []
                });
        }
    }
);


// =====================================================
// API - GAME DETAIL
// =====================================================

app.get(
    '/api/game/:id',
    async (req, res) => {

        const gameId =
            parseInt(
                req.params.id,
                10
            );


        if (
            !Number.isFinite(
                gameId
            ) ||
            gameId <= 0
        ) {
            return res
                .status(400)
                .json({
                    success: false,

                    error:
                        'Geçersiz Steam App ID.'
                });
        }


        const cacheKey =
            `game-detail-${gameId}`;


        const cached =
            getCache(
                cacheKey
            );


        if (cached) {
            return res.json(
                cached
            );
        }


        try {

            // =================================================
            // STEAM
            // USD İÇİN cc=us
            // =================================================

            const steamURL =
                `${CONFIG.STEAM_API}` +
                `/appdetails` +
                `?appids=${gameId}` +
                `&l=english` +
                `&cc=us`;


            const steamData =
                await fetchJSON(
                    steamURL
                );


            const entry =
                steamData?.[gameId];


            if (
                !entry?.success ||
                !entry?.data
            ) {
                return res
                    .status(404)
                    .json({
                        success: false,

                        error:
                            'Steam oyunu bulunamadı.'
                    });
            }


            const game =
                entry.data;


            // =================================================
            // FİYAT
            //
            // Öncelik:
            // 1. CheapShark ana sayfa fiyatı
            // 2. Steam USD fiyatı
            // =================================================

            let price = null;


            const cheapSharkGame =
                (
                    allDealsCache ||
                    []
                ).find(
                    item =>
                        Number(
                            item.steamAppID
                        ) === gameId
                );


            if (
                cheapSharkGame?.price
            ) {

                price = {
                    isFree:
                        Boolean(
                            cheapSharkGame
                                .price
                                .isFree
                        ),

                    final:
                        toNumber(
                            cheapSharkGame
                                .price
                                .final
                        ),

                    initial:
                        toNumber(
                            cheapSharkGame
                                .price
                                .initial
                        ),

                    discount:
                        toNumber(
                            cheapSharkGame
                                .price
                                .discount
                        )
                };

            } else if (
                game.is_free
            ) {

                price = {
                    isFree: true,

                    final: 0,

                    initial: 0,

                    discount: 100
                };

            } else if (
                game.price_overview
            ) {

                price = {
                    isFree: false,

                    final:
                        toNumber(
                            game.price_overview
                                .final
                        ) / 100,

                    initial:
                        toNumber(
                            game.price_overview
                                .initial
                        ) / 100,

                    discount:
                        toNumber(
                            game.price_overview
                                .discount_percent
                        )
                };
            }


            // =================================================
            // SCREENSHOTS
            // =================================================

            const screenshots =
                (
                    game.screenshots ||
                    []
                )
                    .map(
                        screenshot =>
                            screenshot.path_full
                    )
                    .filter(Boolean);


            // =================================================
            // SYSTEM REQUIREMENTS
            // =================================================

            const requirements = {
                minimum:
                    game.pc_requirements
                        ?.minimum ||
                    '',

                recommended:
                    game.pc_requirements
                        ?.recommended ||
                    ''
            };


            // =================================================
            // STORE
            // =================================================

            const stores = [];


            if (price) {

                stores.push({
                    name:
                        'Steam',

                    price:
                        price.final,

                    originalPrice:
                        price.initial,

                    discount:
                        price.discount,

                    url:
                        `https://store.steampowered.com/app/${gameId}/`,

                    isFree:
                        Boolean(
                            price.isFree
                        )
                });
            }


            // =================================================
            // RESPONSE
            // =================================================

            const response = {

                success: true,

                game: {

                    id:
                        game.steam_appid ||
                        gameId,

                    name:
                        game.name ||
                        'Bilinmeyen Oyun',

                    image:
                        game.header_image ||
                        '',

                    background:
                        game.background_raw ||
                        '',

                    description:
                        game.detailed_description ||
                        game.short_description ||
                        '',

                    shortDescription:
                        game.short_description ||
                        '',

                    price,

                    isFree:
                        Boolean(
                            game.is_free
                        ),

                    platforms:
                        Object.entries(
                            game.platforms ||
                                {}
                        )
                            .filter(
                                ([, enabled]) =>
                                    enabled
                            )
                            .map(
                                ([platform]) =>
                                    platform
                            ),

                    developers:
                        game.developers ||
                        [],

                    publishers:
                        game.publishers ||
                        [],

                    releaseDate:
                        game.release_date
                            ?.date ||
                        '',

                    genres:
                        (
                            game.genres ||
                            []
                        )
                            .map(
                                genre =>
                                    genre.description
                            ),

                    metacritic:
                        game.metacritic
                            ?.score ||
                        null,

                    recommendations:
                        game.recommendations
                            ?.total ||
                        0,

                    screenshots,

                    requirements,

                    stores
                }
            };


            setCache(
                cacheKey,
                response
            );


            res.json(
                response
            );

        } catch (error) {

            console.error(
                `/api/game/${gameId}:`,
                error.message
            );

            res.status(500)
                .json({
                    success: false,

                    error:
                        'Oyun detayları yüklenemedi.'
                });
        }
    }
);


// =====================================================
// STATUS
// =====================================================

app.get(
    '/api/status',
    (req, res) => {

        res.json({
            success: true,

            games:
                allDealsCache?.length ||
                0,

            currency:
                'USD',

            loading:
                loadingDeals,

            serverTime:
                new Date()
                    .toISOString()
        });
    }
);


// =====================================================
// FRONTEND
// =====================================================

app.use(
    (req, res, next) => {

        if (
            req.path.startsWith(
                '/api/'
            )
        ) {
            return next();
        }

        res.sendFile(
            path.join(
                __dirname,
                'public',
                'index.html'
            )
        );
    }
);


// =====================================================
// SERVER
// =====================================================

app.listen(
    CONFIG.PORT,
    async () => {

        console.log(
            '===================================='
        );

        console.log(
            '🎮 STENQ GAMES'
        );

        console.log(
            '===================================='
        );

        console.log(
            `🌐 http://localhost:${CONFIG.PORT}`
        );

        console.log(
            '💵 Para birimi: USD ($)'
        );

        console.log(
            '📦 Steam oyunları hazırlanıyor...'
        );


        await fetchAllDeals();


        console.log(
            '🚀 STENQ GAMES hazır!'
        );

        console.log(
            `🎮 ${
                allDealsCache?.length ||
                0
            } oyun`
        );

        console.log(
            '===================================='
        );


        // =================================================
        // OTOMATİK GÜNCELLEME
        // =================================================

        setInterval(
            async () => {

                console.log(
                    '🔄 Oyunlar ve fiyatlar güncelleniyor...'
                );

                allDealsCache =
                    null;


                // Eski oyun detay cache'lerini
                // de temizle.
                for (
                    const key
                    of cache.keys()
                ) {
                    if (
                        key.startsWith(
                            'game-detail-'
                        )
                    ) {
                        cache.delete(
                            key
                        );
                    }
                }


                await fetchAllDeals();

                console.log(
                    '✅ Güncelleme tamamlandı.'
                );

            },
            CONFIG.CACHE_TIME
        );
    }
);
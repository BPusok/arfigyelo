// Árfigyelő Web Alkalmazás – Lidl & Aldi Akció- és Árkövető
import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';

// Supabase konfiguráció
const SUPABASE_URL = 'https://npbdwncxrckvricbtktz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_msZVswp3iu9CwQCtvyJpyA_8Apm3nVm';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Állapot (State)
let allOffers = [];
let allBrands = new Map(); // brandName (uppercase) -> { brand, owner_store, kind, pair_group }
let categories = new Set();
let productGroupsMap = new Map();
let watchlist = new Set(JSON.parse(localStorage.getItem('arfigyelo_watchlist') || '[]'));

let currentTab = 'products'; // 'products' | 'analytics'
let currentStore = 'all';
let currentSource = 'all'; // 'all' | 'flyer' | 'regular'
let currentCategory = 'all';
let currentSort = 'name-asc';
let currentSearch = '';
let showOnlyWatchlist = false;
let currentView = 'grid'; // 'grid' | 'table'

// Összehasonlítás Állapot (Márkák és Sajátmárka-párharc)
let compMode = 'private'; // 'private' | 'national'
let selectedCompKey = null; // kiválasztott termékkör (pl. 'Tejtermék') vagy gyártói márka (pl. 'PÖTTYÖS')

// Chart.js példányok (újrarajzolás előtt el kell pusztítani őket)
let productChartInstance = null;
let analyticsChartInstance = null;

// DOM Elemek
const viewTabs = document.getElementById('main-tabs');
const tabBtnProducts = document.getElementById('tab-btn-products');
const tabBtnAnalytics = document.getElementById('tab-btn-analytics');
const viewProducts = document.getElementById('view-products');
const viewAnalytics = document.getElementById('view-analytics');

const productsContainer = document.getElementById('products-container');
const emptyState = document.getElementById('empty-state');
const resultsCountEl = document.getElementById('results-count');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search');
const storeFilterGroup = document.getElementById('store-filter');
const sourceSelect = document.getElementById('source-select');
const categorySelect = document.getElementById('category-select');
const sortSelect = document.getElementById('sort-select');
const watchlistToggleBtn = document.getElementById('watchlist-toggle-btn');
const watchlistCountEl = document.getElementById('watchlist-count');
const statusTextEl = document.getElementById('status-text');
const resetFiltersBtn = document.getElementById('reset-filters-btn');
const viewGridBtn = document.getElementById('view-grid-btn');
const viewTableBtn = document.getElementById('view-table-btn');

// Modal Elemek
const historyModal = document.getElementById('history-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalProductName = document.getElementById('modal-product-name');
const modalCategory = document.getElementById('modal-category');
const modalSummary = document.getElementById('modal-summary');
const modalHistoryList = document.getElementById('modal-history-list');

// Összehasonlító Nézet Elemek
const compModeTabs = document.getElementById('comp-mode-tabs');
const kpiWinnerText = document.getElementById('kpi-winner-text');
const kpiWinnerSub = document.getElementById('kpi-winner-sub');
const kpiMatchedCount = document.getElementById('kpi-matched-count');
const kpiMatchedSub = document.getElementById('kpi-matched-sub');
const kpiSelectorCount = document.getElementById('kpi-selector-count');
const kpiSelectorLabel = document.getElementById('kpi-selector-label');
const kpiSelectorSub = document.getElementById('kpi-selector-sub');
const compSelectorTitle = document.getElementById('comp-selector-title');
const compSelectorHint = document.getElementById('comp-selector-hint');
const compPillsContainer = document.getElementById('comp-pills-container');
const matchedSectionTag = document.getElementById('matched-section-tag');
const matchedHeaderTitle = document.getElementById('matched-header-title');
const matchedWinnerBadge = document.getElementById('matched-winner-badge');
const matchedProductsGrid = document.getElementById('matched-products-grid');
const compChartTitle = document.getElementById('comp-chart-title');
const compChartSubtitle = document.getElementById('comp-chart-subtitle');

// Inicializálás
async function init() {
  updateWatchlistBadge();
  setupEventListeners();
  await fetchOffers();
}

// Adatok lekérése a Supabase-ből lapozással és tisztítással
async function fetchOffers() {
  try {
    statusTextEl.textContent = 'Adatok betöltése...';

    let loadedOffers = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('offers')
        .select(`
          id,
          store_id,
          raw_name,
          brand,
          package,
          price,
          original_price,
          unit_price,
          valid_from,
          valid_to,
          source,
          products (
            id,
            name,
            category,
            base_unit,
            product_group
          )
        `)
        .order('valid_from', { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) throw error;

      if (data && data.length > 0) {
        loadedOffers.push(...data);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          from += pageSize;
        }
      } else {
        hasMore = false;
      }
    }

    // Tisztítás: kiszűrjük az esetleges hibás százalékos feliratokat vagy név nélküli tételeket
    allOffers = loadedOffers.filter(o => {
      const name = (o.raw_name || '').trim();
      if (!name || name.startsWith('-') || /^\d+\s*%$/.test(name)) return false;
      // Kell benne lennie legalább 2 betűnek
      return /[a-zA-ZáéíóöőúüűÁÉÍÓÖŐÚÜŰ]{2,}/.test(name);
    });

    statusTextEl.textContent = `${allOffers.length.toLocaleString('hu-HU')} ajánlat aktív`;

    // Kategóriák és termékcsoportok összegyűjtése
    categories.clear();
    productGroupsMap.clear();

    allOffers.forEach(o => {
      const cat = o.products?.category;
      if (cat) categories.add(cat);

      const group = o.products?.product_group || 'Egyéb termékek';
      if (!productGroupsMap.has(group)) {
        productGroupsMap.set(group, {
          name: group,
          offers: [],
          lidlOffers: [],
          aldiOffers: [],
          lidlUnitPrices: [],
          aldiUnitPrices: []
        });
      }

      const gData = productGroupsMap.get(group);
      gData.offers.push(o);

      if (o.store_id === 'lidl') {
        gData.lidlOffers.push(o);
        if (o.unit_price && o.unit_price > 0) gData.lidlUnitPrices.push(o.unit_price);
      } else if (o.store_id === 'aldi') {
        gData.aldiOffers.push(o);
        if (o.unit_price && o.unit_price > 0) gData.aldiUnitPrices.push(o.unit_price);
      }
    });

    // Márkák betöltése a brands táblából
    try {
      const { data: bData } = await supabase
        .from('brands')
        .select('brand, owner_store, kind, pair_group');
      if (bData && bData.length > 0) {
        allBrands.clear();
        bData.forEach(b => {
          if (b.brand) allBrands.set(b.brand.trim().toUpperCase(), b);
        });
      }
    } catch (bErr) {
      console.warn('Márkák betöltése sikertelen:', bErr);
    }

    populateCategories();
    render();
    renderComparisonView();
  } catch (err) {
    console.error('Hiba az adatok lekérésekor:', err);
    statusTextEl.textContent = 'Hiba a betöltéskor!';
  }
}

// Kategória legördülő feltöltése
function populateCategories() {
  const sorted = Array.from(categories).sort();
  categorySelect.innerHTML = '<option value="all">Minden kategória</option>';
  sorted.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
    categorySelect.appendChild(opt);
  });
}

// Eseménykezelők beállítása
function setupEventListeners() {
  // Fő fülváltó navigáció
  viewTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    switchTab(tab);
  });

  // Összehasonlítási mód váltás (Sajátmárka-párharc vs Közös gyártói márkák)
  if (compModeTabs) {
    compModeTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.comp-mode-btn');
      if (!btn) return;
      const mode = btn.dataset.mode;
      if (mode === compMode) return;
      compMode = mode;
      selectedCompKey = null;
      document.querySelectorAll('.comp-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === compMode);
      });
      renderComparisonView();
    });
  }

  // Összehasonlító pill gombok kattintása
  if (compPillsContainer) {
    compPillsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.group-pill-btn');
      if (!btn) return;
      selectedCompKey = btn.dataset.key;
      renderComparisonView();
    });
  }

  // Keresőmező
  searchInput.addEventListener('input', (e) => {
    currentSearch = e.target.value.trim().toLowerCase();
    clearSearchBtn.style.display = currentSearch ? 'block' : 'none';
    render();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    currentSearch = '';
    clearSearchBtn.style.display = 'none';
    render();
  });

  // Bolt szűrő (segmented control)
  storeFilterGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    storeFilterGroup.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentStore = btn.dataset.store;
    render();
  });

  // Forrás szűrő (újság vs bolt)
  sourceSelect.addEventListener('change', (e) => {
    currentSource = e.target.value;
    render();
  });

  // Kategória szűrő
  categorySelect.addEventListener('change', (e) => {
    currentCategory = e.target.value;
    render();
  });

  // Rendezés
  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    render();
  });

  // Figyelőlista szűrő gomb
  watchlistToggleBtn.addEventListener('click', () => {
    showOnlyWatchlist = !showOnlyWatchlist;
    watchlistToggleBtn.classList.toggle('active', showOnlyWatchlist);
    render();
  });

  // Nézetváltók (kártya / táblázat)
  viewGridBtn.addEventListener('click', () => {
    currentView = 'grid';
    viewGridBtn.classList.add('active');
    viewTableBtn.classList.remove('active');
    render();
  });

  viewTableBtn.addEventListener('click', () => {
    currentView = 'table';
    viewTableBtn.classList.add('active');
    viewGridBtn.classList.remove('active');
    render();
  });

  // Szűrők visszaállítása gomb
  resetFiltersBtn.addEventListener('click', resetFilters);

  // Terméklista eseménydelegálás (kedvenc csillag és ártörténet modal)
  productsContainer.addEventListener('click', (e) => {
    const starBtn = e.target.closest('.star-btn');
    if (starBtn) {
      const prodName = starBtn.dataset.product;
      toggleWatchlist(prodName);
      return;
    }

    const histBtn = e.target.closest('.history-btn');
    if (histBtn) {
      const prodName = histBtn.dataset.product;
      openHistoryModal(prodName);
    }
  });

  // Modal bezárás
  modalCloseBtn.addEventListener('click', closeModal);
  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyModal.style.display === 'flex') {
      closeModal();
    }
  });
}

// Fülváltás
function switchTab(tab) {
  currentTab = tab;
  tabBtnProducts.classList.toggle('active', tab === 'products');
  tabBtnAnalytics.classList.toggle('active', tab === 'analytics');

  if (tab === 'products') {
    viewProducts.style.display = 'block';
    viewAnalytics.style.display = 'none';
  } else {
    viewProducts.style.display = 'none';
    viewAnalytics.style.display = 'block';
    renderComparisonView();
  }
}

// Szűrők alaphelyzetbe állítása
function resetFilters() {
  searchInput.value = '';
  currentSearch = '';
  clearSearchBtn.style.display = 'none';
  currentStore = 'all';
  currentSource = 'all';
  currentCategory = 'all';
  currentSort = 'name-asc';
  showOnlyWatchlist = false;

  storeFilterGroup.querySelectorAll('.seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.store === 'all');
  });
  sourceSelect.value = 'all';
  categorySelect.value = 'all';
  sortSelect.value = 'name-asc';
  watchlistToggleBtn.classList.remove('active');

  render();
}

// Kedvencek (Watchlist) kezelése
function toggleWatchlist(productName) {
  if (watchlist.has(productName)) {
    watchlist.delete(productName);
  } else {
    watchlist.add(productName);
  }
  localStorage.setItem('arfigyelo_watchlist', JSON.stringify(Array.from(watchlist)));
  updateWatchlistBadge();
  render();
}

function updateWatchlistBadge() {
  watchlistCountEl.textContent = watchlist.size;
}

// ==========================================================================
// 1. TERMÉKKATALÓGUS MEGJELENÍTÉS & SZŰRÉS
// ==========================================================================
function render() {
  let filtered = allOffers.filter(o => {
    // Bolt szűrés
    if (currentStore !== 'all' && o.store_id !== currentStore) return false;

    // Forrás szűrés
    if (currentSource !== 'all' && o.source !== currentSource) return false;

    // Kategória szűrés
    if (currentCategory !== 'all' && o.products?.category !== currentCategory) return false;

    // Keresőszó szűrés
    if (currentSearch) {
      const pName = (o.products?.name || '').toLowerCase();
      const rawName = (o.raw_name || '').toLowerCase();
      const groupName = (o.products?.product_group || '').toLowerCase();
      if (!pName.includes(currentSearch) && !rawName.includes(currentSearch) && !groupName.includes(currentSearch)) {
        return false;
      }
    }

    // Csak figyelőlista
    if (showOnlyWatchlist) {
      const pName = o.products?.name || o.raw_name;
      if (!watchlist.has(pName)) return false;
    }

    return true;
  });

  // Rendezés
  filtered.sort((a, b) => {
    switch (currentSort) {
      case 'price-asc':
        return a.price - b.price;
      case 'discount-desc': {
        const discA = a.original_price ? ((a.original_price - a.price) / a.original_price) : 0;
        const discB = b.original_price ? ((b.original_price - b.price) / b.original_price) : 0;
        return discB - discA;
      }
      case 'unit-asc':
        return (a.unit_price || 999999) - (b.unit_price || 999999);
      case 'date-desc':
        return (b.valid_from || '').localeCompare(a.valid_from || '');
      case 'name-asc':
      default:
        return (a.products?.name || a.raw_name).localeCompare(b.products?.name || b.raw_name, 'hu');
    }
  });

  resultsCountEl.textContent = `${filtered.length.toLocaleString('hu-HU')} ajánlat található`;

  if (filtered.length === 0) {
    productsContainer.style.display = 'none';
    emptyState.style.display = 'block';
  } else {
    productsContainer.style.display = currentView === 'grid' ? 'grid' : 'block';
    emptyState.style.display = 'none';

    if (currentView === 'grid') {
      renderCards(filtered);
    } else {
      renderTable(filtered);
    }
  }
}

// Márka és tiszta terméknév szétválasztása
function getBrandAndName(offer) {
  let brand = (offer.brand || '').trim();
  let name = (offer.raw_name || '').trim();

  // Ha nincs külön rögzített márka, felismerjük a név elején lévő ismert márkaneveket vagy nagybetűs szavakat
  if (!brand && name) {
    const multiBrandMatch = name.match(/^(CHEF SELECT|SELECT & GO|BORDS EVE|LE GUSTO|SWEET VALLEY|SNACK FUN|RIO D'ORO|HAPPY HARVEST|BELLASAN|CUCINA NOBILE|OCEAN SEA|FREE FROM|JUST VEG!|FINEST BAKERY)\b/i);
    if (multiBrandMatch) {
      brand = multiBrandMatch[1].toUpperCase();
    } else {
      const singleWordMatch = name.match(/^([A-ZÁÉÍÓÖŐÚÜŰ]{2,})\b/);
      if (singleWordMatch && !['UHT', 'ESL', 'BIO', 'XL', 'XXL', 'LIGHT', 'MIN', 'MAX', 'CSAK', 'MAGYAR', 'FRISS'].includes(singleWordMatch[1])) {
        brand = singleWordMatch[1];
      }
    }
  }

  // Eltávolítjuk a márka előtagot a névből, hogy ne ismétlődjön kétszer
  let cleanName = name;
  if (brand && cleanName.toUpperCase().startsWith(brand.toUpperCase())) {
    cleanName = cleanName.slice(brand.length).trim();
    cleanName = cleanName.replace(/^[-:,\s]+/, '').trim();
  }

  if (!cleanName) {
    cleanName = offer.products?.name || name;
  }

  return {
    brand: brand ? brand.toUpperCase() : null,
    name: cleanName
  };
}

// Kártyás nézet renderelése
function renderCards(items) {
  productsContainer.className = 'products-grid';
  productsContainer.innerHTML = items.map(o => {
    const { brand, name: displayName } = getBrandAndName(o);
    const pName = o.products?.name || o.raw_name;
    const isStarred = watchlist.has(pName);
    const storeClass = o.store_id === 'lidl' ? 'lidl' : 'aldi';
    const storeCardClass = o.store_id === 'lidl' ? 'lidl-card' : 'aldi-card';

    // Kedvezmény számítása
    let discountBadge = '';
    if (o.original_price && o.original_price > o.price) {
      const pct = Math.round(((o.original_price - o.price) / o.original_price) * 100);
      if (pct > 0) discountBadge = `<span class="discount-badge">-${pct}%</span>`;
    }

    // Forrás badge
    const sourceBadge = o.source === 'regular'
      ? `<span class="tag-pill regular" title="Normál bolti alapár">🏪 Bolti ár</span>`
      : `<span class="tag-pill flyer" title="Heti akciós újság ajánlat">📰 Újság</span>`;

    // Egységár
    let unitPriceHtml = '';
    if (o.unit_price && o.products?.base_unit) {
      unitPriceHtml = `<span class="unit-price">${Math.round(o.unit_price).toLocaleString('hu-HU')} Ft/${o.products.base_unit}</span>`;
    }

    const groupTag = o.products?.product_group
      ? `<span class="product-group-tag">${escapeHtml(o.products.product_group)}</span>`
      : '';

    return `
      <div class="product-card ${storeCardClass}">
        <div class="card-top">
          <div class="card-badges">
            <span class="store-badge ${storeClass}">${o.store_id.toUpperCase()}</span>
            ${sourceBadge}
            ${discountBadge}
          </div>
          <button class="star-btn ${isStarred ? 'starred' : ''}" data-product="${escapeHtml(pName)}" title="Figyelőlistához adás">
            ${isStarred ? '★' : '☆'}
          </button>
        </div>

        <div class="card-body">
          ${brand ? `<div class="product-brand">${escapeHtml(brand)}</div>` : ''}
          <h3 class="product-title" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</h3>
          <div class="product-meta">
            ${groupTag}
            ${o.package ? `<span>${escapeHtml(o.package)}</span>` : ''}
          </div>
          <div class="price-container">
            <div>
              <span class="current-price">${Math.round(o.price).toLocaleString('hu-HU')} Ft</span>
              ${o.original_price ? `<span class="original-price">${Math.round(o.original_price).toLocaleString('hu-HU')} Ft</span>` : ''}
            </div>
            ${unitPriceHtml}
          </div>
        </div>

        <div class="card-footer">
          <span>${formatDate(o.valid_from)}${o.valid_to ? ' - ' + formatDate(o.valid_to) : ''}</span>
          <button class="history-btn" data-product="${escapeHtml(pName)}">Ártörténet</button>
        </div>
      </div>
    `;
  }).join('');
}

// Táblázatos nézet renderelése
function renderTable(items) {
  productsContainer.className = 'table-responsive';
  productsContainer.innerHTML = `
    <table class="products-table">
      <thead>
        <tr>
          <th style="width: 40px;"></th>
          <th>Bolt</th>
          <th>Forrás</th>
          <th>Terméknév</th>
          <th>Csoport</th>
          <th>Kiszerelés</th>
          <th>Ár</th>
          <th>Eredeti ár</th>
          <th>Egységár</th>
          <th>Érvényesség</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items.map(o => {
          const { brand, name: displayName } = getBrandAndName(o);
          const pName = o.products?.name || o.raw_name;
          const isStarred = watchlist.has(pName);
          const unitText = o.unit_price && o.products?.base_unit 
            ? `${Math.round(o.unit_price).toLocaleString('hu-HU')} Ft/${o.products.base_unit}` 
            : '-';
          const srcText = o.source === 'regular' ? '🏪 Bolti' : '📰 Újság';
          return `
            <tr>
              <td>
                <button class="star-btn ${isStarred ? 'starred' : ''}" data-product="${escapeHtml(pName)}">
                  ${isStarred ? '★' : '☆'}
                </button>
              </td>
              <td><span class="store-badge ${o.store_id}">${o.store_id.toUpperCase()}</span></td>
              <td><span class="tag-pill ${o.source === 'regular' ? 'regular' : 'flyer'}">${srcText}</span></td>
              <td>
                ${brand ? `<div class="table-brand">${escapeHtml(brand)}</div>` : ''}
                <strong>${escapeHtml(displayName)}</strong>
              </td>
              <td>${escapeHtml(o.products?.product_group || '-')}</td>
              <td>${escapeHtml(o.package || '-')}</td>
              <td><strong style="color: #fff; font-family: var(--font-mono);">${Math.round(o.price).toLocaleString('hu-HU')} Ft</strong></td>
              <td style="color: var(--text-dim); text-decoration: line-through;">
                ${o.original_price ? `${Math.round(o.original_price).toLocaleString('hu-HU')} Ft` : '-'}
              </td>
              <td style="font-family: var(--font-mono); color: var(--emerald-400);">${unitText}</td>
              <td>${formatDate(o.valid_from)}</td>
              <td><button class="history-btn" data-product="${escapeHtml(pName)}">Történet</button></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ==========================================================================
// 2. MÁRKA- ÉS SAJÁTMÁRKA-ÖSSZEHASONLÍTÓ MOTOR (1-AZ-1-BEN PÁROSÍTÁS)
// ==========================================================================

const KEY_NOUNS = [
  'trappista', 'gouda', 'ementáli', 'edami', 'edamer', 'mozzarella', 'camembert', 'brie', 'mascarpone',
  'ricotta', 'teavaj', 'vaj', 'tejföl', 'túró', 'túródesszert', 'krémtúró', 'joghurt', 'kefir', 'tej',
  'habtejszín', 'főzőtejszín', 'szendvicskrém', 'sajtkrém', 'lapkasajt', 'krémfehér',
  'virsli', 'párizsi', 'szalámi', 'sonka', 'bacon', 'kolbász', 'darált', 'csirkemell', 'csirkecomb',
  'sertéskaraj', 'sertéstarja', 'májkrém', 'májas', 'tepertő', 'pulykamell', 'frankfurti', 'bécsi',
  'kenyér', 'zsemle', 'kifli', 'bagett', 'toast', 'liszt', 'cukor', 'rizs', 'tészta', 'olaj', 'étolaj',
  'napraforgó', 'ecet', 'só', 'ketchup', 'majonéz', 'mustár', 'csokoládé', 'gumicukor', 'keksz', 'nápolyi',
  'mogyorókrém', 'chips', 'ropi', 'mogyoró', 'mandula', 'pörkölt', 'kesudió', 'mosószer', 'öblítő', 'mosogatószer',
  'mosogatótabletta', 'toalettpapír', 'papírtörlő', 'tisztítószer', 'folttisztító', 'fúró', 'csavarhúzó',
  'csiszoló', 'fűrész', 'akkumulátor', 'töltő', 'lámpa', 'serpenyő', 'lábas', 'kés', 'porszívó',
  'vasaló', 'vízforraló', 'kenyérpirító', 'póló', 'nadrág', 'zokni', 'boxeralsó', 'pulóver', 'pizsama', 'sör', 'hasábburgonya'
];

function cleanTokens(text) {
  if (!text) return new Set();
  const normalized = text
    .toLowerCase()
    .replace(/[^a-záéíóöőúüű0-9]+/g, ' ');
  const stopWords = new Set([
    'és', 'vagy', 'db', 'g', 'kg', 'ml', 'l', 'ft', 'lidl', 'aldi', 'akció', 'szuper', 'extra', 
    'min', 'max', 'csomag', 'darab', 'szeletelt', 'többféle', 'válogatás', 'vegyes', 'classic', 'eredeti',
    'friss', 'klasszikus', 'mini', 'prémium', 'válogatott', 'készülék', 'termék', 'darabos'
  ]);
  return new Set(normalized.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)));
}

function scorePair(lName, aName, isSingleItem = false) {
  const ltok = cleanTokens(lName);
  const atok = cleanTokens(aName);
  if (isSingleItem && ltok.size > 0 && atok.size > 0) {
    return 5 + [...ltok].filter(t => atok.has(t)).length;
  }
  
  // Ellenőrizzük a kiemelt kulcs-főneveket
  const commonNouns = KEY_NOUNS.filter(n => ltok.has(n) && atok.has(n));
  if (commonNouns.length > 0) {
    const overlap = [...ltok].filter(t => atok.has(t)).length;
    return 10 + commonNouns.length * 5 + overlap;
  }
  
  const overlap = [...ltok].filter(t => atok.has(t)).length;
  return overlap >= 1 ? overlap : 0;
}

function derivePairTitle(lOffer, aOffer) {
  const ltok = cleanTokens(lOffer.raw_name);
  const atok = cleanTokens(aOffer.raw_name);
  const commonNouns = KEY_NOUNS.filter(n => ltok.has(n) && atok.has(n));
  if (commonNouns.length > 0) {
    const main = commonNouns[0];
    return main.charAt(0).toUpperCase() + main.slice(1);
  }
  const overlap = [...ltok].filter(t => atok.has(t));
  if (overlap.length > 0) {
    return overlap.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  const lClean = getBrandAndName(lOffer).cleanName;
  return lClean.length > 28 ? lClean.slice(0, 28) + '...' : lClean;
}

function renderComparisonView() {
  if (!viewAnalytics || viewAnalytics.style.display === 'none') return;

  if (compMode === 'private') {
    renderPrivateLabelComparison();
  } else {
    renderNationalBrandComparison();
  }
}

// 1. Sajátmárka-párharc megjelenítése
function renderPrivateLabelComparison() {
  compSelectorTitle.textContent = 'Válassz termékkört a sajátmárkák összehasonlításához:';
  compSelectorHint.textContent = 'Lidl és Aldi sajátmárkás termékek (pl. Pilos vs. Milsani, Parkside vs. Ferrex) közvetlen párjai';
  matchedSectionTag.textContent = 'Sajátmárka Párharc';
  compChartTitle.textContent = 'Sajátmárkás Termékek Egységára (Ft/egység)';
  compChartSubtitle.textContent = 'Lidl vs. Aldi sajátmárkás termékek közvetlen ár-összehasonlítása';

  // Csoportosítás pair_group szerint
  const groupsMap = new Map();
  allOffers.forEach(o => {
    const bName = (o.brand || '').trim().toUpperCase();
    const bInfo = allBrands.get(bName);
    if (!bInfo || bInfo.owner_store !== o.store_id) return;
    const grp = bInfo.pair_group;
    if (!grp || grp === 'Egyéb') return;

    if (!groupsMap.has(grp)) {
      groupsMap.set(grp, { name: grp, lidl: [], aldi: [] });
    }
    const g = groupsMap.get(grp);
    if (o.store_id === 'lidl') g.lidl.push(o);
    else if (o.store_id === 'aldi') g.aldi.push(o);
  });

  // Csak azok a csoportok, ahol mindkét boltban van sajátmárkás ajánlat
  const availableGroups = Array.from(groupsMap.values())
    .filter(g => g.lidl.length > 0 && g.aldi.length > 0)
    .sort((a, b) => (b.lidl.length + b.aldi.length) - (a.lidl.length + a.aldi.length));

  kpiSelectorCount.textContent = `${availableGroups.length} termékkör`;
  kpiSelectorLabel.textContent = 'Elérhető Termékkörök';
  kpiSelectorSub.textContent = 'Kattints alább a vizsgálathoz';

  if (availableGroups.length === 0) {
    compPillsContainer.innerHTML = '<span style="color:var(--text-muted);">Nincs összehasonlítható sajátmárkás termékkör az adatbázisban.</span>';
    matchedProductsGrid.innerHTML = '';
    return;
  }

  if (!selectedCompKey || !availableGroups.some(g => g.name === selectedCompKey)) {
    const defaultGroup = availableGroups.find(g => g.name === 'Tejtermék') || availableGroups[0];
    selectedCompKey = defaultGroup.name;
  }

  // Pill gombok generálása
  compPillsContainer.innerHTML = availableGroups.map(g => {
    const isActive = g.name === selectedCompKey;
    return `
      <button class="group-pill-btn ${isActive ? 'active' : ''}" data-key="${escapeHtml(g.name)}">
        <span>${escapeHtml(g.name)}</span>
        <span class="group-pill-count">${g.lidl.length + g.aldi.length}</span>
      </button>
    `;
  }).join('');

  // Aktuális csoport párosítása
  const activeGroup = groupsMap.get(selectedCompKey);
  matchedHeaderTitle.textContent = `${selectedCompKey} – Sajátmárka Összehasonlítás`;

  const pairs = matchOffers(activeGroup.lidl, activeGroup.aldi, selectedCompKey, false);
  renderMatchedResults(pairs, selectedCompKey);
}

// 2. Közös gyártói márkák összehasonlítása
function renderNationalBrandComparison() {
  compSelectorTitle.textContent = 'Válassz közös gyártói márkát:';
  compSelectorHint.textContent = 'Mindkét boltban kapható márkák azonos termékeinek összehasonlítása (pl. Pick, Pöttyös, Danone)';
  matchedSectionTag.textContent = 'Közös Gyártói Márka';
  compChartTitle.textContent = 'Gyártói Márkás Termékek Árai (Ft)';
  compChartSubtitle.textContent = 'Azonos gyártói termékek árai a Lidl és Aldi kínálatában';

  // Gyártói márkák kigyűjtése
  const brandsMap = new Map();
  allOffers.forEach(o => {
    const bName = (o.brand || '').trim().toUpperCase();
    if (!bName) return;
    const bInfo = allBrands.get(bName);
    // Gyártói márka ha nincs rögzített owner_store
    if (bInfo && bInfo.owner_store) return;

    if (!brandsMap.has(bName)) {
      brandsMap.set(bName, { name: bName, lidl: [], aldi: [] });
    }
    const b = brandsMap.get(bName);
    if (o.store_id === 'lidl') b.lidl.push(o);
    else if (o.store_id === 'aldi') b.aldi.push(o);
  });

  const availableBrands = Array.from(brandsMap.values())
    .filter(b => b.lidl.length > 0 && b.aldi.length > 0)
    .sort((a, b) => (b.lidl.length + b.aldi.length) - (a.lidl.length + a.aldi.length));

  kpiSelectorCount.textContent = `${availableBrands.length} gyártói márka`;
  kpiSelectorLabel.textContent = 'Közös Márkák';
  kpiSelectorSub.textContent = 'Mindkét boltban elérhető';

  if (availableBrands.length === 0) {
    compPillsContainer.innerHTML = '<span style="color:var(--text-muted);">Nincs közös gyártói márka az adatbázisban.</span>';
    matchedProductsGrid.innerHTML = '';
    return;
  }

  if (!selectedCompKey || !availableBrands.some(b => b.name === selectedCompKey)) {
    const defaultBrand = availableBrands.find(b => b.name === 'PÖTTYÖS') || availableBrands[0];
    selectedCompKey = defaultBrand.name;
  }

  // Pill gombok
  compPillsContainer.innerHTML = availableBrands.map(b => {
    const isActive = b.name === selectedCompKey;
    return `
      <button class="group-pill-btn ${isActive ? 'active' : ''}" data-key="${escapeHtml(b.name)}">
        <span>${escapeHtml(b.name)}</span>
        <span class="group-pill-count">${b.lidl.length + b.aldi.length}</span>
      </button>
    `;
  }).join('');

  const activeBrand = brandsMap.get(selectedCompKey);
  matchedHeaderTitle.textContent = `${selectedCompKey} Termékek a Két Boltban`;

  const isSingle = activeBrand.lidl.length === 1 && activeBrand.aldi.length === 1;
  const pairs = matchOffers(activeBrand.lidl, activeBrand.aldi, selectedCompKey, isSingle);
  renderMatchedResults(pairs, selectedCompKey);
}

// Közös párosító motor
function matchOffers(lidlList, aldiList, categoryName, isSingleBrand) {
  const pairs = [];
  const usedAldi = new Set();

  lidlList.forEach(l => {
    let bestA = null;
    let bestScore = 0;

    aldiList.forEach(a => {
      if (usedAldi.has(a.id)) return;
      const s = scorePair(l.raw_name, a.raw_name, isSingleBrand);
      if (s > bestScore) {
        bestScore = s;
        bestA = a;
      }
    });

    if (bestA && bestScore >= 1) {
      usedAldi.add(bestA.id);

      // Összehasonlítási alap: ha mindkettőnek van egységára, azt használjuk, különben a csomagárat
      const useUnitPrice = (l.unit_price && l.unit_price > 0 && bestA.unit_price && bestA.unit_price > 0);
      const lVal = useUnitPrice ? l.unit_price : l.price;
      const aVal = useUnitPrice ? bestA.unit_price : bestA.price;
      const compType = useUnitPrice ? 'Egységár alapján' : 'Csomagár alapján';

      const diff = Math.abs(lVal - aVal);
      const higher = Math.max(lVal, aVal);
      const diffPct = higher > 0 ? Math.round((diff / higher) * 100) : 0;

      let winner = 'tie';
      if (diffPct >= 1) {
        winner = lVal < aVal ? 'lidl' : 'aldi';
      }

      pairs.push({
        title: derivePairTitle(l, bestA),
        category: categoryName,
        lidl: l,
        aldi: bestA,
        lidlVal: lVal,
        aldiVal: aVal,
        compType: compType,
        diffPct: diffPct,
        winner: winner
      });
    }
  });

  return pairs;
}

// Párosított kártyák és KPI-ok renderelése
function renderMatchedResults(pairs, compTitle) {
  kpiMatchedCount.textContent = `${pairs.length} termékpár`;
  kpiMatchedSub.textContent = pairs.length > 0 ? 'Közvetlenül megfeleltetve' : 'Nincs pontos pár';

  let lidlWins = 0;
  let aldiWins = 0;
  let ties = 0;

  pairs.forEach(p => {
    if (p.winner === 'lidl') lidlWins++;
    else if (p.winner === 'aldi') aldiWins++;
    else ties++;
  });

  // KPI Győztes Kártya
  if (pairs.length === 0) {
    kpiWinnerText.textContent = 'Nincs egyezés';
    kpiWinnerText.style.color = 'var(--text-muted)';
    kpiWinnerSub.textContent = 'A heti kínálatban nem találtunk közvetlen párt';
    matchedWinnerBadge.textContent = 'Nincs összehasonlítható termékpár';
  } else if (aldiWins > lidlWins) {
    kpiWinnerText.textContent = `Aldi vezet (${aldiWins} párban)`;
    kpiWinnerText.style.color = 'var(--aldi-accent)';
    kpiWinnerSub.textContent = `Lidl: ${lidlWins} | Aldi: ${aldiWins}${ties > 0 ? ' | Azonos: ' + ties : ''}`;
    matchedWinnerBadge.textContent = `🏆 Aldi olcsóbb (${aldiWins} / ${pairs.length} termékpár)`;
    matchedWinnerBadge.style.color = 'var(--aldi-accent)';
    matchedWinnerBadge.style.background = 'rgba(56, 189, 248, 0.15)';
    matchedWinnerBadge.style.borderColor = 'rgba(56, 189, 248, 0.35)';
  } else if (lidlWins > aldiWins) {
    kpiWinnerText.textContent = `Lidl vezet (${lidlWins} párban)`;
    kpiWinnerText.style.color = 'var(--lidl-brand-yellow)';
    kpiWinnerSub.textContent = `Lidl: ${lidlWins} | Aldi: ${aldiWins}${ties > 0 ? ' | Azonos: ' + ties : ''}`;
    matchedWinnerBadge.textContent = `🏆 Lidl olcsóbb (${lidlWins} / ${pairs.length} termékpár)`;
    matchedWinnerBadge.style.color = 'var(--lidl-brand-yellow)';
    matchedWinnerBadge.style.background = 'rgba(250, 204, 21, 0.15)';
    matchedWinnerBadge.style.borderColor = 'rgba(250, 204, 21, 0.35)';
  } else {
    kpiWinnerText.textContent = 'Döntetlen verseny';
    kpiWinnerText.style.color = 'var(--emerald-400)';
    kpiWinnerSub.textContent = `Lidl: ${lidlWins} | Aldi: ${aldiWins}${ties > 0 ? ' | Azonos: ' + ties : ''}`;
    matchedWinnerBadge.textContent = `⚖️ Kiegyenlített árak (${lidlWins} - ${aldiWins})`;
    matchedWinnerBadge.style.color = 'var(--emerald-400)';
    matchedWinnerBadge.style.background = 'rgba(16, 185, 129, 0.15)';
    matchedWinnerBadge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
  }

  // Kártyák megjelenítése
  if (pairs.length === 0) {
    matchedProductsGrid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1px dashed var(--border-subtle);">
        <p style="font-size: 1.1rem; font-weight: 700; color: #fff; margin-bottom: 0.5rem;">Nincs közvetlen termékpár a jelenlegi akciós kínálatban</p>
        <p style="font-size: 0.85rem;">Ebben a kategóriában a heti kínálat nem tartalmaz egymásnak pontosan megfeleltethető termékeket. Válassz másik kategóriát vagy gyártói márkát fentről!</p>
      </div>
    `;
  } else {
    matchedProductsGrid.innerHTML = pairs.map(p => {
      const l = p.lidl;
      const a = p.aldi;
      const winClass = p.winner === 'lidl' ? 'win-lidl' : p.winner === 'aldi' ? 'win-aldi' : 'win-tie';
      const winText = p.winner === 'lidl'
        ? `<span>🏆 Lidl ${p.diffPct}%-kal olcsóbb</span>`
        : p.winner === 'aldi'
        ? `<span>🏆 Aldi ${p.diffPct}%-kal olcsóbb</span>`
        : `<span>⚖️ Megegyező ár</span>`;

      return `
        <div class="matched-card">
          <div class="matched-card-header">
            <div class="matched-product-title">${escapeHtml(p.title)}</div>
            <span class="matched-category-tag">${escapeHtml(p.category)}</span>
          </div>
          <div class="matched-split">
            <div class="matched-store-col lidl">
              <div class="matched-col-top">
                <span class="store-badge lidl">LIDL</span>
                <span class="matched-brand-tag">${escapeHtml(l.brand || 'Lidl')}</span>
              </div>
              <div class="matched-item-name" title="${escapeHtml(l.raw_name)}">${escapeHtml(l.raw_name)}</div>
              <div class="matched-prices">
                <div class="matched-price-main">${Math.round(l.price).toLocaleString('hu-HU')} Ft</div>
                ${l.unit_price ? `<div class="matched-unit-price">${Math.round(l.unit_price).toLocaleString('hu-HU')} Ft/egység</div>` : ''}
              </div>
            </div>

            <div class="matched-store-col aldi">
              <div class="matched-col-top">
                <span class="store-badge aldi">ALDI</span>
                <span class="matched-brand-tag">${escapeHtml(a.brand || 'Aldi')}</span>
              </div>
              <div class="matched-item-name" title="${escapeHtml(a.raw_name)}">${escapeHtml(a.raw_name)}</div>
              <div class="matched-prices">
                <div class="matched-price-main">${Math.round(a.price).toLocaleString('hu-HU')} Ft</div>
                ${a.unit_price ? `<div class="matched-unit-price">${Math.round(a.unit_price).toLocaleString('hu-HU')} Ft/egység</div>` : ''}
              </div>
            </div>
          </div>
          <div class="matched-diff-banner ${winClass}">
            ${winText}
            <span style="font-family: var(--font-mono); font-size: 0.78rem;">${p.compType}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Chart kirajzolása
  renderComparisonChart(pairs);
}

function renderComparisonChart(pairs) {
  const chartCanvas = document.getElementById('analytics-chart');
  if (!chartCanvas) return;

  if (analyticsChartInstance) {
    analyticsChartInstance.destroy();
    analyticsChartInstance = null;
  }

  if (pairs.length === 0) return;

  // Maximum 12 termékpárt jelenítünk meg a diagramon a jó áttekinthetőségért
  const displayPairs = pairs.slice(0, 12);
  const labels = displayPairs.map(p => p.title);
  const lidlData = displayPairs.map(p => Math.round(p.lidlVal));
  const aldiData = displayPairs.map(p => Math.round(p.aldiVal));

  analyticsChartInstance = new Chart(chartCanvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Lidl ár (Ft)',
          data: lidlData,
          backgroundColor: 'rgba(250, 204, 21, 0.85)',
          borderColor: '#facc15',
          borderWidth: 1.5,
          borderRadius: 6
        },
        {
          label: 'Aldi ár (Ft)',
          data: aldiData,
          backgroundColor: 'rgba(56, 189, 248, 0.85)',
          borderColor: '#38bdf8',
          borderWidth: 1.5,
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#fff',
          bodyColor: '#cbd5e1',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw.toLocaleString('hu-HU')} Ft`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 11 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.08)' },
          ticks: {
            color: '#94a3b8',
            font: { family: 'JetBrains Mono', size: 11 },
            callback: (val) => `${val.toLocaleString('hu-HU')} Ft`
          }
        }
      }
    }
  });
}

// ==========================================================================
// 3. TERMÉK ÁRTÖRTÉNET MODAL & CHART.JS GRAFIKON
// ==========================================================================
function openHistoryModal(productName) {
  const matches = allOffers.filter(o => (o.products?.name || o.raw_name) === productName);
  if (matches.length === 0) return;

  const first = matches[0];
  modalProductName.textContent = productName;
  modalCategory.textContent = first.products?.category 
    ? `Kategória: ${first.products.category} (${first.products.product_group || 'Termékcsoport'})` 
    : '';

  // Statisztika számítása
  const prices = matches.map(m => m.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

  modalSummary.innerHTML = `
    <div>
      <div class="summary-stat-val" style="color: var(--emerald-400);">${minPrice.toLocaleString('hu-HU')} Ft</div>
      <div class="summary-stat-label">Legalacsonyabb ár</div>
    </div>
    <div>
      <div class="summary-stat-val">${avgPrice.toLocaleString('hu-HU')} Ft</div>
      <div class="summary-stat-label">Átlagár</div>
    </div>
    <div>
      <div class="summary-stat-val">${matches.length} db</div>
      <div class="summary-stat-label">Rögzített ajánlat</div>
    </div>
  `;

  // Idővonal generálása
  modalHistoryList.innerHTML = matches.map(m => `
    <div class="timeline-item">
      <div class="timeline-left">
        <span class="store-badge ${m.store_id}">${m.store_id.toUpperCase()}</span>
        <div>
          <div><strong>${escapeHtml(m.raw_name)}</strong></div>
          <div class="timeline-date">${formatDate(m.valid_from)}${m.valid_to ? ' - ' + formatDate(m.valid_to) : ''} &bull; ${m.source === 'regular' ? 'Bolti ár' : 'Akciós újság'}</div>
        </div>
      </div>
      <div class="timeline-price">${Math.round(m.price).toLocaleString('hu-HU')} Ft</div>
    </div>
  `).join('');

  // Termékszintű Chart.js Vonaldiagram kirajzolása
  renderProductHistoryChart(matches);

  historyModal.style.display = 'flex';
}

function renderProductHistoryChart(matches) {
  const canvas = document.getElementById('product-chart');
  if (!canvas) return;

  // Dátum szerint növekvő sorrendbe rendezzük
  const sorted = [...matches].sort((a, b) => (a.valid_from || '').localeCompare(b.valid_from || ''));

  const labels = sorted.map(m => formatDate(m.valid_from) || 'Mai');
  const lidlPoints = sorted.map(m => m.store_id === 'lidl' ? m.price : null);
  const aldiPoints = sorted.map(m => m.store_id === 'aldi' ? m.price : null);

  if (productChartInstance) {
    productChartInstance.destroy();
  }

  productChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Lidl ár (Ft)',
          data: lidlPoints,
          borderColor: '#facc15',
          backgroundColor: 'rgba(250, 204, 21, 0.2)',
          pointBackgroundColor: '#facc15',
          pointBorderColor: '#000',
          pointRadius: 6,
          pointHoverRadius: 8,
          borderWidth: 2.5,
          tension: 0.25,
          spanGaps: true
        },
        {
          label: 'Aldi ár (Ft)',
          data: aldiPoints,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.2)',
          pointBackgroundColor: '#38bdf8',
          pointBorderColor: '#000',
          pointRadius: 6,
          pointHoverRadius: 8,
          borderWidth: 2.5,
          tension: 0.25,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#cbd5e1', font: { family: 'Plus Jakarta Sans', weight: '600' } }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#fff',
          bodyColor: '#cbd5e1',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw ? Math.round(ctx.raw).toLocaleString('hu-HU') + ' Ft' : '-'}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 11 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.08)' },
          ticks: {
            color: '#94a3b8',
            font: { family: 'JetBrains Mono', size: 11 },
            callback: (val) => `${val.toLocaleString('hu-HU')} Ft`
          }
        }
      }
    }
  });
}

function closeModal() {
  historyModal.style.display = 'none';
  if (productChartInstance) {
    productChartInstance.destroy();
    productChartInstance = null;
  }
}

// Segédfüggvények
function formatDate(dStr) {
  if (!dStr) return '';
  const parts = dStr.split('-');
  if (parts.length === 3) {
    return `${parts[1]}.${parts[2]}.`;
  }
  return dStr;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Alkalmazás indítása
init();

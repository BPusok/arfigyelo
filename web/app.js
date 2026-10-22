// Árfigyelő Web Alkalmazás – Lidl & Aldi Akció- és Árkövető
import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';

// Supabase konfiguráció
const SUPABASE_URL = 'https://npbdwncxrckvricbtktz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_msZVswp3iu9CwQCtvyJpyA_8Apm3nVm';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Állapot (State)
let allOffers = [];
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
let selectedGroup = null;

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

// Elemzés Nézet Elemek
const kpiWinnerText = document.getElementById('kpi-winner-text');
const kpiWinnerSub = document.getElementById('kpi-winner-sub');
const kpiBiggestDiff = document.getElementById('kpi-biggest-diff');
const kpiDiffSub = document.getElementById('kpi-diff-sub');
const kpiGroupCount = document.getElementById('kpi-group-count');
const kpiItemsCount = document.getElementById('kpi-items-count');
const groupPillsContainer = document.getElementById('group-pills-container');
const selectedGroupTitle = document.getElementById('selected-group-title');
const groupWinnerBadge = document.getElementById('group-winner-badge');
const lidlGroupCount = document.getElementById('lidl-group-count');
const lidlAvgUnitPrice = document.getElementById('lidl-avg-unit-price');
const lidlCheapestName = document.getElementById('lidl-cheapest-name');
const lidlCheapestPrice = document.getElementById('lidl-cheapest-price');
const aldiGroupCount = document.getElementById('aldi-group-count');
const aldiAvgUnitPrice = document.getElementById('aldi-avg-unit-price');
const aldiCheapestName = document.getElementById('aldi-cheapest-name');
const aldiCheapestPrice = document.getElementById('aldi-cheapest-price');

// Inicializálás
async function init() {
  updateWatchlistBadge();
  setupEventListeners();
  await fetchOffers();
}

// Adatok lekérése a Supabase-ből
async function fetchOffers() {
  try {
    statusTextEl.textContent = 'Adatok betöltése...';

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
      .order('valid_from', { ascending: false });

    if (error) throw error;

    allOffers = data || [];
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

    populateCategories();
    render();
    initAnalyticsData();
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
    renderAnalyticsView();
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
// 2. ÁTLAGÁRAK & ELEMZÉS NÉZET
// ==========================================================================
function initAnalyticsData() {
  if (productGroupsMap.size === 0) return;

  // Kiválasztjuk az alapértelmezett csoportot (pl. "Kenyér és pékáru" vagy a legnépesebb)
  const popularGroups = ['Kenyér és pékáru', 'Sajt', 'Virsli', 'Tejtermék és tojás', 'Húskészítmény'];
  for (const p of popularGroups) {
    if (productGroupsMap.has(p)) {
      selectedGroup = p;
      break;
    }
  }
  if (!selectedGroup) {
    selectedGroup = productGroupsMap.keys().next().value;
  }
}

function renderAnalyticsView() {
  if (productGroupsMap.size === 0) return;

  // Csoportok rangsorolása termékszám szerint
  const sortedGroups = Array.from(productGroupsMap.values()).sort((a, b) => b.offers.length - a.offers.length);

  // 1. KPI Számítások
  let lidlWins = 0;
  let aldiWins = 0;
  let totalLidlSum = 0;
  let totalAldiSum = 0;
  let comparedGroupCount = 0;
  let maxDiffPct = 0;
  let maxDiffGroup = '-';

  sortedGroups.forEach(g => {
    if (g.lidlUnitPrices.length > 0 && g.aldiUnitPrices.length > 0) {
      const lidlAvg = g.lidlUnitPrices.reduce((a, b) => a + b, 0) / g.lidlUnitPrices.length;
      const aldiAvg = g.aldiUnitPrices.reduce((a, b) => a + b, 0) / g.aldiUnitPrices.length;

      totalLidlSum += lidlAvg;
      totalAldiSum += aldiAvg;
      comparedGroupCount++;

      const diff = Math.abs(lidlAvg - aldiAvg) / ((lidlAvg + aldiAvg) / 2);
      if (diff > maxDiffPct) {
        maxDiffPct = diff;
        maxDiffGroup = g.name;
      }

      if (lidlAvg < aldiAvg) lidlWins++;
      else if (aldiAvg < lidlAvg) aldiWins++;
    }
  });

  // Heti győztes KPI
  if (comparedGroupCount > 0) {
    const overallDiff = Math.abs(totalLidlSum - totalAldiSum) / ((totalLidlSum + totalAldiSum) / 2) * 100;
    if (totalAldiSum < totalLidlSum) {
      kpiWinnerText.textContent = `Aldi ${overallDiff.toFixed(1)}%-kal olcsóbb`;
      kpiWinnerText.style.color = 'var(--aldi-accent)';
      kpiWinnerSub.textContent = `${aldiWins} kategóriában olcsóbb (Lidl: ${lidlWins})`;
    } else {
      kpiWinnerText.textContent = `Lidl ${overallDiff.toFixed(1)}%-kal olcsóbb`;
      kpiWinnerText.style.color = 'var(--lidl-accent)';
      kpiWinnerSub.textContent = `${lidlWins} kategóriában olcsóbb (Aldi: ${aldiWins})`;
    }
    kpiBiggestDiff.textContent = `${maxDiffGroup} (${Math.round(maxDiffPct * 100)}%)`;
  } else {
    kpiWinnerText.textContent = 'Adatgyűjtés folyamatban';
    kpiBiggestDiff.textContent = '-';
  }

  kpiGroupCount.textContent = `${productGroupsMap.size} csoport`;
  kpiItemsCount.textContent = `${allOffers.length.toLocaleString('hu-HU')} beolvasott tételből`;

  // 2. Csoportválasztó gombok renderelése
  groupPillsContainer.innerHTML = sortedGroups.slice(0, 20).map(g => {
    const isActive = g.name === selectedGroup;
    return `
      <button class="group-pill-btn ${isActive ? 'active' : ''}" data-group="${escapeHtml(g.name)}">
        <span>${escapeHtml(g.name)}</span>
        <span class="group-pill-count">${g.offers.length}</span>
      </button>
    `;
  }).join('');

  // Csoport gomb kattintás kezelése
  groupPillsContainer.onclick = (e) => {
    const btn = e.target.closest('.group-pill-btn');
    if (!btn) return;
    selectedGroup = btn.dataset.group;
    renderAnalyticsView();
  };

  // 3. Kiválasztott csoport részletes adatai
  const curr = productGroupsMap.get(selectedGroup);
  if (curr) {
    selectedGroupTitle.textContent = curr.name;

    const lidlAvg = curr.lidlUnitPrices.length > 0 
      ? Math.round(curr.lidlUnitPrices.reduce((a, b) => a + b, 0) / curr.lidlUnitPrices.length)
      : null;
    const aldiAvg = curr.aldiUnitPrices.length > 0
      ? Math.round(curr.aldiUnitPrices.reduce((a, b) => a + b, 0) / curr.aldiUnitPrices.length)
      : null;

    lidlGroupCount.textContent = `${curr.lidlOffers.length} ajánlat`;
    aldiGroupCount.textContent = `${curr.aldiOffers.length} ajánlat`;

    lidlAvgUnitPrice.textContent = lidlAvg ? `${lidlAvg.toLocaleString('hu-HU')} Ft/egység` : 'Nincs egységár';
    aldiAvgUnitPrice.textContent = aldiAvg ? `${aldiAvg.toLocaleString('hu-HU')} Ft/egység` : 'Nincs egységár';

    // Győztes badge
    if (lidlAvg && aldiAvg) {
      if (lidlAvg < aldiAvg) {
        const pct = Math.round(((aldiAvg - lidlAvg) / aldiAvg) * 100);
        groupWinnerBadge.textContent = `🏆 Lidl ${pct}%-kal kedvezőbb átlagár!`;
        groupWinnerBadge.style.color = 'var(--lidl-brand-yellow)';
        groupWinnerBadge.style.background = 'rgba(250, 204, 21, 0.15)';
        groupWinnerBadge.style.borderColor = 'rgba(250, 204, 21, 0.35)';
      } else if (aldiAvg < lidlAvg) {
        const pct = Math.round(((lidlAvg - aldiAvg) / lidlAvg) * 100);
        groupWinnerBadge.textContent = `🏆 Aldi ${pct}%-kal kedvezőbb átlagár!`;
        groupWinnerBadge.style.color = 'var(--aldi-accent)';
        groupWinnerBadge.style.background = 'rgba(56, 189, 248, 0.15)';
        groupWinnerBadge.style.borderColor = 'rgba(56, 189, 248, 0.35)';
      } else {
        groupWinnerBadge.textContent = '⚖️ Megegyező átlagos árszint';
      }
    } else {
      groupWinnerBadge.textContent = 'Csak az egyik boltban elérhető adat';
    }

    // Legolcsóbb termékek
    const cheapestLidl = curr.lidlOffers.length > 0 
      ? curr.lidlOffers.reduce((min, o) => o.price < min.price ? o : min, curr.lidlOffers[0]) 
      : null;
    const cheapestAldi = curr.aldiOffers.length > 0
      ? curr.aldiOffers.reduce((min, o) => o.price < min.price ? o : min, curr.aldiOffers[0])
      : null;

    if (cheapestLidl) {
      lidlCheapestName.textContent = cheapestLidl.raw_name;
      lidlCheapestPrice.textContent = `${Math.round(cheapestLidl.price).toLocaleString('hu-HU')} Ft`;
    } else {
      lidlCheapestName.textContent = 'Nincs adat';
      lidlCheapestPrice.textContent = '-';
    }

    if (cheapestAldi) {
      aldiCheapestName.textContent = cheapestAldi.raw_name;
      aldiCheapestPrice.textContent = `${Math.round(cheapestAldi.price).toLocaleString('hu-HU')} Ft`;
    } else {
      aldiCheapestName.textContent = 'Nincs adat';
      aldiCheapestPrice.textContent = '-';
    }
  }

  // 4. Chart.js diagram kirajzolása (Lidl vs. Aldi átlagárak kategóriánként)
  renderAnalyticsChart(sortedGroups);
}

function renderAnalyticsChart(sortedGroups) {
  const chartCanvas = document.getElementById('analytics-chart');
  if (!chartCanvas) return;

  // Kiválasztjuk a top 10 olyan csoportot, ahol mindkét boltban van egységár adat
  const comparableGroups = sortedGroups
    .filter(g => g.lidlUnitPrices.length > 0 && g.aldiUnitPrices.length > 0)
    .slice(0, 10);

  if (comparableGroups.length === 0) return;

  const labels = comparableGroups.map(g => g.name);
  const lidlData = comparableGroups.map(g => {
    return Math.round(g.lidlUnitPrices.reduce((a, b) => a + b, 0) / g.lidlUnitPrices.length);
  });
  const aldiData = comparableGroups.map(g => {
    return Math.round(g.aldiUnitPrices.reduce((a, b) => a + b, 0) / g.aldiUnitPrices.length);
  });

  if (analyticsChartInstance) {
    analyticsChartInstance.destroy();
  }

  analyticsChartInstance = new Chart(chartCanvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Lidl átlagos egységár (Ft)',
          data: lidlData,
          backgroundColor: 'rgba(250, 204, 21, 0.85)',
          borderColor: '#facc15',
          borderWidth: 1.5,
          borderRadius: 6
        },
        {
          label: 'Aldi átlagos egységár (Ft)',
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
        legend: {
          display: false // Egyedi HTML legendát használunk
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#fff',
          bodyColor: '#cbd5e1',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (context) => ` ${context.dataset.label}: ${context.raw.toLocaleString('hu-HU')} Ft/egység`
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

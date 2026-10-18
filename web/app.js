// Árfigyelő Web Alkalmazás
import { createClient } from '@supabase/supabase-js';

// Supabase konfiguráció (publikus anon kulcs és projekt URL)
const SUPABASE_URL = 'https://npbdwncxrckvricbtktz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_msZVswp3iu9CwQCtvyJpyA_8Apm3nVm';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Állapot (State)
let allOffers = [];
let categories = new Set();
let watchlist = new Set(JSON.parse(localStorage.getItem('arfigyelo_watchlist') || '[]'));
let currentStore = 'all';
let currentCategory = 'all';
let currentSort = 'name-asc';
let currentSearch = '';
let showOnlyWatchlist = false;
let currentView = 'grid'; // 'grid' | 'table'

// DOM Elemek
const productsContainer = document.getElementById('products-container');
const emptyState = document.getElementById('empty-state');
const resultsCountEl = document.getElementById('results-count');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search');
const categorySelect = document.getElementById('category-select');
const sortSelect = document.getElementById('sort-select');
const storeFilterGroup = document.getElementById('store-filter');
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
    
    // Lekérjük az összes érvényes ajánlatot és a kapcsolódó termékinformációkat
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
          base_unit
        )
      `)
      .order('valid_from', { ascending: false });

    if (error) throw error;

    allOffers = data || [];
    statusTextEl.textContent = `${allOffers.length} ajánlat betöltve`;

    // Kategóriák összegyűjtése
    categories.clear();
    allOffers.forEach(o => {
      const cat = o.products?.category;
      if (cat) categories.add(cat);
    });

    populateCategories();
    render();
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

// Eseménykezelők
function setupEventListeners() {
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

  // Szűrők visszaállítása
  resetFiltersBtn.addEventListener('click', () => {
    currentStore = 'all';
    currentCategory = 'all';
    currentSearch = '';
    currentSort = 'name-asc';
    showOnlyWatchlist = false;

    searchInput.value = '';
    categorySelect.value = 'all';
    sortSelect.value = 'name-asc';
    watchlistToggleBtn.classList.remove('active');
    storeFilterGroup.querySelectorAll('.seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.store === 'all');
    });

    render();
  });

  // Nézetváltás
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

  // Modal bezárása
  modalCloseBtn.addEventListener('click', closeModal);
  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

// Watchlist kezelése
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

// Szűrés és rendezés
function getFilteredOffers() {
  return allOffers.filter(o => {
    // Bolt szűrő
    if (currentStore !== 'all' && o.store_id !== currentStore) return false;

    // Kategória szűrő
    const cat = o.products?.category;
    if (currentCategory !== 'all' && cat !== currentCategory) return false;

    // Figyelőlista szűrő
    const pName = o.products?.name || o.raw_name;
    if (showOnlyWatchlist && !watchlist.has(pName)) return false;

    // Szöveges keresés
    if (currentSearch) {
      const matchName = (o.products?.name || '').toLowerCase().includes(currentSearch);
      const matchRaw = (o.raw_name || '').toLowerCase().includes(currentSearch);
      const matchBrand = (o.brand || '').toLowerCase().includes(currentSearch);
      if (!matchName && !matchRaw && !matchBrand) return false;
    }

    return true;
  }).sort((a, b) => {
    if (currentSort === 'name-asc') {
      const nameA = a.products?.name || a.raw_name;
      const nameB = b.products?.name || b.raw_name;
      return nameA.localeCompare(nameB, 'hu');
    }
    if (currentSort === 'price-asc') {
      return a.price - b.price;
    }
    if (currentSort === 'discount-desc') {
      const discA = a.original_price ? ((a.original_price - a.price) / a.original_price) : 0;
      const discB = b.original_price ? ((b.original_price - b.price) / b.original_price) : 0;
      return discB - discA;
    }
    if (currentSort === 'unit-asc') {
      const uA = a.unit_price || 999999;
      const uB = b.unit_price || 999999;
      return uA - uB;
    }
    if (currentSort === 'date-desc') {
      return (b.valid_from || '').localeCompare(a.valid_from || '');
    }
    return 0;
  });
}

// Megjelenítés (Render)
function render() {
  const filtered = getFilteredOffers();
  resultsCountEl.textContent = `${filtered.length} ajánlat található`;

  if (filtered.length === 0) {
    productsContainer.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  productsContainer.style.display = currentView === 'grid' ? 'grid' : 'block';

  if (currentView === 'grid') {
    productsContainer.className = 'products-grid';
    productsContainer.innerHTML = filtered.map(createProductCard).join('');
  } else {
    productsContainer.className = 'products-table-wrap';
    productsContainer.innerHTML = createProductsTable(filtered);
  }

  // Események csatolása a gombokhoz (star & history)
  productsContainer.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.product);
    });
  });

  productsContainer.querySelectorAll('.history-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openHistoryModal(btn.dataset.product);
    });
  });
}

// Kártya HTML sablon
function createProductCard(o) {
  const pName = o.products?.name || o.raw_name;
  const isStarred = watchlist.has(pName);
  const storeName = o.store_id.toUpperCase();
  const unitText = o.unit_price && o.products?.base_unit 
    ? `${Math.round(o.unit_price).toLocaleString('hu-HU')} Ft/${o.products.base_unit}` 
    : '';

  let discountBadge = '';
  if (o.original_price && o.original_price > o.price) {
    const percent = Math.round(((o.original_price - o.price) / o.original_price) * 100);
    discountBadge = `<span class="discount-badge">-${percent}%</span>`;
  }

  const flyerBadge = o.source === 'flyer' ? '<span class="tag-pill flyer">📰 Újság</span>' : '';

  return `
    <article class="product-card store-${o.store_id}">
      <div class="card-top">
        <span class="store-badge ${o.store_id}">${storeName}</span>
        <div class="card-actions">
          ${flyerBadge}
          <button class="star-btn ${isStarred ? 'starred' : ''}" data-product="${escapeHtml(pName)}" title="Hozzáadás a figyelőlistához">
            ${isStarred ? '★' : '☆'}
          </button>
        </div>
      </div>

      <h3 class="card-title">${escapeHtml(o.raw_name)}</h3>
      
      <div class="card-subtitle">
        ${o.brand ? `<strong>${escapeHtml(o.brand)}</strong>` : ''}
        ${o.package ? `<span>&bull; ${escapeHtml(o.package)}</span>` : ''}
        ${o.products?.category ? `<span class="cat-badge">${escapeHtml(o.products.category)}</span>` : ''}
      </div>

      <div class="card-pricing">
        <div class="price-main">
          ${o.original_price ? `
            <div class="original-price-wrap">
              <span>${Math.round(o.original_price).toLocaleString('hu-HU')} Ft</span>
              ${discountBadge}
            </div>
          ` : ''}
          <div class="current-price">${Math.round(o.price).toLocaleString('hu-HU')} Ft</div>
        </div>
        ${unitText ? `<div class="unit-price">${unitText}</div>` : ''}
      </div>

      <div class="card-footer">
        <span class="validity">🗓️ ${formatDate(o.valid_from)}${o.valid_to ? ' - ' + formatDate(o.valid_to) : ''}</span>
        <button class="history-btn" data-product="${escapeHtml(pName)}">Ártörténet</button>
      </div>
    </article>
  `;
}

// Táblázat HTML sablon
function createProductsTable(items) {
  return `
    <table class="products-table">
      <thead>
        <tr>
          <th style="width: 40px;"></th>
          <th>Bolt</th>
          <th>Termék</th>
          <th>Kategória</th>
          <th>Kiszerelés</th>
          <th>Akciós ár</th>
          <th>Eredeti ár</th>
          <th>Egységár</th>
          <th>Érvényesség</th>
          <th>Művelet</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(o => {
          const pName = o.products?.name || o.raw_name;
          const isStarred = watchlist.has(pName);
          const unitText = o.unit_price && o.products?.base_unit 
            ? `${Math.round(o.unit_price).toLocaleString('hu-HU')} Ft/${o.products.base_unit}` 
            : '-';
          return `
            <tr>
              <td>
                <button class="star-btn ${isStarred ? 'starred' : ''}" data-product="${escapeHtml(pName)}">
                  ${isStarred ? '★' : '☆'}
                </button>
              </td>
              <td><span class="store-badge ${o.store_id}">${o.store_id.toUpperCase()}</span></td>
              <td><strong>${escapeHtml(o.raw_name)}</strong></td>
              <td>${escapeHtml(o.products?.category || '-')}</td>
              <td>${escapeHtml(o.package || '-')}</td>
              <td><strong style="color: #fff; font-family: var(--font-mono);">${Math.round(o.price).toLocaleString('hu-HU')} Ft</strong></td>
              <td style="color: var(--text-dim); text-decoration: line-through;">
                ${o.original_price ? `${Math.round(o.original_price).toLocaleString('hu-HU')} Ft` : '-'}
              </td>
              <td style="font-family: var(--font-mono);">${unitText}</td>
              <td>${formatDate(o.valid_from)}</td>
              <td><button class="history-btn" data-product="${escapeHtml(pName)}">Történet</button></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// Ártörténet modal megnyitása
function openHistoryModal(productName) {
  const matches = allOffers.filter(o => (o.products?.name || o.raw_name) === productName);
  if (matches.length === 0) return;

  const first = matches[0];
  modalProductName.textContent = productName;
  modalCategory.textContent = first.products?.category ? `Kategória: ${first.products.category}` : '';

  // Statisztika számítása
  const prices = matches.map(m => m.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

  modalSummary.innerHTML = `
    <div>
      <div class="summary-stat-val" style="color: var(--accent-green);">${minPrice.toLocaleString('hu-HU')} Ft</div>
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
          <div class="timeline-date">${formatDate(m.valid_from)}${m.valid_to ? ' - ' + formatDate(m.valid_to) : ''}</div>
        </div>
      </div>
      <div class="timeline-price">${Math.round(m.price).toLocaleString('hu-HU')} Ft</div>
    </div>
  `).join('');

  historyModal.style.display = 'flex';
}

function closeModal() {
  historyModal.style.display = 'none';
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

// Indítás
init();

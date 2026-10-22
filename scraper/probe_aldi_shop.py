from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 900})
    pg.goto('https://shop.aldi.hu/kinalat/tejtermek-tojas', timeout=30000)
    for t in ('Összes elfogadása', 'Elfogadom'):
        try:
            pg.get_by_text(t, exact=False).first.click(timeout=1500)
            break
        except Exception:
            pass
    pg.wait_for_timeout(3000)
    cards = pg.locator('.product-card, app-product-card, div.product-box').all()
    if not cards:
        cards = pg.locator('a[href*="/termek/"]').all()
    print("Found cards count:", len(cards))
    for c in cards[:5]:
        print("--- CARD ---")
        print(c.inner_text().strip())
    b.close()

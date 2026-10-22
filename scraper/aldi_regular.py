"""Aldi állandó (nem akciós) bolti árainak gyűjtése a shop.aldi.hu felületről.
Gyors közvetlen parszer + Gemini normalizálás + Supabase mentés (source='regular').
"""
import os, sys, re, time, datetime as dt
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from google import genai
from pydantic import BaseModel
from supabase import create_client

load_dotenv()
MODEL = "gemini-flash-latest"

CATEGORIES = [
    ("tejtermek-tojas", "Tejtermék és tojás"),
    ("pekaru", "Kenyér és pékáru"),
    ("zoldseg-gyumolcs", "Zöldség-gyümölcs"),
    ("hus-hal-felvagott", "Hús és felvágott"),
    ("alapveto-elelmiszerek", "Alapvető élelmiszerek"),
]


class ItemNorm(BaseModel):
    raw_name: str
    product: str
    product_group: str
    category: str
    base_unit: str  # kg | l | db


class NormBatch(BaseModel):
    items: list[ItemNorm]


def parse_card_text(text: str) -> dict | None:
    lines = [l.strip() for l in text.splitlines() if l.strip() and l.strip() != "Kosárba"]
    if len(lines) < 2:
        return None

    raw_name = None
    price = None
    unit_price = None
    base_unit = "db"

    for line in lines:
        m_u = re.search(r"(\d[\d\s.]*)\s*Ft\s*/\s*(kg|l)\b", line, re.I)
        if m_u:
            try:
                unit_price = float(m_u.group(1).replace(" ", "").replace(".", ""))
                base_unit = m_u.group(2).lower()
            except Exception:
                pass
            continue

        m_p = re.search(r"(\d[\d\s.]*)\s*Ft(?:\s*/\s*db)?", line, re.I)
        if m_p and not price:
            try:
                price = float(m_p.group(1).replace(" ", "").replace(".", ""))
            except Exception:
                pass
            continue

        if not raw_name and len(line) > 3 and not re.search(r"^\d+\s*Ft", line):
            raw_name = line

    if not raw_name or not price:
        return None

    return {
        "raw_name": raw_name,
        "price": price,
        "unit_price": unit_price or price,
        "base_unit": base_unit,
    }


def normalize_batch(client: genai.Client, raw_items: list[dict], cat_hint: str) -> dict[str, ItemNorm]:
    prompt = (
        f"Kérlek normalizáld az alábbi magyar Aldi bolti termékeket (kategória: {cat_hint}).\n"
        "Minden tételhez add meg:\n"
        "- raw_name: pontosan az eredeti név\n"
        "- product: egységes rövid név márka nélkül (pl. 'UHT Tej 2,8%', 'Görög krémjoghurt')\n"
        "- product_group: felsőbb szintű termékcsoport (pl. 'Tej és tejes italok', 'Joghurt', 'Kenyér és pékáru', 'Virsli', 'Sajt', 'Hús', 'Zöldség', 'Gyümölcs')\n"
        "- category: fő kategória\n"
        "- base_unit: 'kg', 'l' vagy 'db'\n\n"
        f"TERMÉKEK:\n" + "\n".join(f"- {item['raw_name']} ({item['base_unit']})" for item in raw_items)
    )
    try:
        r = client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config={"response_mime_type": "application/json", "response_schema": NormBatch},
        )
        if r.parsed and r.parsed.items:
            return {it.raw_name: it for it in r.parsed.items}
    except Exception as e:
        print(f"Hiba a normalizálásnál: {e}", file=sys.stderr)
    return {}


def main():
    start_time = time.time()
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    db = create_client(url, key)
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    today = dt.date.today().isoformat()

    all_parsed_items = []

    print("Aldi online shop (shop.aldi.hu) állandó árainak letöltése...")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        for cat_slug, cat_name in CATEGORIES:
            cat_url = f"https://shop.aldi.hu/kinalat/{cat_slug}"
            print(f"\nKategória megnyitása: {cat_name} ({cat_url})...", flush=True)
            try:
                page.goto(cat_url, timeout=35000)
                # Süti modal kezelése
                try:
                    page.locator("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll").click(timeout=2000)
                except Exception:
                    pass
                for _ in range(5):
                    page.mouse.wheel(0, 3000)
                    page.wait_for_timeout(400)

                cards = page.locator(".product-card, app-product-card, div.product-box, a[href*='/termek/']").all()
                print(f"  -> {len(cards)} termékkártya található.")
                for c in cards:
                    parsed = parse_card_text(c.inner_text().strip())
                    if parsed:
                        parsed["cat_hint"] = cat_name
                        all_parsed_items.append(parsed)
            except Exception as e:
                print(f"  Hiba a(z) {cat_name} kategóriánál: {e}")

        browser.close()

    # Ismétlődések szűrése raw_name alapján
    unique_items = {item["raw_name"]: item for item in all_parsed_items}.values()
    print(f"\nÖsszesen {len(unique_items)} egyedi állandó termék és ár beolvasva!")

    # Normalizálás kötegekben
    items_list = list(unique_items)
    batch_size = 50
    normalized_map = {}
    for i in range(0, len(items_list), batch_size):
        chunk = items_list[i:i + batch_size]
        print(f"Normalizálás Gemini-vel: {i + 1}-{min(i + batch_size, len(items_list))} / {len(items_list)}...", flush=True)
        res = normalize_batch(client, chunk, chunk[0]["cat_hint"])
        normalized_map.update(res)

    # Mentés Supabase-be
    print("\nMentés a Supabase-be...")
    # 1. Termékek
    prod_upserts = []
    for item in unique_items:
        raw_name = item["raw_name"]
        norm = normalized_map.get(raw_name)
        pname = norm.product if norm else raw_name
        pgroup = norm.product_group if norm else item["cat_hint"]
        base_u = norm.base_unit if norm and norm.base_unit in ("kg", "l", "db") else item["base_unit"]
        category = norm.category if norm else item["cat_hint"]
        prod_upserts.append({
            "name": pname,
            "product_group": pgroup,
            "category": category,
            "base_unit": base_u,
        })

    for i in range(0, len(prod_upserts), 50):
        db.table("products").upsert(prod_upserts[i:i + 50], on_conflict="name").execute()

    # ID-k lekérdezése
    existing = db.table("products").select("id, name").execute().data or []
    name_to_id = {row["name"]: row["id"] for row in existing}

    # 2. Ajánlatok (source='regular')
    offers_upsert = []
    for item in unique_items:
        raw_name = item["raw_name"]
        norm = normalized_map.get(raw_name)
        pname = norm.product if norm else raw_name
        pid = name_to_id.get(pname)
        offers_upsert.append({
            "store_id": "aldi",
            "product_id": pid,
            "raw_name": raw_name[:250],
            "price": item["price"],
            "unit_price": item["unit_price"],
            "valid_from": today,
            "source": "regular",
        })

    saved = 0
    for i in range(0, len(offers_upsert), 50):
        batch = offers_upsert[i:i + 50]
        res = db.table("offers").upsert(batch, on_conflict="store_id,raw_name,valid_from").execute()
        saved += len(res.data or batch)

    print(f"\n✅ SIKERES: {saved} állandó Aldi termékár rögzítve a Supabase-ben ({time.time() - start_time:.1f} mp alatt)!")


if __name__ == "__main__":
    main()

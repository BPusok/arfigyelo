"""Heti akciós árak gyűjtése (Lidl, Aldi) -> Gemini normalizálás -> Supabase.

Használat:
  python scraper/run.py             # Teljes futtatás és mentés Supabase-be
  python scraper/run.py --dry       # Csak beolvasás és kiírás, nem ment az adatbázisba
  python scraper/run.py --quick     # Gyors teszt (boltonként max 2 oldal)
"""
import os, re, sys, datetime as dt
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from google import genai
from pydantic import BaseModel
from supabase import create_client

load_dotenv()
MODEL = "gemini-flash-latest"
DRY = "--dry" in sys.argv
QUICK = "--quick" in sys.argv
MAX_PAGES = 2 if QUICK else 10


class Offer(BaseModel):
    raw_name: str
    brand: str | None = None
    package: str | None = None
    product: str  # általános terméknév, pl. "Piros burgonya", "Trappista sajt"
    category: str  # pl. zöldség-gyümölcs, pékáru, tejtermék, hús, ital, háztartás, egyéb
    base_unit: str  # kg | l | db
    price: float  # akciós ár Ft-ban
    original_price: float | None = None  # áthúzott ár, ha van
    unit_price: float | None = None  # Ft / base_unit
    valid_from: str  # YYYY-MM-DD
    valid_to: str | None = None


def clean_date(d: str | None, default_date: str) -> str:
    if not d:
        return default_date
    m = re.search(r"(\d{4})[.-](\d{1,2})[.-](\d{1,2})", str(d))
    if m:
        y, mm, dd = m.groups()
        return f"{int(y):04d}-{int(mm):02d}-{int(dd):02d}"
    return default_date


def page_text(pg, url: str) -> str:
    pg.goto(url, wait_until="networkidle", timeout=60000)
    for t in ("Összes elfogadása", "Elfogad", "IGEN, ELMÚLTAM", "Rendben", "Elfogadom"):
        try:
            pg.get_by_text(t, exact=False).first.click(timeout=1500)
            break
        except Exception:
            pass
    for _ in range(6):
        pg.mouse.wheel(0, 3500)
        pg.wait_for_timeout(500)
    return pg.inner_text("body")


def links(pg, url: str, pattern: str) -> list[str]:
    pg.goto(url, wait_until="networkidle", timeout=60000)
    for t in ("Összes elfogadása", "Elfogad", "Rendben"):
        try:
            pg.get_by_text(t, exact=False).first.click(timeout=1500)
            break
        except Exception:
            pass
    hrefs = pg.eval_on_selector_all("a", "e => e.map(x => x.href)")
    filtered = [h for h in hrefs if re.search(pattern, h)]
    return list(dict.fromkeys(filtered))


def discover(pg) -> dict[str, list[str]]:
    lidl = links(pg, "https://www.lidl.hu/", r"/c/(akcioink-|.*-ajanlat)")[:MAX_PAGES]
    aldi = links(pg, "https://www.aldi.hu/hu/ajanlatok.html", r"/ajanlatok/\d{4}-\d\d-\d\d$")[:MAX_PAGES]
    return {"lidl": lidl, "aldi": aldi}


def extract(client: genai.Client, store: str, text: str) -> list[Offer]:
    today = dt.date.today().isoformat()
    prompt = (
        f"Magyar {store.upper()} akciós weboldal szövege alább. Gyűjtsd ki az összes TERMÉKET struktúráltan.\n"
        f"- Mai dátum: {today}. Ha az érvényességből hiányzik az év, ezt az évet használd (formátum: YYYY-MM-DD).\n"
        "- price = az akciós ár magyar forintban (számként).\n"
        "- original_price = az eredeti / áthúzott ár forintban (ha van, különben null).\n"
        "- unit_price = egységár (Ft / base_unit). Ha nincs megadva, számold ki a kiszerelésből (pl. 500g 1000Ft -> 2000 Ft/kg).\n"
        "- base_unit = 'kg', 'l' vagy 'db'.\n"
        "- product = a termék egységes általános magyar neve márka nélkül (pl. 'Teavaj', 'Görögdinnye', 'Kovászos kenyér').\n"
        "- category = kategória (pl. zöldség-gyümölcs, pékáru, hús, tejtermék, ital, háztartás, édesség, egyéb).\n\n"
        f"SZÖVEG:\n{text}"
    )
    try:
        r = client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config={"response_mime_type": "application/json", "response_schema": list[Offer]},
        )
        return r.parsed or []
    except Exception as e:
        print(f"Hiba a Gemini kinyerésnél ({store}): {e}", file=sys.stderr)
        return []


def chunks(text: str, size: int = 14000):
    cur = ""
    for line in text.splitlines():
        if len(cur) + len(line) > size:
            if cur.strip():
                yield cur
            cur = ""
        cur += line + "\n"
    if cur.strip():
        yield cur


def save_to_supabase(rows: dict):
    if not rows:
        print("Nincs mentendő ajánlat.")
        return
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("HIBA: SUPABASE_URL vagy SUPABASE_SERVICE_KEY hiányzik a .env-ből!", file=sys.stderr)
        return

    db = create_client(url, key)
    today = dt.date.today().isoformat()

    # 1. Termékek összegyűjtése és mentése
    products_map = {}
    for _, o in rows.values():
        pname = o.product.strip()
        if not pname:
            continue
        base_u = o.base_unit if o.base_unit in ("kg", "l", "db") else "db"
        products_map[pname] = {
            "name": pname,
            "category": o.category or "egyéb",
            "base_unit": base_u,
        }

    p_list = list(products_map.values())
    for i in range(0, len(p_list), 50):
        db.table("products").upsert(p_list[i:i + 50], on_conflict="name").execute()

    # ID-k lekérdezése
    existing = db.table("products").select("id, name").execute().data or []
    name_to_id = {row["name"]: row["id"] for row in existing}

    # 2. Ajánlatok összeállítása és mentése
    offers_list = []
    for (store, raw_name, valid_from), (s, o) in rows.items():
        pid = name_to_id.get(o.product.strip())
        v_from = clean_date(o.valid_from, today)
        v_to = clean_date(o.valid_to, None) if o.valid_to else None
        offers_list.append({
            "store_id": s,
            "product_id": pid,
            "raw_name": o.raw_name.strip()[:250],
            "brand": (o.brand or "")[:100] or None,
            "package": (o.package or "")[:50] or None,
            "price": o.price,
            "original_price": o.original_price,
            "unit_price": o.unit_price,
            "valid_from": v_from,
            "valid_to": v_to,
            "source": "web",
        })

    saved = 0
    for i in range(0, len(offers_list), 50):
        batch = offers_list[i:i + 50]
        res = db.table("offers").upsert(batch, on_conflict="store_id,raw_name,valid_from").execute()
        saved += len(res.data or batch)

    print(f"Sikeresen mentve: {saved} ajánlat, {len(products_map)} termék.")


def main():
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    rows = {}
    today = dt.date.today().isoformat()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(locale="hu-HU", viewport={"width": 1400, "height": 2000})

        disc = discover(page)
        for store, page_urls in disc.items():
            print(f"\n--- {store.upper()} ({len(page_urls)} oldal) ---")
            for u in page_urls:
                print(f"Letöltés: {u}", flush=True)
                txt = page_text(page, u)
                for chunk in chunks(txt):
                    chunk_offers = extract(client, store, chunk)
                    for o in chunk_offers:
                        v_from = clean_date(o.valid_from, today)
                        k = (store, o.raw_name, v_from)
                        rows[k] = (store, o)
        browser.close()

    print(f"\nÖsszesen {len(rows)} egyedi ajánlat kinyerve.")
    if DRY:
        print("DRY RUN - nem mentünk Supabase-be.")
        for s, o in list(rows.values())[:10]:
            print(f"[{s}] {o.raw_name} -> {o.product} | {o.price} Ft | {o.unit_price} Ft/{o.base_unit}")
        return

    save_to_supabase(rows)


if __name__ == "__main__":
    main()

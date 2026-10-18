"""Jövő heti (43. heti, 2026.10.22-től érvényes) akciós ajánlatok beszkennelése és mentése.
Források:
- Aldi: 43. heti online akciós újság (spreads / szöveges réteg)
- Lidl: 43. heti akciós oldalak & újság
"""
import os, sys, re, json, urllib.request, datetime as dt
from dotenv import load_dotenv
from google import genai
from pydantic import BaseModel
from supabase import create_client
from playwright.sync_api import sync_playwright

load_dotenv()
MODEL = "gemini-flash-latest"


class Offer(BaseModel):
    raw_name: str
    brand: str | None = None
    package: str | None = None
    product: str
    category: str
    base_unit: str  # kg | l | db
    price: float
    original_price: float | None = None
    unit_price: float | None = None
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


def extract_from_text(client: genai.Client, store: str, text: str, default_from: str = "2026-10-22") -> list[Offer]:
    prompt = (
        f"Ez a magyar {store.upper()} jövő heti (43. hét, {default_from}-től) akciós újságjának/oldalának szövege. "
        "Olvasd ki az összes benne szereplő akciós TERMÉKET struktúráltan.\n"
        f"- Érvényesség kezdete: ha nincs más megadva, akkor {default_from} (YYYY-MM-DD formátumban).\n"
        "- price = akciós eladási ár forintban (számként).\n"
        "- original_price = korábbi / áthúzott ár forintban, ha van.\n"
        "- unit_price = egységár (Ft / base_unit). Ha a szövegből kiszámolható, számold ki.\n"
        "- base_unit = 'kg', 'l' vagy 'db'.\n"
        "- product = a termék egységes általános magyar neve márka nélkül (pl. 'UHT Tej', 'Csirkemellfilé', 'Sárgarépa').\n"
        "- category = kategória (zöldség-gyümölcs, tejtermék, pékáru, hús, ital, háztartás, egyéb).\n\n"
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
        print(f"Gemini hiba: {e}", file=sys.stderr)
        return []


def scan_aldi_kw43(client: genai.Client) -> list[tuple[str, Offer]]:
    print("\n=== ALDI 43. heti akciós újság letöltése ===")
    url = "https://szorolap.aldi.hu/aldi_online_akcios_ujsag_2026_kw43/spreads.json"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        spreads = json.loads(resp.read().decode("utf-8"))

    results = []
    # Az első 15 spread bőségesen lefedi az összes élelmiszer és kiemelt akciót
    for idx, s in enumerate(spreads[:15]):
        combined_text = ""
        for p in s.get("pages", []):
            t = p.get("text", "").strip()
            if t:
                combined_text += t + "\n"
        
        if len(combined_text) < 50:
            continue

        print(f"Aldi oldal/spread {idx + 1}/{min(15, len(spreads))} feldolgozása ({len(combined_text)} karakter)...", flush=True)
        offers = extract_from_text(client, "aldi", combined_text, default_from="2026-10-22")
        print(f"  -> {len(offers)} termék kinyerve.")
        for o in offers:
            results.append(("aldi", o))

    return results


def scan_lidl_kw43(client: genai.Client) -> list[tuple[str, Offer]]:
    print("\n=== LIDL 43. heti akciók letöltése ===")
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(locale="hu-HU", viewport={"width": 1400, "height": 2000})

        # Lidl 43. heti főkategória
        lidl_urls = [
            "https://www.lidl.hu/c/akcioink-csutortoktol/a10105264",
            "https://www.lidl.hu/c/szuper-hetvege/a10105273",
            "https://www.lidl.hu/c/akcioink-hetfotol/a10105277"
        ]

        for u in lidl_urls:
            try:
                print(f"Lidl oldal megnyitása: {u}...", flush=True)
                page.goto(u, wait_until="networkidle", timeout=45000)
                for t in ("Összes elfogadása", "Elfogad", "IGEN, ELMÚLTAM", "Rendben"):
                    try:
                        page.get_by_text(t, exact=False).first.click(timeout=1500)
                        break
                    except Exception:
                        pass
                for _ in range(6):
                    page.mouse.wheel(0, 3500)
                    page.wait_for_timeout(400)
                txt = page.inner_text("body")
                if len(txt) > 200:
                    offers = extract_from_text(client, "lidl", txt[:20000], default_from="2026-10-22")
                    print(f"  -> {len(offers)} termék kinyerve.")
                    for o in offers:
                        results.append(("lidl", o))
            except Exception as e:
                print(f"  Hiba a {u} oldalnál: {e}")

        browser.close()
    return results


def save_to_supabase(all_offers: list[tuple[str, Offer]]):
    if not all_offers:
        print("Nincs mentendő ajánlat.")
        return

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    db = create_client(url, key)

    # 1. Termékek mentése
    products_map = {}
    for _, o in all_offers:
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

    existing = db.table("products").select("id, name").execute().data or []
    name_to_id = {row["name"]: row["id"] for row in existing}

    # 2. Ajánlatok mentése
    offers_rows = []
    seen = set()
    for s, o in all_offers:
        pid = name_to_id.get(o.product.strip())
        v_from = clean_date(o.valid_from, "2026-10-22")
        k = (s, o.raw_name.strip()[:250], v_from)
        if k in seen:
            continue
        seen.add(k)

        offers_rows.append({
            "store_id": s,
            "product_id": pid,
            "raw_name": o.raw_name.strip()[:250],
            "brand": (o.brand or "")[:100] or None,
            "package": (o.package or "")[:50] or None,
            "price": o.price,
            "original_price": o.original_price,
            "unit_price": o.unit_price,
            "valid_from": v_from,
            "valid_to": clean_date(o.valid_to, None) if o.valid_to else None,
            "source": "flyer",
        })

    saved = 0
    for i in range(0, len(offers_rows), 50):
        batch = offers_rows[i:i + 50]
        res = db.table("offers").upsert(batch, on_conflict="store_id,raw_name,valid_from").execute()
        saved += len(res.data or batch)

    print(f"\n✅ JÖVŐ HETI AJÁNLATOK SIKERESEN MENTVE!")
    print(f"Összesen {saved} új ajánlat és {len(products_map)} termék rögzítve (érvényes: 2026.10.22-től).")


def main():
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    all_offers = []

    # 1. Aldi 43. hét
    all_offers.extend(scan_aldi_kw43(client))

    # 2. Lidl 43. hét
    all_offers.extend(scan_lidl_kw43(client))

    print(f"\nÖsszesen {len(all_offers)} ajánlat beolvasva a jövő hétre.")
    save_to_supabase(all_offers)


if __name__ == "__main__":
    main()

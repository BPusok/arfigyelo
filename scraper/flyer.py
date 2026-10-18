"""Akciós újság (PDF vagy kép) beolvasása Gemini Vision segítségével -> Supabase.

Használat:
  python scraper/flyer.py "https://assets.leaflets.schwarz/.../ujsag.pdf" --store lidl
  python scraper/flyer.py "C:/letoltesek/aldi_ujsag.pdf" --store aldi
  python scraper/flyer.py "foto.jpg" --store lidl --dry
"""
import os, sys, re, argparse, urllib.request, tempfile, datetime as dt
from dotenv import load_dotenv
from google import genai
from google.genai import types
from pydantic import BaseModel
from supabase import create_client

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


def download_if_url(source: str) -> tuple[bytes, str]:
    if source.startswith("http://") or source.startswith("https://"):
        print(f"Letöltés: {source}...")
        req = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
        mime = "application/pdf" if ".pdf" in source.lower() else "image/jpeg"
        return data, mime
    else:
        with open(source, "rb") as f:
            data = f.read()
        mime = "application/pdf" if source.lower().endswith(".pdf") else "image/jpeg"
        return data, mime


def extract_from_flyer(client: genai.Client, store: str, data: bytes, mime_type: str) -> list[Offer]:
    today = dt.date.today().isoformat()
    prompt = (
        f"Ez egy magyar {store.upper()} akciós újság / szórólap. "
        "Olvasd ki az összes benne szereplő akciós TERMÉKET struktúráltan.\n"
        f"- Mai dátum: {today}. Az érvényesség évét ez alapján add meg (YYYY-MM-DD).\n"
        "- price = akciós eladási ár forintban.\n"
        "- original_price = áthúzott korábbi ár forintban, ha látható.\n"
        "- unit_price = egységár (Ft / base_unit). Ha a képen nincs kiírva, számold ki a kiszerelésből.\n"
        "- base_unit = 'kg', 'l' vagy 'db'.\n"
        "- product = a termék egységes általános magyar neve márka nélkül (pl. 'Trappista sajt', 'Görögdinnye').\n"
        "- category = kategória (zöldség-gyümölcs, tejtermék, pékáru, hús, ital, háztartás, egyéb)."
    )
    part = types.Part.from_bytes(data=data, mime_type=mime_type)
    r = client.models.generate_content(
        model=MODEL,
        contents=[part, prompt],
        config={"response_mime_type": "application/json", "response_schema": list[Offer]},
    )
    return r.parsed or []


def save_offers(store: str, offers: list[Offer]):
    if not offers:
        print("Nincs mentendő ajánlat.")
        return
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    db = create_client(url, key)
    today = dt.date.today().isoformat()

    # 1. Termékek
    p_map = {
        o.product.strip(): {
            "name": o.product.strip(),
            "category": o.category or "egyéb",
            "base_unit": o.base_unit if o.base_unit in ("kg", "l", "db") else "db",
        }
        for o in offers
        if o.product.strip()
    }
    db.table("products").upsert(list(p_map.values()), on_conflict="name").execute()
    existing = db.table("products").select("id, name").execute().data or []
    name_to_id = {row["name"]: row["id"] for row in existing}

    # 2. Ajánlatok
    rows = []
    for o in offers:
        pid = name_to_id.get(o.product.strip())
        rows.append({
            "store_id": store,
            "product_id": pid,
            "raw_name": o.raw_name.strip()[:250],
            "brand": (o.brand or "")[:100] or None,
            "package": (o.package or "")[:50] or None,
            "price": o.price,
            "original_price": o.original_price,
            "unit_price": o.unit_price,
            "valid_from": clean_date(o.valid_from, today),
            "valid_to": clean_date(o.valid_to, None) if o.valid_to else None,
            "source": "flyer",
        })

    saved = 0
    for i in range(0, len(rows), 50):
        batch = rows[i:i + 50]
        res = db.table("offers").upsert(batch, on_conflict="store_id,raw_name,valid_from").execute()
        saved += len(res.data or batch)

    print(f"Sikeresen mentve {saved} akciós újság ajánlat az adatbázisba!")


def main():
    parser = argparse.ArgumentParser(description="Akciós újság beolvasó")
    parser.add_argument("source", help="Fájl elérési út vagy URL (PDF, JPG, PNG)")
    parser.add_argument("--store", required=True, choices=["lidl", "aldi", "tesco", "kifli"], help="Bolt kódja")
    parser.add_argument("--dry", action="store_true", help="Csak kiírás, nem ment az adatbázisba")
    args = parser.parse_args()

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    data, mime = download_if_url(args.source)
    print(f"Feldolgozás Gemini AI-jal ({len(data)} bájt, {mime})...")
    offers = extract_from_flyer(client, args.store, data, mime)
    print(f"{len(offers)} ajánlat felismerve.")

    if args.dry:
        for o in offers[:10]:
            print(f"- {o.raw_name}: {o.price} Ft ({o.unit_price} Ft/{o.base_unit}) | termék: {o.product}")
        return

    save_offers(args.store, offers)


if __name__ == "__main__":
    main()

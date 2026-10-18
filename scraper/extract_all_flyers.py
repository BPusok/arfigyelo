"""Villámgyors párhuzamos akciós újság kinyerő (Lidl 76 oldal + Aldi 25 spread).
Fizetős Gemini Pay-As-You-Go csomaghoz optimalizálva (nincs várakozási idő, többszálú végrehajtás).
Másodpercek alatt kinyeri az összes ajánlatot a Supabase-be.
"""
import os, sys, re, io, time, json, urllib.request, datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv
import pypdf
from google import genai
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


def call_gemini(client: genai.Client, prompt: str) -> list[Offer]:
    for attempt in range(5):
        try:
            r = client.models.generate_content(
                model=MODEL,
                contents=prompt,
                config={"response_mime_type": "application/json", "response_schema": list[Offer]},
            )
            return r.parsed or []
        except Exception as e:
            if "429" in str(e):
                time.sleep(3 * (attempt + 1))
            else:
                print(f"Hiba: {e}", file=sys.stderr)
                time.sleep(2)
    return []


def process_lidl_chunk(client: genai.Client, chunk_info: tuple[int, int, str]) -> list[tuple[str, Offer]]:
    start_idx, end_idx, text = chunk_info
    prompt = (
        f"Ez a Lidl 43. heti (2026.10.22-től érvényes) hivatalos akciós újságjának szövege ({start_idx}-{end_idx}. oldal).\n"
        "Kérlek gyűjtsd ki az ÖSSZES akciós terméket az alábbi szabályok szerint:\n"
        "- valid_from: ha a szövegben van dátum (pl. 10.22, 10.24), használd '2026-MM-DD' formátumban, egyébként '2026-10-22'.\n"
        "- price = akciós eladási ár forintban.\n"
        "- original_price = áthúzott ár forintban (ha van).\n"
        "- unit_price = egységár (Ft/kg, Ft/l, Ft/db).\n"
        "- base_unit = 'kg', 'l' vagy 'db'.\n"
        "- product = a termék egységes általános magyar neve márka nélkül.\n"
        "- category = kategória (zöldség-gyümölcs, hús, tejtermék, pékáru, ital, édesség, non-food, háztartás, egyéb).\n\n"
        f"SZÖVEG:\n{text}"
    )
    offers = call_gemini(client, prompt)
    print(f"  [Lidl] {start_idx}-{end_idx}. oldal kész: {len(offers)} termék kinyerve.", flush=True)
    return [("lidl", o) for o in offers]


def process_aldi_chunk(client: genai.Client, chunk_info: tuple[int, int, str]) -> list[tuple[str, Offer]]:
    start_s, end_s, text = chunk_info
    prompt = (
        f"Ez az Aldi 43. heti (2026.10.22-től érvényes) hivatalos akciós újságjának szövege ({start_s}-{end_s}. spread).\n"
        "Kérlek gyűjtsd ki az ÖSSZES akciós terméket:\n"
        "- valid_from: ha a szövegben van dátum (pl. 10.22, 10.24, 10.25), használd '2026-MM-DD' formátumban, különben '2026-10-22'.\n"
        "- price = akciós ár forintban.\n"
        "- original_price = áthúzott ár forintban, ha van.\n"
        "- unit_price = egységár (Ft / base_unit).\n"
        "- base_unit = 'kg', 'l' vagy 'db'.\n"
        "- product = termék egységes neve márka nélkül.\n"
        "- category = kategória (zöldség-gyümölcs, hús, tejtermék, pékáru, ital, fagyasztott, háztartás, egyéb).\n\n"
        f"SZÖVEG:\n{text}"
    )
    offers = call_gemini(client, prompt)
    print(f"  [Aldi] {start_s}-{end_s}. spread kész: {len(offers)} termék kinyerve.", flush=True)
    return [("aldi", o) for o in offers]


def save_to_supabase(offers_list: list[tuple[str, Offer]]):
    if not offers_list:
        print("Nincs mentendő ajánlat.")
        return

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    db = create_client(url, key)

    print("\nMentés a Supabase adatbázisba...")
    products_map = {}
    for _, o in offers_list:
        pname = o.product.strip()
        if not pname:
            continue
        base_u = o.base_unit if o.base_unit in ("kg", "l", "db") else "db"
        products_map[pname] = {
            "name": pname,
            "category": o.category or "egyéb",
            "base_unit": base_u,
        }

    p_items = list(products_map.values())
    for i in range(0, len(p_items), 50):
        db.table("products").upsert(p_items[i:i + 50], on_conflict="name").execute()

    existing = db.table("products").select("id, name").execute().data or []
    name_to_id = {row["name"]: row["id"] for row in existing}

    rows = []
    seen = set()
    for s, o in offers_list:
        pid = name_to_id.get(o.product.strip())
        v_from = clean_date(o.valid_from, "2026-10-22")
        k = (s, o.raw_name.strip()[:250], v_from)
        if k in seen:
            continue
        seen.add(k)

        rows.append({
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
    for i in range(0, len(rows), 50):
        batch = rows[i:i + 50]
        res = db.table("offers").upsert(batch, on_conflict="store_id,raw_name,valid_from").execute()
        saved += len(res.data or batch)

    print(f"\n==========================================")
    print(f"SIKERES FELDOLGOZÁS!")
    print(f"Összesen {saved} egyedi akciós ajánlat mentve a Supabase-be.")
    print(f"Normalizált termékek száma: {len(products_map)}.")
    print(f"==========================================")


def main():
    start_time = time.time()
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    print("1. Lidl 76 oldalas PDF letöltése...")
    lidl_url = "https://assets.leaflets.schwarz/leaflets/pdfs/01a14593-da6a-76b7-8dbf-cb4215d29c71/Ervenyes-10-22-tol-Akcios-ujsag-43-het-00.pdf"
    req = urllib.request.Request(lidl_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        pdf_bytes = resp.read()

    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    total_pages = len(reader.pages)
    print(f"Lidl PDF kész: {total_pages} oldal.")

    lidl_chunks = []
    block_size = 8
    for start_idx in range(0, total_pages, block_size):
        end_idx = min(start_idx + block_size, total_pages)
        block_text = ""
        for p_num in range(start_idx, end_idx):
            t = reader.pages[p_num].extract_text() or ""
            if t.strip():
                block_text += f"\n--- {p_num + 1}. OLDAL ---\n" + t
        if len(block_text.strip()) >= 80:
            lidl_chunks.append((start_idx + 1, end_idx, block_text))

    print("2. Aldi 25 spread letöltése...")
    aldi_url = "https://szorolap.aldi.hu/aldi_online_akcios_ujsag_2026_kw43/spreads.json"
    req2 = urllib.request.Request(aldi_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req2) as resp2:
        spreads = json.loads(resp2.read().decode("utf-8"))

    aldi_chunks = []
    a_block_size = 3
    for i in range(0, len(spreads), a_block_size):
        chunk = spreads[i:i + a_block_size]
        combined_text = ""
        for s in chunk:
            for p in s.get("pages", []):
                t = p.get("text", "").strip()
                if t:
                    combined_text += t + "\n"
        if len(combined_text.strip()) >= 80:
            aldi_chunks.append((i + 1, min(i + a_block_size, len(spreads)), combined_text))

    print(f"\nPárhuzamos feldolgozás indítása: {len(lidl_chunks)} Lidl blokk és {len(aldi_chunks)} Aldi blokk...")
    all_results = []

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = []
        for c in lidl_chunks:
            futures.append(executor.submit(process_lidl_chunk, client, c))
        for c in aldi_chunks:
            futures.append(executor.submit(process_aldi_chunk, client, c))

        for f in as_completed(futures):
            res = f.result()
            all_results.extend(res)

    print(f"\nÖsszes elemzés befejezve: {len(all_results)} ajánlat kinyerve {time.time() - start_time:.1f} másodperc alatt!")
    save_to_supabase(all_results)


if __name__ == "__main__":
    main()

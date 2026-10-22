"""Márkák összegyűjtése + AI javaslat (kié a sajátmárka, melyik a másik bolt megfelelője).
Kimenet: scraper/brands_proposal.csv -> kézzel átnézendő, jóváhagyás után tölti be brand_import.py.
"""
import os, re, csv
from collections import Counter, defaultdict
from dotenv import load_dotenv
from google import genai
from pydantic import BaseModel
from supabase import create_client

load_dotenv()
MODEL = "gemini-flash-latest"
OUT = os.path.join(os.path.dirname(__file__), "brands_proposal.csv")
# shortcut: ezek a nagybetűs előtagok nem márkák, bővíthető, ha a lista zajos
STOP = {"UHT", "ESL", "BIO", "XL", "XXL", "LIGHT", "MIN", "MAX", "CSAK", "MAGYAR", "FRISS", "ÚJ", "AKCIÓ"}
PREFIX = re.compile(r"^((?:[A-ZÁÉÍÓÖŐÚÜŰ0-9][A-ZÁÉÍÓÖŐÚÜŰ0-9'’&.\-]+)(?:\s+[A-ZÁÉÍÓÖŐÚÜŰ0-9][A-ZÁÉÍÓÖŐÚÜŰ0-9'’&.\-]+){0,2})\b")


class BrandInfo(BaseModel):
    brand: str
    owner_store: str | None = None  # 'lidl' | 'aldi' | null (országos márka)
    kind: str  # 'food' | 'nonfood'
    pair_group: str  # pl. Tejtermék, Barkácsgép, Kávé
    counterpart: str | None = None  # másik bolt megfelelő sajátmárkája, ha van


class BrandBatch(BaseModel):
    items: list[BrandInfo]


def extract_brand(o: dict) -> str | None:
    if o.get("brand"):
        return o["brand"].strip().upper()
    m = PREFIX.match((o["raw_name"] or "").strip())
    if not m:
        return None
    b = m.group(1).strip()
    return None if b.split()[0] in STOP else b.upper()


def main():
    db = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    rows = []
    for s in range(0, 10000, 1000):  # PostgREST 1000 soros limit
        page = db.table("offers").select("store_id, brand, raw_name").range(s, s + 999).execute().data
        rows += page
        if len(page) < 1000:
            break

    stores = defaultdict(Counter)
    for o in rows:
        b = extract_brand(o)
        if b:
            stores[b][o["store_id"]] += 1
    print(f"{len(stores)} egyedi márka")

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    brands = sorted(stores)
    out = []
    for i in range(0, len(brands), 80):
        chunk = brands[i:i + 80]
        lines = "\n".join(f"- {b} (lidl:{stores[b]['lidl']}, aldi:{stores[b]['aldi']})" for b in chunk)
        prompt = (
            "Magyarországi Lidl és Aldi akciós újságokban/webshopban talált márkák. Minden márkához add meg:\n"
            "- owner_store: 'lidl' vagy 'aldi', ha az adott bolt SAJÁTMÁRKÁJA (pl. PARKSIDE=lidl, WORKZONE=aldi, MILSANI=aldi, PILOS/MILBONA=lidl). "
            "Országos/nemzetközi márkánál (Nescafé, Barilla, Kinder) null. Ha nem vagy biztos, null.\n"
            "- kind: 'food' vagy 'nonfood'\n"
            "- pair_group: rövid magyar csoportnév, amiben a két bolt megfelelő márkái összehasonlíthatók (pl. 'Tejtermék', 'Barkácsgép', 'Női ruházat')\n"
            "- counterpart: a MÁSIK bolt megfelelő sajátmárkája, ha biztosan ismered (pl. MILSANI->MILBONA), különben null.\n"
            "Ha a 'márka' valójában nem márka (általános szó), kind='food', pair_group='NEM MÁRKA'.\n\n"
            f"MÁRKÁK:\n{lines}"
        )
        r = client.models.generate_content(
            model=MODEL, contents=prompt,
            config={"response_mime_type": "application/json", "response_schema": BrandBatch},
        )
        out += r.parsed.items if r.parsed else []
        print(f"{min(i + 80, len(brands))}/{len(brands)}", flush=True)

    with open(OUT, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["brand", "owner_store", "kind", "pair_group", "counterpart", "lidl_db", "aldi_db"])
        for it in sorted(out, key=lambda x: (x.owner_store or "z", x.pair_group, x.brand)):
            c = stores.get(it.brand.upper(), Counter())
            w.writerow([it.brand.upper(), it.owner_store or "", it.kind, it.pair_group,
                        (it.counterpart or "").upper(), c["lidl"], c["aldi"]])
    print(f"Kész: {OUT}")


if __name__ == "__main__":
    main()

"""Jóváhagyott brands_proposal.csv betöltése a `brands` táblába + offers.brand egységesítése.
Változatok összevonása (MILSANI UHT -> MILSANI), pár-csoportok fix listára képezése.
"""
import os, csv
from dotenv import load_dotenv
from google import genai
from pydantic import BaseModel
from supabase import create_client
from brand_proposal import extract_brand

load_dotenv()
MODEL = "gemini-flash-latest"
CSV_PATH = os.path.join(os.path.dirname(__file__), "brands_proposal.csv")
GROUPS = ["Tejtermék", "Hús és felvágott", "Pékáru", "Kávé és tea", "Édesség és snack", "Italok",
          "Konzerv és tartós élelmiszer", "Készétel", "Fagyasztott", "Tisztítószer és háztartás",
          "Barkácsgép", "Ruházat", "Háztartási kisgép", "Otthon és lakberendezés", "Szépségápolás",
          "Játék és gyerek", "Sport", "Állateledel", "Egyéb élelmiszer", "Egyéb"]


class Mapping(BaseModel):
    source: str
    target: str


class MapBatch(BaseModel):
    items: list[Mapping]


def norm(b: str) -> str:
    return b.replace("’", "'").strip().upper()


def main():
    rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8-sig"), delimiter=";"))
    rows = [r for r in rows if r["pair_group"] != "NEM MÁRKA"]
    names = {norm(r["brand"]) for r in rows}

    def canon(b: str) -> str:
        b = norm(b)
        parts = b.split()
        for n in range(len(parts) - 1, 0, -1):  # leghosszabb létező előtag nyer
            if " ".join(parts[:n]) in names:
                return " ".join(parts[:n])
        return b

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    free = sorted({r["pair_group"] for r in rows})
    r = client.models.generate_content(
        model=MODEL,
        contents=("Képezd le az alábbi szabad szöveges termékcsoportokat PONTOSAN az egyik megadott csoportra.\n"
                  f"CSOPORTOK: {GROUPS}\n\nLEKÉPEZENDŐ:\n" + "\n".join(f"- {g}" for g in free)),
        config={"response_mime_type": "application/json", "response_schema": MapBatch},
    )
    gmap = {m.source: (m.target if m.target in GROUPS else "Egyéb") for m in r.parsed.items}

    brands = {}
    for row in rows:
        c = canon(row["brand"])
        if c in brands:
            continue
        base = next((x for x in rows if norm(x["brand"]) == c), row)
        brands[c] = {"brand": c, "owner_store": base["owner_store"] or None, "kind": base["kind"],
                     "pair_group": gmap.get(base["pair_group"], "Egyéb")}

    db = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    blist = list(brands.values())
    for i in range(0, len(blist), 100):
        db.table("brands").upsert(blist[i:i + 100], on_conflict="brand").execute()
    print(f"{len(blist)} márka feltöltve")

    # offers.brand egységesítés
    offers = []
    for s in range(0, 10000, 1000):
        page = db.table("offers").select("id, brand, raw_name").range(s, s + 999).execute().data
        offers += page
        if len(page) < 1000:
            break
    todo: dict[str, list[int]] = {}
    for o in offers:
        raw = extract_brand(o)
        c = canon(raw) if raw else None
        if c in brands and norm(o["brand"] or "") != c:
            todo.setdefault(c, []).append(o["id"])
    n = 0
    for c, ids in todo.items():
        for i in range(0, len(ids), 100):
            db.table("offers").update({"brand": c}).in_("id", ids[i:i + 100]).execute()
        n += len(ids)
    print(f"{n} ajánlat márkája frissítve")


if __name__ == "__main__":
    main()

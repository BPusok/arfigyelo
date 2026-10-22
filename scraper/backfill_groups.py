"""Meglévő termékek csoportosítása (product_group) Gemini AI segítségével.
Pl. 'Kovászos cipó' -> 'Kenyér', 'Bécsi virsli' -> 'Virsli', 'Trappista' -> 'Sajt'.
"""
import os, sys, json
from dotenv import load_dotenv
from google import genai
from pydantic import BaseModel
from supabase import create_client

load_dotenv()
MODEL = "gemini-flash-latest"


class ProductCategorization(BaseModel):
    id: int
    name: str
    product_group: str  # Egységes gyűjtőcsoport (pl. Kenyér, Virsli, Sajt, Tej, Vaj, Hús, Zöldség, Gyümölcs, Kávé, Sör, Csokoládé stb.)


class CategorizationResponse(BaseModel):
    items: list[ProductCategorization]


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    db = create_client(url, key)
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    # Lekérjük az összes terméket, ahol még nincs product_group
    prods = db.table("products").select("id, name, category").is_("product_group", "null").execute().data or []
    print(f"Besorolásra váró termékek száma: {len(prods)}")

    if not prods:
        print("Minden termék be van már sorolva!")
        return

    # 100-as kötegekben küldjük a Gemini-nek
    batch_size = 100
    for i in range(0, len(prods), batch_size):
        batch = prods[i:i + batch_size]
        items_json = json.dumps([{"id": p["id"], "name": p["name"], "category": p.get("category")} for p in batch], ensure_ascii=False)

        prompt = (
            "Az alábbi JSON listában magyar élelmiszerek és termékek találhatók id-val és névvel.\n"
            "Minden termékhez határozz meg egy tiszta, egységes, általános magyar termékcsoportot (product_group)!\n"
            "Példák:\n"
            "- 'Kovászos cipó', 'Fehér kenyér', 'Toast kenyér', 'Kifli' -> 'Kenyér és pékáru'\n"
            "- 'Bécsi virsli', 'Pulykavirsli', 'Frankfurti virsli' -> 'Virsli'\n"
            "- 'Trappista sajt', 'Gouda', 'Reszelt mozzarella', 'Cheddar' -> 'Sajt'\n"
            "- 'UHT tej', 'Friss tej', 'Kakaó' -> 'Tej és tejes italok'\n"
            "- 'Teavaj', 'Márkázott vaj' -> 'Vaj és margarin'\n"
            "- 'Csirkemellfilé', 'Csirkecomb', 'Pulykamell' -> 'Baromfihús'\n"
            "- 'Sertéscomb', 'Sertéskaraj', 'Darált hús' -> 'Sertéshús'\n"
            "- 'Alma', 'Banán', 'Mandarin', 'Áfonya' -> 'Gyümölcs'\n"
            "- 'Burgonya', 'Sárgarépa', 'Kígyóuborka', 'Paradicsom' -> 'Zöldség'\n"
            "- 'Sör', 'Bor', 'Pezsgő' -> 'Alkoholos italok'\n"
            "- 'Kávé', 'Tea' -> 'Kávé és tea'\n"
            "- 'Csokoládé', 'Keksz', 'Chips' -> 'Édesség és snack'\n"
            "Ügyelj arra, hogy a hasonló termékek pontosan ugyanazt a csoportnevet kapják (nagy kezdőbetűvel)!\n\n"
            f"TERMÉKEK:\n{items_json}"
        )

        try:
            r = client.models.generate_content(
                model=MODEL,
                contents=prompt,
                config={"response_mime_type": "application/json", "response_schema": CategorizationResponse},
            )
            parsed = r.parsed
            if parsed and parsed.items:
                print(f"  [{i + 1}-{min(i + batch_size, len(prods))}] {len(parsed.items)} termék besorolva. Mentés...")
                # Frissítjük a Supabase-t
                for item in parsed.items:
                    db.table("products").update({"product_group": item.product_group.strip()}).eq("id", item.id).execute()
        except Exception as e:
            print(f"Hiba a köteg feldolgozásakor: {e}", file=sys.stderr)

    print("Minden meglévő termék csoportosítása sikeresen befejeződött!")


if __name__ == "__main__":
    main()

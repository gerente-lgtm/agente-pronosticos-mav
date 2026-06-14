#!/usr/bin/env python3
"""
Carga (una sola vez) la Fecha y Hora de los 72 partidos de fase de grupos en la
base de Notion "Picks Vigentes MAV". Empareja por nombres de equipo (tolera
acentos y variantes como Chequia/República Checa, Catar/Qatar).

Lo usa el comando /update del bot: filtra los partidos por Fecha = hoy.
Las fechas/horas están en hora de Colombia (el calendario que pasó Martín).

Requiere la variable de entorno NOTION_TOKEN (con permiso de escritura).
Se ejecuta desde el workflow "Cargar fechas (una vez)".
"""

import os
import json
import unicodedata
import urllib.request

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
# OJO: aquí va el database_id (de la URL de la base), NO el data_source_id.
# Usar el data_source_id (25ec774d...) en /v1/databases/{id}/query da HTTP 404.
NOTION_DB = os.environ.get("NOTION_PICKS_DB", "71788c0c-8464-4f70-b41a-2afce8f56ae4")
NOTION_VERSION = "2022-06-28"

# (Equipo 1, Equipo 2, Fecha ISO, Hora COL, Grupo) — calendario en hora Colombia.
HORARIO = [
    ("México", "Sudáfrica", "2026-06-11", "14:00", "A"),
    ("Corea del Sur", "Chequia", "2026-06-11", "21:00", "A"),
    ("Canadá", "Bosnia y Herzegovina", "2026-06-12", "14:00", "B"),
    ("Estados Unidos", "Paraguay", "2026-06-12", "20:00", "D"),
    ("Haití", "Escocia", "2026-06-13", "20:00", "C"),
    ("Australia", "Turquía", "2026-06-13", "23:00", "D"),
    ("Brasil", "Marruecos", "2026-06-13", "17:00", "C"),
    ("Catar", "Suiza", "2026-06-13", "14:00", "B"),
    ("Costa de Marfil", "Ecuador", "2026-06-14", "18:00", "E"),
    ("Alemania", "Curazao", "2026-06-14", "12:00", "E"),
    ("Países Bajos", "Japón", "2026-06-14", "15:00", "F"),
    ("Suecia", "Túnez", "2026-06-14", "21:00", "F"),
    ("Arabia Saudita", "Uruguay", "2026-06-15", "17:00", "H"),
    ("España", "Cabo Verde", "2026-06-15", "11:00", "H"),
    ("Irán", "Nueva Zelanda", "2026-06-15", "20:00", "G"),
    ("Bélgica", "Egipto", "2026-06-15", "14:00", "G"),
    ("Francia", "Senegal", "2026-06-16", "14:00", "I"),
    ("Irak", "Noruega", "2026-06-16", "17:00", "I"),
    ("Argentina", "Argelia", "2026-06-16", "20:00", "J"),
    ("Austria", "Jordania", "2026-06-16", "23:00", "J"),
    ("Ghana", "Panamá", "2026-06-17", "18:00", "L"),
    ("Inglaterra", "Croacia", "2026-06-17", "15:00", "L"),
    ("Portugal", "RD del Congo", "2026-06-17", "12:00", "K"),
    ("Uzbekistán", "Colombia", "2026-06-17", "21:00", "K"),
    ("Chequia", "Sudáfrica", "2026-06-18", "11:00", "A"),
    ("Suiza", "Bosnia y Herzegovina", "2026-06-18", "14:00", "B"),
    ("Canadá", "Catar", "2026-06-18", "17:00", "B"),
    ("México", "Corea del Sur", "2026-06-18", "20:00", "A"),
    ("Brasil", "Haití", "2026-06-19", "19:30", "C"),
    ("Escocia", "Marruecos", "2026-06-19", "17:00", "C"),
    ("Turquía", "Paraguay", "2026-06-19", "22:00", "D"),
    ("Estados Unidos", "Australia", "2026-06-19", "14:00", "D"),
    ("Alemania", "Costa de Marfil", "2026-06-20", "15:00", "E"),
    ("Ecuador", "Curazao", "2026-06-20", "19:00", "E"),
    ("Países Bajos", "Suecia", "2026-06-20", "12:00", "F"),
    ("Túnez", "Japón", "2026-06-20", "23:00", "F"),
    ("Uruguay", "Cabo Verde", "2026-06-21", "17:00", "H"),
    ("España", "Arabia Saudita", "2026-06-21", "11:00", "H"),
    ("Bélgica", "Irán", "2026-06-21", "14:00", "G"),
    ("Nueva Zelanda", "Egipto", "2026-06-21", "20:00", "G"),
    ("Noruega", "Senegal", "2026-06-22", "19:00", "I"),
    ("Francia", "Irak", "2026-06-22", "16:00", "I"),
    ("Argentina", "Austria", "2026-06-22", "12:00", "J"),
    ("Jordania", "Argelia", "2026-06-22", "22:00", "J"),
    ("Inglaterra", "Ghana", "2026-06-23", "15:00", "L"),
    ("Panamá", "Croacia", "2026-06-23", "18:00", "L"),
    ("Portugal", "Uzbekistán", "2026-06-23", "12:00", "K"),
    ("Colombia", "RD del Congo", "2026-06-23", "21:00", "K"),
    ("Escocia", "Brasil", "2026-06-24", "17:00", "C"),
    ("Marruecos", "Haití", "2026-06-24", "17:00", "C"),
    ("Suiza", "Canadá", "2026-06-24", "14:00", "B"),
    ("Bosnia y Herzegovina", "Catar", "2026-06-24", "14:00", "B"),
    ("Chequia", "México", "2026-06-24", "20:00", "A"),
    ("Sudáfrica", "Corea del Sur", "2026-06-24", "20:00", "A"),
    ("Curazao", "Costa de Marfil", "2026-06-25", "15:00", "E"),
    ("Ecuador", "Alemania", "2026-06-25", "15:00", "E"),
    ("Japón", "Suecia", "2026-06-25", "18:00", "F"),
    ("Túnez", "Países Bajos", "2026-06-25", "18:00", "F"),
    ("Turquía", "Estados Unidos", "2026-06-25", "21:00", "D"),
    ("Paraguay", "Australia", "2026-06-25", "21:00", "D"),
    ("Noruega", "Francia", "2026-06-26", "14:00", "I"),
    ("Senegal", "Irak", "2026-06-26", "14:00", "I"),
    ("Egipto", "Irán", "2026-06-26", "22:00", "G"),
    ("Nueva Zelanda", "Bélgica", "2026-06-26", "22:00", "G"),
    ("Cabo Verde", "Arabia Saudita", "2026-06-26", "19:00", "H"),
    ("Uruguay", "España", "2026-06-26", "19:00", "H"),
    ("Panamá", "Inglaterra", "2026-06-27", "16:00", "L"),
    ("Croacia", "Ghana", "2026-06-27", "16:00", "L"),
    ("Argelia", "Austria", "2026-06-27", "21:00", "J"),
    ("Jordania", "Argentina", "2026-06-27", "21:00", "J"),
    ("Colombia", "Portugal", "2026-06-27", "18:30", "K"),
    ("RD del Congo", "Uzbekistán", "2026-06-27", "18:30", "K"),
]

# Variantes de nombre Notion <-> tabla, llevadas a una forma canónica.
SINONIMOS = {
    "CHEQUIA": "REPUBLICA CHECA",
    "CATAR": "QATAR",
    "BOSNIA Y HERZEGOVINA": "BOSNIA HERZEGOVINA",
    "RD DEL CONGO": "RD CONGO",
}


def norm(s: str) -> str:
    s = (s or "").upper().strip()
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    s = " ".join(s.split())
    return SINONIMOS.get(s, s)


def _headers():
    return {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def leer_filas() -> list:
    url = f"https://api.notion.com/v1/databases/{NOTION_DB}/query"
    filas, cursor = [], None
    while True:
        payload = {"page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor
        req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                     headers=_headers(), method="POST")
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
        filas.extend(data.get("results", []))
        if data.get("has_more"):
            cursor = data.get("next_cursor")
        else:
            break
    return filas


def rich(props, name):
    arr = props.get(name, {}).get("rich_text", [])
    return "".join(t.get("plain_text", "") for t in arr).strip()


def sel(props, name):
    v = props.get(name, {}).get("select")
    return v.get("name") if v else ""


def patch_fecha_hora(page_id, fecha_iso, hora):
    url = f"https://api.notion.com/v1/pages/{page_id}"
    payload = {"properties": {
        "Fecha": {"date": {"start": fecha_iso}},
        "Hora": {"rich_text": [{"text": {"content": hora}}]},
    }}
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=_headers(), method="PATCH")
    with urllib.request.urlopen(req) as r:
        r.read()


def main() -> int:
    # Mapa por par de equipos normalizado -> (fecha, hora, grupo).
    mapa = {(norm(e1), norm(e2)): (f, h, g) for (e1, e2, f, h, g) in HORARIO}

    filas = leer_filas()
    print(f"Filas leídas en Notion: {len(filas)}")

    actualizadas, sin_match, grupos_dist = 0, [], []
    for fila in filas:
        p = fila.get("properties", {})
        e1, e2 = rich(p, "Equipo 1"), rich(p, "Equipo 2")
        clave = (norm(e1), norm(e2))
        datos = mapa.get(clave) or mapa.get((clave[1], clave[0]))
        if not datos:
            sin_match.append(f"{e1} vs {e2}")
            continue
        fecha_iso, hora, grupo = datos
        try:
            patch_fecha_hora(fila["id"], fecha_iso, hora)
            actualizadas += 1
        except Exception as e:
            sin_match.append(f"{e1} vs {e2} (error: {e})")
            continue
        grupo_notion = sel(p, "Grupo")
        if grupo_notion and grupo_notion != grupo:
            grupos_dist.append(f"{e1} vs {e2}: Notion={grupo_notion} pero debería ser {grupo}")

    print(f"\nFechas/horas actualizadas: {actualizadas}/{len(filas)}")
    if sin_match:
        print(f"\nSIN EMPAREJAR ({len(sin_match)}) — revisar nombres:")
        for s in sin_match:
            print(f"  - {s}")
    if grupos_dist:
        print(f"\nGRUPOS QUE NO COINCIDEN ({len(grupos_dist)}) — NO se tocaron:")
        for s in grupos_dist:
            print(f"  - {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Agente Pronósticos MAV — revisión diaria del Ganagol (Mundial 2026).
Corre en GitHub Actions cada mañana. Busca los partidos del día, investiga
contexto con Claude (usando su herramienta de búsqueda web) según el protocolo
MAV, y envía los picks recomendados a Telegram.

NO envía nada al Google Forms: solo prepara y propone. El usuario confirma.
"""

import os
import sys
import datetime
import urllib.request
import urllib.parse
import json
import anthropic

# ----- Configuración (desde variables de entorno / secretos) -----
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
MODEL = os.environ.get("MAV_MODEL", "claude-sonnet-4-6")

# Notion: base "Picks Vigentes MAV" (fuente de los picks que el usuario edita).
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
NOTION_PICKS_DB = os.environ.get("NOTION_PICKS_DB", "25ec774d-d514-484e-8303-8b8cbaffec34")
NOTION_VERSION = "2022-06-28"

HERE = os.path.dirname(os.path.abspath(__file__))


def cargar_protocolo() -> str:
    with open(os.path.join(HERE, "protocolo_mav.md"), "r", encoding="utf-8") as f:
        return f.read()


def _leer_picks_notion() -> list:
    """Lee los picks vigentes desde la base de Notion. Devuelve lista de dicts
    [{n, equipo1, equipo2, sello, solsticio, disruptivo}], o lanza excepción."""
    url = f"https://api.notion.com/v1/databases/{NOTION_PICKS_DB}/query"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    filas, cursor = [], None
    while True:
        payload = {"page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor
        req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                     headers=headers, method="POST")
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
        filas.extend(data.get("results", []))
        if data.get("has_more"):
            cursor = data.get("next_cursor")
        else:
            break

    def sel(p, name):
        v = p.get(name, {}).get("select")
        return v.get("name") if v else "?"

    def rich(p, name):
        arr = p.get(name, {}).get("rich_text", [])
        return "".join(t.get("plain_text", "") for t in arr).strip()

    def numero(p, name):
        return p.get(name, {}).get("number")

    picks = []
    for f in filas:
        p = f.get("properties", {})
        picks.append({
            "n": numero(p, "N"),
            "equipo1": rich(p, "Equipo 1"),
            "equipo2": rich(p, "Equipo 2"),
            "sello": sel(p, "Sello"),
            "solsticio": sel(p, "Solsticio"),
            "disruptivo": sel(p, "Disruptivo"),
        })
    picks.sort(key=lambda x: (x["n"] is None, x["n"] or 0))
    return picks


def _leer_picks_json() -> list:
    """Fallback: lee formularios_vigentes.json del repo."""
    path = os.path.join(HERE, "formularios_vigentes.json")
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    return doc.get("fase_grupos", [])


def cargar_vigentes_texto() -> str:
    """Devuelve los picks vigentes como tabla compacta de texto para que el
    modelo compare su recomendación contra el estado actual. Primero intenta
    Notion (lo que el usuario edita); si falla, usa el JSON del repo."""
    fuente = ""
    picks = []
    if NOTION_TOKEN:
        try:
            picks = _leer_picks_notion()
            fuente = "Notion (Picks Vigentes MAV)"
        except Exception as e:
            print(f"Aviso: no se pudo leer Notion ({e}). Uso el JSON de respaldo.")
    if not picks:
        try:
            picks = _leer_picks_json()
            fuente = "JSON de respaldo del repo"
        except Exception:
            return "(No se pudo leer el estado vigente; omite la comparación.)"

    lineas = [
        f"#{p['n']} {p['equipo1']} vs {p['equipo2']} → "
        f"Sello:{p['sello']} Solsticio:{p['solsticio']} Disruptivo:{p['disruptivo']}"
        for p in picks
    ]
    return f"(Estado vigente — fuente: {fuente})\n" + "\n".join(lineas)


def fecha_colombia() -> datetime.date:
    # Colombia = UTC-5, sin horario de verano
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).date()


def construir_prompt(hoy: datetime.date) -> str:
    fecha_txt = hoy.strftime("%d de %B de %Y")
    return f"""Hoy es {fecha_txt}. Eres el Agente Pronósticos MAV.

TAREA:
1. Busca en internet TODOS los partidos del Mundial 2026 que se juegan HOY ({fecha_txt}).
   Haz esto en dos pasos para no dejar ninguno por fuera:
   (a) Primero busca el calendario/fixture completo del día y haz una LISTA
       EXHAUSTIVA de todos los partidos del torneo cuyo pitazo caiga hoy. Para
       cada Mundial hay varios partidos por día en fase de grupos (normalmente
       entre 3 y 6). Si tu primera búsqueda devuelve solo 1 o 2, NO te detengas:
       busca de nuevo con otros términos (por jornada, por grupo, "todos los
       partidos de hoy Mundial 2026") hasta tener el calendario completo del día.
   (b) Verifica el conteo: cuenta cuántos part

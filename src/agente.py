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
import time
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
# NOTION_PICKS_DB es el database_id (de la URL de la base), NO el data_source_id.
# Usar el data_source_id (25ec774d...) en /v1/databases/{id}/query da HTTP 404 y
# hacía que la lectura de Notion fallara en silencio y se usara el JSON de respaldo.
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
NOTION_PICKS_DB = os.environ.get("NOTION_PICKS_DB", "71788c0c-8464-4f70-b41a-2afce8f56ae4")
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
        # Reintenta ante hipos de red/API (timeout, 429, 5xx). Sin esto, un solo
        # fallo hacía caer al JSON de respaldo desactualizado.
        data = None
        for intento in range(3):
            try:
                req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                             headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.loads(r.read())
                break
            except Exception:
                if intento == 2:
                    raise
                time.sleep(1.5 * (intento + 1))
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
            "id": f.get("id"),
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


def cargar_vigentes_texto() -> tuple:
    """Devuelve (texto, fuente) con los picks vigentes para que el modelo compare
    su recomendación contra el estado actual. fuente ∈ {'notion', 'json', 'ninguna'}.
    Primero intenta Notion (con reintentos, lo que Martín edita); si falla, usa el
    JSON del repo (que puede estar desactualizado)."""
    picks, fuente = [], "ninguna"
    if NOTION_TOKEN:
        try:
            picks = _leer_picks_notion()
            fuente = "notion"
        except Exception as e:
            print(f"Aviso: no se pudo leer Notion tras reintentos ({e}). Uso el JSON de respaldo.")
    if not picks:
        try:
            picks = _leer_picks_json()
            fuente = "json"
        except Exception:
            return "(No se pudo leer el estado vigente; omite la comparación.)", "ninguna"

    etiqueta = "Notion (Picks Vigentes MAV)" if fuente == "notion" else "JSON de respaldo del repo"
    lineas = [
        f"#{p['n']} {p['equipo1']} vs {p['equipo2']} → "
        f"Sello:{p['sello']} Solsticio:{p['solsticio']} Disruptivo:{p['disruptivo']}"
        for p in picks
    ]
    return f"(Estado vigente — fuente: {etiqueta})\n" + "\n".join(lineas), fuente


def fecha_colombia() -> datetime.date:
    # Colombia = UTC-5, sin horario de verano
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).date()


def construir_prompt(hoy: datetime.date, vigentes_texto: str) -> str:
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
   (b) Verifica el conteo: cuenta cuántos partidos tiene tu lista y confírmalo
       contra el fixture antes de seguir. Reporta TODOS, no solo el más próximo.
   CRITERIO DE DÍA (IMPORTANTE): incluye TODO partido cuyo pitazo (hora de inicio)
   caiga dentro de hoy en HORA DE COLOMBIA (entre las 00:00 y las 23:59 COL),
   sin importar la fecha oficial del fixture FIFA ni la zona horaria del estadio.
   Ejemplo: un partido que arranca a las 23:00 hora Colombia se incluye HOY,
   aunque en la sede ya sea el día siguiente. Incluye también los que ya se
   jugaron hoy más temprano (el usuario igual quiere ver la comparación).
   Lista cada partido con su hora en Colombia, sede y grupo.
2. Para cada partido, investiga lo más reciente: alineaciones probables o
   confirmadas, lesiones/bajas de jugadores clave, forma reciente, contexto,
   sede y clima. Si hay mercados de apuestas o Polymarket disponibles, úsalos
   como referencia de probabilidad/leverage.
3. Aplica el PROTOCOLO MAV (abajo) y decide los picks 1/X/2 recomendados para
   los tres formularios (Sello, Solsticio, Disruptivo) de cada partido del día.
4. COMPARA tu recomendación con el ESTADO VIGENTE de abajo: busca cada partido
   de hoy por los nombres de los equipos y mira qué tiene cargado el usuario en
   cada formulario. Para cada formulario indica si debe DEJAR IGUAL o CAMBIAR.
5. Si no se juega ningún partido hoy (según el criterio de hora Colombia), dilo
   claramente en una sola línea.

FORMATO DE ENVÍO (MUY IMPORTANTE):
- Comienza el bloque de CADA partido con una línea que contenga exactamente:
  ===PARTIDO===
- No escribas NADA antes del primer ===PARTIDO===: ni título, ni saludo, ni un
  resumen o conteo de partidos, ni texto de "estoy buscando...". Tu PRIMERA línea
  de salida debe ser exactamente ===PARTIDO===. (El conteo lo pone el sistema.)
- Después del último partido, agrega una sola línea final con la acción
  ("Acción: aplica solo los cambios marcados 🔄 en el Forms antes de cada pitazo.").
- Sigue el FORMATO DE SALIDA del protocolo para el contenido de cada partido.

Sé honesto: si no encuentras un dato, di "no sé" en vez de inventar.

--- ESTADO VIGENTE (lo que el usuario YA tiene cargado en el Ganagol) ---
{vigentes_texto}

--- PROTOCOLO MAV ---
{cargar_protocolo()}
"""


def consultar_claude(prompt: str) -> str:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    resp = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 12}],
    )
    # Concatena todos los bloques de texto de la respuesta
    partes = [b.text for b in resp.content if getattr(b, "type", None) == "text"]
    return "\n".join(p for p in partes if p).strip()


def enviar_telegram(texto: str) -> None:
    # Telegram limita a ~4096 caracteres por mensaje; partimos si hace falta.
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    for i in range(0, len(texto), 3800):
        chunk = texto[i:i + 3800]
        data = urllib.parse.urlencode({
            "chat_id": TELEGRAM_CHAT_ID,
            "text": chunk,
            "disable_web_page_preview": "true",
        }).encode()
        req = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(req) as r:
            r.read()


def trocear_en_partidos(salida: str) -> list:
    """Separa la salida del modelo en un bloque por partido usando el marcador.
    Descarta cualquier preámbulo antes del primer marcador (resúmenes, saludos).
    Si no hay marcador (ej. 'hoy no hay partidos'), devuelve un solo bloque."""
    marcador = "===PARTIDO==="
    if marcador in salida:
        # Todo lo anterior al primer marcador se descarta (preámbulo del modelo).
        cuerpo = salida.split(marcador, 1)[1]
        partes = [p.strip() for p in cuerpo.split(marcador)]
        return [p for p in partes if p]
    s = salida.strip()
    return [s] if s else []


def main() -> int:
    hoy = fecha_colombia()
    vigentes_texto, fuente = cargar_vigentes_texto()
    try:
        salida = consultar_claude(construir_prompt(hoy, vigentes_texto))
    except Exception as e:
        enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n"
                        f"⚠️ Error al generar los picks: {e}")
        return 1

    # Aviso si NO se pudo leer el estado vigente desde Notion (los "tienes [P]"
    # podrían venir del respaldo desactualizado, o faltar la comparación).
    aviso = ""
    if fuente == "json":
        aviso = ("⚠️ No pude leer Notion; usé el respaldo del repo. Los picks marcados como "
                 "«tienes» pueden estar desactualizados — verifica contra Notion.\n\n")
    elif fuente == "ninguna":
        aviso = ("⚠️ No pude leer el estado vigente (ni Notion ni respaldo); puede faltar la "
                 "comparación «tienes [P]».\n\n")

    bloques = trocear_en_partidos(salida)
    if not bloques:
        enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n{aviso}"
                        "No recibí contenido del modelo. Revisa manualmente los partidos de hoy.")
        return 0

    # Mensaje de encabezado (buenos días)
    n = len(bloques)
    es_no_partidos = (n == 1 and "no" in bloques[0].lower()[:25])
    if es_no_partidos:
        enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n{bloques[0]}")
        print("Sin partidos hoy.")
        return 0

    enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n{aviso}"
                    f"{n} partido(s) hoy. Te envío uno por mensaje 👇")
    for bloque in bloques:
        enviar_telegram(bloque)

    print(f"Enviados {n} bloque(s) a Telegram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

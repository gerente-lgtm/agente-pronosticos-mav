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


def _patch_fecha_notion(page_id: str, fecha_iso: str) -> None:
    """Escribe la propiedad Fecha de una fila de la base Picks Vigentes MAV.
    Requiere que la integración de Notion tenga permiso de escritura."""
    url = f"https://api.notion.com/v1/pages/{page_id}"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    payload = {"properties": {"Fecha": {"date": {"start": fecha_iso}}}}
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=headers, method="PATCH")
    with urllib.request.urlopen(req) as r:
        r.read()


def estampar_fechas_hoy(ns: list, hoy: datetime.date) -> None:
    """Marca Fecha=hoy en las filas de Notion de los partidos de hoy (por N).
    Es lo que permite que el comando /update del bot muestre solo los de hoy.
    Best-effort: si falla, no interrumpe el envío de los picks a Telegram."""
    if not NOTION_TOKEN or not ns:
        return
    try:
        picks = _leer_picks_notion()
    except Exception as e:
        print(f"Aviso: no pude leer Notion para estampar fechas ({e}).")
        return
    por_n = {p["n"]: p.get("id") for p in picks if p.get("id")}
    fecha_iso = hoy.isoformat()
    marcados = 0
    for n in ns:
        page_id = por_n.get(n)
        if not page_id:
            continue
        try:
            _patch_fecha_notion(page_id, fecha_iso)
            marcados += 1
        except Exception as e:
            print(f"Aviso: no pude estampar fecha en N={n} ({e}).")
    print(f"Fechas estampadas en Notion: {marcados}/{len(ns)}.")


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
- AL FINAL DE TODO (en la última línea, después de la acción) agrega el marcador
  ===NUMEROS_HOY=== seguido de los números N (de la tabla ESTADO VIGENTE) de los
  partidos de hoy, separados por coma. Ejemplo: ===NUMEROS_HOY=== 9,10,11
  Si hoy no hay partidos, escribe: ===NUMEROS_HOY=== ninguno
  El sistema usa esa línea para marcar la fecha en Notion y NO se muestra en
  Telegram; por eso debe ir tal cual, con los N exactos del estado vigente.

Sé honesto: si no encuentras un dato, di "no sé" en vez de inventar.

--- ESTADO VIGENTE (lo que el usuario YA tiene cargado en el Ganagol) ---
{cargar_vigentes_texto()}

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


def extraer_numeros_hoy(salida: str):
    """Separa el marcador ===NUMEROS_HOY=== del cuerpo. Devuelve
    (lista_de_N, salida_sin_el_marcador). El marcador no se envía a Telegram."""
    marca = "===NUMEROS_HOY==="
    idx = salida.find(marca)
    if idx == -1:
        return [], salida
    cola = salida[idx + len(marca):].strip()
    primera = cola.splitlines()[0] if cola else ""
    ns = [int(t) for t in primera.replace(" ", "").split(",") if t.isdigit()]
    return ns, salida[:idx].rstrip()


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
    try:
        salida = consultar_claude(construir_prompt(hoy))
    except Exception as e:
        enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n"
                        f"⚠️ Error al generar los picks: {e}")
        return 1

    # Marca en Notion la fecha de hoy en los partidos detectados (para el /update
    # del bot) y quita el marcador antes de enviar a Telegram.
    ns_hoy, salida = extraer_numeros_hoy(salida)
    try:
        estampar_fechas_hoy(ns_hoy, hoy)
    except Exception as e:
        print(f"Aviso: fallo al estampar fechas en Notion ({e}).")

    bloques = trocear_en_partidos(salida)
    if not bloques:
        enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n"
                        "No recibí contenido del modelo. Revisa manualmente los partidos de hoy.")
        return 0

    # Mensaje de encabezado (buenos días)
    n = len(bloques)
    es_no_partidos = (n == 1 and "no" in bloques[0].lower()[:25])
    if es_no_partidos:
        enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n{bloques[0]}")
        print("Sin partidos hoy.")
        return 0

    enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n"
                    f"{n} partido(s) hoy. Te envío uno por mensaje 👇")
    for bloque in bloques:
        enviar_telegram(bloque)

    print(f"Enviados {n} bloque(s) a Telegram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

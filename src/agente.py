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

HERE = os.path.dirname(os.path.abspath(__file__))


def cargar_protocolo() -> str:
    with open(os.path.join(HERE, "protocolo_mav.md"), "r", encoding="utf-8") as f:
        return f.read()


def cargar_vigentes_texto() -> str:
    """Lee formularios_vigentes.json y lo devuelve como tabla compacta de texto
    para que el modelo compare su recomendación contra el estado actual."""
    path = os.path.join(HERE, "formularios_vigentes.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except Exception:
        return "(No se pudo leer el estado vigente; omite la comparación.)"
    lineas = []
    for p in doc.get("fase_grupos", []):
        lineas.append(
            f"#{p['n']} {p['equipo1']} vs {p['equipo2']} → "
            f"Sello:{p['sello']} Solsticio:{p['solsticio']} Disruptivo:{p['disruptivo']}"
        )
    actualizado = doc.get("actualizado", "")
    return f"(Estado vigente, actualizado {actualizado})\n" + "\n".join(lineas)


def fecha_colombia() -> datetime.date:
    # Colombia = UTC-5, sin horario de verano
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).date()


def construir_prompt(hoy: datetime.date) -> str:
    fecha_txt = hoy.strftime("%d de %B de %Y")
    return f"""Hoy es {fecha_txt}. Eres el Agente Pronósticos MAV.

TAREA:
1. Busca en internet qué partidos del Mundial 2026 se juegan HOY ({fecha_txt}).
   CRITERIO DE DÍA (IMPORTANTE): incluye TODO partido cuyo pitazo (hora de inicio)
   caiga dentro de hoy en HORA DE COLOMBIA (entre las 00:00 y las 23:59 COL),
   sin importar la fecha oficial del fixture FIFA ni la zona horaria del estadio.
   Ejemplo: un partido que arranca a las 23:00 hora Colombia se incluye HOY,
   aunque en la sede ya sea el día siguiente. El usuario puede modificar ese pick
   en el Forms hasta su pitazo, así que cuenta como del día de hoy.
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
{cargar_vigentes_texto()}

--- PROTOCOLO MAV ---
{cargar_protocolo()}
"""


def consultar_claude(prompt: str) -> str:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    resp = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}],
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
    try:
        salida = consultar_claude(construir_prompt(hoy))
    except Exception as e:
        enviar_telegram(f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n"
                        f"⚠️ Error al generar los picks: {e}")
        return 1

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

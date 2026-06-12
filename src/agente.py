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


def fecha_colombia() -> datetime.date:
    # Colombia = UTC-5, sin horario de verano
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).date()


def construir_prompt(hoy: datetime.date) -> str:
    fecha_txt = hoy.strftime("%d de %B de %Y")
    return f"""Hoy es {fecha_txt}. Eres el Agente Pronósticos MAV.

TAREA:
1. Busca en internet qué partidos del Mundial 2026 se juegan HOY ({fecha_txt}),
   con su hora en Colombia, sede y grupo.
2. Para cada partido, investiga lo más reciente: alineaciones probables o
   confirmadas, lesiones/bajas de jugadores clave, forma reciente, contexto,
   sede y clima. Si hay mercados de apuestas o Polymarket disponibles, úsalos
   como referencia de probabilidad/leverage.
3. Aplica el PROTOCOLO MAV (abajo) y entrega los picks 1/X/2 para los tres
   formularios (Sello, Solsticio, Disruptivo) de cada partido del día.
4. Si no se juega ningún partido hoy, dilo claramente en una línea.

Responde en el FORMATO DE SALIDA que indica el protocolo, listo para Telegram.
Sé honesto: si no encuentras un dato, di "no sé" en vez de inventar.

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


def main() -> int:
    hoy = fecha_colombia()
    encabezado = f"🤖 Agente Pronósticos MAV — {hoy.strftime('%d/%m/%Y')}\n\n"
    try:
        salida = consultar_claude(construir_prompt(hoy))
    except Exception as e:
        enviar_telegram(encabezado + f"⚠️ Error al generar los picks: {e}")
        return 1
    if not salida:
        salida = "No recibí contenido del modelo. Revisa manualmente los partidos de hoy."
    enviar_telegram(encabezado + salida)
    print("Picks enviados a Telegram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

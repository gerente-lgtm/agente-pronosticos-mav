# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

Agente que cada mañana revisa los partidos del Mundial 2026 que se juegan hoy, investiga
contexto (lesiones, forma, clima) con Claude + web_search, aplica el "Protocolo MAV" y envía
a Telegram los picks recomendados 1/X/2 para tres formularios (Sello, Solsticio, Disruptivo)
del Bono Ganagol. **No escribe en Google Forms ni en Notion: solo propone; Martín confirma.**

Es uno de tres componentes del sistema (ver `CONTEXTO_Mundial_2026_MAV.md` en la raíz, el
documento de traspaso con el estado completo del proyecto y los IDs de Notion):
1. Este agente (`agente-pronosticos-mav`).
2. Tracker web (repo separado `tracker-mav`).
3. Notion como fuente única de datos (bases "Picks Vigentes MAV" y "Tracker MAV — Balances").

El idioma del proyecto es español; mantén comentarios, mensajes y commits en español.

## Comandos

```bash
# Ejecutar el agente localmente (requiere las variables de entorno, ver abajo)
python src/agente.py

# Dependencia única
pip install anthropic
```

No hay tests, linter ni build. La verificación real es: correr el script y ver que llegue el
mensaje a Telegram (o disparar el workflow a mano desde la pestaña Actions → "Run workflow").

Variables de entorno requeridas (en GitHub son Secrets):
- `ANTHROPIC_API_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` (obligatorias).
- `NOTION_TOKEN` (opcional; sin ella usa el JSON de respaldo).
- `MAV_MODEL` (opcional; default `claude-sonnet-4-6`), `NOTION_PICKS_DB` (opcional).

## Arquitectura

Un solo script, `src/agente.py`, ejecutado por GitHub Actions
(`.github/workflows/revision-diaria.yml`). Flujo en `main()`:

1. **`fecha_colombia()`** — calcula "hoy" en hora Colombia (UTC-5, sin DST). Crítico: el
   criterio de "partidos de hoy" es el pitazo en hora Colombia 00:00–23:59, **no** la fecha
   FIFA del estadio. Esto está explicado a fondo en el prompt y debe respetarse.
2. **`cargar_vigentes_texto()`** — lee el estado vigente de los picks. **Primero intenta
   Notion** (base "Picks Vigentes MAV", lo que Martín edita); si falla, cae al respaldo
   `src/formularios_vigentes.json`. Esto permite que el modelo compare "tienes [P]" vs
   "recomiendo [R]".
3. **`construir_prompt()`** — arma el prompt con: fecha, instrucciones de búsqueda exhaustiva
   del fixture del día, el estado vigente, y `src/protocolo_mav.md` completo.
4. **`consultar_claude()`** — una sola llamada a la API con la tool `web_search` (hasta 12
   usos). Concatena los bloques de texto de la respuesta.
5. **`trocear_en_partidos()`** — el modelo separa cada partido con el marcador literal
   `===PARTIDO===`. Esta función descarta todo preámbulo antes del primer marcador y parte la
   salida en un mensaje por partido.
6. **`enviar_telegram()`** — envía a Telegram troceando a ~3800 chars (límite de ~4096).

### Las tres piezas que definen el comportamiento

- **`src/protocolo_mav.md`** — la "lógica de negocio". Define los lineamientos de cada
  formulario (Sello = probabilidad pura/ancla; Solsticio = Sello salvo clima o suerte
  histórica; Disruptivo = upset con disciplina), el check de leverage, y el **FORMATO DE
  SALIDA exacto** que el modelo debe producir para Telegram. Para cambiar cómo razona o cómo
  se ve la salida, se edita este markdown, **no** el código Python.
- **El prompt en `construir_prompt()`** — define el proceso (buscar fixture completo, criterio
  de hora Colombia, comparar vs vigente, emitir `===PARTIDO===`).
- **`src/formularios_vigentes.json`** — respaldo local de los 72 picks de fase de grupos.
  Solo se usa si Notion no responde. La fuente real y editable es Notion.

### Contrato implícito modelo ↔ código

El código depende de dos convenciones que el modelo debe cumplir (definidas en el prompt y el
protocolo):
- El marcador `===PARTIDO===` separa partidos y nada debe precederlo.
- "Hoy no hay partidos" se detecta heurísticamente: un solo bloque cuyas primeras ~25 letras
  contienen "no" (`es_no_partidos` en `main()`). Si cambias el texto de "sin partidos" en el
  protocolo, revisa esa heurística.

## El cron (punto delicado, ver CONTEXTO doc sección 5)

GitHub Actions omite casi siempre los cron en repos **privados** de cuentas gratuitas; por eso
este repo se hizo **público**. Si el cron programado no dispara (solo funciona "Run workflow"
manual), el problema suele ser ese, no el código. Plan B documentado: cron-job.org externo
llamando al `workflow_dispatch`. Los horarios de producción son 6:40/7:00/7:20 AM COL
(`"40 11"`, `"0 12"`, `"20 12"` UTC). El workflow puede tener horarios de prueba temporales;
restaurar los de producción al terminar de validar.

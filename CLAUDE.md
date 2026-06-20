# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

Agente que cada mañana revisa los partidos del Mundial 2026 que se juegan hoy, investiga
contexto (lesiones, forma, clima) con Claude + web_search, aplica el "Protocolo MAV" y envía
a Telegram los picks recomendados 1/X/2 para tres formularios (Sello, Solsticio, Disruptivo)
del Bono Ganagol. **El agente diario (`src/agente.py`) solo propone: no envía nada.**

Hay además un **listener de Telegram** (`listener/`, ver sección abajo) que sí actúa por orden
de Martín: con `/update` escribe picks en la base de Notion y le entrega un link del Forms
**pre-llenado** — pero el envío real al concurso de Juan Ramón siempre lo confirma él (abre el
link y le da Enviar).

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

## Listener de Telegram (Cloudflare Worker) — `listener/worker.js`

Worker siempre prendido que recibe el webhook de Telegram (valida `WEBHOOK_SECRET`; solo
atiende el chat de Martín). Hace tres cosas:

- **`/picks`** — dispara el `workflow_dispatch` de `revision-diaria.yml` (corre el agente a pedido).
- **`/update`** — flujo guiado por botones: muestra los partidos de hoy **que aún no empiezan**
  (lee Notion filtrando por `Fecha` = hoy y descarta los que ya pasaron su `Hora`) → formulario
  → valor 1/X/2 → entrega un link del Forms **pre-llenado** y, al confirmar "ya lo envié",
  escribe el pick en Notion (`PATCH` del select). Es la única parte que ESCRIBE en Notion.
- **Disparo diario** (handler `scheduled`): un **Cron Trigger** de Cloudflare a `0 12 * * *`
  (12:00 UTC = 7:00 AM COL) llama al workflow. **Reemplaza al cron de GitHub**, que no dispara
  confiable en esta cuenta ni con el repo público (por eso `revision-diaria.yml` ya solo tiene
  `workflow_dispatch`, sin `schedule`).

Detalles clave (ganados a las malas):
- El header `X-GitHub-Api-Version` debe ser soportado (**`2022-11-28`**); `2022-06-28` quedó
  obsoleto y GitHub responde **400**. Aplica a cualquier llamada a la API de GitHub.
- `MATCH_FORM` (en `worker.js`) mapea cada partido (N) a su fase y al `entry.*` de su fila en
  el Forms, para armar el link pre-llenado. Cubre los partidos aún editables. **Si Juan recrea
  el formulario, los `entry.*` cambian y hay que regenerar el mapa** leyendo el HTML del Forms
  (el bloque `FB_PUBLIC_LOAD_DATA_`).
- El campo "Correo electrónico" del Forms es el de recolección automática de Google: **no se
  puede pre-llenar** por link (probado). El navegador lo autocompleta.
- Los secretos del Worker viven en **Cloudflare** (no en GitHub): `GITHUB_TOKEN` (PAT
  fine-grained, Actions R/W), `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_SECRET`,
  `NOTION_TOKEN` (con permiso de escritura). Despliegue paso a paso en `listener/README.md`.

## Notion: IDs, columnas y carga de fechas

- Base "Picks Vigentes MAV". **Para la API usa el `database_id` `71788c0c-8464-4f70-b41a-2afce8f56ae4`,
  NO el `data_source_id` `25ec774d-...`** — usar el data_source_id en `/v1/databases/{id}/query`
  da **HTTP 404**. Este error hacía que `agente.py` cayera en silencio al JSON de respaldo en vez
  de leer Notion; ya está corregido en `agente.py` y en `worker.js`.
- Columnas que el `/update` necesita: `Fecha` (date) y `Hora` (text). Se llenan **una sola vez**
  con el calendario completo de fase de grupos vía `scripts/cargar_fechas.py`, que se corre a
  mano desde Actions → workflow **"Cargar fechas (una vez)"** (`cargar-fechas.yml`). El script
  empareja por nombres de equipo (tolera acentos y variantes Chequia/Catar, etc.) y reporta los
  que no emparejen o cuyo grupo no coincida.

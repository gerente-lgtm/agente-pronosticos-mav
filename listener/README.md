# Listener de Telegram — comandos /picks y /update

Hace que, escribiéndole al bot en Telegram:
- **`/picks`** → se ejecuta el workflow "Revisión diaria MAV" (el mismo del cron de
  las 7 AM) y llegan los picks del día. Sirve también como **respaldo manual** si el
  cron no dispara.
- **`/update`** (o `/actualizar`) → flujo guiado por botones: eliges el partido (solo
  los de hoy que aún no empiezan) → el formulario (Sello/Solsticio/Disruptivo) → el
  valor (1/X/2). El bot te entrega un **link del Forms ya pre-llenado** con tu nombre
  (MAV - …), la fase y el partido; lo abres, revisas y le das Enviar, y al tocar
  "Ya lo envié" el bot guarda el cambio en Notion. Cancelar en cualquier paso.

  El mapa partido→campo del Forms vive en `MATCH_FORM` dentro de `worker.js`. Si Juan
  recrea el formulario y cambian los `entry.*`, hay que regenerar ese mapa leyendo el
  HTML del formulario (el bloque `FB_PUBLIC_LOAD_DATA_`).

  **Cambio de formulario para la fase final (jun 2026):** al terminar los grupos, Juan
  reusó el **mismo documento** de Forms (misma URL) y lo rearmó para la eliminación.
  El desplegable de fase pasó de tener grupos a tener solo Dieciseisavos → Octavos →
  Cuartos → Semifinal → Final y 3er Puesto, y **todos los `entry.*` cambiaron** (también
  los de "Pronóstico" y "¿Qué fase desea editar?"). Por eso `MATCH_FORM` ya no tiene los
  partidos 1–72 (grupos, ya jugados) sino:
  - **Dieciseisavos (73–88):** con equipos confirmados.
  - **Octavos→Final (89–104):** `entry.*` ya mapeados desde el HTML (van por número de
    partido); los equipos se cargan en Notion al definirse cada ronda.

  Los N de `MATCH_FORM` coinciden con la numeración oficial FIFA y con la columna `N` de
  Notion (el `/update` mapea N de Notion → `entry` del Forms, así que deben ir alineados).
  El **Email** se pre-llena con `&emailAddress=` (recolección automática de Google, no es
  un `entry.*`). **Ojo con la navegación condicional:** el Forms tiene 6 páginas por rama
  según la fase; el pre-llenado de los partidos puede no "saltar" la navegación solo, así
  que hay que avanzar con *Siguiente* y confirmar que el 1/X/2 quedó marcado antes de
  enviar (queda por probar en la práctica).

  > Tras editar `worker.js` hay que **redesplegar el Worker** en Cloudflare (Edit code →
  > pegar → Deploy); el push a GitHub no actualiza el Worker por sí solo.

Los "partidos de hoy" salen de la columna **Fecha** de la base "Picks Vigentes MAV".
Esa columna se llena una sola vez con el calendario completo de fase de grupos
mediante el workflow **"Cargar fechas (una vez)"** (ver `scripts/cargar_fechas.py`).

Es un **Cloudflare Worker**: un mini-programa gratis que queda siempre prendido
escuchando a Telegram. GitHub Actions no puede escuchar; por eso va aparte.

```
Telegram (/picks) → Cloudflare Worker → GitHub workflow_dispatch → agente.py → Telegram (picks)
```

## Qué vas a necesitar

- Una cuenta en Cloudflare (gratis).
- El **token del bot** de Telegram (`TELEGRAM_TOKEN`) y tu **chat id** (`TELEGRAM_CHAT_ID`)
  — son los mismos secretos que ya están en GitHub.
- Un **token nuevo de GitHub** (el anterior se revocó). Fine-grained, repo
  `agente-pronosticos-mav`, permiso **Actions: Read and write**.
- Una **palabra secreta** que inventes (`WEBHOOK_SECRET`), ej. una frase larga sin espacios.

## Pasos (todo por la web, sin instalar nada)

### 1. Crear el Worker
1. Entra a https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
2. Nómbralo `agente-mav-listener` → **Deploy** (crea uno de ejemplo).
3. **Edit code** → borra todo y pega el contenido de [`worker.js`](worker.js) → **Deploy**.

### 2. Configurar los secretos
En el Worker → **Settings** → **Variables and Secrets** → **Add**, crea estos 4
(tipo **Secret**, no Text):

| Nombre | Valor |
|---|---|
| `GITHUB_TOKEN` | el PAT nuevo de GitHub (`github_pat_...`) |
| `TELEGRAM_TOKEN` | token del bot @agente_mav_bot |
| `TELEGRAM_CHAT_ID` | tu chat id |
| `WEBHOOK_SECRET` | la palabra secreta que inventaste |
| `NOTION_TOKEN` | token de la integración "Agente MAV" (con permiso de escritura) |

Guarda y **Deploy** de nuevo si lo pide.

> El `NOTION_TOKEN` lo necesita el comando `/update` para leer y escribir en la base.
> La integración debe tener activado **Update content** en https://www.notion.so/my-integrations.

### 3. Copiar la URL del Worker
En la página del Worker aparece una URL tipo:
`https://agente-mav-listener.TU-SUBDOMINIO.workers.dev` — cópiala.

### 4. Conectar Telegram al Worker (webhook)
Pega esta URL en el navegador, reemplazando `<TELEGRAM_TOKEN>`, `<WORKER_URL>` y
`<WEBHOOK_SECRET>` por tus valores:

```
https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>
```

Debe responder `{"ok":true, ... "description":"Webhook was set"}`.

### 5. Probar
Escríbele **`/picks`** al bot. Debe contestar "estoy generando los picks…" y en
1–2 min llegan las recomendaciones.

### 6. Disparo diario automático (Cron Trigger)
El Worker también corre el agente cada mañana solo (reemplaza al cron de GitHub,
que en cuentas gratuitas no dispara confiable). En el Worker → **Settings** →
**Triggers** → **Cron Triggers** → **Add** la expresión:

```
0 12 * * *
```

(12:00 UTC = 7:00 AM hora Colombia.) Eso ejecuta el handler `scheduled` de
`worker.js`, que llama al `workflow_dispatch` del workflow "Revisión diaria MAV".

## Seguridad
- Solo **tu** chat (`TELEGRAM_CHAT_ID`) puede disparar el workflow; a cualquier otro lo ignora.
- El `WEBHOOK_SECRET` evita que alguien que adivine la URL del Worker lo dispare.
- Los tokens viven como **secretos en Cloudflare**, nunca en este repo.

## Si algo falla
- El bot no responde nada → revisa el webhook (paso 4) y que `WEBHOOK_SECRET` coincida
  en Cloudflare y en la URL del setWebhook.
- Responde "no pude lanzar el proceso" → el `GITHUB_TOKEN` está mal o sin permiso
  "Actions: Read and write".
- Para ver el detalle: en Cloudflare, Worker → **Logs** (Real-time logs).

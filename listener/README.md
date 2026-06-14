# Listener de Telegram — disparar el agente con /picks

Hace que, al escribirle **`/picks`** al bot en Telegram, se ejecute el workflow
"Revisión diaria MAV" (el mismo del cron de las 7 AM) y lleguen los picks del día.
Sirve como función nueva y como **respaldo manual** si el cron no dispara.

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

Guarda y **Deploy** de nuevo si lo pide.

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

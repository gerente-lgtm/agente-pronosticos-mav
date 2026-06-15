// Listener de Telegram para el Agente Pronósticos MAV (Cloudflare Worker).
//
// Comandos:
//   /picks               → dispara el workflow de GitHub y manda los picks del día.
//   /update | /actualizar → flujo guiado por botones: elige partido (solo los de hoy
//                           que aún no empiezan) → formulario → valor 1/X/2. El bot
//                           entrega un link del Forms YA PRE-LLENADO; Martín lo abre,
//                           revisa y envía, y al confirmar el bot guarda en Notion.
//
// El "partido de hoy" sale de la columna Fecha de la base "Picks Vigentes MAV", que
// se carga una vez con el calendario completo (workflow "Cargar fechas").
//
// Secretos en Cloudflare → Settings → Variables and Secrets:
//   GITHUB_TOKEN      → PAT fine-grained "Actions: Read and write" sobre el repo.
//   TELEGRAM_TOKEN    → token del bot @agente_mav_bot.
//   TELEGRAM_CHAT_ID  → chat de Martín; SOLO ese chat puede usar el bot.
//   WEBHOOK_SECRET    → palabra secreta que Telegram manda en el header.
//   NOTION_TOKEN      → token de la integración "Agente MAV" (con permiso de escritura).
//   MAV_EMAIL         → (variable) correo para pre-llenar el campo de correo del Forms.

const REPO = "gerente-lgtm/agente-pronosticos-mav";
const WORKFLOW_FILE = "revision-diaria.yml";
// database_id de la base Picks Vigentes MAV (de la URL). OJO: NO es el
// data_source_id (25ec774d...), que en /v1/databases/{id}/query da HTTP 404.
const NOTION_DB = "71788c0c-8464-4f70-b41a-2afce8f56ae4";
const NOTION_VERSION = "2022-06-28"; // versión de la API de Notion (válida)

// ---- Formulario de Juan Ramón (para generar links pre-llenados) ----
const FORM_VIEW =
  "https://docs.google.com/forms/d/e/1FAIpQLSchbOBjdB-987wnWMSDiYd1jvEqhFUqRvttVAsM-ijxuuLbtw/viewform";
const ENTRY_PRONOSTICO = "entry.333536740"; // desplegable "Pronóstico" (qué formulario)
const ENTRY_FASE = "entry.1118126026"; // "¿Qué fase desea editar?"
const PRONOSTICO = {
  Sello: "MAV - SELLO",
  Solsticio: "MAV - SOLSTICIO",
  Disruptivo: "MAV - DISRUPTIVO",
};
// N de partido -> { phase: opción de fase, entry: campo de la fila en la grilla }.
// Generado desde el formulario; cubre los partidos aún editables (no jugados).
// Si cambia el formulario, regenerar (ver listener/README.md).
const MATCH_FORM = {
  10: { phase: "Grupo F", entry: "entry.2097471829" },
  11: { phase: "Grupo E", entry: "entry.1069429518" },
  12: { phase: "Grupo F", entry: "entry.1117731183" },
  13: { phase: "Grupo H", entry: "entry.321886448" },
  14: { phase: "Grupo G", entry: "entry.1548300475" },
  15: { phase: "Grupo H", entry: "entry.189437360" },
  16: { phase: "Grupo G", entry: "entry.1961136234" },
  17: { phase: "Grupo I", entry: "entry.1594909871" },
  18: { phase: "Grupo I", entry: "entry.203645401" },
  19: { phase: "Grupo J", entry: "entry.681539997" },
  20: { phase: "Grupo J", entry: "entry.1537161926" },
  21: { phase: "Grupo K", entry: "entry.1379825598" },
  22: { phase: "Grupo L", entry: "entry.297707473" },
  23: { phase: "Grupo L", entry: "entry.1160309496" },
  24: { phase: "Grupo K", entry: "entry.2030991840" },
  25: { phase: "Grupo A", entry: "entry.1567106053" },
  26: { phase: "Grupo B", entry: "entry.1796992615" },
  27: { phase: "Grupo B", entry: "entry.478600219" },
  28: { phase: "Grupo A", entry: "entry.464921062" },
  29: { phase: "Grupo D", entry: "entry.278303135" },
  30: { phase: "Grupo C", entry: "entry.1450083711" },
  31: { phase: "Grupo C", entry: "entry.937413470" },
  32: { phase: "Grupo D", entry: "entry.251320165" },
  33: { phase: "Grupo F", entry: "entry.1419020317" },
  34: { phase: "Grupo E", entry: "entry.828053866" },
  35: { phase: "Grupo E", entry: "entry.1233850960" },
  36: { phase: "Grupo F", entry: "entry.1717090229" },
  37: { phase: "Grupo H", entry: "entry.1945501812" },
  38: { phase: "Grupo G", entry: "entry.1428787829" },
  39: { phase: "Grupo H", entry: "entry.632519440" },
  40: { phase: "Grupo G", entry: "entry.266125407" },
  41: { phase: "Grupo J", entry: "entry.849132542" },
  42: { phase: "Grupo I", entry: "entry.1684104528" },
  43: { phase: "Grupo I", entry: "entry.357656181" },
  44: { phase: "Grupo J", entry: "entry.1787352918" },
  45: { phase: "Grupo K", entry: "entry.632768083" },
  46: { phase: "Grupo L", entry: "entry.1117690586" },
  47: { phase: "Grupo L", entry: "entry.214017504" },
  48: { phase: "Grupo K", entry: "entry.2006263827" },
  49: { phase: "Grupo B", entry: "entry.488929516" },
  50: { phase: "Grupo B", entry: "entry.1033784882" },
  51: { phase: "Grupo C", entry: "entry.1839000064" },
  52: { phase: "Grupo C", entry: "entry.1659790144" },
  53: { phase: "Grupo A", entry: "entry.751819717" },
  54: { phase: "Grupo A", entry: "entry.1777000105" },
  55: { phase: "Grupo E", entry: "entry.291602745" },
  56: { phase: "Grupo E", entry: "entry.2014400191" },
  57: { phase: "Grupo F", entry: "entry.1446267601" },
  58: { phase: "Grupo F", entry: "entry.902906700" },
  59: { phase: "Grupo D", entry: "entry.341526811" },
  60: { phase: "Grupo D", entry: "entry.465446993" },
  61: { phase: "Grupo I", entry: "entry.1959305606" },
  62: { phase: "Grupo I", entry: "entry.580687493" },
  63: { phase: "Grupo H", entry: "entry.80555283" },
  64: { phase: "Grupo H", entry: "entry.1244693565" },
  65: { phase: "Grupo G", entry: "entry.1219524415" },
  66: { phase: "Grupo G", entry: "entry.2025558146" },
  67: { phase: "Grupo L", entry: "entry.235241352" },
  68: { phase: "Grupo L", entry: "entry.1082440585" },
  69: { phase: "Grupo K", entry: "entry.815108800" },
  70: { phase: "Grupo K", entry: "entry.534211244" },
  71: { phase: "Grupo J", entry: "entry.24058358" },
  72: { phase: "Grupo J", entry: "entry.1558250329" },
};

function prefillUrl(env, form, n, val) {
  const m = MATCH_FORM[n];
  const pron = PRONOSTICO[form];
  if (!m || !pron) return null;
  let q =
    `usp=pp_url&${ENTRY_PRONOSTICO}=${encodeURIComponent(pron)}` +
    `&${ENTRY_FASE}=${encodeURIComponent(m.phase)}` +
    `&${m.entry}=${encodeURIComponent(val)}`;
  // Correo (campo de Google "Recopilar correos"). Se toma de una variable de
  // Cloudflare para no exponerlo en el repo público. Si no está, no se pre-llena.
  if (env.MAV_EMAIL) q += `&emailAddress=${encodeURIComponent(env.MAV_EMAIL)}`;
  return `${FORM_VIEW}?${q}`;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Listener MAV activo.", { status: 200 });
    }
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    try {
      if (update.callback_query) {
        await manejarBoton(update.callback_query, env);
      } else {
        await manejarMensaje(update.message || update.edited_message, env);
      }
    } catch (e) {
      // Nunca devolvemos error a Telegram (reintentaría). Solo lo registramos.
      console.log("Error manejando update:", e);
    }
    return new Response("OK", { status: 200 });
  },

  // Disparo diario del agente. Lo activa un "Cron Trigger" de Cloudflare configurado
  // a "0 12 * * *" (12:00 UTC = 7:00 AM Colombia). Reemplaza al cron de GitHub, que
  // en cuentas gratuitas no dispara confiable. Ver listener/README.md.
  // Si algo falla, avisa por Telegram (en vez de quedar como "Error" silencioso).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const r = await dispararWorkflow(env);
          if (!r.ok) {
            await tgSend(env, env.TELEGRAM_CHAT_ID,
              `⚠️ Disparo automático (cron): GitHub respondió ${r.status}. ${r.detalle || ""}`);
          }
        } catch (e) {
          await tgSend(env, env.TELEGRAM_CHAT_ID,
            `⚠️ Disparo automático (cron) falló: ${String(e)}`);
        }
      })()
    );
  },
};

// ---------- Mensajes de texto ----------

async function manejarMensaje(msg, env) {
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return; // solo Martín

  const text = msg.text.trim().toLowerCase();

  if (text === "/picks" || text === "/picks@agente_mav_bot") {
    const r = await dispararWorkflow(env);
    await tgSend(env, chatId, r.ok
      ? "🤖 Listo, estoy generando los picks de hoy. En 1-2 min te llegan 👇"
      : `⚠️ No pude lanzar el proceso (código ${r.status}). ${r.detalle}`);
    return;
  }

  if (text === "/update" || text === "/actualizar" ||
      text === "/update@agente_mav_bot" || text === "/actualizar@agente_mav_bot") {
    const partidos = await notionHoy(env);
    if (!partidos.length) {
      await tgSend(env, chatId,
        "Hoy no hay partidos en el calendario. (Si crees que sí, puede faltar cargar las fechas en Notion.)");
      return;
    }
    const teclado = partidos.map((p) => [
      { text: `${p.e1} vs ${p.e2}`, callback_data: `m|${p.n}` },
    ]);
    teclado.push([{ text: "❌ Cancelar", callback_data: "x" }]);
    await tgSend(env, chatId, "¿Qué partido editaste en el Forms?", teclado);
    return;
  }

  if (text === "/start" || text === "/help") {
    await tgSend(env, chatId,
      "Comandos:\n• /picks — genero las recomendaciones de los partidos de hoy.\n• /update — corrijo en Notion un pick que cambiaste en el Forms.");
  }
}

// ---------- Botones (callback_query) ----------

async function manejarBoton(cq, env) {
  const chatId = String(cq.message.chat.id);
  const messageId = cq.message.message_id;
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
    await tgAnswer(env, cq.id);
    return;
  }

  const parts = (cq.data || "").split("|");
  const kind = parts[0];

  if (kind === "x") {
    await tgEdit(env, chatId, messageId, "❌ Cancelado. No se hicieron cambios.");
    await tgAnswer(env, cq.id);
    return;
  }

  // Elegir partido → preguntar qué formulario
  if (kind === "m") {
    const n = parts[1];
    const teclado = [
      [{ text: "A. Sello", callback_data: `f|${n}|Sello` }],
      [{ text: "B. Solsticio", callback_data: `f|${n}|Solsticio` }],
      [{ text: "C. Disruptivo", callback_data: `f|${n}|Disruptivo` }],
      [{ text: "❌ Cancelar", callback_data: "x" }],
    ];
    await tgEdit(env, chatId, messageId, "¿Qué pronóstico cambiaste?", teclado);
    await tgAnswer(env, cq.id);
    return;
  }

  // Elegir formulario → mostrar lo que tiene Notion y preguntar el nuevo valor
  if (kind === "f") {
    const n = parts[1];
    const form = parts[2];
    const row = await notionPorN(env, n);
    if (!row) {
      await tgEdit(env, chatId, messageId, "No encontré ese partido. Intenta de nuevo con /update.");
      await tgAnswer(env, cq.id);
      return;
    }
    const actual = row[form.toLowerCase()] || "(vacío)";
    const teclado = [
      [
        { text: "1", callback_data: `v|${n}|${form}|1` },
        { text: "X", callback_data: `v|${n}|${form}|X` },
        { text: "2", callback_data: `v|${n}|${form}|2` },
      ],
      [{ text: "No cambié nada", callback_data: `v|${n}|${form}|nc` }],
      [{ text: "❌ Cancelar", callback_data: "x" }],
    ];
    await tgEdit(env, chatId, messageId,
      `${row.e1} vs ${row.e2}\n${form}: en Notion tienes «${actual}».\n¿Qué dejaste en el Forms de Juan Ramón?`,
      teclado);
    await tgAnswer(env, cq.id);
    return;
  }

  // Elegir valor → dar el Forms pre-llenado para que Martín lo envíe él mismo.
  if (kind === "v") {
    const n = parts[1];
    const form = parts[2];
    const val = parts[3];
    if (val === "nc") {
      await tgEdit(env, chatId, messageId, "✅ Listo, no se hicieron cambios.");
      await tgAnswer(env, cq.id);
      return;
    }
    const url = prefillUrl(env, form, n, val);
    if (!url) {
      // Sin enlace para este partido: actualizo Notion directo y aviso editar a mano.
      const row = await notionPorN(env, n);
      const ok = row && (await notionActualizarSelect(env, row.id, form, val));
      await tgEdit(env, chatId, messageId, ok
        ? `✅ Guardado en Notion: ${form}: ${val}.\nEste partido no tiene enlace pre-llenado; edítalo a mano en el Forms.`
        : "⚠️ No pude actualizar Notion. Revisa NOTION_TOKEN.");
      await tgAnswer(env, cq.id);
      return;
    }
    const teclado = [
      [{ text: "📝 Abrir Forms (pre-llenado)", url }],
      [{ text: "✅ Ya lo envié → guardar en Notion", callback_data: `d|${n}|${form}|${val}` }],
      [{ text: "❌ Cancelar", callback_data: "x" }],
    ];
    await tgEdit(env, chatId, messageId,
      `Te dejé el Forms pre-llenado como ${PRONOSTICO[form]} → ${val}.\n\n` +
      `1) Ábrelo, revisa y dale Enviar en el Forms.\n` +
      `2) Vuelve y toca “Ya lo envié” para guardarlo en Notion.`,
      teclado);
    await tgAnswer(env, cq.id);
    return;
  }

  // Confirmación de envío → ahora sí actualizar Notion.
  if (kind === "d") {
    const n = parts[1];
    const form = parts[2];
    const val = parts[3];
    const row = await notionPorN(env, n);
    const ok = row && (await notionActualizarSelect(env, row.id, form, val));
    await tgEdit(env, chatId, messageId, ok
      ? `✅ Guardado en Notion:\n${row.e1} vs ${row.e2}\n${form}: ${val}`
      : "⚠️ No pude actualizar Notion. Revisa que NOTION_TOKEN tenga permiso de escritura.");
    await tgAnswer(env, cq.id);
    return;
  }

  await tgAnswer(env, cq.id);
}

// ---------- GitHub ----------

async function dispararWorkflow(env) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "agente-mav-listener",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (resp.status === 204) return { ok: true };
  let detalle = "";
  try { detalle = (await resp.text()).slice(0, 250); } catch {}
  return { ok: false, status: resp.status, detalle };
}

// ---------- Notion ----------

function notionHeaders(env) {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function hoyColombia() {
  // Colombia = UTC-5, sin horario de verano.
  return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
}

function minutosColombia() {
  // Minutos transcurridos del día actual en hora Colombia.
  const c = new Date(Date.now() - 5 * 3600000);
  return c.getUTCHours() * 60 + c.getUTCMinutes();
}

function horaAMinutos(h) {
  const m = /^(\d{1,2}):(\d{2})/.exec(h || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function filaDesdePagina(pg) {
  const p = pg.properties || {};
  const sel = (name) => (p[name] && p[name].select ? p[name].select.name : "");
  const rich = (name) =>
    p[name] && p[name].rich_text ? p[name].rich_text.map((t) => t.plain_text).join("") : "";
  const num = (name) => (p[name] ? p[name].number : null);
  return {
    id: pg.id,
    n: num("N"),
    e1: rich("Equipo 1"),
    e2: rich("Equipo 2"),
    hora: rich("Hora"),
    sello: sel("Sello"),
    solsticio: sel("Solsticio"),
    disruptivo: sel("Disruptivo"),
  };
}

async function notionHoy(env) {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB}/query`;
  const body = { filter: { property: "Fecha", date: { equals: hoyColombia() } }, page_size: 100 };
  const resp = await fetch(url, { method: "POST", headers: notionHeaders(env), body: JSON.stringify(body) });
  if (!resp.ok) return [];
  const data = await resp.json();
  let filas = (data.results || []).map(filaDesdePagina);
  // Ocultar los partidos que ya dieron pitazo (hora de inicio <= ahora en Colombia),
  // para no editar por error uno ya empezado. Si una fila no tiene hora, se muestra.
  const ahora = minutosColombia();
  filas = filas.filter((f) => {
    const ko = horaAMinutos(f.hora);
    return ko === null || ko > ahora;
  });
  filas.sort((a, b) => (a.n || 0) - (b.n || 0));
  return filas;
}

async function notionPorN(env, n) {
  const url = `https://api.notion.com/v1/databases/${NOTION_DB}/query`;
  const body = { filter: { property: "N", number: { equals: Number(n) } }, page_size: 1 };
  const resp = await fetch(url, { method: "POST", headers: notionHeaders(env), body: JSON.stringify(body) });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.results || !data.results.length) return null;
  return filaDesdePagina(data.results[0]);
}

async function notionActualizarSelect(env, pageId, form, val) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const body = { properties: { [form]: { select: { name: val } } } };
  const resp = await fetch(url, { method: "PATCH", headers: notionHeaders(env), body: JSON.stringify(body) });
  return resp.ok;
}

// ---------- Telegram ----------

async function tgSend(env, chatId, text, teclado) {
  const body = { chat_id: chatId, text };
  if (teclado) body.reply_markup = { inline_keyboard: teclado };
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tgEdit(env, chatId, messageId, text, teclado) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (teclado) body.reply_markup = { inline_keyboard: teclado };
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tgAnswer(env, callbackId, text) {
  const body = { callback_query_id: callbackId };
  if (text) body.text = text;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

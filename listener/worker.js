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

const REPO = "gerente-lgtm/agente-pronosticos-mav";
const WORKFLOW_FILE = "revision-diaria.yml";
// database_id de la base Picks Vigentes MAV (de la URL). OJO: NO es el
// data_source_id (25ec774d...), que en /v1/databases/{id}/query da HTTP 404.
const NOTION_DB = "71788c0c-8464-4f70-b41a-2afce8f56ae4";
const NOTION_VERSION = "2022-06-28"; // versión de la API de Notion (válida)

// ---- Formulario de Juan Ramón (para generar links pre-llenados) ----
// Juan reusó el MISMO documento de Forms (misma URL) y lo rearmó para la fase
// final: el desplegable de fase ya no tiene grupos (solo Dieciseisavos→Final) y
// TODOS los entry.* cambiaron. Por eso ENTRY_PRONOSTICO/ENTRY_FASE y MATCH_FORM
// se regeneraron desde el HTML nuevo (bloque FB_PUBLIC_LOAD_DATA_). Ver README.
const FORM_VIEW =
  "https://docs.google.com/forms/d/e/1FAIpQLSchbOBjdB-987wnWMSDiYd1jvEqhFUqRvttVAsM-ijxuuLbtw/viewform";
const ENTRY_PRONOSTICO = "entry.1733454846"; // desplegable "Pronóstico" (qué formulario)
const ENTRY_FASE = "entry.1932888000"; // "¿Que fase desea editar?"
// El Email es de recolección automática de Google: NO se pre-llena con un entry.*,
// sino con el parámetro especial &emailAddress=. (El navegador igual lo autocompleta
// si Martín ya tiene sesión; esto es un refuerzo.)
const EMAIL = "manono32@gmail.com";
const PRONOSTICO = {
  Sello: "MAV - SELLO",
  Solsticio: "MAV - SOLSTICIO",
  Disruptivo: "MAV - DISRUPTIVO",
};
// N de partido (numeración oficial FIFA, igual que en Notion) -> { phase, entry }.
//   phase = opción EXACTA del campo "¿Que fase desea editar?" (entry.1932888000).
//   entry = campo 1/X/2 de ese partido en el Forms.
// La fase de grupos (N 1-72) ya terminó: Juan reconstruyó el MISMO formulario para
// la fase final, así que esos entry.* viejos se eliminaron y aquí ya no van.
// Octavos→Final (89-104) ya quedaron mapeados desde el HTML (el orden de los entry
// sigue la numeración de partido); los equipos se llenarán en Notion al definirse.
// Si Juan vuelve a recrear el formulario, regenerar (ver listener/README.md).
const MATCH_FORM = {
  // Dieciseisavos de Final (73-88) — equipos confirmados
  73: { phase: "Dieciseisavos de Final", entry: "entry.2118226769" }, // Sudáfrica - Canadá
  74: { phase: "Dieciseisavos de Final", entry: "entry.397906492" }, // Alemania - Paraguay
  75: { phase: "Dieciseisavos de Final", entry: "entry.1781559261" }, // Países Bajos - Marruecos
  76: { phase: "Dieciseisavos de Final", entry: "entry.2095044498" }, // Brasil - Japón
  77: { phase: "Dieciseisavos de Final", entry: "entry.1093874664" }, // Francia - Suecia
  78: { phase: "Dieciseisavos de Final", entry: "entry.2146985311" }, // Costa de Marfil - Noruega
  79: { phase: "Dieciseisavos de Final", entry: "entry.1282885633" }, // México - Ecuador
  80: { phase: "Dieciseisavos de Final", entry: "entry.21340784" }, // Inglaterra - RD Congo
  81: { phase: "Dieciseisavos de Final", entry: "entry.1536413203" }, // Estados Unidos - Bosnia y Herzegovina
  82: { phase: "Dieciseisavos de Final", entry: "entry.1801104802" }, // Bélgica - Senegal
  83: { phase: "Dieciseisavos de Final", entry: "entry.1964534821" }, // Portugal - Croacia
  84: { phase: "Dieciseisavos de Final", entry: "entry.961815495" }, // España - Austria
  85: { phase: "Dieciseisavos de Final", entry: "entry.158754040" }, // Suiza - Argelia
  86: { phase: "Dieciseisavos de Final", entry: "entry.1462427909" }, // Argentina - Cabo Verde
  87: { phase: "Dieciseisavos de Final", entry: "entry.1321152750" }, // Colombia - Ghana
  88: { phase: "Dieciseisavos de Final", entry: "entry.1090640977" }, // Australia - Egipto
  // Octavos de Final (89-96) — equipos por definir; entry ya mapeado
  89: { phase: "Octavos de Final", entry: "entry.1886201498" },
  90: { phase: "Octavos de Final", entry: "entry.1887649088" },
  91: { phase: "Octavos de Final", entry: "entry.866848116" },
  92: { phase: "Octavos de Final", entry: "entry.686024072" },
  93: { phase: "Octavos de Final", entry: "entry.776928103" },
  94: { phase: "Octavos de Final", entry: "entry.974896850" },
  95: { phase: "Octavos de Final", entry: "entry.1123384809" },
  96: { phase: "Octavos de Final", entry: "entry.751674502" },
  // Cuartos de Final (97-100) — equipos por definir
  97: { phase: "Cuartos de Final", entry: "entry.373169074" },
  98: { phase: "Cuartos de Final", entry: "entry.931302959" },
  99: { phase: "Cuartos de Final", entry: "entry.557154252" },
  100: { phase: "Cuartos de Final", entry: "entry.799987062" },
  // Semifinal (101-102) — equipos por definir
  101: { phase: "Semifinal", entry: "entry.1959617231" },
  102: { phase: "Semifinal", entry: "entry.797875772" },
  // 3er Puesto (103) y Final (104) — usan la misma opción de fase
  103: { phase: "Final y 3er Puesto", entry: "entry.1930004699" },
  104: { phase: "Final y 3er Puesto", entry: "entry.89152736" },
};

function prefillUrl(env, form, n, val) {
  const m = MATCH_FORM[n];
  const pron = PRONOSTICO[form];
  if (!m || !pron) return null;
  // El Email va como &emailAddress (recolección automática de Google; no es entry.*).
  // OJO (navegación condicional): el Forms tiene 6 páginas por rama según la fase. El
  // pre-llenado de páginas posteriores puede no "saltar" la navegación solo, así que
  // Martín debe avanzar con Siguiente y confirmar que el 1/X/2 quedó marcado antes de
  // enviar. Esto hay que probarlo en la práctica.
  const q =
    `usp=pp_url&emailAddress=${encodeURIComponent(EMAIL)}` +
    `&${ENTRY_PRONOSTICO}=${encodeURIComponent(pron)}` +
    `&${ENTRY_FASE}=${encodeURIComponent(m.phase)}` +
    `&${m.entry}=${encodeURIComponent(val)}`;
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
      `1) Ábrelo. El Forms tiene páginas por fase: avanza con “Siguiente” y ` +
      `confirma que el partido quedó marcado en ${val} antes de enviar.\n` +
      `2) Dale Enviar en el Forms.\n` +
      `3) Vuelve y toca “Ya lo envié” para guardarlo en Notion.`,
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

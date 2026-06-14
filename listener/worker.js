// Listener de Telegram para el Agente Pronósticos MAV (Cloudflare Worker).
//
// Comandos:
//   /picks               → dispara el workflow de GitHub y manda los picks del día.
//   /update | /actualizar → flujo guiado por botones para corregir un pick en Notion:
//                           elige partido (solo los de hoy) → formulario → valor 1/X/2.
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
const NOTION_DB = "25ec774d-d514-484e-8303-8b8cbaffec34"; // base Picks Vigentes MAV
const NOTION_VERSION = "2022-06-28"; // versión de la API de Notion (válida)
const FORMS = ["Sello", "Solsticio", "Disruptivo"];

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

  // Elegir valor → actualizar Notion (o no) y confirmar
  if (kind === "v") {
    const n = parts[1];
    const form = parts[2];
    const val = parts[3];
    if (val === "nc") {
      await tgEdit(env, chatId, messageId, "✅ Listo, no se hicieron cambios.");
      await tgAnswer(env, cq.id);
      return;
    }
    const row = await notionPorN(env, n);
    if (!row) {
      await tgEdit(env, chatId, messageId, "No encontré ese partido. Intenta /update de nuevo.");
      await tgAnswer(env, cq.id);
      return;
    }
    const ok = await notionActualizarSelect(env, row.id, form, val);
    await tgEdit(env, chatId, messageId, ok
      ? `✅ Actualizado en Notion:\n${row.e1} vs ${row.e2}\n${form}: ${val}`
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
  const filas = (data.results || []).map(filaDesdePagina);
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

// Listener de Telegram para el Agente Pronósticos MAV (Cloudflare Worker).
//
// Qué hace: queda "prendido" siempre esperando mensajes de Telegram. Cuando
// Martín le escribe /picks al bot, este Worker dispara el workflow
// "Revisión diaria MAV" en GitHub (el mismo que corre el cron de las 7 AM).
// El workflow corre agente.py y envía los picks a Telegram como siempre.
//
// Por qué un Worker y no GitHub Actions: GitHub Actions solo se ejecuta y se
// apaga; no puede quedarse escuchando. El Worker sí (y es gratis y siempre activo).
//
// Secretos que necesita (se configuran en Cloudflare → Settings → Variables and Secrets):
//   GITHUB_TOKEN      → PAT fine-grained con permiso "Actions: Read and write" sobre el repo.
//   TELEGRAM_TOKEN    → token del bot @agente_mav_bot (para responder en el chat).
//   TELEGRAM_CHAT_ID  → chat de Martín; SOLO ese chat puede disparar el workflow.
//   WEBHOOK_SECRET    → palabra secreta para verificar que el POST viene de Telegram.
//
// Ver listener/README.md para el despliegue paso a paso.

const REPO = "gerente-lgtm/agente-pronosticos-mav";
const WORKFLOW_FILE = "revision-diaria.yml";

export default {
  async fetch(request, env) {
    // Telegram siempre llama por POST. Cualquier otra cosa (ej. abrir la URL en
    // el navegador) responde OK para confirmar que el Worker está vivo.
    if (request.method !== "POST") {
      return new Response("Listener MAV activo.", { status: 200 });
    }

    // Seguridad: el POST debe traer el secreto que Telegram envía en el header.
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK", { status: 200 }); // siempre 200 para que Telegram no reintente
    }

    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return new Response("OK", { status: 200 });

    const chatId = String(msg.chat.id);
    const text = msg.text.trim().toLowerCase();

    // Solo el chat de Martín puede disparar; a cualquier otro lo ignoramos.
    if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
      return new Response("OK", { status: 200 });
    }

    if (text === "/picks" || text === "/picks@agente_mav_bot") {
      const r = await dispararWorkflow(env);
      const respuesta = r.ok
        ? "🤖 Listo, estoy generando los picks de hoy. En 1-2 min te llegan 👇"
        : `⚠️ No pude lanzar el proceso (código ${r.status}). ${r.detalle}`;
      await responderTelegram(env, chatId, respuesta);
    } else if (text === "/start" || text === "/help") {
      await responderTelegram(
        env,
        chatId,
        "Escríbeme /picks y genero las recomendaciones de los partidos de hoy."
      );
    }

    return new Response("OK", { status: 200 });
  },
};

async function dispararWorkflow(env) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-06-28",
      "Content-Type": "application/json",
      "User-Agent": "agente-mav-listener", // GitHub exige User-Agent
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 204 No Content = éxito al disparar el workflow.
  if (resp.status === 204) return { ok: true };
  let detalle = "";
  try {
    detalle = (await resp.text()).slice(0, 250);
  } catch {}
  return { ok: false, status: resp.status, detalle };
}

async function responderTelegram(env, chatId, texto) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto }),
  });
}

// src/telegram.js
// Kumpulan helper kecil buat ngomong sama Telegram Bot API.

const TG_API = (token) => `https://api.telegram.org/bot${token}`;
const TG_FILE_API = (token) => `https://api.telegram.org/file/bot${token}`;

export async function tgCall(env, method, payload) {
  const res = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.log("Telegram API error:", method, JSON.stringify(data));
  }
  return data;
}

export function sendMessage(env, chatId, text, extra = {}) {
  // Telegram batasin ~4096 karakter per pesan, potong kalau kepanjangan.
  const chunks = splitText(text, 3500);
  return Promise.all(
    chunks.map((chunk) =>
      tgCall(env, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        ...extra,
      })
    )
  );
}

export function splitText(text, size) {
  if (!text) return [""];
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

// Kirim file (dokumen) ke chat. `bytes` harus Uint8Array atau ArrayBuffer.
export async function sendDocument(env, chatId, filename, bytes, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 1024));
  const blob = new Blob([bytes]);
  form.append("document", blob, filename);
  const res = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.log("sendDocument error:", JSON.stringify(data));
  }
  return data;
}

// Download isi file dari Telegram berdasarkan file_id -> ArrayBuffer.
export async function downloadTelegramFile(env, fileId) {
  const info = await tgCall(env, "getFile", { file_id: fileId });
  if (!info.ok) throw new Error("Gagal ambil info file dari Telegram");
  const filePath = info.result.file_path;
  const res = await fetch(`${TG_FILE_API(env.TELEGRAM_BOT_TOKEN)}/${filePath}`);
  if (!res.ok) throw new Error("Gagal download file dari Telegram");
  return await res.arrayBuffer();
}

export function editMessageText(env, chatId, messageId, text) {
  return tgCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
  });
}

export async function setWebhook(env, url) {
  return tgCall(env, "setWebhook", {
    url,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
}

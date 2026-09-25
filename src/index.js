// src/index.js
import {
  sendMessage,
  sendDocument,
  downloadTelegramFile,
  tgCall,
} from "./telegram.js";
import { unzipToFileMap, fileMapToZip } from "./zipfiles.js";
import { editCode, parseEditedFiles, extractExplanation } from "./llm.js";

const PENDING_TTL_SECONDS = 6 * 60 * 60; // 6 jam

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    console.log("DEBUG path masuk:", url.pathname);
    console.log("DEBUG path diharapkan:", `/webhook/${env.WEBHOOK_SECRET}`);

    if (request.method === "POST" && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      try {
        const update = await request.json();
        // Jangan block response ke Telegram nunggu semua proses selesai kalau bisa dihindari,
        // tapi karena harus reply hasil edit, kita proses sekalian di sini.
        await handleUpdate(update, env, ctx);
      } catch (err) {
        console.log("handleUpdate error:", err && err.stack ? err.stack : err);
      }
      return new Response("OK");
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("telegram-code-bot is running.");
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleUpdate(update, env, ctx) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;

  if (!isAllowed(env, chatId)) {
    await sendMessage(env, chatId, "⛔ Bot ini private, chat ID kamu tidak diizinkan.");
    return;
  }

  const text = message.text || "";

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendMessage(
      env,
      chatId,
      "👋 <b>Halo!</b> Aku bot bantu edit code.\n\n" +
        "Cara pakai:\n" +
        "1. Kirim file code (.js, .py, dst) atau file .zip project kamu.\n" +
        "2. Kirim pesan teks isinya instruksi edit (mau ditambah/diubah apa).\n" +
        "   (Boleh juga langsung tulis instruksi di <i>caption</i> waktu kirim file.)\n" +
        "3. Aku proses ke model, terus kirim balik file hasil editnya.\n" +
        "4. Bisa lanjut kasih instruksi lagi buat nge-edit hasil sebelumnya.\n\n" +
        "Command lain:\n" +
        "/reset — hapus file yang lagi diproses, mulai dari awal."
    );
    return;
  }

  if (text.startsWith("/reset")) {
    await env.BOT_KV.delete(pendingKey(chatId));
    await sendMessage(env, chatId, "🔄 Sip, state direset. Kirim file baru kapan aja.");
    return;
  }

  // User kirim dokumen (file kode atau zip)
  if (message.document) {
    await handleDocument(message, env, chatId);
    return;
  }

  // User kirim teks biasa -> anggap sebagai instruksi buat file yang lagi pending
  if (text) {
    const pending = await getPending(env, chatId);
    if (!pending) {
      await sendMessage(
        env,
        chatId,
        "Belum ada file yang lagi diproses. Kirim dulu file code atau .zip-nya, ya."
      );
      return;
    }
    await processInstruction(env, chatId, pending, text);
    return;
  }
}

async function handleDocument(message, env, chatId) {
  const doc = message.document;
  const filename = doc.file_name || "file";
  const isZip =
    filename.toLowerCase().endsWith(".zip") ||
    doc.mime_type === "application/zip" ||
    doc.mime_type === "application/x-zip-compressed";

  await sendMessage(env, chatId, `📥 Lagi download <b>${escapeHtml(filename)}</b>...`);

  let arrayBuffer;
  try {
    arrayBuffer = await downloadTelegramFile(env, doc.file_id);
  } catch (err) {
    await sendMessage(env, chatId, `❌ Gagal download file: ${err.message}`);
    return;
  }

  let pending;
  try {
    if (isZip) {
      const files = unzipToFileMap(arrayBuffer);
      const count = Object.keys(files).length;
      if (count === 0) {
        await sendMessage(env, chatId, "❌ Zip-nya kosong atau gagal dibaca.");
        return;
      }
      pending = { type: "zip", filename, files };
      await sendMessage(
        env,
        chatId,
        `✅ Zip diterima, ${count} file terdeteksi.\nSekarang kirim instruksi editnya (mau diubah/ditambah apa).`
      );
    } else {
      const text = new TextDecoder("utf-8").decode(arrayBuffer);
      pending = { type: "single", filename, files: { [filename]: { text } } };
      await sendMessage(
        env,
        chatId,
        `✅ File <b>${escapeHtml(filename)}</b> diterima.\nSekarang kirim instruksi editnya.`
      );
    }
  } catch (err) {
    await sendMessage(env, chatId, `❌ Gagal proses file: ${err.message}`);
    return;
  }

  await setPending(env, chatId, pending);

  // Kalau user nulis instruksi langsung di caption, langsung proses.
  if (message.caption && message.caption.trim()) {
    await processInstruction(env, chatId, pending, message.caption.trim());
  }
}

async function processInstruction(env, chatId, pending, instruction) {
  await sendMessage(env, chatId, "🤖 Lagi mikir & ngedit code...");

  let raw;
  try {
    raw = await editCode(env, pending.files, instruction);
  } catch (err) {
    await sendMessage(env, chatId, `❌ Gagal manggil model: ${err.message}`);
    return;
  }

  const parsed = parseEditedFiles(raw);
  const explanation = extractExplanation(raw);

  if (Object.keys(parsed).length === 0) {
    // Model gak ngikutin format -> tampilkan mentah aja biar user tetap dapet sesuatu.
    await sendMessage(
      env,
      chatId,
      "⚠️ Model gak balikin format file yang dikenali. Ini jawaban mentahnya:"
    );
    await sendMessage(env, chatId, raw);
    return;
  }

  // Merge hasil edit ke pending.files supaya instruksi berikutnya bisa nyambung.
  for (const [path, content] of Object.entries(parsed)) {
    pending.files[path] = { text: content };
  }
  await setPending(env, chatId, pending);

  const changedList = Object.keys(parsed).join(", ");
  const captionBase = `✅ Selesai. File diubah/ditambah: ${changedList}`;

  try {
    if (pending.type === "single" && Object.keys(pending.files).length === 1) {
      const [onlyPath, onlyEntry] = Object.entries(pending.files)[0];
      const bytes = new TextEncoder().encode(onlyEntry.text || "");
      await sendDocument(env, chatId, baseName(onlyPath) || pending.filename, bytes, captionBase);
    } else {
      const zipBytes = fileMapToZip(pending.files);
      const outName = pending.type === "zip" ? `edited_${pending.filename}` : `edited_${pending.filename}.zip`;
      await sendDocument(env, chatId, outName, zipBytes, captionBase);
    }
  } catch (err) {
    await sendMessage(env, chatId, `❌ Gagal kirim file hasil: ${err.message}`);
  }

  if (explanation) {
    await sendMessage(env, chatId, explanation);
  }

  await sendMessage(
    env,
    chatId,
    "Mau edit lagi? Langsung kirim instruksi berikutnya. Atau /reset buat mulai dari file baru."
  );
}

function pendingKey(chatId) {
  return `pending:${chatId}`;
}

async function getPending(env, chatId) {
  const raw = await env.BOT_KV.get(pendingKey(chatId));
  return raw ? JSON.parse(raw) : null;
}

async function setPending(env, chatId, pending) {
  await env.BOT_KV.put(pendingKey(chatId), JSON.stringify(pending), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
}

function isAllowed(env, chatId) {
  if (!env.ALLOWED_CHAT_IDS) return true; // gak diset = semua boleh (gak disarankan buat production)
  const allowed = env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim());
  return allowed.includes(String(chatId));
}

function baseName(path) {
  return path.split("/").pop();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

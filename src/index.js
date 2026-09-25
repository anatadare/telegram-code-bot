// src/index.js
import {
  sendMessage,
  sendDocument,
  downloadTelegramFile,
  editMessageText,
} from "./telegram.js";
import { unzipToFileMap, fileMapToZip } from "./zipfiles.js";
import { editCode, parseEditedFiles, extractExplanation } from "./llm.js";

const PENDING_TTL_SECONDS = 6 * 60 * 60; // 6 jam

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      let update;
      try {
        update = await request.json();
      } catch (err) {
        return new Response("Bad Request", { status: 400 });
      }
      // PENTING: proses beratnya (download file / panggil LLM / kirim hasil) TIDAK
      // dijalanin langsung di sini pake ctx.waitUntil() lagi. Cloudflare cuma ngasih
      // jatah tambahan ~30 detik buat waitUntil() setelah response ini dikirim, terus
      // proses yang belum kelar langsung DIBUNUH PAKSA tanpa sempet ngasih tau error
      // apapun -> makanya sebelumnya bot suka "freeze" diem selamanya kalau modelnya
      // butuh reasoning/proses lebih dari 30 detik.
      //
      // Solusinya: taruh update-nya ke Queue, terus jawab "OK" ke Telegram. Proses
      // beratnya dikerjain di handler queue() di bawah, yang jatah waktunya 15 MENIT
      // (bukan 30 detik), jadi model boleh mikir lama tanpa bikin bot-nya kepotong.
      try {
        await env.JOB_QUEUE.send(update);
      } catch (err) {
        console.log("Gagal masukin update ke queue:", err && err.stack ? err.stack : err);
      }
      return new Response("OK");
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("telegram-code-bot is running.");
    }

    return new Response("Not found", { status: 404 });
  },

  // Ini "pekerja" yang beneran ngerjain proses berat (download file, panggil LLM,
  // kirim hasil), dipanggil Cloudflare pas ada pesan baru masuk ke queue. Wall-clock
  // time limit-nya 15 menit -> jauh lebih dari cukup buat model reasoning yang lama.
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        await handleUpdate(message.body, env, ctx);
      } catch (err) {
        console.log("queue handleUpdate error:", err && err.stack ? err.stack : err);
      }
      // Selalu ack (walau error) -> errornya udah ditangani & dikasih tau ke user
      // lewat setStatus di processInstruction. Kalau nggak di-ack, queue bakal
      // nyoba ulang otomatis dan bisa bikin user dapet pesan dobel.
      message.ack();
    }
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
    if (pending.processing) {
      await sendMessage(
        env,
        chatId,
        "⏳ Masih ada proses edit yang lagi jalan, tunggu dulu ya sampai selesai (atau /reset kalau mau batalin & mulai ulang)."
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
  // Tandain lagi proses, biar instruksi lain yang nyusul gak numpuk jadi proses baru.
  pending.processing = true;
  await setPending(env, chatId, pending);

  try {
    await processInstructionInner(env, chatId, pending, instruction);
  } finally {
    // Apapun hasilnya (sukses/gagal/timeout), lepas flag processing di akhir.
    pending.processing = false;
    await setPending(env, chatId, pending);
  }
}

async function processInstructionInner(env, chatId, pending, instruction) {
  const startMsgs = await sendMessage(env, chatId, "📖 Membaca file & instruksi kamu...");
  const messageId = startMsgs?.[0]?.result?.message_id;

  const setStatus = async (text) => {
    if (!messageId) return;
    try {
      await editMessageText(env, chatId, messageId, text);
    } catch (err) {
      console.log("setStatus gagal edit pesan:", err && err.message ? err.message : err);
    }
  };

  await setStatus("🔍 Menganalisa struktur code & instruksi kamu...");

  let raw;
  try {
    raw = await editCode(env, pending.files, instruction, setStatus);
  } catch (err) {
    console.log("editCode error:", err && err.stack ? err.stack : err);
    await setStatus(`❌ Gagal: ${err.message}`);
    return;
  }

  await setStatus("🧩 Model selesai nulis, lagi nyusun & mengecek hasil...");

  const parsed = parseEditedFiles(raw);
  const explanation = extractExplanation(raw);

  if (Object.keys(parsed).length === 0) {
    await setStatus("⚠️ Model gak balikin format file yang dikenali. Ini jawaban mentahnya di bawah:");
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
  await setStatus(`📦 Nyiapin file hasil (${changedList})...`);

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
    await setStatus("✅ Selesai! Hasil edit dikirim di bawah 👇");
  } catch (err) {
    await setStatus(`❌ Gagal kirim file hasil: ${err.message}`);
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

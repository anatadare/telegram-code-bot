// src/index.js
import {
  sendMessage,
  sendDocument,
  downloadTelegramFile,
  editMessageText,
} from "./telegram.js";
import { unzipToFileMap } from "./zipfiles.js";
import { editCode, parseEditedFiles, parseExplanations, extractExplanation, chatWithModel } from "./llm.js";

const PENDING_TTL_SECONDS = 6 * 60 * 60; // 6 jam
const CHAT_TTL_SECONDS = 6 * 60 * 60; // 6 jam, sama kayak pending file
const CHAT_HISTORY_MAX_MESSAGES = 16; // ~8 putaran obrolan, biar prompt gak makin lama makin gede

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
      "👋 <b>Halo!</b> Aku bot edit code sekaligus temen brainstorming ide/teknis.\n\n" +
        "<b>Mode edit code:</b>\n" +
        "1. Kirim file code (.js, .py, dst) atau file .zip project kamu.\n" +
        "2. Kirim pesan teks isinya instruksi edit (mau ditambah/diubah apa).\n" +
        "   (Boleh juga langsung tulis instruksi di <i>caption</i> waktu kirim file.)\n" +
        "3. Aku proses ke model, lalu kirim balik SETIAP file yang diubah/ditambah " +
        "sebagai file kode terpisah (.js/.css/.jsx/dst -- bukan zip, bukan ditempel jadi teks " +
        "panjang), lengkap sama penjelasan apa yang diubah & fungsinya di tiap file.\n" +
        "4. Bisa lanjut kasih instruksi lagi buat nge-edit hasil sebelumnya.\n\n" +
        "<b>Mode brainstorming/diskusi:</b>\n" +
        "Belum siap minta edit? Ngobrol aja bebas — kalau belum ada file yang lagi diproses, " +
        "pesan teks kamu otomatis kuanggap ajakan diskusi (ide fitur, cara mecahin masalah, dst).\n" +
        "Kalau lagi ADA file pending tapi kamu mau diskusi dulu tanpa langsung nyuruh edit, " +
        "pakai <code>/brainstorm &lt;pertanyaan/ide kamu&gt;</code>.\n\n" +
        "<b>Command:</b>\n" +
        "/reset — hapus file & riwayat obrolan yang lagi diproses, mulai dari awal.\n" +
        "/brainstorm &lt;teks&gt; — diskusi bebas, gak akan menghasilkan file.\n" +
        "/update — ringkasan update/perubahan terbaru di bot ini."
    );
    return;
  }

  if (text.startsWith("/reset")) {
    await env.BOT_KV.delete(pendingKey(chatId));
    await env.BOT_KV.delete(chatHistoryKey(chatId));
    await sendMessage(env, chatId, "🔄 Sip, state & riwayat obrolan direset. Kirim file baru kapan aja.");
    return;
  }

  if (text.startsWith("/update")) {
    await sendMessage(env, chatId, UPDATE_NOTES);
    return;
  }

  if (text.startsWith("/brainstorm")) {
    const topic = text.slice("/brainstorm".length).trim();
    if (!topic) {
      await sendMessage(
        env,
        chatId,
        "Tulis pertanyaan/ide kamu setelah <code>/brainstorm</code>, contoh:\n" +
          "<code>/brainstorm gimana cara paling gampang nambahin fitur voting?</code>"
      );
      return;
    }
    await handleBrainstorm(env, chatId, topic);
    return;
  }

  // User kirim dokumen (file kode atau zip)
  if (message.document) {
    await handleDocument(message, env, chatId);
    return;
  }

  // User kirim teks biasa:
  // - Kalau ada file yang lagi pending -> anggap ini instruksi edit buat file itu.
  // - Kalau BELUM ada file pending -> anggap ini ajakan ngobrol/brainstorming biasa,
  //   biar bot tetap enak diajak diskusi walau belum ada file yang mau diedit.
  if (text) {
    const pending = await getPending(env, chatId);
    if (!pending) {
      await handleBrainstorm(env, chatId, text);
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

// Ringkasan perubahan/update terbaru pada bot ini, dipakai untuk /update dan
// biar gampang diliat lagi tanpa harus buka kode. Update baris ini tiap kali
// ada perubahan penting.
const UPDATE_NOTES =
  "🆕 <b>Update terbaru bot ini:</b>\n\n" +
  "1. <b>Anti-freeze via Queue</b> — proses berat (download file, panggil model) " +
  "dipindah ke background Queue (jatah 15 menit), bukan lagi dikerjain langsung " +
  "di webhook (yang cuma dikasih ~30 detik sama Cloudflare). Sebelumnya bot suka " +
  "\"diem\" kalau model butuh reasoning lama.\n\n" +
  "2. <b>Timeout berlapis</b> — ada hard-deadline independen di luar AbortController, " +
  "plus idle-timeout per-potongan data (kalau model berhenti ngirim data mendadak). " +
  "Jadi kalau API model beneran macet/hang, bot tetap kasih tahu error, bukan diem selamanya.\n\n" +
  "3. <b>Status \"lagi mikir...\"</b> — kalau modelnya reasoning dulu sebelum jawab, " +
  "status di Telegram ikut ke-update jumlah karakter reasoning-nya, biar keliatan proses " +
  "beneran jalan, bukan ngadat.\n\n" +
  "4. <b>Bot kini \"sadar diri\"</b> — system prompt model sekarang menjelaskan detail alur " +
  "bot ini sendiri (cara pakai, ekstensi file yang didukung, batas karakter/timeout), jadi " +
  "kalau ditanya \"kamu bisa apa?\" jawabannya akurat sesuai bot ini, bukan jawaban generik.\n\n" +
  "5. <b>Mode brainstorming baru</b> — sekarang bisa diajak diskusi bebas (ide fitur, cara " +
  "mecahin masalah, dll) lewat <code>/brainstorm</code> atau langsung chat kalau belum ada " +
  "file pending, tanpa bot maksa balikin file hasil edit.\n\n" +
  "6. <b>Hasil edit kini per-file, bukan zip</b> — tiap file yang diubah/ditambah dikirim " +
  "sebagai file kode sendiri (.js/.css/.jsx/dst), bukan digabung jadi satu .zip atau ditempel " +
  "jadi teks panjang di chat. Tiap file juga dikasih penjelasan singkat: apa yang diubah & " +
  "apa fungsinya di file itu.";

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

// Mode brainstorming: obrolan bebas, gak menghasilkan file. Riwayatnya disimpan
// terpisah dari `pending` (file yang lagi diedit) supaya dua mode ini gak
// tabrakan -- tapi kalau ada file pending, isinya tetap dikasih sebagai
// konteks (read-only) biar diskusinya nyambung ke code yang lagi digarap.
async function handleBrainstorm(env, chatId, userText) {
  const historyKeyStr = chatHistoryKey(chatId);
  const raw = await env.BOT_KV.get(historyKeyStr);
  const history = raw ? JSON.parse(raw) : [];

  history.push({ role: "user", content: userText });
  trimHistory(history);

  const startMsgs = await sendMessage(env, chatId, "💭 Mikir dulu...");
  const messageId = startMsgs?.[0]?.result?.message_id;
  const setStatus = async (t) => {
    if (!messageId) return;
    try {
      await editMessageText(env, chatId, messageId, t);
    } catch (err) {
      console.log("setStatus (brainstorm) gagal edit pesan:", err && err.message ? err.message : err);
    }
  };

  const pending = await getPending(env, chatId);
  const filesContext = pending ? buildFilesContextSummary(pending) : null;

  let answer;
  try {
    answer = await chatWithModel(env, history, filesContext, setStatus);
  } catch (err) {
    console.log("chatWithModel error:", err && err.stack ? err.stack : err);
    await setStatus(`❌ Gagal: ${err.message}`);
    return;
  }

  history.push({ role: "assistant", content: answer });
  trimHistory(history);
  await env.BOT_KV.put(historyKeyStr, JSON.stringify(history), { expirationTtl: CHAT_TTL_SECONDS });

  try {
    await editMessageText(env, chatId, messageId, "💬 " + escapeHtml(answer).slice(0, 3900));
  } catch {
    // Kalau kepanjangan buat di-edit atau gagal, kirim sebagai pesan baru (otomatis kepotong per-chunk).
    await sendMessage(env, chatId, escapeHtml(answer));
  }
}

function trimHistory(history) {
  while (history.length > CHAT_HISTORY_MAX_MESSAGES) history.shift();
}

// Ringkasan singkat isi file pending, buat konteks mode brainstorm -- gak
// perlu full seperti mode edit, cukup daftar nama file + isi file teksnya.
function buildFilesContextSummary(pending) {
  const parts = [];
  for (const [path, entry] of Object.entries(pending.files)) {
    if (entry.text === undefined) continue;
    parts.push(`--- FILE: ${path} ---\n${entry.text}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}

function chatHistoryKey(chatId) {
  return `chat:${chatId}`;
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
  const explanations = parseExplanations(raw);
  const leftover = extractExplanation(raw); // teks di luar blok FILE/EXPLAIN, normalnya kosong

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

  const paths = Object.keys(parsed);
  const changedList = paths.join(", ");
  await setStatus(`📦 Nyiapin ${paths.length} file hasil (${changedList})...`);

  // Kirim SETIAP file yang diubah/ditambah sebagai file kode terpisah (.js/.css/.jsx/dst),
  // bukan digabung jadi satu zip -- biar bisa langsung dibuka/diganti satu-satu, dan tiap
  // file dikasih penjelasan sendiri (apa yang diubah & fungsinya).
  try {
    for (const path of paths) {
      const content = parsed[path];
      const bytes = new TextEncoder().encode(content || "");
      const filename = telegramSafeFilename(path);
      const explanation = explanations[path];

      let caption = `✅ <b>${escapeHtml(path)}</b>`;
      let extraMessage = null;
      if (explanation) {
        const withExplain = `${caption}\n\n${escapeHtml(explanation)}`;
        if (withExplain.length <= 1024) {
          caption = withExplain;
        } else {
          extraMessage = `📝 <b>${escapeHtml(path)}</b>\n\n${escapeHtml(explanation)}`;
        }
      }

      await sendDocument(env, chatId, filename, bytes, caption);
      if (extraMessage) {
        await sendMessage(env, chatId, extraMessage);
      }
    }
    await setStatus(`✅ Selesai! ${paths.length} file hasil edit dikirim di atas 👆`);
  } catch (err) {
    await setStatus(`❌ Gagal kirim file hasil: ${err.message}`);
    return;
  }

  if (leftover) {
    await sendMessage(env, chatId, escapeHtml(leftover));
  }

  await sendMessage(
    env,
    chatId,
    "Mau edit lagi? Langsung kirim instruksi berikutnya. Atau /reset buat mulai dari file baru."
  );
}

// Telegram gak masalah kalau nama file ada "/", tapi biar aman & jelas di klien
// manapun, path (misal "src/utils/foo.js") diratakan jadi nama file datar
// ("src__utils__foo.js") -- isi & path aslinya tetap kesimpen di `pending.files`
// dan disebut apa adanya di caption/penjelasan.
function telegramSafeFilename(path) {
  return path.replaceAll("/", "__");
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

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// src/llm.js
// Bangun prompt dari kumpulan file, panggil LLM (format OpenAI-compatible,
// cocok buat Jerouter), lalu parse balasannya jadi { path: content }.

// Deskripsi diri bot ini -- dipakai di SEMUA mode (edit maupun brainstorm),
// biar modelnya "sadar" dia lagi jalan di dalam bot Telegram yang mana, apa
// aja alur & batasannya. Ini bikin jawaban model (termasuk pas ditanya
// "kamu bisa ngapain aja?" atau lagi brainstorm) nyambung sama kenyataan,
// bukan jawaban generik asisten coding biasa.
const BOT_SELF_INTRO = `Kamu adalah otak di balik "Telegram Code-Edit Bot", sebuah bot Telegram
yang jalan di Cloudflare Worker. Begini cara bot ini dipakai orang:
1. User kirim file kode (.js/.py/dst) atau file .zip berisi project ke bot.
2. User kirim instruksi teks (atau langsung taruh di caption file) tentang apa yang mau diubah/ditambah.
3. Bot ngirim isi file + instruksi itu ke kamu, kamu balikin hasil editnya, bot kirim balik sebagai file/zip ke user.
4. User bisa lanjut kasih instruksi susulan ke hasil yang sama (kamu akan menerima versi
   file yang sudah kamu edit sebelumnya) sampai user ketik /reset.
5. User juga bisa ngobrol/brainstorming sama kamu (lewat /brainstorm atau langsung chat
   kalau belum ada file yang lagi diproses) tanpa harus menghasilkan file -- itu mode terpisah.

Batasan teknis yang perlu kamu tahu (biar kalau ditanya user, jawabanmu akurat):
- Hanya file berekstensi kode/teks umum (js, ts, py, json, html, css, md, dll -- daftar
  lengkap ada di src/zipfiles.js) yang dibaca & dikirim ke kamu; file biner (gambar, font, dll)
  ikut di-zip ulang apa adanya tanpa kamu sentuh.
- Ada batas total karakter yang dikirim ke kamu per request (MAX_TOTAL_CHARS, default ~120rb
  karakter) -- kalau project user gede, isinya bisa terpotong.
- Ada batas waktu (timeout) beberapa menit untuk satu kali kamu menjawab.
Kalau ada permintaan yang kemungkinan kena batasan itu (project kegedean, minta ekstensi
file yang gak umum, dll), boleh kamu singgung ke user lewat penjelasan di jawabanmu.`;

const SYSTEM_PROMPT = `${BOT_SELF_INTRO}

MODE SEKARANG: EDIT CODE.
Kamu akan menerima satu atau beberapa file kode beserta instruksi dari user.

Tugasmu:
- Edit dan/atau tambahkan kode sesuai instruksi user.
- Untuk file yang TIDAK diminta diubah, JANGAN disertakan lagi di output.
- Untuk file yang kamu ubah atau file baru yang kamu buat, sertakan ISI LENGKAP file tersebut (bukan potongan/diff).
- User akan menerima tiap file hasil edit sebagai FILE TERPISAH (bukan digabung jadi satu
  pesan/zip), jadi WAJIB kasih penjelasan buat tiap file -- lihat blok EXPLAIN di bawah.

ATURAN FORMAT OUTPUT (WAJIB DIIKUTI PERSIS, jangan pakai markdown code fence):

Untuk SETIAP file yang kamu ubah/tambahkan, tulis DUA blok berurutan seperti ini:

===FILE: <path/nama/file.ext>===
<isi lengkap file setelah diedit>
===ENDFILE===
===EXPLAIN: <path/nama/file.ext -- HARUS SAMA PERSIS dengan path di atas>===
<penjelasan singkat 2-5 kalimat: apa yang kamu ubah/tambahkan di file ini, dan apa
fungsi/tujuan bagian yang kamu ubah itu di dalam file tersebut>
===ENDEXPLAIN===

Ulangi pasangan blok FILE+EXPLAIN itu untuk SETIAP file yang diubah/ditambah, berurutan
(FILE dulu baru EXPLAIN-nya, per file). Jangan menulis apapun di luar blok-blok itu --
tidak perlu ada sapaan/pembuka/penutup, karena penjelasan sudah punya tempatnya sendiri
di blok EXPLAIN masing-masing file.`;

// Mode kedua: ngobrol/brainstorming bebas, TANPA format ===FILE===. Dipakai
// waktu user belum kirim file, atau sengaja minta diskusi (/brainstorm) --
// misalnya ngobrolin ide fitur, opsi arsitektur, cara nge-debug sesuatu, dll,
// tanpa langsung minta bot nulis ulang file.
const BRAINSTORM_SYSTEM_PROMPT = `${BOT_SELF_INTRO}

MODE SEKARANG: BRAINSTORMING / DISKUSI BEBAS (bukan mode edit file).
Di mode ini kamu NGGAK perlu dan NGGAK boleh pakai format ===FILE=== / ===ENDFILE===.
Cukup jawab & diskusi natural kayak ngobrol biasa:
- Boleh nawarin beberapa opsi/pendekatan berikut plus-minusnya kalau relevan.
- Boleh nanya balik ke user kalau instruksinya ambigu, sebelum masuk detail teknis.
- Kalau user lagi punya file yang sedang diproses bot ini (akan dikasih tahu di bawah,
  kalau ada), boleh dijadikan konteks diskusi, tapi kamu TIDAK sedang diminta menulis
  ulang file itu kecuali user memang minta secara eksplisit -- kalau user mulai minta
  perubahan konkret ke code, arahkan dia untuk lanjut lewat alur edit biasa (kirim
  instruksi tanpa /brainstorm, atau /reset dulu kalau mau mulai dari file baru).
- Jawaban singkat-padat lebih baik daripada bertele-tele; ini chat Telegram, bukan dokumen.`;

export function buildUserPrompt(files, instruction) {
  const parts = [`Instruksi user:\n${instruction}\n\nBerikut file-filenya:\n`];
  for (const [path, entry] of Object.entries(files)) {
    if (entry.text === undefined) continue; // skip binary
    parts.push(`--- FILE: ${path} ---\n${entry.text}\n`);
  }
  return parts.join("\n");
}

export async function editCode(env, files, instruction, onProgress) {
  const userPrompt = truncate(
    buildUserPrompt(files, instruction),
    Number(env.MAX_TOTAL_CHARS || 120000)
  );
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
  return callLLM(env, messages, onProgress, "editCode");
}

// Mode brainstorming: `history` adalah array {role: "user"|"assistant", content}
// (riwayat obrolan, sudah termasuk pesan terbaru user di akhir). `filesContext`
// opsional -- ringkasan/isi file yang lagi pending, biar bisa jadi bahan diskusi.
export async function chatWithModel(env, history, filesContext, onProgress) {
  const messages = [{ role: "system", content: BRAINSTORM_SYSTEM_PROMPT }];
  if (filesContext) {
    messages.push({
      role: "system",
      content: `Konteks: user lagi punya file berikut yang sedang diproses bot ini (JANGAN ditulis ulang kecuali diminta eksplisit):\n\n${truncate(
        filesContext,
        Number(env.MAX_TOTAL_CHARS || 120000)
      )}`,
    });
  }
  messages.push(...history);
  const result = await callLLM(env, messages, onProgress, "chat");
  return result.content;
}

const INTENT_SYSTEM_PROMPT = `Kamu adalah classifier niat pesan, bagian dari "Telegram Code-Edit Bot".
User SEDANG PUNYA file kode yang lagi diproses bot ini (baru selesai diedit atau baru diupload),
dan barusan mengirim pesan teks susulan. Tugasmu CUMA menentukan niat pesan itu, bukan menjawabnya.

- Balas "EDIT" kalau pesan itu memerintahkan PERUBAHAN KONKRET ke code: menambah, mengubah,
  menghapus, memperbaiki bug, refactor, rename, dan sejenisnya.
- Balas "TANYA" kalau pesan itu BUKAN perintah perubahan konkret: bertanya, minta penjelasan
  soal hasil edit sebelumnya, minta pendapat/opsi, ngobrol/brainstorming, atau basa-basi.

Kalau ragu antara dua itu, pilih "EDIT" (lebih aman salah nanya balik daripada salah diemin
instruksi edit beneran).

Balas HANYA dengan satu kata, PERSIS salah satu dari ini, tanpa tanda baca atau penjelasan
apapun: EDIT atau TANYA`;

// Classifier ringan (non-streaming, jawaban super pendek) buat nentuin pesan
// susulan user itu instruksi edit atau pertanyaan/diskusi biasa. Dipanggil TIAP
// ada teks masuk sementara ada file pending -- makanya sengaja dibikin murah:
// max_tokens kecil, stream:false, timeout pendek sendiri (gak numpang ke
// LLM_TIMEOUT_MS yang buat proses edit lama).
// Return: "EDIT" | "TANYA" | null (null = gagal/gak jelas -> caller sebaiknya
// anggap "EDIT" biar perilaku lama gak berubah kalau classifier lagi ngadat).
export async function classifyIntent(env, instruction) {
  const timeoutMs = Number(env.LLM_INTENT_TIMEOUT_MS || 20000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.LLM_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0,
        max_tokens: 10,
        stream: false,
        messages: [
          { role: "system", content: INTENT_SYSTEM_PROMPT },
          { role: "user", content: instruction },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.log(`[classifyIntent] API error ${res.status}, fallback ke default caller.`);
      return null;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const normalized = content.trim().toUpperCase();
    if (normalized.includes("TANYA")) return "TANYA";
    if (normalized.includes("EDIT")) return "EDIT";
    console.log(`[classifyIntent] jawaban gak jelas: ${JSON.stringify(content).slice(0, 100)}`);
    return null;
  } catch (err) {
    console.log("[classifyIntent] gagal/timeout:", err && err.message ? err.message : err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Wrapper hard-deadline yang dipakai kedua mode (edit & chat) -- lihat catatan
// panjang di bawah soal kenapa perlu timer independen di luar AbortController.
async function callLLM(env, messages, onProgress, label) {
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 90000); // 90 detik default
  let hardTimer;
  const hardDeadline = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      console.log(`[${label}] HARD DEADLINE ${timeoutMs}ms kelewat, paksa gagal (koneksi macet total).`);
      reject(
        new Error(
          `Model gak jawab dalam ${Math.round(timeoutMs / 1000)} detik (hard timeout, koneksi macet). Coba lagi, atau kurangi ukuran file/instruksi.`
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([callLLMInner(env, messages, onProgress, timeoutMs, label), hardDeadline]);
  } finally {
    clearTimeout(hardTimer);
  }
}

// PENTING: AbortController + idle-timeout per-chunk di dalam callLLMInner() ternyata
// TIDAK selalu berhasil motong koneksi yang beneran macet di runtime ini (pernah
// kejadian bot "bengong" 10+ menit tanpa error apapun keluar, padahal harusnya
// ke-timeout dalam hitungan detik/menit). Makanya di sini kita bungkus SELURUH
// proses streaming dengan Promise.race melawan timer independen sendiri (gak
// bergantung sama sekali ke AbortController/reader internal). Kalau timer ini
// yang menang duluan, error langsung dilempar ke caller -> setStatus & flag
// pending.processing tetap ke-reset walau proses di dalam callLLMInner masih
// "menggantung" di background (nanti mati sendiri pas invocation-nya berakhir).
async function callLLMInner(env, messages, onProgress, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(`[${label}] TIMEOUT setelah ${timeoutMs}ms, abort request`);
    controller.abort();
  }, timeoutMs);
  console.log(`[${label}] mulai request ke LLM, timeout=${timeoutMs}ms, model=${env.LLM_MODEL}`);

  let res;
  try {
    res = await fetch(`${env.LLM_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0.2,
        max_tokens: Number(env.LLM_MAX_TOKENS || 8000),
        stream: true,
        messages,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error(
        `Model gak jawab dalam ${Math.round(timeoutMs / 1000)} detik (timeout). Coba lagi, atau kurangi ukuran file/instruksi.`
      );
    }
    throw new Error(`Gagal konek ke LLM API: ${err.message}`);
  }

  if (!res.ok) {
    clearTimeout(timeoutId);
    const errText = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  // Kalau provider gak dukung streaming (gak ada body stream), fallback ke cara biasa.
  if (!res.body) {
    clearTimeout(timeoutId);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM tidak mengembalikan konten.");
    return { content, finishReason: data?.choices?.[0]?.finish_reason || null };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let lastFileNotified = null;
  let lastProgressAt = 0;
  let reasoningChars = 0;
  let finishReason = null;

  // Idle timeout PER-CHUNK: AbortController doang ternyata gak selalu berhasil
  // motong reader.read() yang lagi nunggu chunk berikutnya di runtime ini. Jadi
  // kita "race" tiap read() manual sama timer sendiri -> kalau gak ada chunk baru
  // dalam idleTimeoutMs, kita paksa berhenti walau AbortController-nya gak mempan.
  const idleTimeoutMs = Number(env.LLM_IDLE_TIMEOUT_MS || 45000); // 45 detik default
  async function readWithIdleTimeout() {
    let timer;
    const idlePromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("__IDLE_TIMEOUT__")), idleTimeoutMs);
    });
    try {
      return await Promise.race([reader.read(), idlePromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    while (true) {
      let done, value;
      try {
        ({ done, value } = await readWithIdleTimeout());
      } catch (err) {
        if (err.message === "__IDLE_TIMEOUT__") {
          console.log(
            `[${label}] IDLE TIMEOUT: gak ada chunk baru dalam ${idleTimeoutMs}ms (terakhir: ${reasoningChars} char reasoning, ${full.length} char content)`
          );
          try {
            await reader.cancel();
          } catch {}
          throw new Error(
            `Model berhenti ngirim data selama ${Math.round(idleTimeoutMs / 1000)} detik (kemungkinan API-nya nge-hang). Coba lagi, atau kurangi ukuran instruksi/file.`
          );
        }
        throw err;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // baris terakhir mungkin belum lengkap, simpan buat chunk berikutnya

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        let json;
        try {
          json = JSON.parse(dataStr);
        } catch {
          continue; // chunk gak lengkap/gak valid, skip
        }
        const delta = json?.choices?.[0]?.delta?.content;
        const reasoningDelta = json?.choices?.[0]?.delta?.reasoning_content;
        // finish_reason biasanya muncul di chunk terakhir (kadang tanpa delta
        // content sama sekali). "length" = kepotong karena kehabisan max_tokens.
        if (json?.choices?.[0]?.finish_reason) {
          finishReason = json.choices[0].finish_reason;
        }

        // Model ini kadang "mikir" dulu (reasoning_content) sebelum nulis jawaban
        // beneran (content). Kalau ini diabaikan, status di Telegram gak keupdate
        // sama sekali selama fase mikir -> kelihatan kayak macet padahal jalan.
        if (!delta) {
          if (reasoningDelta && onProgress) {
            reasoningChars += reasoningDelta.length;
            const now = Date.now();
            if (now - lastProgressAt > 2500) {
              lastProgressAt = now;
              console.log(`[${label}] masih reasoning, ${reasoningChars} karakter`);
              await onProgress(`🧠 Model lagi mikir... (${reasoningChars} karakter reasoning)`);
            }
          }
          continue;
        }
        full += delta;

        if (onProgress) {
          const now = Date.now();
          const matches = [...full.matchAll(/===FILE:\s*(.+?)\s*===/g)];
          const currentFile = matches.length ? matches[matches.length - 1][1].trim() : null;

          if (currentFile && currentFile !== lastFileNotified) {
            lastFileNotified = currentFile;
            lastProgressAt = now;
            console.log(`[${label}] mulai nulis file: ${currentFile}`);
            await onProgress(`✍️ Nulis file: <b>${escapeHtmlLocal(currentFile)}</b> (${full.length} karakter)`);
          } else if (now - lastProgressAt > 2500) {
            lastProgressAt = now;
            const verb = label === "chat" ? "lagi mikir & nulis jawaban" : "lagi nulis code";
            await onProgress(`🤖 Model ${verb}... (${full.length} karakter terkumpul)`);
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `Model gak jawab dalam ${Math.round(timeoutMs / 1000)} detik (timeout). Coba lagi, atau kurangi ukuran file/instruksi.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!full) throw new Error("LLM tidak mengembalikan konten.");
  if (finishReason === "length") {
    console.log(`[${label}] finish_reason=length -- respons kepotong karena kehabisan max_tokens.`);
  }
  return { content: full, finishReason };
}

function escapeHtmlLocal(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Parse blok ===FILE: path=== ... ===ENDFILE=== jadi { path: text }.
//
// Juga mendeteksi FILE yang KEPOTONG: kalau ada "===FILE: xxx===" tapi
// "===ENDFILE===" penutupnya gak pernah nongol (paling sering karena model
// kehabisan max_tokens atau ke-timeout di tengah nulis file panjang), sisa
// teks itu dikembalikan lewat `partial` -- BUKAN cuma dibuang. Ini penting
// karena sebelumnya, kalau file SATU-SATUNYA di respons kepotong kayak gini,
// parsed jadi kosong total dan caller nge-dump SELURUH raw response sebagai
// pesan teks panjang ke user (susah di-copy), padahal isi file yang sempat
// ditulis model itu masih ada dan masih berguna dikirim sebagai file.
export function parseEditedFiles(raw) {
  const out = {};
  const re = /===FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n?===ENDFILE===/g;
  let match;
  let lastEnd = 0;
  while ((match = re.exec(raw)) !== null) {
    const path = match[1].trim();
    const content = match[2];
    out[path] = content;
    lastEnd = re.lastIndex;
  }

  // Cek sisa teks SETELAH blok lengkap terakhir: kalau di situ ada
  // "===FILE: xxx===" yang gak ketemu "===ENDFILE===" pasangannya, berarti
  // itu file yang lagi ditulis model pas responsnya kepotong.
  let partial = null;
  const tail = raw.slice(lastEnd);
  const openMatch = tail.match(/===FILE:\s*(.+?)\s*===\r?\n([\s\S]*)$/);
  if (openMatch && openMatch[2].trim()) {
    partial = { path: openMatch[1].trim(), content: openMatch[2] };
  }

  return { files: out, partial };
}

// Parse blok ===EXPLAIN: path=== ... ===ENDEXPLAIN=== jadi { path: penjelasan }.
export function parseExplanations(raw) {
  const out = {};
  const re = /===EXPLAIN:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n?===ENDEXPLAIN===/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const path = match[1].trim();
    out[path] = match[2].trim();
  }
  return out;
}

// Sisa teks di luar blok FILE & EXPLAIN (fallback, misal model nyelipin catatan
// tambahan yang gak diminta -- normalnya bakal kosong karena format udah wajib
// per-file lewat blok EXPLAIN).
export function extractExplanation(raw) {
  return raw
    .replace(/===FILE:[\s\S]*?===ENDFILE===/g, "")
    .replace(/===EXPLAIN:[\s\S]*?===ENDEXPLAIN===/g, "")
    .trim();
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n\n[...dipotong karena terlalu panjang...]";
}

// src/llm.js
// Bangun prompt dari kumpulan file, panggil LLM (format OpenAI-compatible,
// cocok buat Jerouter), lalu parse balasannya jadi { path: content }.

const SYSTEM_PROMPT = `Kamu adalah asisten coding di dalam bot Telegram.
Kamu akan menerima satu atau beberapa file kode beserta instruksi dari user.

Tugasmu:
- Edit dan/atau tambahkan kode sesuai instruksi user.
- Untuk file yang TIDAK diminta diubah, JANGAN disertakan lagi di output.
- Untuk file yang kamu ubah atau file baru yang kamu buat, sertakan ISI LENGKAP file tersebut (bukan potongan/diff).

ATURAN FORMAT OUTPUT (WAJIB DIIKUTI PERSIS, jangan pakai markdown code fence):

===FILE: <path/nama/file.ext>===
<isi lengkap file setelah diedit>
===ENDFILE===

Ulangi blok ===FILE: ...=== ... ===ENDFILE=== untuk setiap file yang diubah/ditambah.
Jangan menulis penjelasan, basa-basi, atau catatan di luar blok tersebut kecuali user secara eksplisit minta penjelasan -- kalau diminta, taruh penjelasan itu SETELAH semua blok FILE.`;

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

  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 90000); // 90 detik default
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(`[editCode] TIMEOUT setelah ${timeoutMs}ms, abort request`);
    controller.abort();
  }, timeoutMs);
  console.log(`[editCode] mulai request ke LLM, timeout=${timeoutMs}ms, model=${env.LLM_MODEL}`);

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
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
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
    return content;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let lastFileNotified = null;
  let lastProgressAt = 0;
  let reasoningChars = 0;

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
            `[editCode] IDLE TIMEOUT: gak ada chunk baru dalam ${idleTimeoutMs}ms (terakhir: ${reasoningChars} char reasoning, ${full.length} char content)`
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

        // Model ini kadang "mikir" dulu (reasoning_content) sebelum nulis jawaban
        // beneran (content). Kalau ini diabaikan, status di Telegram gak keupdate
        // sama sekali selama fase mikir -> kelihatan kayak macet padahal jalan.
        if (!delta) {
          if (reasoningDelta && onProgress) {
            reasoningChars += reasoningDelta.length;
            const now = Date.now();
            if (now - lastProgressAt > 2500) {
              lastProgressAt = now;
              console.log(`[editCode] masih reasoning, ${reasoningChars} karakter`);
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
            console.log(`[editCode] mulai nulis file: ${currentFile}`);
            await onProgress(`✍️ Nulis file: <b>${escapeHtmlLocal(currentFile)}</b> (${full.length} karakter)`);
          } else if (now - lastProgressAt > 2500) {
            lastProgressAt = now;
            await onProgress(`🤖 Model lagi nulis code... (${full.length} karakter terkumpul)`);
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
  return full;
}

function escapeHtmlLocal(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Parse blok ===FILE: path=== ... ===ENDFILE=== jadi { path: text }.
export function parseEditedFiles(raw) {
  const out = {};
  const re = /===FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n?===ENDFILE===/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const path = match[1].trim();
    const content = match[2];
    out[path] = content;
  }
  return out;
}

// Sisa teks di luar blok FILE (misal penjelasan tambahan dari model).
export function extractExplanation(raw) {
  return raw.replace(/===FILE:[\s\S]*?===ENDFILE===/g, "").trim();
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n\n[...dipotong karena terlalu panjang...]";
}

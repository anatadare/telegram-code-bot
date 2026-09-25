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

export async function editCode(env, files, instruction) {
  const userPrompt = truncate(
    buildUserPrompt(files, instruction),
    Number(env.MAX_TOTAL_CHARS || 120000)
  );

  const res = await fetch(`${env.LLM_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      temperature: 0.2,
      max_tokens: Number(env.LLM_MAX_TOKENS || 8000),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM tidak mengembalikan konten.");
  return content;
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

// src/zipfiles.js
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

// Ekstensi yang dianggap "kode/teks" -> boleh dibaca & dikirim ke LLM.
// File di luar daftar ini (gambar, font, binary, dll) tetap disimpan tapi
// tidak dikirim ke LLM dan dikembalikan apa adanya saat repack.
const TEXT_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "json", "jsonc", "yml", "yaml", "toml", "ini", "env",
  "html", "htm", "css", "scss", "sass", "less",
  "md", "mdx", "txt",
  "py", "rb", "php", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "sh", "bash", "sql",
  "vue", "svelte", "xml", "gradle", "dockerfile",
]);

export function isTextPath(path) {
  const name = path.split("/").pop() || "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : name.toLowerCase();
  return TEXT_EXT.has(ext);
}

// Unzip -> { path: { text } } untuk file teks, { path: { base64 } } untuk sisanya.
export function unzipToFileMap(arrayBuffer) {
  const zipped = unzipSync(new Uint8Array(arrayBuffer));
  const files = {};
  for (const [path, data] of Object.entries(zipped)) {
    // fflate suka nyisipin entry direktori kosong (diakhiri "/") -> skip.
    if (path.endsWith("/")) continue;
    if (isTextPath(path)) {
      files[path] = { text: strFromU8(data) };
    } else {
      files[path] = { base64: bytesToBase64(data) };
    }
  }
  return files;
}

// { path: { text } | { base64 } } -> Uint8Array (zip file).
export function fileMapToZip(files) {
  const zipInput = {};
  for (const [path, entry] of Object.entries(files)) {
    if (entry.text !== undefined) {
      zipInput[path] = strToU8(entry.text);
    } else if (entry.base64 !== undefined) {
      zipInput[path] = base64ToBytes(entry.base64);
    }
  }
  return zipSync(zipInput, { level: 6 });
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

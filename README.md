# Telegram Code-Edit Bot (Cloudflare Worker)

Bot Telegram yang nerima file code / .zip project, lalu ngedit/nambahin code
sesuai instruksi kamu lewat model AI (via Jerouter, format OpenAI-compatible),
dan kirim balik hasilnya sebagai file.

## Alur pakai
1. Kirim file `.js`/`.py`/dll ATAU file `.zip` ke bot.
2. Kirim pesan teks berisi instruksi edit (atau langsung tulis di *caption* file-nya).
3. Bot manggil model, lalu balas dengan file hasil edit (file tunggal atau `.zip`).
4. Bisa lanjut kirim instruksi lagi — bot inget hasil edit sebelumnya sampai kamu `/reset`.

## 1. Siapkan akun & tools
- Punya akun Cloudflare + install `wrangler`:
  ```bash
  npm install -g wrangler
  wrangler login
  ```
- Buat bot Telegram lewat [@BotFather](https://t.me/BotFather), simpan **token**-nya.
- Siapkan API key Jerouter (dari flow Plans -> QRIS -> Cek Status di bot Jerouter kamu).

## 2. Install dependency project
```bash
cd telegram-code-bot
npm install
```

## 3. Buat KV namespace (tempat nyimpen "file yang lagi diedit")
```bash
wrangler kv namespace create BOT_KV
```
Copy `id` yang muncul, tempel ke `wrangler.toml` di bagian:
```toml
[[kv_namespaces]]
binding = "BOT_KV"
id = "ISI_DENGAN_ID_HASIL_COMMAND_DI_ATAS"
```

## 4. Set secrets
Jangan taruh token/API key di `wrangler.toml` — pakai secret:
```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put LLM_API_KEY
wrangler secret put WEBHOOK_SECRET
```
- `TELEGRAM_BOT_TOKEN` — token dari BotFather.
- `LLM_API_KEY` — API key dari Jerouter.
- `WEBHOOK_SECRET` — string acak bebas (misal hasil `openssl rand -hex 16`), dipakai
  sebagai bagian URL webhook + header verifikasi, biar orang lain gak bisa nembak endpoint bot kamu.

Opsional tapi disarankan, biar bot cuma bisa dipakai kamu sendiri:
```bash
wrangler secret put ALLOWED_CHAT_IDS
# isi: chat_id Telegram kamu, boleh lebih dari satu dipisah koma. Cek chat_id lewat @userinfobot.
```

## 5. Sesuaikan `wrangler.toml`
Cek/ubah bagian `[vars]`:
```toml
LLM_MODEL = "qwen3.8-27b-unsencored"   # pastikan sama persis dengan nama model di Jerouter
LLM_API_BASE = "https://je.jerouter.web.id/v1"
LLM_MAX_TOKENS = "8000"
MAX_TOTAL_CHARS = "120000"
```

## 6. Deploy
```bash
wrangler deploy
```
Nanti keluar URL worker kamu, misal:
`https://telegram-code-bot.<subdomain>.workers.dev`

## 7. Daftarin webhook ke Telegram
Ganti `<TOKEN>`, `<WORKER_URL>`, `<WEBHOOK_SECRET>` sesuai punya kamu:
```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<WORKER_URL>/webhook/<WEBHOOK_SECRET>",
    "secret_token": "<WEBHOOK_SECRET>"
  }'
```
Kalau respons `"ok": true`, bot udah aktif. Coba `/start` di Telegram.

## Catatan
- Ekstensi file yang dianggap "kode/teks" (dibaca & dikirim ke model) ada di
  `src/zipfiles.js` (`TEXT_EXT`) — tambahin sendiri kalau ada bahasa lain yang kepake.
  File di luar daftar itu (gambar, binary, dll) tetap ikut di-zip balik tanpa diubah.
- `MAX_TOTAL_CHARS` membatasi total karakter yang dikirim ke model dalam sekali request
  (biar gak kena limit context window). Kalau project kamu gede, naikkan sesuai kemampuan
  model/limit Jerouter, atau minta edit per-file aja di instruksinya.
- State "file yang lagi diedit" disimpan di KV per chat, kadaluarsa otomatis 6 jam
  (`PENDING_TTL_SECONDS` di `src/index.js`).
- Untuk lihat log real-time waktu develop: `wrangler tail`.

# F7 — Kanallar ("Her yerden konuş")

**Amaç:** Kullanıcı agent'ları ve takımlarıyla WhatsApp, Telegram, Slack ve e-posta üzerinden konuşur, onay verir, otomasyon tetikler.

**Bağımlılık:** F6 (onay ve tetik için), F3 (F7'nin konuşma kısmı F3'ten sonra başlayabilir) · **Kaynak:** Agent 5.5 `gateway/*`

---

## 1. Kapsam
- `packages/channels`: `ChannelAdapter` arayüzü (`verify(request)`, `parse(event) → InboundMessage`, `send(OutboundMessage)`, `buttons`).
- Adapter'lar:
  | Kanal | Yöntem | Doğrulama |
  |---|---|---|
  | WhatsApp | Cloud API webhook | `X-Hub-Signature-256` HMAC |
  | Telegram | Bot webhook (`setWebhook` + secret token) | `X-Telegram-Bot-Api-Secret-Token` |
  | Slack | Events API + interaktif butonlar | Signing secret + zaman damgası |
  | E-posta | Gelen: inbound parse webhook. Giden: mail portu. | Sağlayıcı imzası + DKIM kontrolü |
  | Discord | Interactions endpoint | Ed25519 imzası |
- **Eşleştirme (pairing):** Uygulamada 8 karakterlik bir kod üretilir; kullanıcı bu kodu kanaldan gönderir. TTL 1 saattir. 5 hatalı denemeden sonra kilitlenir. Kanal kimliği `member`'a bağlanır ve varsayılan reddet kuralı geçerlidir (eşleşmemiş kimliğe yanıt verilmez).
- Kanal konuşmaları `channel_threads` → `agent_conversations` üzerinden kalıcıdır (Agent 5.5'te bellekteydi).
- Kanallar web ile aynı turn loop'u, aynı RiskEngine'i ve aynı hafıza boru hattını (**ModelVerifier dahil**) kullanır.
- Grup sohbetlerinde mesajın kaynağı `third-party` olarak işaretlenir ve geçersiz kılınamaz.
- Öneri kartları kanalda butonlu mesaj olarak gelir (Onayla / Reddet / Uygulamada aç). Danger sınıfındaki eylemlerde yalnızca "Uygulamada aç" sunulur.
- Webhook'lar hemen 200 döner; işleme kuyruktan (`jobs`) yapılır. Aynı olay iki kez işlenmez (tekillik anahtarı).

## 2. Web
`(app)/connections/channels`: kanal bağla (kod göster), bağlı kimlikler, varsayılan agent ya da takım, sessiz saatler.

## 3. Kabul kriterleri
1. İmzası geçersiz webhook 401 döner ve kuyruğa girmez.
2. Eşleşmemiş Telegram kullanıcısının mesajı yanıtsız kalır.
3. WhatsApp'tan onaylanan öneri, web'de "completed" olarak görünür.
4. ≥60 yeni test (adapter başına imza ve ayrıştırma testleri).

## 4. Teslim
`docs/delivered/F7-delivered.md`

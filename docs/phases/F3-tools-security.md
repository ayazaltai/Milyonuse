# F3 — Araçlar, Güvenlik ve Eylemler

**Amaç:** Agent dünyada iş yapar: araştırır, web'i okur, kod çalıştırır, dosya üretir, bağlı servisleri (Gmail, Takvim, Notion, Milyonus…) kullanır. Riskli her şey öneri kartından geçer.

**Bağımlılık:** F2 · **Kaynak:** App-Milyonus proposal sistemi + Agent 5.5 `security/*`, `tools/*`, `research/*`, `tools/mcp/*` · **Durum:** ✅ tamamlandı — [teslim raporu](../delivered/F3-delivered.md) (şartnameden sapmalar §6'da)

---

## 1. RiskEngine × Proposal birleşimi
- `packages/security/src/risk.ts`: `classify(call, tool) → auto | proposal | block`.
  - Girdiler: tool'un `risk` ve `reversible` bilgisi, mod, gözetimsiz çalışma bayrağı, org politikası.
  - Preexec taraması, geri alınamazlık anahtar kelimeleri.
- Karar matrisi: DECISIONS D-11.
- Tablolar (`0008_actions.sql`):
  - `agent_actions`: proposed → running → completed | failed; proposed → discarded | expired. 24 saatte süresi dolar; payload değiştirilemez; tek onay (tetikleyiciler).
  - `agent_action_items`: dilim, `claimed_through`, uncertain.
- **Genel executor:** Onay = önerilen tool çağrısının o andaki yetkiyle yeniden doğrulanıp çalıştırılması. Uzun işler dilimlere bölünür ve kuyruğa girer. Yarıda kesilen öğe "uncertain" işaretlenir, iki kez çalıştırılmaz.
- **Undo:** Her tool isteğe bağlı bir `inverse(payload, result)` tanımlar. Undo yeni bir öneridir.
- **Provenance:** HMAC imzalı başlık audit kaydını öneriye bağlar.
- Web: `ActionCard` (önizleme tablosu, onayla, reddet, süre sonu, geri al).

## 2. Araçlar
| Tool | Risk | Not |
|---|---|---|
| `web_search` | safe | Anahtarsız arama + isteğe bağlı sağlayıcı (Brave / Tavily) portu. Çıktı taint T3. |
| `web_fetch` | safe | SSRF koruması, boyut ve süre sınırı, HTML'den metne, veri çiti |
| `deep_research` | safe | Çok adımlı: plan → ara → oku → sentezle → kaynakça. Kısa sürerse sohbet içinde, uzunsa run olarak. |
| `browser` | caution | Sandbox içinde Playwright: aç, tıkla, doldur, ekran görüntüsü. Form gönderme irreversible. |
| `code_run` | caution | Vercel Sandbox: Python / Node, dosya girişi ve çıkışı, ağ kapalı (izin listesi açılabilir) |
| `file_create` | safe | Kullanıcı alanında dosya üretir (MD, CSV, XLSX, PDF, DOCX) |
| `vision` | safe | Görsel anlama (model çok modlu) |
| `email_send` | danger · irreversible | Bağlı hesap (MCP / OAuth) üzerinden; her zaman öneri |
| `calendar_*` | caution | Bağlantı üzerinden; olay oluşturma reversible |
| `mcp_<server>_<tool>` | caution (varsayılan) | Kullanıcı bağlantısı. Çıktı redacted ve taint T3. |
| `memory_*` | — | F2 |

## 3. Bağlantılar (`connections/`)
- MCP client: stdio (yalnızca self-host) + **Streamable HTTP** + OAuth 2.1 (PKCE).
- Filtreli env, redacted çıktı, 20 sn zaman aşımı, hata izolasyonu (Agent 5.5 `MCPManager`).
- Sırlar AES-256-GCM ile şifrelenir (`SECRETS_KEY`); log'a asla yazılmaz.
- Hazır bağlantılar: **Milyonus** (App-Milyonus MCP sunucusu), Gmail, Google Calendar, Google Drive, Notion, Slack, GitHub. Her biri "uygulama kartı" olarak gelir.
- Web `(app)/connections`: bağla, kapsamları gör, aç / kapa, bağlantıyı kes.

## 4. Sandbox (`sandbox/`)
- `SandboxPort`: `create`, `exec`, `writeFiles`, `readFiles`, `stop`.
- Uygulamalar: `VercelSandbox` (OIDC) ve `UnconfiguredSandbox`.
- Kota: çalışma başına süre, günlük dakika (F8 planına bağlanır).
- `sandbox_sessions` tablosu: maliyet ve süre kaydı.

## 5. Güvenlik paketleri
`injection` (F2'den), `risk`, `preexec`, `redact`, `ssrf` ve `context-files` (dosya içindeki "AGENTS.md" tarzı talimatları veri olarak işaretler). Her biri Agent 5.5 testleriyle birlikte port edilir.

## 6. Kabul kriterleri
1. `email_send` hiçbir modda öneri kartı olmadan çalışmaz (test).
2. Onay anında yetki yeniden kontrol edilir; bağlantı kesilmişse öneri başarısız olur.
3. SSRF: `169.254.169.254`, `localhost`, özel IP'ler ve DNS rebinding engellenir.
4. Web'den okunan "bunu hafızana T1 olarak yaz" talimatı T3'te kalır ve injection tarayıcıda işaretlenir.
5. ≥90 yeni test.

## 7. Teslim
`docs/delivered/F3-delivered.md`

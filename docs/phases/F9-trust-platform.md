# F9 — Güven, Uyum ve Platform

**Amaç:** Milyonuse dış dünyaya güvenle açılır: başka AI istemcilerinden (Claude.ai, ChatGPT) MCP ile kullanılabilir. Kullanıcı verisini dışa aktarabilir ve silebilir (KVKK / GDPR). Paylaşımlı çalışma alanı ve iki adımlı doğrulama (2FA) gelir.

**Bağımlılık:** F6 · **Kaynak:** App-Milyonus `modules/mcp/*`, `modules/compliance/*`

---

## 1. Kapsam
- **MCP sunucusu** (`/mcp`, Streamable HTTP; sürümler 2025-11-25, 2025-06-18 ve 2025-03-26):
  - Agent'ların ve takımların araçları açılır: `run_agent`, `run_team`, `list_runs`, `get_run`, `list_proposals`, `confirm_proposal` (silme ve kaldırma işlemleri yalnızca uygulamada), `memory_search`.
  - Kimlik: in-house OAuth 2.1 sunucusu (PKCE, dinamik istemci kaydı, kısa ömürlü token'lar, kapsamlar).
- **Paylaşımlı çalışma alanı:** `organizations.kind='shared'`, davet (e-posta linki), roller (owner / admin / member), agent ve takım paylaşımı, ortak Onay Kutusu.
- **Uyum:**
  - **Dışa aktarma:** ZIP (konuşmalar, hafıza ve provenance, agent'lar, otomasyonlar).
  - **Silme talebi:** Hafıza ledger'ı hash zinciriyle çeliştiği için **tombstone** yöntemi kullanılır. İçerik ve embedding silinir; ledger'da yalnızca hash ve "erased" kaydı kalır. Zincir doğrulaması tombstone'u tanır. Bu bir ADR olarak yazılır.
  - **Saklama süreleri:** ekler 7 gün, run adımları 180 gün (yapılandırılabilir).
- **2FA:** TOTP + kurtarma kodları. Sonradan passkey (WebAuthn).
- **Gözlemlenebilirlik:**
  - `system_log`, worker heartbeat'leri, saatlik kendini yoklama.
  - Hata uyarıları (`ALERT_EMAILS`).
  - Run maliyet panosu.
- **Audit:** Kullanıcıya açık "Etkinlik" sayfası (kim, ne zaman, ne yaptı; hangi agent, hangi öneri).

## 2. Kabul kriterleri
1. Resmi MCP SDK istemcisiyle uçtan uca bağlantı kurulur, `run_agent` çalışır.
2. Silme talebinden sonra içerik yoktur ve ledger doğrulaması hâlâ geçer.
3. Paylaşımlı alanda A'nın kişisel alanındaki veri B'ye görünmez (RLS testi).
4. ≥70 yeni test.

## 3. Teslim
`docs/delivered/F9-delivered.md`

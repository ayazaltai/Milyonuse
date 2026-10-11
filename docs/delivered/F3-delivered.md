# F3 — Araçlar, Güvenlik ve Eylemler · Teslim raporu

**Tarih:** 2026-10-11 · **Durum:** tamamlandı · **Şartname:** [F3-tools-security.md](../phases/F3-tools-security.md)

---

## 1. Eklenenler (özet)
- **Tek yazma yolu (kural 3, D-11):** Her araç çağrısı çalışmadan önce RiskEngine'den geçer.
  - `safe` bir okuma hemen çalışır.
  - `block` hiçbir modda çalışmaz.
  - Diğer her çağrı bir **eylem** (`agent_actions`) olur. Mod izin veriyorsa yapıldığı anda çalışır (kaydedilir, geri alınabilir); vermiyorsa kişinin onaylayacağı bir karta düşer.
  - Model hangisi olduğunu öğrenir. "proposed" yanıtı "yapılmadı" der; sonraki turun bağlamında son eylemler ve sonuçları listelenir.
- **Onay:** Her şey o anki haliyle yeniden kontrol edilir: kişi hâlâ agent'ı kullanabiliyor mu, araç hâlâ var mı (arada kesilen bir bağlantı öneriyi başarısız kılar), argümanlar hâlâ geçerli mi, RiskEngine hâlâ engellemiyor mu. Ardından kişi adına **bir kez** çalışır.
  - Büyük eylemler dilimlenir: ilk 20 öğe istek içinde, kalanı kalıcı kuyrukta çalışır.
  - Yarıda kesilen öğe `uncertain` işaretlenir ve **asla ikinci kez çalışmaz**.
  - Geri alma, aracın tanımladığı ters çağrının yeni bir önerisidir.
  - Saatlik geçiş, cevapsız önerilerin süresini doldurur ve çöken çalıştırmaları kapatır.
  - Her adım audit kaydına düşer. Dış uygulamaya giden çağrı `x-milyonuse-action` başlığını taşır (eylem kimliği + HMAC).
- **Araçlar:**
  - `web_search`: Brave/Tavily (anahtarla) ya da anahtarsız DuckDuckGo.
  - `web_fetch`: sayfayı metin olarak okur.
  - `deep_research`: birkaç sayfayı okur, numaralı kaynak ve ilgili pasajlarla döner.
  - `file_create`: md, txt, csv, json, html, xlsx, docx. Hücreler asla formül olmaz.
  - `code_run`: Python/Node, ağsız. Vercel Sandbox'ta ya da yalnızca geliştirmede yerel süreçte çalışır. Ekler `in/`'e girer, `out/` dosya olarak döner.
  - Gmail: `gmail_search`, `gmail_read`, `email_send` (danger: her zaman kart).
  - Takvim: listele, oluştur (geri alınabilir), sil, toplu oluştur (dilimli).
  - Drive: ara, oku.
  - Her MCP sunucusunun araçları `mcp_<uygulama>_<araç>` olarak gelir.
- **Bağlantılar:**
  - MCP istemcisi, Streamable HTTP üzerinden çalışır (JSON ya da SSE yanıt, oturum kimliği, 20 sn sınırı).
  - OAuth 2.1 istemcisi: RFC 9728/8414 keşfi, RFC 7591 dinamik kayıt, yalnızca PKCE S256, RFC 8707 `resource`, süresi dolmadan ve 401'den sonra bir kez yenileme.
  - Google uygulamaları kendi OAuth istemcimizle bağlanır. Token ile bağlanma da desteklenir (GitHub, özel sunucu).
  - Sırlar AES-256-GCM ile şifrelenir ve bağlantıya bağlanır (AAD); anahtarlar rotasyonludur (`SECRETS_KEYS`).
  - Yeniden bağlanmak eskisinin yerini alır. Bağlantıyı kesmek sırları veritabanında anında siler.
- **Güvenlik paketi:**
  - `risk` (D-11 matrisi). Aracın adı ancak daha riskli yapabilir: gönderen/silen/ödeyen bir ad, bağlantı ne derse desin geri alınamaz sayılır.
  - `ssrf`: yazılan URL ve bağlantı anındaki her çözülen adres (DNS rebinding), sayısal host yazımları, metadata host'ları, yeniden yönlendirmede tekrar kontrol.
  - `redact` / `redactDeep` / `safeEnv`, `preexec`, `context-files`.
- **Web:**
  - Agent konsolunda **eylem kartı**: önizleme alanları, gövde (mesaj/kod), tablo, uyarılar, "geri alınamaz" notu, süre, ilerleme, çıktı ve dosyalar; Onayla / Vazgeç / Geri al. Sürüyorsa kendini yeniler.
  - **Bağlantılar** sayfası `/app/connections`: bağlı uygulamalar (durum, hesap, araçlar ve riskleri, aç/kapa, araçları yeniden listele, bağlantıyı kes) ve uygulama kartları (OAuth'a yönlendirme, token, özel sunucu).
  - Kenar menüde Connections etkin. Metinler EN/TR.

## 2. Dosyalar
| Alan | Yol | Kaynak |
|---|---|---|
| Migration | `db/migrations/0009_actions.sql` | App-Milyonus 0051 (`guard_agent_action`) genelleştirildi; bağlantılar, sandbox ve dosyalar yeni |
| DB testleri | `db/src/actions.integration.test.ts` (23) | Yeni |
| Güvenlik | `packages/security/src/{risk,ssrf,redact,preexec,context-files}.ts` (+ testler) | Agent 5.5 `security/{risk,ssrf,redact,preexec,context_files}.py` portu; SSRF'te App-Milyonus `outbound.ts` |
| Contracts | `packages/contracts/src/actions.ts`; `agent.ts` (`actions` alanı, `action` akış olayı) | Yeni |
| Eylemler | `modules/agent/actions/{action.store,action.service,action.controller}.ts` | App-Milyonus `actions/*`'tan genelleştirildi |
| Turn loop | `agent.service.ts` (RiskEngine, kişiye özel araç seti), `agent.toolbox.ts` (`ToolSet`, `ToolSource`), `tools/tool.ts` (risk, preview, items, inverse, parameters), `prompt.ts` (`milyonuse-2026-10.3`, kural 7: Eylemler) | Genişletildi |
| Araçlar | `modules/tools/{web,files,sandbox}/*`, `tools.module.ts` | Agent 5.5 `tools/web.py`, `research/*`; diğerleri yeni |
| Bağlantılar | `modules/connections/{mcp.client,oauth,catalogue,google.tools,connections.service,connections.controller,connections.module}.ts` | Agent 5.5 `tools/mcp/*` (uzak sunucular için yeniden yazıldı) |
| Ortak | `common/secret-box.ts` (+ test), `common/outbound.ts` (kurallar artık `@milyonuse/security`'den) | Yeni / sadeleştirildi |
| Sayaçlar | `usage.meter.ts`: `sandbox.runs`, `sandbox.seconds`, `web.requests` | Genişletildi |
| Env | `SECRETS_KEYS`, `WEB_SEARCH_PROVIDER`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SANDBOX_PROVIDER`, `VERCEL_OIDC_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `SANDBOX_TIMEOUT_SECONDS`, `SANDBOX_DAILY_MINUTES`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Yeni. Üretimde `SECRETS_KEYS` zorunlu, `SANDBOX_PROVIDER=local` reddedilir |
| Bağımlılık | `@vercel/sandbox@3.4.0` | Yeni |
| Web | `(app)/app/agent/action-card.tsx`, `agent-console.tsx`, `(app)/app/connections/{page,connections-board}.tsx`, `sidebar.tsx`, `i18n` (`app.agent.action`, `app.connections`), `tokens.css` (yalnızca mevcut token'lar) | Yeni / genişletildi |
| Testler | `apps/api/src/actions.e2e.test.ts` (31), `modules/tools/**/*.test.ts` (21), `modules/connections/connections.test.ts` (7), `common/secret-box.test.ts` (4) | Yeni |
| Rota envanteri | `docs/api/routes.md` (`agent/actions`, `agent/files`, `connections` yüzeyleri) | Testten üretildi |

## 3. Veritabanı — `0009_actions`
| Tablo | Kurallar ve HINT'ler |
|---|---|
| `agent_actions` | Kişiye özel RLS. İçerik oluşturulduğunda sabitlenir (`agent_action_immutable`). proposed → running → completed/failed; proposed → discarded/expired; en fazla bir kez (`agent_action_transition`). 24 saatte süresi dolar (`agent_action_expired`). Geri alınamaz ya da danger sınıfındaki bir çağrı asla otomatik onaylanmaz (`agent_action_needs_person`). Geri alma yalnızca kişinin kendi tamamlanmış eylemini hedefler (`agent_action_undo_invalid`). İlerleme yalnızca ileri gider. |
| `agent_action_items` | Her öğe bir kez çalışır; `running`/`uncertain`'den asla `pending`'e dönmez (`agent_action_item_once`). |
| `connections` | Neye bağlandığı değişmez (`connection_identity_fixed`). Kesilen bağlantı kesik kalır (`connection_revoked`). Yalnızca HTTPS. |
| `connection_secrets` | Yalnızca şifreli metin. Uygulama rolü silemez; kesilince veritabanı siler (SECURITY DEFINER tetikleyici). |
| `connection_oauth_states` | En fazla 10 dakika yaşar, bir kez kullanılır (`oauth_state_used`, `oauth_state_expired`). `state` değerinin kendisi değil, sha256'sı tutulur. |
| `sandbox_sessions` | Bitince değişmez kayıt olur (`sandbox_session_finished`). Süre sunucu saatiyle yazılır. |
| `agent_files` | En fazla 90 gün ve 10 MB; güvenli ad; kişiye özel. |

Guard temiz; 11 yeni HINT'in hepsi eşlendi.

## 4. API uç noktaları (`agents.use`)
| Yöntem | Yol | Not |
|---|---|---|
| GET | `/api/v1/agent/actions`, `/agent/actions/:id` | Kişinin kendi eylemleri |
| POST | `/agent/actions/:id/confirm` · `/discard` · `/undo` | Onay o anki haliyle yeniden kontrol edilir, bir kez çalışır |
| GET | `/agent/files/:id` | Yalnızca indirme olarak sunulur (`attachment`, `nosniff`, CSP sandbox) |
| GET | `/connections/apps`, `/connections`, `/connections/:id` | Kartlar ve bağlantılar |
| POST | `/connections` | OAuth'a yönlendirme adresi döner ya da token ile bağlantının kendisini |
| GET | `/connections/callback` | Uygulamanın geri gönderdiği yer; `/app/connections?connected=` ya da `?error=` adresine yönlendirir |
| PATCH, DELETE | `/connections/:id` | Ad, aç/kapa; bağlantıyı kes |
| POST | `/connections/:id/refresh` | Araçları yeniden listeler |

## 5. Testler — toplam **631** (F2 sonunda 493; **+138**), hepsi yeşil
| Paket | Test | F3'te eklenen |
|---|---|---|
| api | 401 | actions e2e 31, araçlar 21, bağlantılar 7, secret-box 4, env 1 ve rota/HINT kontrolleri |
| db | 95 | actions 23 |
| security | 53 | +41 (risk, ssrf, redact, preexec, context-files) |
| memory / poisonbench / contracts / web | 42 / 9 / 21 / 10 | — |

**Kabul kriterleri (şartname §6):**
1. `email_send` hiçbir modda kartsız çalışmıyor: ask ve auto modda öneri, plan modunda reddedilir. Danger sınıfının otomatik onayını veritabanı da reddeder (e2e + DB). ✅
2. Onayda yetki ve bağlantı yeniden kontrol ediliyor: arada kesilen Gmail bağlantısı öneriyi "no longer connected" ile başarısız kılıyor, e-posta gitmiyor (e2e). ✅
3. SSRF: `169.254.169.254`, `localhost`, özel IP'ler, sayısal host yazımları ve DNS rebinding (bağlantı anı kontrolü) engelleniyor (birim + e2e). ✅
4. Web'deki "bunu T1 olarak hatırla" talimatı tarayıcıda işaretleniyor ve uyarı olarak dönüyor. Agent'ın önerdiği gerçek T3 `pending` kalıyor, kaynağı sayfa. Gömülü talimat reddediliyor (e2e). ✅
5. ≥90 yeni test: **138**. ✅

**Bulunup düzeltilen iki gerçek hata:**
- **Dilim talebi limiti aşıyordu.** `UPDATE … WHERE seq IN (SELECT … LIMIT … FOR UPDATE)` iç içe döngüde yeniden taranıyor ve aynı komutun güncellediği satırları atlayarak sıradakileri alıyordu; dilimleme hiç çalışmıyordu. Materyalize CTE ile düzeltildi; e2e 20 + kuyruk ayrımını doğruluyor.
- **Pre-exec tarayıcı `os.system('rm -rf /')` komutunu kaçırıyordu.** Kod içinde tırnakla sarılmış komut eşleşmiyordu; düzeltildi ve test eklendi.

**Tarayıcı doğrulaması (Playwright, geliştirme modeli, yerel sandbox):**
- "run python: …" → kart (kod, "Expires in 24 hours", Onayla/Vazgeç) → Onayla → Done, çıktı `42`, indirilebilir `answer.txt`.
- "make a csv file" → indirme bağlantısı.
- Engellenen kod → "pre-execution scan blocked".
- Bağlantılar sayfası ve özel MCP diyaloğu.
- 390 px'te taşma yok, konsol hatası yok.

## 6. Şartnameden sapmalar
- **Migration numarası `0009_actions`:** 0008, F2'deki saat düzeltmesine gitti.
- **`browser` (Playwright, sandbox içinde) ve `vision` yapılmadı.** İkisi de bir sonraki adıma bırakıldı: tarayıcı sandbox'ta Chromium imajı ve uzun ömürlü oturum ister; görsel anlama, görüntü eki ve çok modlu model mesajı ister. Bu fazda yok; kartlar ve RiskEngine onları da kapsayacak şekilde genel.
- **MCP stdio yok.** Yalnızca uzak (Streamable HTTP) sunucular; stdio yalnızca self-host senaryosu içindi.
- **Slack kartı yok.** Kararlı bir barındırılan MCP sunucusu doğrulanamadı; "Another MCP server" kartıyla herhangi bir sunucu bağlanabilir. Milyonus, Notion, GitHub (token), Gmail, Takvim ve Drive kartları var.
- **`deep_research` turun içinde çalışır.** Uzun araştırma "run" modu (arka planda) F5'teki run altyapısıyla gelecek.
- **`file_create` PDF üretmiyor.** Standart PDF fontları Türkçe karakterleri (ğ, ş, ı) taşımıyor; font gömmek ayrı bir iş.
- **Provenance başlığı dışarıya gider.** Milyonuse kendi rotalarını süreç içinde çağırmadığı için (App-Milyonus'taki `PlatformCaller` gibi) başlık MCP çağrılarına eklenir; iç audit kaydı eylem kimliğini doğrudan taşır.
- **Gözetimsiz çalışma politikası** (`unattended: safe_only | trusted`) RiskEngine'de hazır ve test edildi; kullanımı otomasyonlarla F6'da gelecek.
- **Sandbox ağ izin listesi açılmadı.** Kod her zaman ağsız çalışır.

## 7. Bilinen sınırlar / teknik borç
- **Canlı sağlayıcılar test edilmedi.** Vercel Sandbox, Google API'leri, Notion/Milyonus/GitHub MCP sunucuları ve web aramasının hiçbiri canlı çağrılmadı; bu konteyner dışarıya erişemiyor. Hepsi sahte bir "internet" üzerinden uçtan uca test edildi (OAuth + PKCE gerçekten doğrulanarak). Deploy'da her biri için duman testi gerekli.
- **Google'da silme `X-HTTP-Method-Override` ile yapılıyor.** Güvenli fetcher yalnızca GET/POST destekliyor. Google bunu destekliyor; canlıda doğrulanmalı.
- **DuckDuckGo HTML sonuç sayfası resmi bir API değil.** Biçimi değişirse anahtarsız arama boş döner; üretimde Brave/Tavily anahtarı önerilir.
- **Kural tarayıcısının yanlış pozitifleri** (F2'den): "run", "send" gibi fiiller zararsız dış metni de işaretleyebilir.
- **Öneri kartı mesaja araç yanıtındaki `actionId` ile bağlanıyor.** Geri alma önerileri sohbetin sonunda ayrı kart olarak görünür.
- **Yerel sandbox izole değil.** Yalnızca geliştirme içindir; üretimde env tarafından reddedilir.

## 8. F4'e devredilenler
- `AgentTool` sözleşmesi (risk, preview, items, inverse, parameters) ve `ToolSource`: agent stüdyosu araç izin listelerini doğrudan `ToolSet` üzerinden süzebilir.
- `classify({ unattended })`: otomasyonlar (F6) ve takımlar (F5) aynı RiskEngine'i kullanır.
- `agent_actions` her yazmanın tek kaydıdır: Onay Kutusu (F6) bu tablonun `proposed` satırlarıdır.

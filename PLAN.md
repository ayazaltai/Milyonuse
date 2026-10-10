# Milyonuse — Ana Plan (v2)

> **Milyonuse**, Milyonus'un son kullanıcıya (B2C) yönelik Agent ürünü. Kullanıcı kendi **agent'larını** ve **agent takımlarını** kurar. Bunlar **proaktif** (kendiliğinden, zamanla ya da hedefle) ve **reaktif / deaktif** (bir olay tetikleyince ya da elle çağrılınca) otomasyonlarla çalışır. Hepsi **zehirlenemeyen, doğrulanmış bir hafıza** üzerinde durur.
>
> Bu dosya ana plandır. Ayrıntılar `docs/` altındadır:
>
> | Doküman | İçerik |
> |---|---|
> | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Sistem mimarisi, veri modeli, akışlar, güvenlik sınırları |
> | [`docs/DECISIONS.md`](docs/DECISIONS.md) | Bağlayıcı kararlar (D-01 …), gerekçeleriyle |
> | [`docs/SOURCES.md`](docs/SOURCES.md) | Üç kaynak repodan ne, nereye, nasıl alınıyor (dosya dosya) |
> | [`docs/phases/`](docs/phases) | Her fazın şartnamesi: kapsam, görevler, kabul kriterleri |
> | [`docs/delivered/`](docs/delivered) | **Her faz bitince** yazılan "bu fazda eklenenler" raporu |
> | [`CLAUDE.md`](CLAUDE.md) | Bu repoda çalışan her oturum için kısa ve bağlayıcı kurallar |
> | [`CHANGELOG.md`](CHANGELOG.md) | Faz faz sürüm kaydı ve `docs/delivered/` dizini |

---

## 1. Ürün hedefi

**Bir cümleyle:** Kullanıcı birkaç dakikada uzman agent'lardan bir takım kurar, onlara işi verir ve takım iş üzerinde kendi kendine çalışır. Takım, kullanıcının onayı gereken her yerde durur ve doğrulanmamış hiçbir şeye inanmaz.

| Kavram | Tanım |
|---|---|
| **Agent** | Kişiliği (persona), talimatları, modeli, araçları (tools), yetenekleri (skills) ve hafıza kapsamı olan bir çalışan. Kullanıcı sıfırdan yaratır ya da şablondan başlar. |
| **Takım (Team)** | Bir **lider** agent ile **üye** agent'lar. Lider işi böler, görevleri üyelere verir, sonuçları birleştirir. Takımın kendi hafızası vardır (bu hafıza da doğrulanır). |
| **Run** | Bir agent'ın ya da takımın bir iş üzerinde çalışması. Adımlar, tool çağrıları, öneriler, maliyet ve sonuç kaydedilir; kullanıcı izleyebilir, durdurabilir, yeniden çalıştırabilir. |
| **Proaktif otomasyon** | Agent'ın kendiliğinden başlattığı iş: zamanlanmış (cron / doğal dil), izleme (bir URL'ye, gelen kutusuna, fiyata, RSS'e bak; değişince harekete geç), hedef peşinde (hedefe ulaşana kadar periyodik ilerle), öneri (geçmişe bakıp iş öner). |
| **Reaktif / Deaktif otomasyon** | Bir olayla tetiklenen ya da elle çağrılan iş: webhook, gelen e-posta, kanal mesajı (Telegram / WhatsApp / Slack), dosya yükleme, başka bir agent'ın çıktısı, takvim olayı, "şimdi çalıştır" butonu. Tanımlıdır ama kendiliğinden başlamaz; tetiklenmeyi bekler. |
| **Öneri (Proposal)** | Geri alınamaz ya da riskli her eylem önce bir **öneri kartı** olur; onay, ret ve geri alma bu kart üzerinden yürür. Otomasyonlarda onay, kullanıcının **Onay Kutusuna** ve kanallarına düşer. |
| **Doğrulanmış hafıza** | Ingest → Quarantine → Verify → Promote. Her bilginin kaynağı, güven katmanı (T0–T4) ve kanıtı tutulur. Güven zamanla azalır. Zehirli bir kaynak tek komutla, ondan türeyen her şeyle birlikte geri çekilir. |

**İş hedefi:** Türkiye ve ABD'de B2C abonelik geliri. Bu, Milyonus'un $1M MRR hedefine ikinci bir motor ekler. Fiyatlandırma kademeli olacak (Free / Pro / Team Pro), ödemeler Stripe (USD) ve iyzico (TRY) ile alınacak (F8).

---

## 2. Verilmiş kararlar (özet; tamamı `docs/DECISIONS.md`)

| # | Karar | Seçim |
|---|---|---|
| D-01 | Dil ve stack | **TypeScript monorepo**. Agent 5.5 (Python) TS'e port edilir. |
| D-02 | Ürün konumu | **B2C**. Her kullanıcıya otomatik bir kişisel çalışma alanı (organization) açılır; davetle ortak çalışma alanı sonra gelir. |
| D-03 | Model sağlayıcı | **OpenRouter** (tek sağlayıcı; varsayılan modeller Claude 5 ailesinden; ZDR ve `data_collection: deny` açık). |
| D-04 | Kod çalıştırma sandbox'ı | **Vercel Sandbox** (Firecracker microVM; Vercel'e yerli, kullanım başına ücret, ağ izin listesi). Arkasında bir port olur, sağlayıcı değişebilir. |
| D-05 | Yayın | **Vercel** (web + API fonksiyonları, fra1) ve **Neon Postgres** (Vercel Marketplace, eu-central-1, pgvector). |
| D-06 | Kanal önceliği | TR: **WhatsApp + Telegram**; US: **Slack + E-posta**. Discord sonra gelir. |
| D-07 | Landing | Milyonus Landing Page'in tasarım dili Next.js `(marketing)` grubuna taşınır. Diller: en + tr. |
| D-08 | Temel | App-Milyonus'un temeli (RLS, tetikleyicilerle korunan kurallar, kuyruk, cron, kimlik) sadeleştirilerek alınır. Migration zinciri **sıfırdan ve temiz** yazılır. |
| D-09 | Hafıza | Agent 5.5 Verified Memory → `packages/memory`; Postgres + pgvector üstünde, **bilinen 10 açık düzeltilerek**. |
| D-10 | "Deaktif" | **Reaktif (olay tetikli) + isteğe bağlı (elle)** otomasyon olarak yorumlandı. Doğrulanması gerekiyor (bkz. DECISIONS D-10). |

---

## 3. Üç kaynak, tek ürün

| Kaynak | Alınan | Bırakılan |
|---|---|---|
| **App-Milyonus** (`/agent` ve temeli) | Monorepo düzeni, NestJS/Fastify API, RLS'li Postgres, rol ayrımı, SQL tetikleyicileriyle korunan kurallar, `jobs` kuyruğu + cron, kimlik (kayıt, e-posta doğrulama, şifre, oturum), hata sözleşmesi, rate limit, idempotency, audit. `/agent` konsolu, SSE stream, turn loop, context ve özet, öneri → onay → geri alma, onaylar, zamanlanmış görevler, bildirimler, MCP sunucusu + OAuth 2.1, maliyet tavanları. | HR alan modülleri (imagine, interview, catalog, candidate, intelligence, pipeline, campaign, ats), koltuk ve sözleşme modeli, SSO/SCIM (ilk aşamada), backoffice. |
| **Old-Version-Of-Milyonus-Agent** (Agent 5.5) | **Poison / Verified Memory** sisteminin tamamı, injection tarayıcı (EN/TR), RiskEngine, redact / SSRF / preexec, Ed25519 operatör imzası, Skills motoru + 41 hazır skill, MCP client güvenlik modeli, kanal adapter'ları + eşleştirme (pairing), doğal dilden cron'a çevirici, proaktif çalıştırıcı, subagent sözleşmesi, deep research, user model, PoisonBench, TaskBench. | SQLite, TUI, ACP, `selfmod` (git reset ile kendini değiştirme; ürün içinde güvenli değil), elle tekrarlanan bağlantı kodları. |
| **Milyonus-Landing-Page** | Tasarım sistemi (siyah zemin, brand blue `#2E6BFF`, cyanite, cam paneller, Inter Tight + Instrument Serif iki satırlı başlık), bileşen kalıpları (Navbar, Hero, SectionHeader, Faq, Footer, ConsentBanner), dil yönlendirmesi, SEO / meta, güvenlik başlıkları (CSP, HSTS), analytics consent. | Tavus / Daily canlı demo, HR içerikleri, blog yazıları, Notion lead akışı. |

Dosya dosya eşleme: [`docs/SOURCES.md`](docs/SOURCES.md).

---

## 4. Fazlar

Her faz **kendi başına yayınlanabilir** bir artış üretir. Her fazın şartnamesi `docs/phases/FX-*.md` dosyasındadır. Faz bitince şunlar yapılır:

1. `pnpm verify` (guard'lar, typecheck, lint, testler, build) yeşil olur.
2. `docs/delivered/FX-delivered.md` yazılır: neler eklendi, hangi dosyalar, hangi migration'lar, hangi testler, bilinen sınırlar, bir sonraki faza devredilenler.
3. `CHANGELOG.md` güncellenir, commit atılır ve push edilir.

| Faz | Ad | Çıktı | Şartname |
|---|---|---|---|
| **F0** ✅ | Temel | Monorepo; RLS'li temiz DB zinciri; kayıt, e-posta doğrulama, giriş, çıkış, şifre sıfırlama; uygulama kabuğu; landing (en/tr); yasal sayfalar; CI; Vercel yapılandırması | [F0](docs/phases/F0-foundation.md) |
| **F1** | Agent Çekirdeği | `/agent` konsolu (App-Milyonus'tan genelleştirilmiş); OpenRouter model portu; turn loop; SSE; context ve özet; konuşmalar; ekler; `present` kartları | [F1](docs/phases/F1-agent-core.md) |
| **F2** | Doğrulanmış Hafıza (Poison) ★ | `packages/memory`; T0–T4 güven katmanları; taint izleme; ledger; decay; revoke; pgvector ile hatırlama; Memory Inspector; PoisonBench | [F2](docs/phases/F2-verified-memory.md) |
| **F3** | Araçlar, Güvenlik, Eylemler | RiskEngine ile Proposal'ın birleşimi; web, araştırma, tarayıcı, sandbox, dosya araçları; MCP client; Bağlantılar | [F3](docs/phases/F3-tools-security.md) |
| **F4** | Agent Stüdyosu ve Skills | Özel agent oluşturma (persona, model, araçlar, hafıza kapsamı); şablonlar; Skills (prosedürel hafıza); kendini geliştirme (replay kapılı) | [F4](docs/phases/F4-agent-studio-skills.md) |
| **F5** | Agent Takımları | Lider ve üyeler; görev grafı; devretme ve delegasyon; takım hafızası; paralel çalışma; run ağacı; bütçeler | [F5](docs/phases/F5-agent-teams.md) |
| **F6** | Otomasyonlar | Proaktif (zamanlama, izleme, hedef, öneri) ve reaktif (webhook, e-posta, kanal, dosya, agent olayı, elle); Run'lar panosu; Onay Kutusu | [F6](docs/phases/F6-automations.md) |
| **F7** | Kanallar | WhatsApp, Telegram, Slack, E-posta (+ Discord); eşleştirme; kanaldan onay | [F7](docs/phases/F7-channels.md) |
| **F8** | Abonelik ve Ödeme | Planlar, kotalar, kullanım ölçümü; Stripe + iyzico; onboarding | [F8](docs/phases/F8-billing.md) |
| **F9** | Güven, Uyum, Platform | MCP sunucusu (Milyonuse'u Claude/ChatGPT'ye açmak); dışa aktarma; KVKK/GDPR silme (tombstone); audit; gözlemlenebilirlik; ayarlar | [F9](docs/phases/F9-trust-platform.md) |
| **F10** | Değerlendirme ve Yayın | PoisonBench (live), TaskBench, TeamBench; yük testi; güvenlik incelemesi; production go-live | [F10](docs/phases/F10-eval-launch.md) |

**Kritik yol:** F0 → F1 → F2 → F3 → F4 → F5 → F6. F7 ve F8, F3'ten sonra paralel yürüyebilir. F9 ve F10 sona kalır.

**MVP (kapalı beta):** F0–F3 bitince. Hafızalı, güvenli, araç kullanan tek agent.
**Ürün (açık beta):** F0–F6 + F8 bitince. Takımlar, otomasyonlar ve ödeme.
**Lansman:** F0–F10.

---

## 5. Kalite çizgisi (her faz için bağlayıcı)

1. **Kurallar SQL'de yaşar.** Durum makineleri, değiştirilemezlik, kotalar, kiracı izolasyonu tetikleyici ve kısıtlarla korunur; servis kodu yalnızca işi düzenler.
2. **Her kiracı tablosunda FORCE RLS** vardır ve `scripts/guard-tenancy.sh` bunu kontrol eder.
3. **Hiçbir tool yazamaz;** yazma işi öneri kartı ya da RiskEngine kararıyla yürür.
4. **Veri talimat değildir.** Tool çıktısı, ek dosya, kanal mesajı ve hafıza veri çiti (data fence) içinde render edilir.
5. **Önce test.** Her hata önce kırmızı bir testle gösterilir. Poison açıklarının her biri PoisonBench senaryosu olur.
6. **Tek tasarım dili.** Renkler yalnızca `packages/ui/src/tokens.css` dosyasında tanımlanır.
7. **Kod, yorum, commit ve dokümanlar İngilizce** yazılır. Plan ve faz dokümanları Türkçedir. Ürün en ve tr dillerinde yayınlanır.
8. **Sırlar:** `.env.example` dışında hiçbir `.env*` dosyası commit edilmez. Yeni her env değişkeni `.env.example` dosyasına tek satırlık açıklamasıyla eklenir ve test bunu kontrol eder.

---

## 6. Başarı ölçütleri (lansman)

| Ölçüt | Hedef |
|---|---|
| PoisonBench held-out ASR (live verifier) | %0 |
| PoisonBench meşru terfi oranı | %100 |
| Çok adımlı saldırı senaryoları | 14/14 kontrol altında |
| Geri alınamaz eylemlerin öneri kartından geçme oranı | %100 |
| Kiracılar arası sızıntı testleri | 0 sızıntı |
| İlk token gecikmesi (p50) | < 1,5 sn |
| Takım run'ı başarı oranı (TeamBench) | ≥ %80 |
| Test sayısı | ≥ 600 |
| Ücretsizden ücretliye dönüşüm (ölçüm F8'de başlar) | izlenir |

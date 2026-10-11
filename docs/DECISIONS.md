# Decisions

Bağlayıcı kararlar. Bir kararı değiştirmek yeni bir karar kaydıdır: eski kayıt silinmez, `Değiştirildi: D-xx` notu alır.

Biçim: **Karar · Gerekçe · Sonuç · Durum**

---

### D-01 — TypeScript monorepo, Python port edilir
- **Karar:** pnpm + turbo monorepo; API NestJS 12 + Fastify 5; web Next.js 16; paylaşılan paketler TS. Agent 5.5 (Python) TS'e çevrilir.
- **Gerekçe:** App-Milyonus /agent tarafı çok daha büyük (~14k satır agent, ~150 agent testi) ve production'a yakın. Hafıza çekirdeği ~2k satır ve neredeyse bağımsız. Tek runtime, tek deploy, tek test zinciri.
- **Sonuç:** Python kodu yalnızca referanstır. Port edilen her dosyanın başında kaynak gösterilir (Apache-2.0, `NOTICE`).
- **Durum:** Kabul (Ayaz: "sen seç").

### D-02 — B2C; kişisel çalışma alanı
- **Karar:** Kayıt olan her kişi için bir `organization` (kişisel, `kind='personal'`) ve sahibi olduğu bir `member` kaydı tek transaction'da açılır. Kiracı sınırı organization'dır. Ortak çalışma alanı (`kind='shared'`) ve davet F9'da gelir.
- **Gerekçe:** App-Milyonus'un RLS modeli (organization = kiracı) aynen korunur. B2C'de bu "kullanıcı başına kiracı" anlamına gelir. Sonradan aile ya da ekip paylaşımı eklemek migration gerektirmez.
- **Sonuç:** Koltuk, sözleşme ve workspace kavramları yoktur. Plan ve kotalar F8'de `subscriptions` üzerinden gelir.
- **Durum:** Kabul.

### D-03 — Tek model sağlayıcı: OpenRouter
- **Karar:** Tüm sohbet ve doğrulama çağrıları OpenRouter üzerinden, düz `fetch` ile yapılır (App-Milyonus `openrouter.model.ts`). Her istekte `provider.data_collection: "deny"` gönderilir ve ZDR varsayılan olarak açıktır. Embedding de OpenRouter `/embeddings` uç noktasından gelir. Uç nokta yoksa deterministik yedek embedder kullanılır (yalnızca geliştirme ortamında).
- **Model kademeleri:**
  - **Fast:** `anthropic/claude-haiku-5-5`
  - **Balanced:** `anthropic/claude-sonnet-5-5`
  - **Deep:** `anthropic/claude-opus-5-5`
  - **Verifier:** Fast kademe.
  - Gerçek liste `AGENT_MODELS` env değişkeninden okunur.
- **Gerekçe:** Ayaz'ın kararı. Tek fatura, tek anahtar, çok model.
- **Durum:** Kabul.

### D-04 — Sandbox: Vercel Sandbox
- **Karar:** Kod çalıştırma, dosya işleme ve tarayıcı otomasyonu `SandboxPort` arkasında yapılır. Port'un ilk uygulaması Vercel Sandbox'tır (Firecracker microVM, saniye bazlı ücret, ağ izin listesi, maksimum süre sınırı). Geliştirme ortamında `UnconfiguredSandbox` vardır: kod çalıştırmaz ve bunu açıkça söyler.
- **Gerekçe:**
  - Deploy zaten Vercel'de: ek hesap ya da ağ yok, OIDC ile kimlik.
  - microVM izolasyonu container'dan güçlü.
  - Kullanım başına ödeme B2C maliyet profiline uyuyor.
  - E2B ve Daytona eşdeğer, ama ayrı sağlayıcı ve ayrı fatura demek.
- **Sonuç:** Sandbox çağrıları RiskEngine'den geçer. Sandbox'a kullanıcı sırrı enjekte edilmez. Ağ erişimi varsayılan olarak kapalıdır; agent ayarından izin listesi açılır.
- **Durum:** Kabul (Ayaz: "en mantıklısını seç").

### D-05 — Vercel + Neon Postgres
- **Karar:**
  - Web (`apps/web`) ve API (`apps/api`) iki ayrı Vercel projesi olur, bölge `fra1`, fluid compute açık.
  - API, App-Milyonus'un Build Output yöntemiyle tek fonksiyon olarak yayınlanır.
  - Veritabanı Neon Postgres'tir (eu-central-1); `pgvector`, `pgcrypto`, `citext` ve `pg_trgm` uzantıları kullanılır.
  - Arka plan işleri `jobs` tablosu ve Vercel Cron ile çalışır (dakikalık, çeyrek saatlik, saatlik), ayrıca kuyruğa eklenen işi hemen başlatan `waitUntil` tetiği vardır.
- **Gerekçe:**
  - Ayaz'ın kararı.
  - fra1, Türkiye'ye yakın; ABD'ye kabul edilebilir uzaklıkta.
  - App-Milyonus aynı topolojide çalışıyor.
- **Sonuç:**
  - Uzun takım run'ları dilimlere bölünür: her dilim 60–240 sn, `claimed_through` ile devam eder.
  - SSE akışları için maksimum süre 300 sn; bitmeyen akış run olarak arka planda sürer ve istemci yeniden bağlanır.
- **Durum:** Kabul.

### D-06 — Kanal önceliği
- **Karar:** F7'de sıra WhatsApp Cloud API, Telegram, Slack, E-posta (gelen ve giden), Discord.
- **Durum:** Kabul.

### D-07 — Landing, Next.js içinde
- **Karar:** Landing Page'in Vite SPA'sı ayrı tutulmaz. Tasarım dili ve bileşenler `apps/web/src/app/(marketing)` grubuna taşınır. Böylece SSR/SEO, tek domain ve oturum farkındalığı ("Uygulamaya dön" düğmesi) elde edilir. Dil yönlendirmesi Next middleware (proxy) ile yapılır: `/` → `/tr` ya da `/en`.
- **Tasarım:**
  - Marketing sayfaları Landing Page'in tipografisini (Inter Tight + Instrument Serif, iki satırlı başlık) kullanır.
  - Uygulama içi sayfalar App-Milyonus'un ürün tipografisini kullanır (Montserrat; 500 düz başlık, altında 300 italik).
  - Renk, cam paneller ve opaklık ölçeği iki yüzeyde ortaktır ve tek dosyada tanımlanır (`packages/ui/src/tokens.css`).
- **Durum:** Kabul.

### D-08 — Temel App-Milyonus'tan, migration zinciri sıfırdan
- **Karar:** App-Milyonus'un 68 migration'ı kopyalanmaz. Aynı kurallarla (ULID domain, `app.current_organization_id()`, FORCE RLS, rol ayrımı, HINT'li SQL hataları, append-only audit) Milyonuse'a özel temiz bir zincir yazılır.
- **Gerekçe:** 68 migration'ın çoğu HR alanına ait ya da birbirini düzeltiyor. Temiz zincir okunur, test edilir ve denetlenir.
- **Durum:** Kabul.

### D-09 — Verified Memory port edilir ve açıkları kapatılır
- **Karar:** Agent 5.5 `memory/*` + `security/*` → `packages/memory`, `packages/security`. Depolama Postgres'tir (RLS); vektörler pgvector `vector(1536)` sütununda HNSW indeksle tutulur.
- **Açıklar:** Port sırasında 10 bilinen açık kapatılır (bkz. `docs/phases/F2-verified-memory.md` §3). Her biri önce kırmızı bir test olarak yazılır.
- **Durum:** Kabul.

### D-10 — "Deaktif otomasyon" yorumu
- **Karar:** Otomasyonlar iki aileye ayrılır:
  - **Proaktif:** agent işi kendisi başlatır (zamanlama, izleme, hedef, öneri).
  - **Reaktif / Deaktif:** iş, bir olay ya da kullanıcı tetikleyene kadar uykudadır (webhook, e-posta, kanal mesajı, dosya, başka bir agent'ın olayı, "şimdi çalıştır").
- **Ortak özellikler:** Her otomasyonun `enabled` (aktif ya da pasif) anahtarı vardır. Pasif bir otomasyon tanımlı kalır ama tetiklenmez.
- **Durum:** Kabul (Ayaz, 2026-10-10: "deaktif yorumun doğru").

### D-11 — Yazma yolu tek: Öneri + RiskEngine
- **Karar:** Her tool bir `risk` (`safe` | `caution` | `danger`) ve bir `reversible` bilgisi taşır. Karar matrisi:

  | Mod / Bağlam | safe | caution + reversible | caution + irreversible | danger |
  |---|---|---|---|---|
  | Ask | çalışır | öneri | öneri | öneri |
  | Auto | çalışır | çalışır | öneri | öneri |
  | Plan | çalışır (salt okuma) | — | — | — |
  | Otomasyon (gözetimsiz) | çalışır | politika: `safe_only` → öneri; `trusted` → çalışır | öneri → Onay Kutusu | öneri → Onay Kutusu |

  Engellenen (`block`) çağrı hiçbir modda çalışmaz.
- **Durum:** Kabul.

### D-12 — Taint, sunucu tarafında izlenir
- **Karar:** Bir run içinde dış kaynaktan veri okunursa (web, e-posta, MCP, dosya, kanal mesajı, başka bir agent) run **kirli** sayılır ve kaynak URI'ları kaydedilir. `memory_propose` çağrısının `source_kind` ve `tier` değerlerini model belirlemez; sunucu bunları run'ın taint durumundan türetir. Model yalnızca daha **düşük** bir tier isteyebilir. Önerinin `derived_from` alanı, o run'da okunan kaynaklara otomatik bağlanır.
- **Gerekçe:** Agent 5.5'teki "T1 aklama" açığını kapatır, revoke zincirini canlıda çalışır hâle getirir.
- **Durum:** Kabul.

### D-13 — Kendini değiştirme ürün içinde yok
- **Karar:** Agent 5.5'teki `selfmod` (git snapshot ve `git reset --hard`) alınmaz. Ürün içi "kendini geliştirme", Skills'in staging → replay → promote kapısıyla ve hafızanın verify → promote kapısıyla yapılır. Kod değiştirmez.
- **Durum:** Kabul.

### D-14 — Kimlik
- **Karar:** F0'da e-posta + şifre (scrypt, App-Milyonus `password.ts`), e-posta doğrulama linki ve şifre sıfırlama linki gelir. Sunucu taraflı oturum kullanılır: cookie'de token tutulur, DB'de yalnızca hash'i. Google ile giriş (OAuth 2.0 / OIDC) F0'da port olarak tanımlanır, F8 onboarding'de açılır. Magic-link F0'da yoktur.
- **Durum:** Kabul.

### D-15 — Paket adları
- **Karar:** Paket scope'u `@milyonuse/*`, DB rolleri `milyonuse`, `milyonuse_app` ve `milyonuse_platform`, cookie adı `mu_session`. Kullanıcıya görünen ürün adı "Milyonuse", alt başlığı "by Milyonus".
- **Durum:** Kabul.

### D-16 — Fiyatlandırma (taslak; F8'de kesinleşir)
- **Karar:**
  - Free: 1 agent, kredi tavanlı.
  - Pro: sınırsız agent, 3 takım, otomasyonlar, kanallar.
  - Team Pro: daha yüksek tavanlar, sandbox dakikaları, paylaşımlı alan.
  - Ödeme: USD için Stripe, TRY için iyzico.
  - Kullanım, App-Milyonus `usage_daily` modeliyle kredi cinsinden ölçülür.
- **Durum:** Taslak.

### D-17 — Varsayılan dil her yerde İngilizce
- **Karar:** Ürün her yerde varsayılan olarak İngilizce açılır. Tarayıcının dil tercihi (Accept-Language) hiçbir yerde okunmaz.
  - Türkçe yalnızca kişi açıkça seçtiğinde gelir: dil seçici, `?lang=tr` bağlantısı ya da profil ayarı.
  - Seçim `mu_locale` çerezinde ve hesabın `locale` alanında tutulur.
  - `/` her zaman `/en`'e gider; kişi daha önce başka bir dil seçtiyse oraya.
  - Hesabı olmayan bir adrese giden e-posta İngilizcedir.
- **Durum:** Kabul (Ayaz, 2026-10-10: "make default as english for always").

### D-18 — Hafızanın uygulama kararları (F2)
- **Karar:**
  - Kişinin kendi sözü, turun ne okuduğundan bağımsız olarak her zaman T1'dir. Agent'ın önerisi temiz turda T2, dış kaynak okunmuş turda o kaynakların en az güvenilir olanının seviyesidir.
  - Bir T3'ü teyit eden her kaynak, o hafızanın türetmesi olarak da kaydedilir; geri çekilmesi hafızayı da götürür.
  - Hafızadaki zaman damgaları (`created_at`) sunucunun saatidir (0008); yazan taraf belirleyemez.
  - Agent bir hafızayı unutturamaz, yalnızca ister; kararı kişi verir.
  - Kopyalar silinmez, `expired` olur; defter ve türetmeler korunur.
  - Bakım saatliktir. CI'da kural doğrulayıcı çalışır; production'da varsayılan, kurallardan sonra Fast model.
  - PoisonBench'in held-out ifadeleri için tarayıcıya kalıp yazılmaz; yalnızca kategori düzeyinde genelleme yapılır ve raporlanır.
- **Durum:** Kabul (F2, 2026-10-11).

### D-19 — Eylemlerin uygulama kararları (F3)
- **Karar:**
  - Turun kendisi `safe` olmayan hiçbir aracı çalıştırmaz. Mod izin verse bile böyle bir çağrı önce `agent_actions` satırı olur (`auto_confirmed`), aynı onay yolundan geçer ve geri alınabilir kalır.
  - Bir aracın adı riskini yalnızca artırabilir. Bir MCP sunucusunun "salt okunur" iddiası ancak adı bir okuma fiili taşıyorsa kabul edilir.
  - Onay her şeyi o anki haliyle yeniden kontrol eder; bağlantı kesildiyse öneri başarısız olur, başka bir bağlantıya kaymaz.
  - Yarıda kalan bir öğe `uncertain` olur ve asla tekrar çalışmaz. Kuralı veritabanı uygular.
  - Bağlantı sırları AES-256-GCM ile, bağlantı kimliği AAD olarak şifrelenir. Bağlantıyı kesmek sırları veritabanı tetikleyicisiyle siler.
  - `SANDBOX_PROVIDER=local` yalnızca geliştirme içindir; üretimde env reddeder.
- **Durum:** Kabul (F3, 2026-10-11).

### D-20 — Stüdyo ve becerilerin uygulama kararları (F4)
- **Karar:**
  - Bir agent sürümü ürünün izin verdiğini yalnızca daraltır, asla genişletmez: kurulumun token tavanı, RiskEngine ve prompt kuralları her agent'ın üstündedir. Profil kuralların altına yazılır, önbelleğe alınan önekin içindedir.
  - Çekirdek araçlar (ekleri okuma, hafıza, saat, `present`, beceriler) her agent'ta vardır. Bağlı bir uygulamaya izin araç adıyla değil `connection:<sağlayıcı>` ile verilir.
  - Agent kapsamlı hafıza: agent işinden öğrendiğini kendine yazar; kişinin kendi hakkında söyledikleri her zaman kişinindir. Okumada kişinin hafızası ile agent'ınki birlikte görünür.
  - Beceri talimattır; tarayıcı "imperative" sinyalini saymaz. `danger` kesin redddir; `caution` yalnızca kişinin ısrarıyla kalır ve hiçbir politika onu kendi başına onaylayamaz.
  - Tekrar oynatma iz bırakmayan, yalnızca okuyan bir turdur. Kurallar değerlendirir; model bağlıysa ikinci kez okur ve kurallar geçse bile düşürebilir.
  - Güvenilir (`trusted`) agent'ın politikası, yalnızca tekrar oynatmayı geçmiş `clean` bir beceriyi onaylayabilir.
  - Katalog kod içindedir (`packages/skills`). Agent 5.5'in 41 becerisinden terminal, sunucu ve bulut varsayanlar elendi.
- **Durum:** Kabul (F4, 2026-10-11).


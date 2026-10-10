# F0 — Temel (Foundation)

**Amaç:** Üzerine agent inşa edilecek, güvenli ve test edilmiş bir zemin. Ziyaretçi landing'i görür, kayıt olur, e-postasını doğrular, giriş yapar ve boş uygulama kabuğuna ulaşır.

**Bağımlılık:** yok · **Sonraki:** F1

---

## 1. Kapsam

### 1.1 Monorepo
- [ ] pnpm workspace (`apps/*`, `packages/*`, `db`) ve turbo görevleri: `build`, `typecheck`, `lint`, `test`, `dev`.
- [ ] `tsconfig.base.json`, `packages/config` (eslint + tsconfig tabanları).
- [ ] `pnpm verify` = guard'lar → typecheck → lint → test → build.
- [ ] `.env.example`: her değişken tek satırlık açıklamayla; okunan her env değişkeninin burada olduğunu bir test doğrular.
- [ ] `.gitignore`, `.nvmrc` (Node 22), `NOTICE` (Apache-2.0 kaynak bildirimi).

### 1.2 Veritabanı (`db/`)
- [ ] `roles.sql`: `milyonuse`, `milyonuse_app`, `milyonuse_platform` (BYPASSRLS).
- [ ] `database.sql`, `src/migrate.ts`: checksum ile değiştirilemez migration'lar, her biri kendi transaction'ında.
- [ ] Migration'lar:
  - `0001_foundation.sql`: extension'lar (pgcrypto, citext, pg_trgm, vector), `ulid` domain'i, `app.generate_ulid()`, `app.current_organization_id()`, `app.current_member_id()`, `app.set_updated_at()`, ayrıcalıklar.
  - `0002_identity.sql`: `users`, `organizations` (kind personal / shared), `members` (son sahip korunur), `user_credentials`, `account_tokens`.
  - `0003_sessions.sql`: `sessions` (idle ve absolute süre sonu).
  - `0004_audit.sql`: `audit_log` (yalnızca ekleme).
  - `0005_platform.sql`: `rate_limit_windows` (UNLOGGED), `idempotency_keys`, `jobs`, `system_log`.
- [ ] `src/testing.ts`: `asTenant`, `hintOf`.
- [ ] Entegrasyon testleri:
  - Kiracı izolasyonu: A, B'yi göremez.
  - FORCE RLS sahibi de bağlar.
  - Son sahip silinemez.
  - Audit değiştirilemez.
  - Token biçimi CHECK'leri.
  - Kayıt transaction'ı.

### 1.3 API (`apps/api`)
- [ ] Önyükleme: `app.factory.ts`, `main.ts`, `serverless.ts`, `serverless/vercel.js`, `scripts/vercel-output.mjs`.
- [ ] Config: zod env, prod'da zorunlu değerler.
- [ ] `database/`: `APP_POOL`, `PLATFORM_POOL`, RLS preflight (prod'da fail-closed).
- [ ] `common/`:
  - `AppError` + `AllExceptionsFilter` → `{ error: { code, message, details? } }`.
  - logger ve redaction.
  - rate-limit (DB pencereleri), raw-body, request-context (request id), outbound (zaman aşımlı fetch).
- [ ] `tenancy/`:
  - `TenantScope.run(principal, fn)`.
  - `PrincipalService`, `PrincipalGuard`, `@CurrentPrincipal()`.
  - `AuditService`.
  - `database-error.ts` (HINT → ErrorCode); test, migration'lardaki her HINT'in eşlendiğini doğrular.
  - `@Idempotent()`.
- [ ] `identity/`:
  - `POST /auth/register`: ad, e-posta, şifre (≥10 karakter, zayıf liste kontrolü) → verify_email linki maillenir. Adres var olsa da yanıt aynıdır (hesap var mı sızdırılmaz).
  - `POST /auth/verify`: token → user, credentials, kişisel organization ve owner member tek transaction'da açılır. Oturum açılır.
  - `POST /auth/login`: e-posta ve şifre. Hata mesajı maskelenir. Rate limit: e-posta ve IP başına.
  - `POST /auth/logout`: oturumu revoke eder, cookie'yi temizler.
  - `POST /auth/password/forgot`: set_password linki (2 saat); yanıt her durumda aynı.
  - `POST /auth/password/reset`: token ve yeni şifre. Kişinin diğer oturumları revoke edilir.
  - `GET /auth/session`: kim, hangi organization; oturum yoksa 401.
  - `SessionGuard`: cookie `mu_session` (HttpOnly, Secure prod, SameSite=Lax). Idle 7 gün, absolute 30 gün; kayan `last_seen_at`.
- [ ] `account/`:
  - `GET /me`.
  - `PATCH /me`: ad, dil (`en` | `tr`), saat dilimi (IANA).
  - `POST /me/password`: mevcut şifre ve yeni şifre.
  - `GET /me/sessions`, `DELETE /me/sessions/:id`.
- [ ] `notifications/`: `MAILER` portu.
  - `SmtpMailer`.
  - `LoggingMailer`: geliştirmede linki loglar.
  - `UnconfiguredMailer`: prod'da yapılandırma yoksa açıkça hata verir.
  - Şablonlar en ve tr: doğrulama ve şifre linki.
- [ ] `queue/`: `jobs` claim / lease / retry / dead, `JobWorker`, handler kaydı.
- [ ] `cron/`:
  - `POST /cron/:cadence` (`CRON_SECRET` Bearer).
  - Geçişler: süresi dolan token'ları, rate pencerelerini ve idempotency kayıtlarını siler; kuyruğu işletir.
- [ ] `health/`: `/health/live`, `/health/ready` (DB erişimi).
- [ ] Testler:
  - Unit: password, cookie, env, redact, rate-limit, database-error map.
  - e2e: kayıt → doğrula → giriş → me → çıkış; şifre unuttum → sıfırla; maskeleme; rate limit; RLS (iki kullanıcı).

### 1.4 Web (`apps/web`)
- [ ] Next.js 16 App Router, Tailwind 4, `@milyonuse/ui` tokenları.
- [ ] `next.config.ts`: `/api/v1/*` → API rewrite, `allowedDevOrigins`, güvenlik başlıkları.
- [ ] `src/proxy.ts`:
  - Dil yönlendirmesi: `/` → `/tr` ya da `/en`, Accept-Language ve cookie'ye göre.
  - CSP (nonce'suz, strict default-src).
  - Korunan rotalar: `(app)` için oturum cookie'si yoksa `/login?next=`.
- [ ] `(marketing)/[locale]`:
  - Ana sayfa: Hero, "Nasıl çalışır", Agent / Takım / Otomasyon kartları, Güven (Verified Memory), Fiyat önizlemesi, SSS, Kapanış CTA.
  - `pricing`, `privacy`, `terms`, `cookies`.
  - Navbar ve Footer; çerez onayı (ConsentBanner).
  - SEO: `metadata`, hreflang, `sitemap.ts`, `robots.ts`.
- [ ] `(auth)`: `/register`, `/login`, `/verify` (token query), `/forgot`, `/reset` (token query), "e-postanı kontrol et" ekranı.
- [ ] `(app)`:
  - Kabuk: sol ray (Agent, Agents, Teams, Automations, Memory, Connections, Settings; henüz gelmeyenler "Yakında" rozetiyle).
  - Üst çubuk, kullanıcı menüsü.
  - `/app` karşılama, `/settings/profile`, `/settings/security` (şifre, oturumlar).
- [ ] i18n: `messages/en.ts`, `messages/tr.ts`. Test: her anahtarın iki dilde de olduğunu doğrular.
- [ ] Erişilebilirlik: form etiketleri, odak halkaları, kontrast (AA).

### 1.5 Altyapı
- [ ] `docker-compose.yml`: yerel Postgres 16+ ve pgvector.
- [ ] `.github/workflows/ci.yml`: Postgres servisi, roller, migrate, `pnpm verify`.
- [ ] `apps/api/vercel.json`, `apps/web/vercel.json` (fra1, fluid).
- [ ] `scripts/guard-tenancy.sh`: her `organization_id` tablosu için ENABLE, FORCE ve politikayı kontrol eder.
- [ ] `scripts/guard-secrets.sh`: sırların web paketine sızmasını yakalar; `NEXT_PUBLIC_` dışı env'lerin istemci koduna girmesini engeller.

---

## 2. Kabul kriterleri
1. Temiz bir makinede `docker compose up -d && pnpm i && pnpm db:setup && pnpm dev` ile landing, kayıt, doğrulama (link logda), giriş ve kabuk çalışır.
2. `pnpm verify` yeşil.
3. Kiracı izolasyon testi: kullanıcı A, kullanıcı B'nin hiçbir satırını göremez (app rolü). Sahip rolü de FORCE ile bağlıdır.
4. Şifre hiçbir tabloda düz metin değildir (CHECK). Token'ların yalnızca hash'i tutulur.
5. Giriş hatası e-postanın var olup olmadığını sızdırmaz. 5 başarısız denemeden sonra rate limit 429 döner.
6. Production'da `milyonuse_app` RLS'i atlayabiliyorsa API başlamaz.
7. Landing en ve tr dillerinde render edilir; Lighthouse SEO ≥ 95.

## 3. Kapsam dışı
Google ile giriş (port tanımlanır, F8'de açılır), ortak çalışma alanı ve davet (F9), 2FA (F9), ödeme (F8).

## 4. Teslim
`docs/delivered/F0-delivered.md`

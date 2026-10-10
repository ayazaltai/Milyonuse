# F0 — Temel · Teslim raporu

**Tarih:** 2026-10-10 · **Durum:** tamamlandı · **Şartname:** [F0-foundation.md](../phases/F0-foundation.md)

---

## 1. Eklenenler (özet)
- **Monorepo:** pnpm 11 + turbo, TypeScript 7. Paketler: `apps/api` (NestJS 12 / Fastify 5), `apps/web` (Next.js 16 / React 19 / Tailwind 4), `packages/{contracts,ui,config}`, `db`.
- **Veritabanı:** Sıfırdan yazılmış, temiz bir migration zinciri (0001–0005).
  - Üç rol ve her kiracı tablosunda FORCE RLS.
  - Kurallar SQL'de, HINT'li hatalarla korunuyor: son sahip, kişisel çalışma alanı, append-only audit, değiştirilemez oturum, kuyruk.
- **Kimlik:**
  - Kayıt: e-posta doğrulanana kadar hiçbir kayıt oluşmaz. Doğrulamada kullanıcı, kişisel organization, owner üyeliği ve oturum tek transaction'da açılır.
  - Giriş, çıkış, şifre unuttum/sıfırla, şifre değiştirme, oturum listesi ve kapatma.
  - E-postalar iki dilli (en/tr).
- **Web:**
  - Landing (en/tr): Hero, Nasıl çalışır, Yetenekler, Doğrulanmış hafıza, Fiyatlar, SSS, Kapanış, Footer.
  - Fiyat sayfası; Gizlilik, Koşullar ve Çerezler sayfaları (taslak ibareli).
  - Auth sayfaları; uygulama kabuğu (kenar menü, ana sayfa, profil ve güvenlik ayarları).
  - SEO: sitemap, robots, hreflang.
- **Altyapı:**
  - Kuyruk (`jobs`) ve worker; Vercel Cron geçişleri ve heartbeat'ler.
  - `system_log` ve hata özeti e-postası; tablo bakımı (purge).
  - Health/readiness probları; rate limit (DB üzerinden); idempotency.
  - Guard'lar (tenancy, secrets), CI workflow'u, docker-compose (pgvector), Vercel yapılandırması.

## 2. Dosyalar
| Alan | Yol | Kaynak |
|---|---|---|
| Kök | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.env.example`, `.nvmrc`, `docker-compose.yml`, `.github/workflows/ci.yml` | App-Milyonus'tan uyarlandı |
| Config | `packages/config/*` | App-Milyonus (HR'a özel ESLint kuralı çıkarıldı) |
| Contracts | `packages/contracts/src/{errors,primitives,constants,account,tenancy,health,index}.ts` + testler | Yeniden yazıldı (B2C) |
| UI | `packages/ui/src/tokens.css`, `tokens.ts` | App-Milyonus (HR bölümleri çıkarıldı; 4566 → ~3300 satır) + Landing Page'den Marketing bölümü (`mk-*`) + segmented navigasyon |
| DB | `db/roles.sql`, `db/database.sql`, `db/migrations/0001–0005`, `db/src/{client,migrate,testing,index}.ts`, `db/src/foundation.integration.test.ts` | Yeni |
| API bootstrap | `apps/api/src/{main,app.factory,app.module,serverless}.ts`, `serverless/vercel.js`, `scripts/{dev,vercel-output}.mjs` | App-Milyonus'tan uyarlandı |
| API common | `common/{app-error,filters,logging,rate-limit,raw-body,request-context.plugin,outbound,cursor,route-table}` | App-Milyonus'tan uyarlandı |
| Config | `config/{env,routing,config.module}.ts` | Yeniden yazıldı |
| Database | `database/{database.module,rls-preflight,database.testing}.ts` | Uyarlandı (region preflight yok) |
| Tenancy | `modules/tenancy/{tenant-scope.service,principal.service,audit.service,database-error,idempotency,guards/*}` | Uyarlandı (koltuk ve workspace yok; `app.member_id` desteği) |
| Identity | `modules/identity/{account.service,account-mail,account-tokens,auth.controller,me.controller,profile.service,session.service,session.guard,password,cookie,request-context}.ts` | Uyarlandı ve yeniden yazıldı |
| Diğer modüller | `modules/{queue,cron,notifications,observability,health}` | Uyarlandı |
| Testler | `src/auth.e2e.test.ts`, `src/testing/test-app.ts`, `route-inventory.test.ts` | Yeni / uyarlandı |
| Web | `apps/web/src/{proxy.ts,i18n/*,lib/*,components/{brand,marketing,shell,ui}/*,app/**}` | Yeni; primitives App-Milyonus'tan, tasarım Landing Page'den |
| Rota envanteri | `docs/api/routes.md` | Testten üretiliyor |

## 3. Veritabanı
| Migration | Tablolar | Kurallar ve HINT'ler |
|---|---|---|
| 0001_foundation | — | `ulid` domain'i, `app.generate_ulid()`, `app.current_organization_id()`, `app.current_member_id()`, `app.set_updated_at()`, iki rol için varsayılan yetkiler; pgcrypto, citext, pg_trgm, vector |
| 0002_identity | `users`, `organizations`, `members`, `user_credentials`, `account_tokens` | `time_zone_unknown`, `organization_identity_fixed`, `personal_organization_single_member`, `last_owner_protected`. Kısıtlar: tek kişisel organization (`organizations_one_personal`), scrypt biçimi, kısa ömürlü ve şifre içermeyen linkler. Kiracı-güvenli bileşik FK hedefleri. `users` tablosu RLS altında: bir kişiyi yalnızca aynı organization'daki üyeler görür. |
| 0003_sessions | `sessions` | `session_fixed` (kapanan oturum geri açılamaz); en fazla 90 gün; üye/organization/kişi tutarlılığı bileşik FK ile sağlanır |
| 0004_audit | `audit_log` | `audit_log_immutable`; actor `member` / `agent` / `system` |
| 0005_platform | `rate_limit_windows` (UNLOGGED), `idempotency_keys`, `jobs`, `system_log`, `worker_heartbeats` | `idempotency_record_fixed`, `job_finished`, `system_log_immutable` |

Guard sonucu: `guard:tenancy — 7 table(s) checked, clean`. Allowlist'te 6 tablo var, her birinin gerekçesi `scripts/tenancy-allowlist.txt` dosyasında yazılı.

## 4. API uç noktaları (`docs/api/routes.md`)
| Yöntem | Yol | Erişim |
|---|---|---|
| POST | `/api/v1/auth/register` | public · 10/saat adres · 3/saat e-posta · 500/saat toplam |
| POST | `/api/v1/auth/verify` | public · 20/10dk adres |
| POST | `/api/v1/auth/login` | public · 60/10dk adres · 5/10dk e-posta |
| POST | `/api/v1/auth/logout` | member |
| POST | `/api/v1/auth/password/forgot` | public · 10/saat adres · 3/saat e-posta |
| POST | `/api/v1/auth/password/reset` | public · 20/10dk adres |
| GET | `/api/v1/auth/session` | member |
| GET, PATCH | `/api/v1/me` | member (PATCH: Idempotency-Key) |
| POST | `/api/v1/me/password` | member · 5/10dk üye |
| GET | `/api/v1/me/sessions` | member |
| DELETE | `/api/v1/me/sessions/:sessionId` | member |
| GET | `/api/v1/cron/:cadence` | `CRON_SECRET` bearer (yalnızca `WORKER_MODE=cron`) |
| GET | `/health/live`, `/health/ready` | public |

## 5. Web sayfaları
| Yol | Açıklama |
|---|---|
| `/` | Dile göre `/en` ya da `/tr`'ye yönlendirir (cookie → Accept-Language → en) |
| `/en`, `/tr` | Landing |
| `/{locale}/pricing`, `/privacy`, `/terms`, `/cookies` | Fiyat ve yasal sayfalar |
| `/login`, `/register`, `/verify?token=`, `/forgot`, `/reset?token=` | Kimlik. Doğrulama token'ı GET ile değil, sayfanın gönderdiği POST ile harcanır; böylece e-posta tarayıcıları hesap açamaz. |
| `/app` | Kabuk ve ana sayfa (yol haritası) |
| `/app/settings/profile`, `/app/settings/security` | Ad, dil, saat dilimi; şifre değiştirme; oturumlar |

## 6. Testler — toplam **205**, hepsi yeşil
| Paket | Dosya | Test | Kapsam |
|---|---|---|---|
| api | 17 | 158 | e2e kimlik akışı (20); env ve `.env.example` uyumu; rota envanteri; HINT haritası; rate limit (unit ve integration); idempotency; logger ve redaction; cron; health; observability; tenant scope; password |
| db | 2 | 23 | RLS izolasyonu (sahip rolü dahil), kimlik kuralları, oturumlar, audit, kuyruk, hesap silme zinciri |
| contracts | 3 | 17 | Şemalar, `can()` |
| web | 2 | 7 | en/tr sözlük eşitliği, dil çözümü, `safeNext` |

**Tarayıcı doğrulaması (Playwright, production build ile):**
- Akış: kayıt → geliştirme linki → `/app` → profilde dili TR yap → Türkçe arayüz → çıkış → yanlış şifre (TR hata mesajı) → doğru şifreyle giriş.
- Ekran görüntüleri: landing (EN, TR, mobil), kayıt, uygulama ana sayfası, güvenlik ayarları.

Çalıştırmak için:
```bash
pnpm db:setup && pnpm verify
```

## 7. Şartnameden sapmalar
- **Cron rotası `GET`:** Vercel Cron GET isteği gönderir. ARCHITECTURE ve env açıklaması buna göre güncellendi.
- **Logo:** Milyonus'un tescilli wordmark'ı şirketin adını yazıyor. Bu yüzden ürün kilidi "Milyonus işareti + *Milyonuse* yazısı" olarak tipografiyle kuruldu (`components/brand/lockup.tsx`).
- **Landing animasyonları:** Framer Motion yerine CSS animasyonları kullanıldı (daha hafif; `prefers-reduced-motion` destekli). Video ve Tavus demosu alınmadı (SOURCES §C).
- **Çerez onay banner'ı yok:** Yalnızca zorunlu çerezler var (`mu_session`, `mu_locale`). Analitik eklendiğinde banner gelecek (Çerez Politikası bunu söylüyor).
- **Fiyatlar:** Planlar ve özellikler gösteriliyor, fiyatlar "Lansmanda açıklanacak" (D-16 taslak).

## 8. Bilinen sınırlar / teknik borç
- **Marketing sayfaları dinamik render ediliyor:** kök layout `headers()` okuyor. Statik/ISR'a geçiş F10 performans çalışmasında yapılacak.
- **Yasal metinler taslak:** sayfalarda görünür "hukuki inceleme bekliyor" notu var. Lansmandan önce avukat onayı gerekiyor.
- **Google ile giriş yok:** F8'e bırakıldı (D-14). 2FA F9'da.
- **E-posta adresi değiştirilemiyor:** doğrulama akışı F9'da gelecek.
- **Yerel ortamda Postgres 16 kullanıldı:** CI ve compose pgvector/pg17 kullanıyor; App-Milyonus pg18 kullanıyordu. Neon sürümü kurulumda seçilecek.
- **Vercel'e gerçek deploy yapılmadı:** Vercel projeleri, Neon veritabanı ve env değişkenleri Ayaz tarafından bağlanmalı.

## 9. F1'e devredilenler
- `TenantScope.run({ organizationId, memberId })` hazır: agent konuşmaları üye bazında kapsanabilir.
- `enqueue()` ve `JobRegistry`: agent dilimleri ve öneri koşucusu için.
- `tokens.css` içindeki agent konsolu sınıfları (`agent-*`) korundu; F1 konsolu bunları kullanacak.
- `ErrorCode`'a `AGENT_*` kodları F1'de eklenecek.
- `/app/agent` kenar menüde "Yakında" olarak duruyor.

## 10. Doğrulama
```
guard:tenancy — 7 table(s) checked, clean
guard:secrets — clean
typecheck  9/9 · lint 9/9 · test 7/7 (205 test) · build 5/5
```

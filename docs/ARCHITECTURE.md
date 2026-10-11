# Architecture

> Tüm fazların ulaşacağı hedef mimari. Her faz bu belgenin bir dilimini inşa eder. Bir faz mimariyi değiştirirse önce bu belge güncellenir.

---

## 1. Repo düzeni

```
milyonuse/
├─ apps/
│  ├─ api/                     NestJS 12 + Fastify 5 — /api/v1/*
│  │  ├─ src/config/           env (zod), routing
│  │  ├─ src/database/         APP_POOL (RLS) · PLATFORM_POOL (BYPASSRLS) · preflight'lar
│  │  ├─ src/common/           AppError, filtre, logger + redact, rate-limit, raw-body, outbound
│  │  └─ src/modules/
│  │     ├─ identity/          kayıt, doğrulama, giriş, oturum, şifre        (F0)
│  │     ├─ tenancy/           principal, TenantScope, audit, db-error map  (F0)
│  │     ├─ account/           profil, tercihler (dil, saat dilimi)         (F0)
│  │     ├─ queue/             jobs: claim / lease / retry                  (F0)
│  │     ├─ cron/              Vercel Cron geçişleri                        (F0)
│  │     ├─ notifications/     mail port (SMTP / API / log)                 (F0)
│  │     ├─ health/            /health/live, /health/ready                  (F0)
│  │     ├─ agent/             konsol, turn loop, araçlar, öneriler          (F1, F3)
│  │     ├─ memory/            Verified Memory servisleri + inspector API   (F2)
│  │     ├─ connections/       MCP client, OAuth bağlantıları               (F3)
│  │     ├─ sandbox/           SandboxPort + Vercel Sandbox                 (F3)
│  │     ├─ studio/            agent tanımları, şablonlar                   (F4)
│  │     ├─ skills/            skill kütüphanesi, staging, replay           (F4)
│  │     ├─ teams/             takım, rol, görev grafı, run ağacı           (F5)
│  │     ├─ automations/       tetikler, zamanlama, izleme, Onay Kutusu      (F6)
│  │     ├─ channels/          webhook'lar, eşleştirme, kanal oturumları    (F7)
│  │     ├─ billing/           planlar, abonelik, Stripe, iyzico            (F8)
│  │     ├─ usage/             ölçüm, kotalar                               (F1 → F8)
│  │     ├─ mcp/               MCP sunucusu + OAuth 2.1                     (F9)
│  │     └─ compliance/        dışa aktarma, silme, saklama                 (F9)
│  └─ web/                     Next.js 16 (App Router), React 19, Tailwind 4
│     └─ src/app/
│        ├─ (marketing)/[locale]/   landing, fiyatlar, SSS, yasal         (F0)
│        ├─ (auth)/                 register, login, verify, forgot, reset (F0)
│        └─ (app)/                  uygulama kabuğu — agent, agents, teams,
│                                   automations, memory, connections, settings
├─ packages/
│  ├─ config/        eslint + tsconfig tabanları
│  ├─ contracts/     zod şemaları, hata sözleşmesi, AgentStreamEvent, izinler
│  ├─ ui/            tokens.css (tek renk kaynağı) + tokens.ts
│  ├─ security/      injection (EN/TR), RiskEngine, redact, SSRF, preexec, operator (Ed25519)   (F2/F3)
│  ├─ memory/        Verified Memory çekirdeği (saf mantık + store arayüzü)                     (F2)
│  ├─ skills/        SKILL.md motoru, scanner, manifest                                         (F4)
│  └─ channels/      adapter'lar (WhatsApp, Telegram, Slack, E-posta, Discord)                  (F7)
├─ db/               numaralı SQL migration'lar, roller, migrate runner, entegrasyon testleri
├─ evals/            poisonbench/ taskbench/ teambench/                                         (F2, F10)
├─ scripts/          guard-tenancy.sh, guard-secrets.sh, guard-naming.sh
└─ docs/             plan, kararlar, kaynaklar, faz şartnameleri, teslim raporları
```

---

## 2. Çalışma topolojisi

```
                ┌───────────── Vercel (fra1) ─────────────┐
 Tarayıcı ──►   │  web (Next.js)                          │
                │   /api/v1/* ──rewrite──► api function   │──► Neon Postgres (eu-central-1)
 Kanallar ──►   │  api (NestJS/Fastify, tek fonksiyon)    │       RLS · pgvector · jobs
 (webhook)      │   /api/v1/cron/{minute,quarter,hour}    │
                │      ▲ Vercel Cron                      │──► OpenRouter (modeller, embedding)
                │   waitUntil(kick) ── jobs ── worker     │──► Vercel Sandbox (kod/dosya/tarayıcı)
                └─────────────────────────────────────────┘──► Mail (SMTP/API) · Stripe · iyzico
```

- **Tek kaynak (origin):** Web, `/api/v1/*` isteklerini API'ye yönlendirir; cookie'ler `SameSite=Lax` kalır.
- **Worker modu:** Production'da `WORKER_MODE=cron`; geliştirmede `WORKER_MODE=timer` (süreç içi zamanlayıcı).
- **Uzun işler:** Run'lar `jobs` kuyruğunda dilimlere bölünür. Her dilim en fazla `RUN_SLICE_SECONDS` sürer ve kaldığı yeri DB'ye yazar; tamamlanmadıysa bir sonraki dilim kuyruğa girer.

---

## 3. Veritabanı modeli

### 3.1 Roller ve izolasyon
| Rol | Ne için | RLS |
|---|---|---|
| `milyonuse` | Şemanın sahibi, migration'ları çalıştırır | FORCE RLS'e tabi |
| `milyonuse_app` | API trafiği; her sorgu bir kiracı kapsamında | Tabi |
| `milyonuse_platform` | Kiracı belirlenmeden önceki işler (kayıt, oturum çözümleme, rate limit, cron taraması) | `BYPASSRLS` |

- Kiracı fonksiyonu `app.current_organization_id()`, değeri `SET LOCAL app.organization_id` ile alır.
- Politika her zaman `(SELECT app.current_organization_id())` biçiminde yazılır, böylece Postgres değeri bir kez hesaplar.
- API production'da kendi rolünün RLS'i atlayabildiğini görürse başlamayı reddeder.

### 3.2 Tablolar (faz faz)

**F0 — Temel**
| Tablo | Kapsam | Not |
|---|---|---|
| `users` | global | email (citext), name, locale, time_zone |
| `user_credentials` | yalnızca platform | scrypt digest, CHECK ile biçim kontrolü |
| `account_tokens` | yalnızca platform | verify_email / set_password; sadece SHA-256 hash; kısa ömürlü (CHECK) |
| `organizations` | kiracı kökü | `kind`: personal / shared; status |
| `members` | kiracı | role: owner / admin / member; son sahip korunur (tetikleyici) |
| `sessions` | kiracı | token_hash, idle ve absolute süre sonu, revoke |
| `audit_log` | kiracı | yalnızca ekleme; UPDATE/DELETE tetikleyiciyle reddedilir |
| `idempotency_keys` | kiracı | 24 saat; yanıtlanınca sabitlenir |
| `rate_limit_windows` | platform, UNLOGGED | SHA-256 anahtar |
| `jobs` | global + organization_id | claim / lease / retry / dead |
| `system_log` | global | worker heartbeat, uyarılar |

**F1 — Agent çekirdeği** (App-Milyonus 0051, 0055, 0059, 0065 kaynaklı, sadeleştirilmiş)
`agent_conversations` (RLS: organization ve member), `agent_messages` (yalnızca ekleme; kaynaklar `src-xxxxxx` araç mesajının içinde tutulur), `agent_attachments`, `agent_feedback`, `usage_daily` — `0006_agent_core`

**F2 — Doğrulanmış hafıza**
| Tablo | Not |
|---|---|
| `memory_items` | content, tier T0–T4, state (pending / active / demoted / rejected / revoked / expired), scope (user / agent / team), provenance (source_kind, source_uri, run_id, actor), evidence_hash, trust_ceiling, sensitivity, embedding `vector(1536)` |
| `memory_confirmations` | bağımsız kanıt (distinct evidence + kaynak), T3 terfisi için |
| `memory_derivations` | `derived_from` kenarları (revoke zinciri) |
| `memory_negative` | reddedilen içerik + embedding (rephrase tespiti) |
| `memory_ledger` | sha256 zincirli, yalnızca ekleme (kiracı başına zincir) |
| `memory_t0_staged` | iki aşamalı imza ve review penceresi |
| `run_taint` | run → okunan dış kaynaklar |

**F3 — Araçlar ve eylemler**
`agent_actions` (öneri durum makinesi, tetikleyicilerle), `agent_action_items`, `connections` (MCP / OAuth; sırlar şifreli), `sandbox_sessions`

**F4 — Stüdyo ve skills**
`agents` (persona, talimatlar, model kademesi, tool izin listesi, hafıza kapsamı, autonomy), `agent_versions` (değişmez anlık görüntü), `skills`, `skill_versions` (staging → active), `skill_runs` (replay kanıtı)

**F5 — Takımlar**
`teams`, `team_members` (agent, rol: lead / member / reviewer), `runs` (kök run + çocuk run ağacı), `run_steps`, `run_tasks` (görev grafı: bağımlılık, durum, atanan agent), `team_memory` (`memory_items.scope='team'` görünümü)

**F6 — Otomasyonlar**
`automations` (tür: schedule / monitor / goal / suggest / webhook / email / channel / file / agent_event / manual; `enabled`; hedef agent ya da takım; autonomy politikası), `automation_triggers` (olay kaydı, tekrarlananı engellemek için tekillik anahtarı), `automation_runs`, `inbox_items` (Onay Kutusu), `monitors_state` (son görülen hash)

**F7 — Kanallar**
`channel_accounts` (kullanıcının bağlı Telegram / WhatsApp / Slack / e-posta kimlikleri), `channel_pairings` (8 karakterlik kod, TTL, deneme sınırı), `channel_threads` (kanal konuşması → `agent_conversation`)

**F8 — Abonelik**
`plans`, `subscriptions`, `billing_customers`, `billing_events` (webhook kaydı, tekillik), `credit_ledger` (yalnızca ekleme)

**F9 — Platform**
`mcp_clients`, `mcp_grants`, `mcp_tokens`, `exports`, `erasure_requests`, `memory_tombstones`

---

## 4. Bir turun akışı (F1–F3)

```
POST /api/v1/agent/conversations/:id/messages/stream   (SSE)
 1. SessionGuard → PrincipalGuard (organization, member)
 2. Rate limit, idempotency, günlük ve tur bütçesi kontrolleri
 3. Kullanıcı mesajı kaydedilir (yalnızca ekleme), ek dosya id'leri bağlanır
 4. Context Engine:
      stable prefix (cache) ─ agent talimatları ─ kişi bağlamı (dil, saat dilimi)
      ─ T0 operatör politikası
      ─ <milyonuse:memory> veri çiti: trust-weighted recall (cosine × current_trust)
      ─ skill dizini (seviye 0)
      ─ konuşma özeti + bütçeli pencere
 5. Döngü (≤ AGENT_MAX_ROUNDS):
      model.complete (stream) ──► SSE: text / step / proposal
      her tool çağrısı:
        zod doğrulaması → RiskEngine.classify → auto | proposal | block
        dış veri okunduysa run_taint += kaynak; çıktı veri çitine sarılır
        çıktı "fit" edilir (≈12k karakter), tamamı agent_sources'a yazılır
 6. Tur sonu: kullanım ve maliyet yazılır;
    memory_propose kuyrukta → MemoryPipeline (asenkron)
 7. SSE: done
```

## 5. Hafıza boru hattı (F2)

```
propose(content, hint) ──► server: source_kind/tier = f(run_taint, kanal, aktör)  [D-12]
   │
   ▼  insert_candidate (tek ekleme yolu) — state = pending, ledger: ingest
Quarantine
   │
   ▼  verify (job)
   ├─ negative check: Jaccard ≥ 0.86 VEYA cosine ≥ 0.92 → reject
   ├─ RuleVerifier: injection scan (EN/TR) + kaynak yetkinliği
   └─ ModelVerifier (Fast kademe, kesin JSON) — hata olursa kural kararına düşer
   ▼
Promote
   ├─ T1/T2: onayla → active
   ├─ T3: ≥2 BAĞIMSIZ onay (farklı evidence + kaynak) → active (expires_at)
   ├─ T4 / subagent: asla otomatik değil (kullanıcı onayı)
   └─ T0: yalnızca operatör imzası + review penceresi
Consolidation (saatlik; cron'da `memory` adımı)
   └─ decay → floor altı: demoted (yeniden terfi yalnızca yeni kanıtla)
      · expire · dedupe · çelişki bayrağı · ledger doğrulama
Revoke(source_uri) → özyinelemeli derivations (teyit eden kaynaklar dahil) → revoked + ledger
T0: stage (imza 1) → ≥300 sn → activate (imza 2); saat sunucunun (0008)
```

## 6. Takım run'ı (F5)

```
Run (kök, team) ── lead agent planlar ──► run_tasks DAG
   ├─ task A → member agent X (çocuk run)   ┐ paralel (≤ TEAM_MAX_PARALLEL)
   ├─ task B → member agent Y (çocuk run)   ┘
   └─ task C (A, B'ye bağlı) → reviewer agent
Her çocuk run:
   kendi bütçesi; kendi taint'i; çocuk hafıza önerileri en fazla T3;
   subagent çıktısı = T4 (D-09)
Lead sonuçları birleştirir → kullanıcıya teslim + öneriler → Onay Kutusu
```

## 7. Otomasyon motoru (F6)

```
Kaynaklar ─┬─ cron (dakikalık): due schedules, monitor tick, goal tick
           ├─ webhook   POST /api/v1/hooks/:automationId/:secret (HMAC)
           ├─ e-posta   gelen adres (inbound) → olay
           ├─ kanal     F7 adapter → olay
           ├─ agent_event  bir run bitti, bir hafıza terfi etti, …
           └─ manual    "Şimdi çalıştır"
             ▼
 automation_triggers (tekillik anahtarı) ──► policy (enabled? kota? sessiz saatler?)
             ▼
 run (agent | team) — gözetimsiz autonomy politikası (D-11)
             ▼
 sonuç → bildirim (in-app, e-posta, kanal) · öneriler → Onay Kutusu
```

## 8. Güvenlik sınırları (özet)

| Sınır | Mekanizma |
|---|---|
| Kiracı | FORCE RLS + rol ayrımı + RLS preflight + guard-tenancy |
| Kimlik | scrypt, hash'lenmiş oturum token'ı, kısa ömürlü linkler, rate limit, sign-in failure maskeleme |
| Model girdisi | Veri çiti; "veri talimat değildir" kuralı; injection tarayıcı |
| Hafıza | Tier, taint, verify, decay, revoke, ledger, T0 imzası |
| Eylem | RiskEngine + öneri durum makinesi (SQL) + yeniden yetki kontrolü + undo |
| Ağ | SSRF koruması (özel IP'ler, metadata uç noktaları), outbound izin listesi |
| Sandbox | microVM, sır yok, ağ varsayılan kapalı, süre ve CPU sınırı |
| MCP client | Filtreli env, redacted çıktı, varsayılan risk caution |
| Sırlar | AES-256-GCM (`SECRETS_KEY`), log redaction, `.env.example` kontrolü |
| Web | CSP, HSTS, `X-Frame-Options: DENY`, güvenli markdown (HTML yok, yalnızca iç linkler) |

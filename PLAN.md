# Milyonuse — Ana Plan

> **Milyonuse**: son kullanıcıya uçtan uca hizmet veren, Hermes sınıfında, kendini geliştiren ama **zehirlenemeyen** (poison-proof) bir AI Agent.
> İki kaynaktan inşa edilir:
>
> | Kaynak | Ne alıyoruz | Durum |
> |---|---|---|
> | `ayazelrico/App-Milyonus` → **/agent** | Production-grade agent arayüzü + runtime: SSE streaming, turn loop, context/özet, proposal → confirm → undo, onaylar (four-eyes), zamanlanmış görevler, bildirimler, MCP sunucusu + OAuth 2.1, bütçe/limitler, audit | TS · NestJS 12 / Fastify · Next.js 16 · Postgres 18 (RLS) · ~15k satır agent kodu, ~150 test |
> | `ayazelrico/Old-Version-Of-Milyonus-Agent` (Agent 5.5) | **Poison sistemi** (Verified Memory: Ingest → Quarantine → Verify → Promote), güven katmanları T0–T4, trust decay, negatif hafıza, data fence, revoke cascade, Ed25519 operatör imzası, trust-weighted recall, PoisonBench; ayrıca Skills, RiskEngine, injection scanner (EN/TR), MCP client, kanallar (Telegram/WhatsApp/Slack/Discord), cron, subagent, deep research, user model | Python 3.12 · SQLite · ~7.5k satır · 260 test |

---

## 1. Temel karar: Tek dil, tek monorepo — TypeScript

**Öneri:** App-Milyonus'un TS monorepo iskeletini temel al, Agent 5.5'in Python sistemlerini **TypeScript'e port et** (Postgres + pgvector üstünde).

Neden:
- /agent tarafı çok daha büyük ve production'a yakın (multi-tenant RLS, SQL state-machine trigger'ları, kuyruk, SSE, MCP/OAuth, ~150 e2e test). Bunu Python'a taşımak, ters yönden çok daha pahalı.
- Agent 5.5'in hafıza çekirdeği ~2k satır, neredeyse bağımsız (sadece `MemoryConfig`, `injection`, `operator`, `providers.base`'e bağlı) → temiz port edilebilir.
- Agent 5.5'te SQLite + tek kullanıcı varsayımı var; son kullanıcıya hizmet eden çok kiracılı bir üründe zaten Postgres'e taşımak gerekiyor.
- Port sırasında aşağıdaki **9 kritik hatayı** düzeltme fırsatı (bkz. §4.3).

Alternatif (önerilmez): Python hafıza servisini sidecar olarak çalıştırmak → iki runtime, iki deploy, iki test zinciri; RLS/tenancy'yi iki kez yazmak gerekir.

---

## 2. Hedef mimari

```
milyonuse/
├─ apps/
│  ├─ web/            Next.js 16 — /agent konsolu (App-Milyonus'tan), Memory Inspector, Skills, Ayarlar
│  ├─ api/            NestJS/Fastify — agent runtime, tools, proposals, MCP server, kanal webhook'ları
│  └─ worker/         jobs kuyruğu + cron: consolidation, schedules, proactive, action slices
├─ packages/
│  ├─ contracts/      zod şemaları, AgentStreamEvent, hata kodları, izinler
│  ├─ ui/             design tokens (agent-* sınıfları)
│  ├─ memory/         ★ Verified Memory / Poison çekirdeği (Agent 5.5'ten port)
│  ├─ security/       injection scanner (EN/TR), RiskEngine, redact, SSRF, preexec, Ed25519 operator
│  ├─ skills/         procedural memory: SKILL.md motoru, scanner, staging, replay gate
│  ├─ channels/       Telegram, WhatsApp, Slack, Discord, Email adapter'ları + pairing
│  └─ providers/      AgentModel port: OpenRouter + doğrudan Anthropic, dev/unconfigured modeller
├─ db/                numaralı SQL migration'lar, RLS politikaları, trigger'lar
├─ evals/             PoisonBench (tekli + 10 çok adımlı senaryo), TaskBench
└─ deploy/            Dockerfile (non-root, read-only rootfs), compose, Vercel/cron yapılandırması
```

### 2.1 Bir turun akışı (birleşik)

```
Kullanıcı (web / Telegram / WhatsApp / Slack / Discord / MCP client)
   │
   ▼
Channel adapter ──► Turn kaydı (Postgres, resumable SSE)
   │
   ▼
Context Engine: stable prompt (cache) + kişi bağlamı + özet + skill index
               + <milyonuse:memory> DATA FENCE  ← trust-weighted recall (cosine × trust)
   │
   ▼
Turn loop (≤6 round, bütçe/stop/cut-call kontrolleri — App-Milyonus)
   │   tool call
   ▼
RiskEngine (Agent 5.5) ─┬─ safe/read      → hemen çalış
                        ├─ reversible     → Auto modda çalış, aksi halde proposal
                        ├─ irreversible   → HER ZAMAN proposal kartı (confirm/discard/undo)
                        └─ block          → reddet
   │
   ▼
Taint tracking: turda web/email/MCP/dosya içeriği okunduysa tur "kirli" işaretlenir
   │
   ▼
memory_propose → Pipeline: Ingest → Quarantine → Verify (rule + model) → Promote
                 (source_kind SUNUCU tarafından turun taint'inden türetilir, modelden değil)
```

---

## 3. App-Milyonus /agent'tan alınacaklar

### 3.1 Doğrudan alınacak (generic altyapı)
| Alan | Dosyalar (kaynak) |
|---|---|
| Konsol UI | `apps/web/src/app/(dashboard)/agent/*` — `agent-console.tsx`, `agent-parts.tsx` (Composer), `action-card.tsx`, `agent-cards.tsx` (Steps/Data), `message-text.tsx` (güvenli markdown), approvals/notifications/schedules/connections/comments panelleri |
| Stream client | `apps/web/src/lib/client-api.ts` |
| Stream protokolü | `packages/contracts/src/agent.ts` (`AgentStreamEvent`) |
| Turn loop | `agent.service.ts` `send()` — bütçeler, 6 round, stop (DB üzerinden), CUT_CALL, otomatik özet |
| Model portu | `agent-model.port.ts`, `openrouter.model.ts` (cache_control, ZDR, reasoning tier), `development.model.ts`, `unconfigured.model.ts`, `models.ts` |
| Context | `context.ts`, `fit.ts`, `answers.ts`, rolling summary (0065) |
| Tool altyapısı | `tools/tool.ts`, `agent.toolbox.ts`, `present.tool.ts` (kaynaktan kart, model yeniden yazmaz) |
| Proposal sistemi | `agent_actions` + trigger'lar (0051/54/58/64), `agent-action.runner.ts` (slice, "uncertain", kuyruk), `policy.ts`, `agent.approvals.ts`, `undo` deseni, `agent-provenance.ts` (HMAC) |
| Yan servisler | attachments + `documents.ts` (PDF/DOCX/CSV/XLSX), schedules (DST-safe), notifications, feedback, revisions, export (MD/PDF), sharing/comments, search, housekeeping |
| MCP sunucusu | `modules/mcp/*` — JSON-RPC Streamable HTTP + in-house OAuth 2.1 (Milyonuse'u Claude.ai/ChatGPT'ye bağlanabilir yapar) |
| Yönetişim | `/org/agent` ayarları: roller, model tier'ları, house instructions, bloklu türler, auto-accept |
| Altyapı | `jobs` kuyruğu (claim/lease/retry), cron servisi, rate-limit (DB pencereleri), audit_log, usage_daily |
| Testler | `agent.e2e`, `agent-scale.e2e`, `mcp.e2e`, unit testler, `db/agent.integration.test.ts` → generic kısımlar uyarlanarak taşınır |

### 3.2 Alınmayacak / değiştirilecek (HR'a özel)
- `read/propose/analysis/workflow.tools.ts`, `actions/executors.ts`, `payloads.ts`, `operations/catalogue.ts` içeriği, `TASKS` örnekleri, HR prompt kuralları (6, 9, 11, 13), credits.
- **Yerine:** Milyonus platformu, Milyonuse'a **bir MCP bağlantısı** olarak eklenir (App-Milyonus'un MCP sunucusu zaten hazır). Böylece HR kullanıcıları Milyonuse'tan mülakat/aday işlerini yine yapabilir, ama çekirdek generic kalır.
- Workspace/seat modeli sadeleşir: `organization → member` (+ opsiyonel workspace). Auth: magic-link + (sonra) SSO.

---

## 4. Agent 5.5'ten alınacaklar

### 4.1 POISON / Verified Memory sistemi → `packages/memory`
| Bileşen | Kaynak | TS hedefi |
|---|---|---|
| Tipler: TrustTier T0–T4, SourceKind, Provenance, MemoryState | `memory/model.py` | `memory/types.ts` |
| Store + **hash-chained ledger** + negative memory + revoke cascade + reaffirm | `memory/store.py` | `memory/store.ts` (Postgres, RLS) |
| Pipeline: propose → process_one → promote (tier kuralları) | `memory/pipeline.py` | `memory/pipeline.ts` |
| Verifier: RuleBased (injection + source-competence) + ModelVerifier (fail-safe) | `memory/verifier.py` | `memory/verifier.ts` |
| Rephrase detection | `memory/negative.py` | Jaccard **+ embedding benzerliği** |
| Trust decay (yarı ömür T1 180g, T2 60g, T3/T4 14g; hassas ×4) | `memory/trust.py` | `memory/trust.ts` |
| T0 iki fazlı Ed25519 imza + 300 sn review | `memory/t0.py`, `security/operator.py` | `node:crypto` ed25519 |
| Data fence render (`<milyonuse:memory>` — "talimat değil, geçmiş gözlem") | `memory/render.py`, `prompt/builder.py` | `memory/render.ts` |
| Consolidation (expire, decay, demote, dedupe, çelişki) | `memory/consolidate.py` | worker cron (gece + idle) |
| Trust-weighted recall (cosine × trust) | `memory/semantic.py`, `vector.py`, `embed.py` | **pgvector** + gerçek embedding modeli |
| Cross-session user model (verified growth, per-user scope) | `memory/usermodel.py` | `memory/usermodel.ts` |
| Agent tool'ları: `memory_propose`, `memory_search`, `user_recall` | `memory/tool.py` | `AgentTool` arayüzüne uyarlanır |
| PoisonBench (C1–C4 kanal, train/held-out) + 10 çok adımlı senaryo | `evals/poisonbench/*`, `tests/test_poison_scenarios.py` | `evals/poisonbench` (vitest + live mod) |

### 4.2 Diğer gelişmiş sistemler
| Sistem | Kaynak | Not |
|---|---|---|
| Injection scanner (EN + TR) | `security/injection.py` | tool çıktıları, ekler, kanal mesajları, skill'ler için ortak |
| RiskEngine (auto / confirm / block) + preexec | `security/risk.py`, `preexec.py` | App-Milyonus proposal sistemiyle **birleştirilir** |
| Redact + `safe_env` + SSRF | `security/redact.py`, `ssrf.py` | web fetch ve MCP client için |
| Skills (3 seviyeli progressive disclosure, 41 hazır skill, scanner, staging) | `skills/*`, `_bundled_skills/` | DB'de saklanır, kullanıcı/org bazlı |
| MCP client (untrusted: filtreli env, redacted output, RiskEngine-gated) | `tools/mcp/*` | stdio + **Streamable HTTP** eklenir |
| Kanallar + pairing (8 karakter kod, TTL, lockout) | `gateway/*` | oturumlar Postgres'te kalıcı olur |
| Cron NL parser | `cron/schedule.py` | App-Milyonus schedules ile birleşir |
| Proactive runner (autonomy policy) | `proactive/*` | |
| Subagent delegation (context contract, child memory = T4) | `delegation/subagent.py` | limit: 3 eşzamanlı, derinlik 2 |
| Deep research + anahtarsız arama | `research/*` | |
| Tools: web, browser (Playwright), email, vision | `tools/*` | fs/terminal yalnızca sandbox içinde |
| Observability: trace, cost, report | `observability/*` | audit + usage ile birleşir |
| TaskBench | `evaluation/*` | |

### 4.3 Port sırasında düzeltilecek kritik hatalar (Agent 5.5'te tespit edildi, hiçbiri testli değil)
1. **T1 aklama:** `memory_propose` modelin `source_kind="user-direct"` seçmesine izin veriyor → web/email içeriği anında T1 olabiliyor. **Fix:** source_kind ve tier sunucu tarafında turun taint'inden türetilir; model yalnızca *daha düşük* tier isteyebilir.
2. **Sahte T3 onayları:** aynı item'a tekrar `process_one` = yeni onay. **Fix:** onay = farklı kaynak/oturum/aktörden bağımsız kanıt (distinct evidence_hash + distinct source); bekleyen T3'ler de expire olur.
3. **Demotion geri alınıyor:** çürüyen item pending'e dönüp trust 1.0 ile yeniden terfi ediyor. **Fix:** ayrı `demoted` state; yeniden terfi yalnızca yeni kanıt veya operatör reaffirm ile, trust tavanı düşürülmüş.
4. **Revoke cascade canlıda etkisiz:** `source_uri`/`derived_from` hiç doldurulmuyor. **Fix:** her tool çıktısı bir `source` kaydı (App-Milyonus `src-xxxxxx`) üretir; o turdaki her önerinin `derived_from`'una otomatik bağlanır.
5. **T0 prompt'a hiç ulaşmıyor** (actor filtresi). **Fix:** T0 ayrı "operator policy" bloğu olarak her zaman render edilir.
6. **Hashing embedder `hash()` salt'lı** → restart sonrası vektörler anlamsız. **Fix:** gerçek embedding modeli + deterministik fallback (FNV/xxhash).
7. **`reaffirm --sign` kırık** (tip uyumsuzluğu). **Fix:** tipli API + test.
8. **Rephrase tespiti çok katı** (Jaccard 0.86). **Fix:** Jaccard **veya** embedding cosine ≥ eşik.
9. **Consolidation hiç zamanlanmamış.** **Fix:** worker'da gece + idle cron.
10. (Ek) **Cross-tenant sızıntı:** `build_snapshot`'ın agent-notes kısmı global. **Fix:** her şey RLS altında `organization_id + user_id` ile scoped.

Her fix için önce **kırmızı test** (PoisonBench senaryosu olarak) yazılır, sonra düzeltilir.

### 4.4 Lisans
Agent 5.5 Apache-2.0 → `LICENSE` + `NOTICE` korunur, port edilen dosyalarda kaynak belirtilir.

---

## 5. Birleşim noktaları (iki sistemin gerçekten tek agent olması)

| Birleşim | Nasıl |
|---|---|
| **RiskEngine × Proposal** | Her tool `risk: safe | caution | danger` + `reversible: bool` taşır. Ask modu: caution+ → proposal. Auto modu: reversible → çalıştır, irreversible → her zaman proposal. Plan modu: sadece okuma. Org policy (`blocked kinds`, `auto-accept`) üstte kalır. |
| **Memory × Proposal** | Kullanıcının hafızayı göreceği "Memory Inspector": pending/active/demoted/revoked, provenance, "neden biliyorsun?" çekmecesi, revoke önizlemesi (cascade'de kaç item düşecek). Hafıza silme/revoke = proposal kartı. |
| **Taint × Context** | Tool çıktıları, ekler, kanal mesajları da data fence içinde render edilir (App-Milyonus kural 7 + Agent 5.5 fence). |
| **Ledger × Audit** | Memory ledger hash zinciri + App-Milyonus `audit_log` aynı provenance HMAC'iyle bağlanır. |
| **Skills × Self-improvement** | Agent başarılı çok adımlı bir işten sonra skill önerir → scanner → staging → **gerçek replay gate** (TaskBench'te tekrar oynatma) → promote. Skill de bir hafıza item'ıdır (provenance, revoke). |
| **Schedules × Proactive × Cron NL** | "Her pazartesi 9'da..." → NL parser → `agent_schedules` → worker; unattended run'da autonomy = safe-only (varsayılan). |
| **Kanallar × Pairing × Tenancy** | Kanal kimliği pairing ile `member`'a bağlanır; grup sohbetlerinde varsayılan kaynak `third-party` ve **override edilemez**. |
| **MCP (iki yön)** | Server: Milyonuse'u Claude/ChatGPT'ye açar (App-Milyonus). Client: kullanıcının Gmail/Calendar/Notion/Milyonus vb. bağlantıları (Agent 5.5 güvenlik modeliyle). |

---

## 6. Fazlar

Her faz sonunda: `pnpm verify` yeşil, yeni testler, kısa demo.

### F0 — İskelet (1 hafta)
- pnpm/turbo monorepo, TS, NestJS/Fastify, Next.js 16, Tailwind 4, Postgres 18 + pgvector (docker-compose).
- db roller (`owner / app (RLS) / platform`), migration altyapısı, `jobs` kuyruğu, cron, env doğrulama, logger, AppError.
- Auth: magic-link oturum + organization/member; RLS `app.current_organization_id()` + `app.current_member_id()`.
- CI (GitHub Actions): typecheck, lint, test, build, guard'lar (tenancy, naming).

### F1 — Agent çekirdeği + /agent arayüzü (2 hafta)
- `providers/`: OpenRouter + doğrudan Anthropic (Claude 5 ailesi varsayılan), dev & unconfigured modeller, tier'lar, prompt caching.
- Turn loop, context window + rolling summary, `/compact`, fit/answers, stop, bütçeler, rate limit.
- SSE controller + `AgentStreamEvent`; konsol UI (rail, modlar, model seçici, composer, steps/data kartları, revisions, feedback).
- Generic prompt (kişinin dilinde yanıt, TR/EN), `present` tool, attachments + document reader.
- Testler: App-Milyonus agent e2e'lerinin generic kısmı.

### F2 — POISON / Verified Memory (2 hafta) ★
- `packages/memory` port + §4.3'teki 10 fix + pgvector recall + data fence.
- Taint tracking ve sunucu taraflı source_kind türetme.
- `memory_propose / memory_search / user_recall` tool'ları; turn sonunda user-model reflect.
- Consolidation worker (gece + idle), trust decay, ledger doğrulama endpoint'i.
- T0 operatör imzası (CLI + admin sayfası), reaffirm (zayıf/güçlü).
- **PoisonBench** port: tekli korpus + 10 senaryo + yeni senaryolar (laundering, sahte T3, demotion döngüsü, cross-tenant). Hedef: rule-only'de mevcut %75'ten belirgin düşüş, live verifier ile ASR %0, meşru terfi %100.
- Memory Inspector UI (trust rail, why drawer, revoke preview).

### F3 — Tools + Güvenlik + Proposal birleşimi (2 hafta)
- `packages/security`: injection (EN/TR), RiskEngine, redact, SSRF, preexec.
- Generic proposal executor: "onaylanınca şu tool çağrısını çalıştır" + undo kuralları; trigger'lı state machine, slice runner, four-eyes.
- Tool'lar: web search/fetch, deep research, browser (Playwright), email (IMAP/SMTP veya MCP), vision, takvim (MCP), dosya alanı.
- Kod çalıştırma: **izole sandbox** (karar gerekli, §8).
- MCP client (stdio + HTTP), connections paneli; Milyonus platformu ilk resmi bağlantı.

### F4 — Skills + Kendini geliştirme (1,5 hafta)
- SKILL.md motoru (3 seviye), 41 hazır skill'in gözden geçirilip taşınması, skill scanner.
- Agent'ın skill yazması → staging → replay gate → promote; skill provenance + revoke.
- Skills sayfası (listele, aç/kapa, kaynağını gör).

### F5 — Her yerden konuş: Kanallar (1,5 hafta)
- Telegram, WhatsApp Cloud API, Slack, Discord, Email adapter'ları (HMAC/signing doğrulamalı webhook'lar).
- Pairing (kod, TTL, lockout), oturumların Postgres'te kalıcılığı, kanallarda proposal onayı (inline butonlar / web linki).
- Tüm kanallar aynı pipeline'dan geçer (ModelVerifier dahil — Agent 5.5'te gateway'de yoktu).

### F6 — Proaktif agent (1 hafta)
- NL → cron, schedules, unattended run autonomy policy, bildirimler (in-app + mail + kanal).
- Subagent delegation (context contract, 3 eşzamanlı / derinlik 2, child memory = T4).
- Proaktif öneriler (user model + geçmiş işlere göre).

### F7 — Yönetişim, MCP sunucusu, kurumsal (1,5 hafta)
- Org ayarları: roller, model tier'ları, house instructions, bloklu türler, auto-accept, bütçeler/kotalar.
- Audit + Activity sekmesi, export (MD/PDF), paylaşım/yorumlar.
- MCP sunucusu + OAuth 2.1 (Milyonuse'u Claude.ai / ChatGPT'ye bağla).
- KVKK/GDPR: silme talebi ↔ hash-chain ledger çatışması için **tombstone** ADR'si; veri saklama süreleri.

### F8 — Değerlendirme & Yayın (1 hafta)
- TaskBench (uçtan uca görev başarısı), PoisonBench live, smoke check, maliyet raporu.
- Deploy: Docker (non-root, read-only rootfs, cap drop) + yönetilen Postgres; web/api ayrımı.
- Gözlemlenebilirlik: trace, tur başına maliyet, hata oranları, feedback panosu.

**Toplam tahmin:** ~13–14 hafta (tek geliştirici + Claude). F0→F2 sonunda gösterilebilir bir MVP çıkar: web'de konuşan, hatırlayan ve zehirlenmeyen agent.

---

## 7. Başarı kriterleri

| Metrik | Hedef |
|---|---|
| PoisonBench held-out ASR (live verifier) | %0 |
| PoisonBench RSR / meşru terfi | %0 / %100 |
| Çok adımlı saldırı senaryoları | 14/14 (10 eski + 4 yeni) kontrol altında |
| Geri alınamaz eylemler | %100 proposal kartından geçer |
| Cross-tenant sızıntı testleri | 0 |
| İlk token gecikmesi (p50) | < 1,5 sn |
| Tur başına ortalama maliyet | ölçülür + org bütçesiyle sınırlı |
| Test sayısı | ≥ 400 (unit + e2e + PoisonBench) |

---

## 8. Açık kararlar (başlamadan önce netleşmeli)

1. **Stack:** TypeScript'e port (öneri) mi, yoksa Python mı?
2. **Ürün konumu:** (a) Bireysel son kullanıcı asistanı (B2C), (b) şirket çalışanları için kurumsal asistan (B2B — Milyonus'un HR müşterilerine upsell), (c) ikisi birden. Bu; auth, fiyatlandırma, kanal önceliği ve onboarding'i belirler. $1M MRR hedefi için öneri: **B2B öncelikli**, Milyonus HR müşterilerine ilk satış kanalı.
3. **Model sağlayıcı:** OpenRouter (App-Milyonus'taki gibi, çok model) + doğrudan Anthropic mi, sadece biri mi?
4. **Kod çalıştırma sandbox'ı:** E2B / Vercel Sandbox / Daytona / Docker / şimdilik yok.
5. **Deploy hedefi:** Vercel + yönetilen Postgres (Neon/Supabase) mi, kendi sunucu (Docker/Hostinger) mi?
6. **Kanal önceliği:** Türkiye için WhatsApp + Telegram, ABD için Slack + Email önerilir.

---

## 9. Hemen sonraki adım
Kararlar netleşince **F0** başlar: monorepo iskeleti, db + RLS, auth, CI. Ardından F1'de App-Milyonus /agent'ı generic hâle getirip taşıma ve F2'de Poison çekirdeği.

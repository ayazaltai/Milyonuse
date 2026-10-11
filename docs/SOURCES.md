# Sources — what comes from where

Üç kaynak repo, Milyonuse'a nasıl taşınıyor. "Port" = dil ya da çerçeve değişiyor. "Uyarla" = kod alınıyor ama alan bilgisi ve isimler değişiyor. "Al" = neredeyse aynen alınıyor. "Bırak" = alınmıyor.

Kaynak commit'leri (inceleme anı):
| Repo | Commit |
|---|---|
| `ayazelrico/App-Milyonus` | `707bdc0` |
| `ayazelrico/Old-Version-Of-Milyonus-Agent` | tek commit, "Add web plan document" |
| `ayazelrico/Milyonus-Landing-Page` | `835e4db` |

---

## A. App-Milyonus → Milyonuse

### A.1 Temel (F0)
| Kaynak | Hedef | İşlem |
|---|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` | aynı | Uyarla (`@milyonuse/*`) |
| `packages/config/*` | aynı | Al |
| `packages/contracts/src/{errors,primitives,constants,account,health}.ts` | aynı | Uyarla |
| `packages/contracts/src/{tenancy,permissions}.ts` | aynı | Uyarla: B2C rolleri (owner / admin / member) |
| `packages/ui/src/tokens.css` | aynı | Uyarla: HR sınıfları çıkar, marketing tokenları ekle |
| `db/roles.sql`, `db/database.sql`, `db/src/{migrate,client,testing}.ts` | aynı | Uyarla: rol adları; drizzle yok |
| `db/migrations/0000,0001,0002,0005,0007,0008,0016,0031,0042,0043,0049` | `db/migrations/0001–0006` | **Yeniden yaz** (D-08) |
| `apps/api/src/{main,app.factory,app.module,serverless}.ts` | aynı | Uyarla |
| `apps/api/serverless/vercel.js`, `scripts/{dev,vercel-output}.mjs` | aynı | Al |
| `apps/api/src/config/*` | aynı | Uyarla: env değişkenleri ayıklanır |
| `apps/api/src/database/*` (pools, rls/region preflight) | aynı | Uyarla (region preflight yok) |
| `apps/api/src/common/{app-error,filters,logging,rate-limit,raw-body,request-context.plugin,outbound,cursor,route-table}` | aynı | Al |
| `apps/api/src/modules/identity/{password,cookie,account-tokens,session.service,session.guard,sign-in-failure}` | aynı | Al / uyarla |
| `apps/api/src/modules/identity/{account.service,auth.service,self-serve.service,*.controller}` | `identity/` | Uyarla: SSO/SCIM yok; kayıt = kişisel organization |
| `apps/api/src/modules/tenancy/{tenant-scope.service,principal.service,guards/*,audit.service,database-error,idempotency}` | `tenancy/` | Uyarla: seat ve workspace yok |
| `apps/api/src/modules/{queue,cron,notifications,health}` | aynı | Uyarla |
| `apps/web/src/app/(auth)/*` | `(auth)/*` | Uyarla |
| `apps/web/src/lib/{api,client-api,format}.ts`, `components/ui/primitives` | aynı | Al |
| `apps/web/src/proxy.ts` (CSP), `next.config.ts` | aynı | Uyarla |
| `scripts/guard-tenancy.sh` | aynı | Al |
| `scripts/guard-naming.sh` | `guard-secrets.sh` + `guard-naming.sh` | Uyarla |

### A.2 Agent (F1, F3, F6)
| Kaynak | Hedef | İşlem |
|---|---|---|
| `apps/web/src/app/(dashboard)/agent/*` (konsol, composer, kartlar, paneller) | `(app)/agent/*` | Uyarla: HR görev örnekleri çıkar; agent/takım seçici eklenir |
| `apps/web/src/lib/client-api.ts` `stream()` | aynı | Al |
| `packages/contracts/src/agent.ts` | aynı | Uyarla: HR action kind'ları çıkar |
| `modules/agent/agent.service.ts` (turn loop) | `agent/turn.service.ts` | Uyarla: loop ayrı dosyaya; agent tanımı (F4) okunur |
| `modules/agent/{agent-model.port,openrouter.model,development.model,unconfigured.model,models}.ts` | `agent/model/*` | Al |
| `modules/agent/{context,fit,answers,prompt,documents}.ts` | `agent/*` | Al / uyarla (prompt genelleşir) |
| `modules/agent/{agent.toolbox,tools/tool,tools/present.tool}.ts` | `agent/tools/*` | Al |
| `modules/agent/agent.store.ts` | `agent/agent.store.ts` | Uyarla: workspace yok |
| `modules/agent/{agent-action.runner,policy,agent.approvals,actions/undo}.ts` + 0051/0058/0064 tetikleyicileri | `agent/actions/*` | Uyarla: genel executor = "onaylanınca tool çağrısını çalıştır" |
| `modules/agent/{agent.schedules,agent.notifications,agent.feedback,agent.export,agent.housekeeping}.ts` | `automations/`, `agent/` | Uyarla |
| `modules/agent/tools/{read,propose,analysis,workflow,operations}.tools.ts`, `actions/executors.ts` | — | **Bırak** (HR). Milyonus platformu MCP bağlantısı olarak gelir (F3). |
| `modules/mcp/*` | `mcp/*` | Uyarla (F9) |
| `common/agent-provenance.ts` | aynı | Al |

### A.3 Bırakılanlar
`imagine`, `interview`, `catalog`, `candidate`, `intelligence`, `pipeline`, `campaign`, `ats`, `analytics` (HR), `backoffice`, `siem`, `organization` (seat / contract), SSO / SCIM, `directory-sync`, kredi (interview credits).

---

## B. Old-Version-Of-Milyonus-Agent (Agent 5.5) → Milyonuse

| Kaynak (`src/milyonus/…`) | Hedef | İşlem | Faz |
|---|---|---|---|
| `memory/model.py` | `packages/memory/src/types.ts` | Port | F2 |
| `memory/store.py` | `apps/api/src/modules/memory/memory.store.ts` (SQL) + `packages/memory` arayüzü | Port + 10 düzeltme | F2 |
| `memory/pipeline.py` | `packages/memory/src/pipeline.ts` | Port | F2 |
| `memory/verifier.py` | `packages/memory/src/verifier.ts` | Port | F2 |
| `memory/negative.py` | `packages/memory/src/negative.ts` | Port (+ embedding) | F2 |
| `memory/trust.py` | `packages/memory/src/trust.ts` | Port | F2 |
| `memory/t0.py`, `security/operator.py` | `packages/memory/src/t0.ts`, `packages/security/src/operator.ts` | Port (`node:crypto` ed25519) | F2 |
| `memory/render.py`, `prompt/builder.py` | `packages/memory/src/render.ts` | Port | F2 |
| `memory/consolidate.py` | `packages/memory/src/consolidate.ts` + cron | Port | F2 |
| `memory/{semantic,vector,embed}.py` | `memory/recall.ts` (pgvector) + `embedder.port.ts` | Port | F2 |
| `memory/usermodel.py` | `packages/memory/src/user-model.ts` | Port | F2 |
| `memory/tool.py` | `agent/tools/memory.tools.ts` | Port | F2 |
| `security/injection.py` | `packages/security/src/injection.ts` | Port | F2 |
| `security/{risk,preexec}.py` | `packages/security/src/{risk,preexec}.ts` | Port | F3 |
| `security/{redact,ssrf,context_files}.py` | `packages/security/src/*` | Port | F3 |
| `tools/{web,browser,vision,email}.py` | `agent/tools/*` | Port | F3 |
| `tools/mcp/{client,manager}.py` | `connections/mcp-client/*` | Port + Streamable HTTP | F3 |
| `research/{deep,search}.py` | `agent/tools/research.tools.ts` | Port | F3 |
| `skills/*`, `_bundled_skills/` (41) | `packages/skills` (16 kaynak → 12 beceri; 25 elendi — F4-delivered §6) | Port + inceleme | F4 |
| `delegation/subagent.py` | `teams/delegation.ts` | Port | F5 |
| `cron/schedule.py` | `packages/contracts` + `automations/schedule-parser.ts` | Port | F6 |
| `proactive/{scheduler,runner,suggest}.py` | `automations/*` | Port | F6 |
| `gateway/{adapter,pairing,server}.py`, `gateway/adapters/*` | `packages/channels`, `channels/*` | Port | F7 |
| `observability/{trace,cost,report}.py` | `usage/`, `run_steps` | Port | F5 / F8 |
| `evals/poisonbench/*`, `tests/test_poison_scenarios.py` | `evals/poisonbench/*` | Port | F2 |
| `evaluation/{tasks,runner}.py` | `evals/taskbench/*` | Port | F10 |
| `selfmod/*`, `acp/*`, `cli/tui.py` | — | Bırak (D-13) | — |
| `deploy/compose.yaml` güvenlik ayarları | `docker-compose.yml` (yerel) | Uyarla | F0 |

---

## C. Milyonus-Landing-Page → Milyonuse

| Kaynak | Hedef | İşlem |
|---|---|---|
| `docs/design-system.md` | `docs/reference/design-system.md` | Uyarla |
| `tailwind.config.js` + `src/index.css` tokenları | `packages/ui/src/tokens.css` (marketing bölümü) | Port (Tailwind 3 → 4) |
| `src/components/{Navbar,Footer,SectionHeader,Faq,ConsentBanner,ScrollToTop,Tooltip,Brand,PageShell,HeroBackground}.tsx` | `apps/web/src/components/marketing/*` | Port (Vite → Next, `react-router` → `next/link`) |
| `src/components/{Hero,Capabilities,Benefits,Trust,Closing}.tsx` | aynı | Uyarla: Milyonuse içeriği |
| `src/lib/{i18n,site,useLocale,consent,analytics}.ts` | `apps/web/src/lib/marketing/*` | Uyarla: en + tr |
| `shared/locale-routing.ts`, `middleware.ts` | `apps/web/src/proxy.ts` | Port |
| `vercel.json` güvenlik başlıkları | `apps/web/src/proxy.ts` + `next.config.ts` | Port |
| `src/pages/LegalPages.tsx` | `(marketing)/[locale]/{privacy,terms,cookies}` | Uyarla (B2C, KVKK) |
| `public/assets/brand/*` | `apps/web/public/brand/*` | Al |
| Tavus / Daily demo, blog, Notion lead, newsletter | — | Bırak |

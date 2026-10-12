# F5 — Agent Takımları · Teslim raporu

**Tarih:** 2026-10-12 · **Durum:** tamamlandı · **Şartname:** [F5-agent-teams.md](../phases/F5-agent-teams.md)

---

## 1. Eklenenler (özet)
- **Takımlar:** Kişinin kendi agent'larından oluşur: bir lider, üyeler ve en fazla bir gözden geçiren.
  - Çalışma şekli: hiyerarşik, boru hattı ya da tartışma.
  - Çalıştırma başına token bütçesi var.
  - Roster bir bütün olarak değişir. Takım silinmez, arşivlenir.
  - **4 şablon** (en/tr): Araştırma Masası, İçerik Stüdyosu, Pazar İstihbaratı, Kişisel Ofis. Şablondan kurulan takımın agent'ları o takım için yeniden yapılır.
- **Çalıştırma motoru (`team_run` işi):**
  - Çalıştırma kalıcı kuyrukta dilim dilim ilerler (`RUN_SLICE_SECONDS`). Her dilim veritabanının söylediği durumdan devam eder; hangi instance alırsa alsın kaldığı yerden sürer.
  - Dilim çalıştırmanın kirasını (`lease_until`) tutar. Başında hâlâ `running` olan görevleri ölü bir sürecin yarım bıraktığı görevler sayar ve `uncertain` yapar. Bunlar kendiliğinden asla ikinci kez çalışmaz.
  - **Hiyerarşik:**
    - Lider `plan_tasks` ile bir görev grafı çıkarır; hedef basitse `finish_run` ile kendisi yanıtlar.
    - Hazır görevler paralel çalışır (`TEAM_MAX_PARALLEL`).
    - Lider `merge_results` ile birleştirir.
    - Gözden geçiren `approve_result` ya da `request_revision` ile karar verir; en fazla 2 tur.
  - **Boru hattı:** Roster sırasıyla aşamalar zinciri; son aşamanın çıktısı taslaktır.
  - **Tartışma:** 2–3 üye aynı soruyu bağımsız yanıtlar, lider sentezler.
  - **Delegasyon sözleşmesi:** Üye yalnızca görevin hedefini, bağlamını, başarı ölçütünü ve bağlı olduğu görevlerin çıktılarını görür. Çıktılar çalıştırmaya özel rastgele bir çitle veri olarak sarılır.
  - **Üyenin çıkmaması:**
    - Başarısız görev bir kez başka bir üyeye verilir.
    - İkinci başarısızlıkta çalıştırma açık bir hatayla durur ("Task t1 failed twice: …").
    - Kişi görevi yeniden çalıştırabilir; bu yeni bir denemedir.
  - **Bütçe:** Her model çağrısından önce çalıştırmanın bütçesine ve kişinin günlük kotasına bakılır. Biri bitmişse çalıştırma güvenle `waiting_approval`'a geçer. Bekleme bir görevin deneme hakkını harcamaz. Kişi token ekleyince devam eder.
  - **Durdurma:** Açık görevler iptal edilir, yapılanlar kalır, çalıştırma mühürlenir.
  - **Saatlik geçiş:** Kimsenin ilerletmediği bir çalıştırmayı yeniden kuyruğa alır.
- **Güvenlik:**
  - Üye turları gözetimsiz çalışır ve her araç çağrısı agent'ın gözetimsiz politikasıyla RiskEngine'den geçer.
  - `danger` araçlar hiç sunulmaz. `skill_propose`, `memory_forget` ve `present` takımda yoktur.
  - Güvenli okuma dışındaki her şey, çalıştırmanın konuşmasında kişiye bir kart olur.
  - Sonuç o konuşmaya yazılır; kişi oradan liderle sohbete devam edebilir.
- **Takım hafızası:**
  - Üyelerin önerileri `scope=team` olur ve en fazla **T4**'tür. Liderinkiler en fazla **T2**'dir; üye çıktısını okumuş bir lider (subagent taint) en fazla T4 olur.
  - Takım hafızası kişinin hafızasına yalnızca kişi onu **sahiplenirse** (`/memory/:id/adopt`) geçer. Sahiplenmede kişinin kendi sözü olarak yeniden önerilir ve her şey gibi kontrol edilir.
- **Ölçüler:**
  - **TeamBench taslağı (10 görev, `evals/teambench`):** Referans planlar ve yapısal puanlama.
  - **PoisonBench'e takım senaryoları** (7) eklendi.
- **Web:**
  - `/app/teams`: takımlar, şablonlar, takım kurucu (agent, rol, uzmanlık, çalışma şekli, bütçe).
  - `/app/teams/[id]`: hedef verip çalıştırma, geçmiş çalıştırmalar, üyeler, düzenleme.
  - `/app/runs/[id]`: canlı görev grafiği (SVG, seviyeli yerleşim, düğümde avatar ve durum), görevler (sözleşme, çıktı, yeniden çalıştır), adım akışı, sonuç, durdur, token ekle ve devam et, bekleyen kart sayısı. Çalışırken 2,5 sn'de bir yenilenir.
  - Hafızada "Takım" ya da "Bir agent'ın kendisi" rozeti ve "Benimki yap".
  - Kenar menüde Teams etkin. Metinler EN/TR.

## 2. Dosyalar
| Alan | Yol | Kaynak |
|---|---|---|
| Migration | `db/migrations/0012_teams.sql` | Yeni (run dilimleme fikri App-Milyonus `jobs`) |
| DB testleri | `db/src/teams.integration.test.ts` (15) | Yeni |
| Contracts | `packages/contracts/src/teams.ts`; `memory.ts` (`teamId`) | Yeni |
| Şablonlar | `packages/skills/src/templates.ts` (`TEAM_TEMPLATES`) | Yeni |
| Takım modülü | `modules/teams/{teams.store,teams.service,run-engine,team-turn,teams.controller,teams.module}.ts` | Agent 5.5 `delegation/subagent.py` bağlam sözleşmesinden uyarlandı |
| Hafıza | `memory.store.ts` (`scopeOf`, `lensOf`: `agent:<id>` / `team:<id>`), `memory.service.ts` (`adopt`), `memory.controller.ts`, `tools/memory.tools.ts` (takım kapsamı, tier tavanı) | Genişletildi |
| Agent | `profile.ts` (`teamId`, `tierCap`), `agent.store.ts` (`teamId` ile konuşma), `actions/action.service.ts` (`classify(…, unattended)`), `development.model.ts` (takım rolleri) | Genişletildi |
| Cron | `cron.service.ts`: saatlik `teams` adımı (`RunEngine.sweep`) | Genişletildi |
| Env | `TEAM_MAX_PARALLEL` (3), `RUN_SLICE_SECONDS` (240) | Yeni |
| Ölçüler | `evals/teambench/*` (yeni paket), `evals/poisonbench/src/team.ts` | Yeni |
| Web | `(app)/app/teams/{page,teams-gallery,team-builder}.tsx`, `teams/[teamId]/{page,team-detail}.tsx`, `(app)/app/runs/[runId]/{page,run-viewer,run-graph}.tsx`, `memory-why.tsx`, `memory-inspector.tsx`, `sidebar.tsx`, i18n `app.teams`, `app.runs`, `app.memory`, `tokens.css` | Yeni / genişletildi |
| Testler | `apps/api/src/teams.e2e.test.ts` (20), `apps/api/src/teambench.e2e.test.ts` (11) | Yeni |

## 3. Veritabanı — `0012_teams`
| Tablo | Kurallar ve HINT'ler |
|---|---|
| `teams`, `team_members` | Kişiye özel RLS. En fazla bir lider ve bir gözden geçiren (kısmi benzersiz indeks). Yalnızca kişinin kendi agent'ları (FK). |
| `runs` | `queued`'da ve harcamasız başlar. Geçişler: queued → running/cancelled; running → waiting_approval/completed/failed/cancelled; waiting_approval → running/cancelled; failed → running/cancelled (`run_transition`). completed ve cancelled mühürlüdür (`run_finished`); şema sahibi bile değiştiremez. Kimliği sabittir (`run_identity_fixed`). Harcama yalnızca artar (`run_spend_backwards`). Derinliği veritabanı belirler, en fazla 2 (`run_too_deep`). Tek başına silinmez. |
| `run_tasks` | Bağımlılık yalnızca aynı çalıştırmadaki önceki bir görev olabilir; bu yüzden döngü olamaz (`task_dependency_unknown`). Sözleşme sabittir (`task_contract_fixed`). Bitmiş görev bitmiştir. Yeniden atama yalnızca beklerken yapılır. failed/uncertain/cancelled → pending ancak yeni bir denemeyle olur (`task_transition`). Çalıştırma bitince görevler de donar. |
| `run_steps` | Sıra numarasını veritabanı verir; yalnızca eklenir (`run_step_immutable`). |
| `memory_items` | `scope = team` kişinin kendi takımlarından birini göstermelidir (`memory_scope_unknown`; 0011'deki tetikleyici genişletildi). |
| `agent_conversations` | `team_id`: takımın çalıştırmasını tutan konuşma. |

Guard temiz; 9 yeni HINT'in hepsi eşlendi.

## 4. API uç noktaları (`agents.use`)
| Yöntem | Yol | Not |
|---|---|---|
| GET | `/teams` (`?archived=true`), `/teams/templates` (`?locale=tr`), `/teams/:id`, `/teams/:id/runs` | |
| POST | `/teams` | Idempotent. Şablondan ya da rosterden |
| PATCH | `/teams/:id` | Roster bir bütün olarak değişir |
| POST | `/teams/:id/archive`, `/restore` | |
| POST | `/teams/:id/runs` | Idempotent, üye başına 10/dk. Çalıştırma kuyruğa girer |
| GET | `/runs`, `/runs/:id` | Graf, adımlar, sonuç, bekleyen kartlar |
| POST | `/runs/:id/cancel` · `/resume` · `/tasks/:taskId/rerun` | |
| POST | `/memory/:id/adopt` | Takımın ya da agent'ın hafızasını kişinin kendi sözü olarak önerir |

## 5. Testler — toplam **851** (F4 sonunda 773; **+78**), hepsi yeşil
| Paket | Test | F5'te eklenen |
|---|---|---|
| api | 499 | teams e2e 20, TeamBench e2e 11, rota ve HINT kontrolleri |
| db | 127 | teams 15 |
| teambench | 16 | yeni paket |
| skills | 72 | takım şablonları 5 |
| poisonbench | 11 | takım senaryoları 2 |
| security / memory / contracts / web | 53 / 42 / 21 / 10 | — |

**Kabul kriterleri (şartname §4):**
1. 3 üyeli takım paralel çalışıyor: e2e'de üç bağımsız görev aynı anda çalıştı (zirve eşzamanlılık 3) ve dördüncüsü üçünü bekledi. Çıkan bir üyenin görevi başka bir üyeye geçiyor; ikisi de çıkarsa çalıştırma "Task t1 failed twice: …" ile bitiyor, kişi yeniden çalıştırınca tamamlanıyor. Yarıda kalan görev `uncertain` oluyor, kendiliğinden çalışmıyor (model hiç çağrılmadı), yeniden çalıştırmayla bitiyor. ✅
2. Bütçe aşımı çalıştırmayı güvenle durduruyor: `waiting_approval`, harcama dondu, bekleyen görevin denemesi harcanmadı. Token eklenince devam edip tamamlanıyor; ikinci "devam" reddediliyor. ✅
3. Üyenin zehirli çıktısı kullanıcı hafızasına onaysız ulaşamıyor: takım kapsamında T4 ve aktif değil; kişinin turunda hiç görünmüyor. Kişi sahiplenirse T1 olarak, kontrol edilerek ekleniyor. PoisonBench takım senaryolarında hiçbir zehirli aday tutulmuyor ve kişiye ulaşmıyor. ✅
4. TeamBench taslağı (10 görev) motor üzerinden uçtan uca çalışıyor; deterministik modelle 10/10 geçiyor. ✅
5. ≥70 yeni test: **78**. ✅

**Tarayıcı doğrulaması (Playwright, geliştirme modeli, gerçek kuyruk):**
- Takım galerisi → Araştırma Masası şablonu → takım sayfası → hedef → çalıştırma sayfası. Çalıştırma kendiliğinden ilerledi: plan, atama, iş, birleştirme, inceleme, bitti.
- Grafik, adımlar ve sonuç göründü.
- Takım kurucuyla özel bir takım kaydedildi.
- 390 px'te taşma yok, konsol hatası yok.

## 6. Şartnameden sapmalar
- **Migration numarası `0012_teams`:** 0010 ve 0011 F4'e gitti.
- **Görev başına çocuk `runs` satırı açılmıyor.** Delegasyon birimi `run_tasks`'tır (sözleşme, atama, deneme, çıktı, token). Şemada `parent_run_id` ve derinlik (≤2) hazır ve test edildi; bir üyenin kendi alt takımını başlatması sonraki bir adım.
- **`ask_member` ve `assign_task` lider araçları yok.** Lider atamayı `plan_tasks`'ta yapıyor, yeniden atamayı motor yapıyor. Planlama turunda üyeye soru sormak ileride eklenebilir. `request_revision` lideri yeniden birleştirmeye gönderiyor, üyenin görevini yeniden açmıyor.
- **Sürükle-bırak yok.** Kurucu seçim listeleriyle çalışıyor; boru hattının sırası satır sırası.
- **"Toplu öneri kartı" ayrı bir kart değil.** Çalıştırmanın önerileri konuşmasında tek tek kart olarak duruyor; çalıştırma sayfası kaç tanesinin beklediğini gösterip oraya bağlıyor.
- **Bütçe görev başına değil, çalıştırma başına.** Görevlerin harcaması ayrıca kaydediliyor ve gösteriliyor.

## 7. Bilinen sınırlar / teknik borç
- **Canlı modelle takım çalıştırması yapılmadı** (konteyner openrouter.ai'ye erişemiyor). TeamBench'in canlı puanı bu yüzden henüz yok; deterministik koşu motoru ve puanlayıcıyı doğruluyor.
- **Paralel görevler aynı dilimde birlikte bekleniyor.** Uzun bir görev, aynı paletteki diğerlerinin bitmesini geciktirebilir; ince taneli zamanlama sonraki bir adım.
- **Lider yanıtı plan yerine düz metinse** çalıştırma onu sonuç sayıyor (planlamadan yanıtladı). Bu, gerçek modellerde kötüye kullanılırsa sıkılaştırılmalı.
- **Kişinin yaptığı hafıza sahiplenmesi** orijinal takım hafızasını silmiyor; ikisi bağlı olarak duruyor (türetme kaydı var).

## 8. F6'ya devredilenler
- `RunEngine`, `teamTurn` ve gözetimsiz `classify(…, unattended)`: otomasyonlar bir takımı ya da agent'ı zamanlanmış veya tetiklenmiş olarak aynı motorla çalıştıracak.
- `waiting_approval` ve kartlar: F6'nın Onay Kutusu bunları ve `agent_actions`'ı tek yerde toplayacak.
- TeamBench'in canlı koşusu ve model puanlaması F10'da.

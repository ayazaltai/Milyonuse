# F2 — Doğrulanmış Hafıza (Poison Defense) ★

**Amaç:** Agent'lar oturumlar boyunca kullanıcıyı ve dünyayı hatırlar. Bu hafızaya kimin yazdığı, nereden geldiği ve doğrulanıp doğrulanmadığı her zaman bilinir. Zehirli bir kaynak tek işlemle, ondan türeyen her şeyle birlikte silinir.

**Bağımlılık:** F1 · **Kaynak:** Agent 5.5 `memory/*`, `security/{injection,operator}.py`, `evals/poisonbench/*` (bkz. SOURCES B) · **Durum:** ✅ tamamlandı — [teslim raporu](../delivered/F2-delivered.md) (şartnameden sapmalar §6'da)

---

## 1. Model

### 1.1 Güven katmanları
| Tier | Kaynak | Varsayılan tavan | Yarı ömür | Terfi |
|---|---|---|---|---|
| **T0** | Operatör: Ed25519 imzalı, iki aşamalı | 1.0 | azalmaz | İmza + 300 sn review |
| **T1** | Kullanıcının kendi doğrudan beyanı (temiz run) | 1.0 | 180 gün | Verify geçerse hemen |
| **T2** | Agent'ın temiz run'da çıkardığı sonuç | 0.85 | 60 gün | Verify geçerse hemen |
| **T3** | Dış kaynak (web, e-posta, MCP, dosya, kanal) | 0.6 | 14 gün | ≥2 **bağımsız** onay; süreli |
| **T4** | Subagent ya da takım üyesinin çıktısı; bilinmeyen kaynak | 0.4 | 14 gün | Yalnızca kullanıcı onayı |

- **Hassas içerik** (sağlık, finans, kimlik, konum; EN/TR anahtar kelime ve sınıflandırıcıyla tespit) 4 kat hızlı azalır.
- **Kapsam (scope):** `user` (kullanıcının tüm agent'ları), `agent` (tek agent), `team` (F5).

### 1.2 Durumlar
`pending → active → demoted → (yeni kanıtla) active` · `pending → rejected` · `* → revoked` · `active → expired`

Durum geçişleri SQL tetikleyicisiyle zorlanır. `revoked` ve `rejected` geri dönülemez durumlardır.

### 1.3 Tablolar (`0007_memory.sql`)
Alanlar ARCHITECTURE §3.2'deki gibidir.
- **Değiştirilemezlik:** `content`, `evidence_hash` ve `provenance` değiştirilemez (tetikleyici).
- **Ledger:** Kiracı başına sha256 zinciri; `app.memory_ledger_append()` tek yazma yoludur. `verify_ledger` fonksiyonu zinciri yeniden hesaplar.
- **Vektör:** `embedding vector(1536)`, HNSW (`vector_cosine_ops`) indeksi.

## 2. Bileşenler (`packages/memory`, `packages/security`)
| Modül | Görev |
|---|---|
| `types.ts` | TrustTier, SourceKind, MemoryState, Provenance, MemoryItem |
| `taint.ts` | Run taint → (source_kind, tier, derived_from) türetimi (D-12) |
| `pipeline.ts` | `propose` / `processOne` / `processPending` / `approvePending` |
| `verifier.ts` | `RuleVerifier` (injection + kaynak yetkinliği) · `ModelVerifier` (kesin JSON; hata olursa kural kararına düşer) |
| `negative.ts` | Jaccard ≥ 0.86 **veya** cosine ≥ 0.92 → rephrase |
| `trust.ts` | `current = ceiling × 0.5^(age/half_life)`, hassasiyet sınıflandırması |
| `consolidate.ts` | Expire, decay → demote, dedupe, çelişki bayrağı, ledger doğrulama |
| `render.ts` | `<milyonuse:memory kind=…>` veri çiti; tier sırasıyla, karakter bütçesiyle; T0 ayrı "operator policy" bloğu |
| `recall.ts` | pgvector over-fetch → `cosine × current_trust` → top-k; yalnızca active; scope filtresi |
| `user-model.ts` | Tur sonu reflect: kullanıcı hakkındaki gerçekler pipeline'dan geçer |
| `t0.ts` + `security/operator.ts` | Ed25519 (`node:crypto`); stage → activate (ikinci imza + review penceresi) |
| `security/injection.ts` | EN/TR regex tarayıcı ve şiddet dereceleri |

Agent tool'ları:
- `memory_propose`: modelin `source_kind` alanı yoktur; yalnızca isteğe bağlı `lower_tier` alabilir.
- `memory_search`
- `user_recall`
- `memory_forget`: öneri olarak çalışır.

## 3. Kapatılan açıklar (her biri önce kırmızı test)
| # | Açık (Agent 5.5) | Düzeltme | Test |
|---|---|---|---|
| 1 | T1 aklama: model `source_kind="user-direct"` seçebiliyor | Tier, sunucu tarafında taint'ten türetilir | `laundering.scenario` |
| 2 | Sahte T3 onayı: aynı item'ı tekrar işlemek onay sayılıyor | `memory_confirmations` tablosunda farklı evidence + kaynak; bekleyen T3 de süresi dolunca silinir | `fake-confirmation.scenario` |
| 3 | Demotion geri alınıyor | `demoted` durumu; yeniden terfi için yeni kanıt gerekir, tavan düşer | `demotion-loop.scenario` |
| 4 | Revoke zinciri canlıda çalışmıyor | `derived_from` = run'da okunan kaynaklar (otomatik) | `live-revoke.scenario` |
| 5 | T0 prompt'a ulaşmıyor | Ayrı "operator policy" bloğu | `t0-render.test` |
| 6 | Hash'li embedder her süreçte farklı | Gerçek embedder + deterministik FNV yedeği | `embedder-stable.test` |
| 7 | `reaffirm --sign` çalışmıyor | Tipli API | `reaffirm-signed.test` |
| 8 | Rephrase tespiti çok katı | Jaccard ya da cosine | `rephrase.scenario` |
| 9 | Consolidation zamanlanmamış | Gece cron + boşta tetik | `consolidation-cron.test` |
| 10 | Kiracılar arası sızıntı (global notlar) | RLS + scope | `cross-tenant.scenario` |

## 4. Memory Inspector (web)
- `(app)/memory`:
  - Liste: tier, durum, scope, güven çubuğu.
  - Filtreler.
  - "Neden biliyorsun?" çekmecesi: provenance, kanıt, ledger kayıtları, türevler.
- Eylemler:
  - Onayla (pending, T4)
  - Unut: öneri olarak çalışır.
  - Kaynağı geri çek: revoke önizlemesi, "N öğe düşecek".
  - Yeniden onayla (zayıf).
- Ledger bütünlüğü rozeti.

## 5. PoisonBench (`evals/poisonbench`)
- Tek seferlik korpus: C1–C4 kanalları; train ve held-out bölümleri (Agent 5.5'ten port).
- Çok adımlı senaryolar: Agent 5.5'teki 10 senaryo + 4 yeni (laundering, sahte onay, demotion döngüsü, kiracılar arası).
- Ölçümler: ASR, RSR, meşru terfi oranı.
- Kural verifier ile CI'da çalışır. `POISONBENCH_LIVE=1` ile model verifier eklenir.
- Hedef: CI (kural) held-out ASR mevcut %75'in belirgin altında; live ile %0.

## 6. Kabul kriterleri
1. 14/14 senaryo kontrol altında.
2. Tek komutla revoke: 3 seviyeli türetme zinciri < 1 sn içinde düşer.
3. Ledger doğrulaması bozulmuş bir satırı yakalar.
4. Recall'da düşük güvenli bir eşleşme, güvenilir bir eşleşmenin önüne geçemez (test).
5. ≥80 yeni test.

## 7. Teslim
`docs/delivered/F2-delivered.md`

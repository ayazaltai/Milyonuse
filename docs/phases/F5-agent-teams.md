# F5 — Agent Takımları

**Amaç:** Kullanıcı birden çok agent'ı takım olarak çalıştırır. Lider işi planlar, üyelere görev verir, işler paralel yürür, gözden geçiren üye kontrol eder, sonuç birleşik teslim edilir. Takım hafızası ortaktır ama doğrulanmıştır.

**Bağımlılık:** F4 · **Kaynak:** Agent 5.5 `delegation/subagent.py` (context contract), App-Milyonus run dilimleme

---

## 1. Model (`0010_teams.sql`)
| Tablo | Not |
|---|---|
| `teams` | Ad, amaç, lider agent, çalışma şekli (`hierarchical`, `pipeline`, `debate`), bütçe |
| `team_members` | agent_id, rol (`lead` / `member` / `reviewer`), uzmanlık notu |
| `runs` | Kök ya da çocuk (`parent_run_id`); hedef agent ya da takım; durum (`queued → running → waiting_approval → completed / failed / cancelled`); bütçe ve harcama; taint; `agent_version_id` |
| `run_steps` | Değiştirilemez adım kaydı: düşünce özeti, tool çağrısı, sonuç kaynağı, maliyet |
| `run_tasks` | Görev grafı (DAG): başlık, girdi sözleşmesi (`goal`, `context`, `success_criteria`), bağımlılıklar, atanan agent, durum, çıktı kaynağı |

- Durum makineleri tetikleyicilerle korunur. Tamamlanmış run değiştirilemez.

## 2. Çalışma şekilleri
| Şekil | Akış |
|---|---|
| **Hiyerarşik** (varsayılan) | Lider `plan_tasks` ile DAG üretir. Üyeler görevleri alır (paralel ≤ `TEAM_MAX_PARALLEL`). Lider `merge_results` ile birleştirir. Reviewer onaylar ya da düzeltme ister (≤2 tur). |
| **Pipeline** | Sabit sıra: A → B → C; her çıktı bir sonrakinin girdisi |
| **Tartışma** | 2–3 agent aynı soruya bağımsız yanıt verir; lider sentezler |

- Lider tool'ları: `plan_tasks`, `assign_task`, `ask_member`, `merge_results`, `request_revision`, `finish_run`.
- **Delegasyon sözleşmesi:** Çocuk run yalnızca sözleşmede verilen context'i görür. Çocukta yasaklı tool'lar vardır (ör. `email_send`). Derinlik ≤2, eşzamanlılık ≤3 (yapılandırılabilir).
- **Hafıza:**
  - Üyelerin önerileri `scope=team` alır.
  - Üye çıktısından gelen her şey en fazla **T4** olur; lider sentezi en fazla **T2** olur.
  - Takım hafızası kullanıcı hafızasına ancak kullanıcı onayıyla taşınır.
- **Run motoru:** `jobs` ile dilimlenir (`RUN_SLICE_SECONDS`). Her dilim kaldığı yeri yazar. Instance düşerse kaldığı yerden devam eder; yarım kalan tool çağrısı "uncertain" olur.
- **Maliyet:** Bütçe görev ve run başına tutulur; aşımda run `waiting_approval` durumuna geçer ("devam için X kredi gerek").

## 3. Web
- `(app)/teams`: takım oluştur (sürükle-bırak üye, rol, çalışma şekli), şablon takımlar:
  - Araştırma Masası: araştırmacı + analist + editör
  - İçerik Stüdyosu: stratejist + yazar + editör
  - Pazar İstihbaratı: izleyici + analist
  - Kişisel Ofis: asistan + takvim + e-posta
- **Run görünümü:**
  - Canlı görev grafiği (DAG), her düğümde agent avatarı, durum, maliyet.
  - Adım akışı.
  - Durdur, devam et, bir görevi yeniden çalıştır.
  - Sonuç belgesi.
- Sonuçtaki öneriler toplu öneri kartı olarak gelir.

## 4. Kabul kriterleri
1. 3 üyeli bir takım paralel çalışır; bir üye düşerse görev yeniden atanır ya da run açık bir hatayla biter.
2. Bütçe aşımı run'ı güvenle durdurur ve sonra devam ettirilebilir.
3. Üyenin zehirli çıktısı kullanıcı hafızasına onaysız ulaşamaz (PoisonBench'e takım senaryosu eklenir).
4. TeamBench taslağı (10 görev) çalışır.
5. ≥70 yeni test.

## 5. Teslim
`docs/delivered/F5-delivered.md`

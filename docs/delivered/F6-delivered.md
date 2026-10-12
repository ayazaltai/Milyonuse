# F6 — Otomasyonlar · Teslim raporu

**Tarih:** 2026-10-12 · **Durum:** tamamlandı · **Şartname:** [F6-automations.md](../phases/F6-automations.md)

---

## 1. Eklenenler (özet)
- **Otomasyon türleri (7):** `schedule`, `monitor`, `goal`, `webhook`, `email`, `agent_event`, `manual`.
  - Her otomasyon kişinin bir agent'ını ya da takımını çalıştırır.
  - Ortak alanlar: açık/kapalı, hedef, her seferinde sorulan istem, gözetimsiz politika (`safe_only` / `trusted`), saat dilimi, sessiz saatler, çalıştırma başına token bütçesi, günlük tavan, hata politikası (durdur / bildir / bir kez daha dene) ve bildirim yeri (Onay Kutusu, e-posta).
- **Agent'ın tek başına çalışması:** Hedef bir agent ise otomasyon takımsız bir çalıştırma açar. Bu çalıştırmanın tek görevi vardır ve F5'in motoruyla ilerler. Sonuç görevin çıktısıdır ve çalıştırmanın konuşmasına yazılır.
- **Motor:**
  - **Dakikalık geçiş** (`AutomationScheduler.tick`):
    - Vadesi gelenleri tek bir SQL ifadesiyle `SKIP LOCKED` kullanarak sahiplenir ve sonraki çalışma zamanını ileri alır. İki süreç aynı otomasyonu asla birlikte almaz.
    - Kaçırılmış birden çok çalışma (süreç kapalıyken) tek bir çalıştırma başlatır, birikmiş hepsini değil.
  - **Sonraki çalışma zamanı SQL'de** (`app.automation_next`): yerel saat o günün anına çevrilir, böylece yaz saati geçişinde 09:00 yine 09:00 kalır.
  - **Olay → tetik → iş:**
    - Her olay `automation_triggers`'a tekillik anahtarıyla bir kez yazılır. Aynı olay ikinci kez gelirse hiçbir şey başlamaz.
    - Tetik kalıcı kuyrukta (`automation_fire`) ateşlenir: hemen, ya da sessiz saatler bitince.
    - Ateşleme otomasyonun hâlâ açık ve günlük tavanın altında olduğunu yeniden kontrol eder.
  - **Monitor:**
    - Sayfa SSRF korumalı fetcher ile okunur, metne çevrilir ve sha256 alınır.
    - İlk okuma yalnızca temel çizgidir.
    - Değişiklik yoksa çalıştırma da model çağrısı da yoktur (maliyet 0).
    - Değişiklik olursa agent sayfanın önceki ve yeni hâlini veri olarak alır.
    - Sayfa okunamazsa Onay Kutusuna günde bir uyarı düşer.
  - **Hedef (goal):**
    - Takvime göre çalışır.
    - Çalıştırma `goal_reached` aracıyla hedefin tuttuğunu söyleyebilir; o zaman otomasyon durur ve bir bildirim düşer.
    - Son gün geçince otomasyon kendiliğinden kapanır.
  - **Zincirler (`agent_event`):**
    - Bir otomasyonun ya da takımın çalıştırması bitince (ya da başarısız olunca) onu izleyen otomasyonlar başlar.
    - Zincir veritabanında taşınır: en fazla 3 derinlik, aynı otomasyon aynı zincirde bir kez.
    - Reddedilen bir halka Onay Kutusuna "başlatılmadı" uyarısı olarak düşer.
  - **Hatalar:**
    - Üst üste 3 başarısızlık otomasyonu SQL'de duraklatır ve nedenini yazar.
    - `pause` ilk hatada durdurur, `notify` bildirir, `retry` bir kez yeni bir çalıştırma açar.
    - Bildirim Onay Kutusuna ve istenirse e-postaya gider.
- **Gözetimsiz güvenlik:**
  - Otomasyon çalıştırmalarında `danger` araçlar *sunulur*; böylece agent'ın göndermek istediği şey Onay Kutusuna bir öneri olarak düşer. RiskEngine `danger`'ı asla kendi başına çalıştırmaz.
  - `safe_only` altında yalnızca güvenli okumalar çalışır.
  - `trusted` yalnızca kişi onay cümlesini işaretlerse kaydedilir (`trusted_confirmed_at`). O zaman bile geri alınamaz işler her zaman öneri olur.
  - Çalıştırmanın politikası (`runs.unattended_policy`) agent'ın kendi politikasının yerine geçer.
- **Dış girdi:**
  - Webhook, e-posta ve monitor girdisi her zaman dış kaynaktır. Rastgele bir çitle veri olarak sarılır ve çalıştırma `third_party` olarak işaretlenir.
  - Bu çalıştırmadan çıkan hafıza önerileri buna göre sınıflanır.
- **Webhook:**
  - `POST /api/v1/hooks/:token`. İmza `<timestamp>.<gövde>` üzerinde HMAC-SHA256'dır. ±5 dakika içinde olmalıdır; değiştirilmiş gövde reddedilir.
  - Tekillik `x-milyonuse-delivery` başlığıyla sağlanır; başlık yoksa gövdenin özetiyle.
  - İmza anahtarı adresten sunucu anahtarıyla türetilir, **hiçbir yerde saklanmaz**. Yalnızca oluşturulduğunda ve yenilendiğinde gösterilir.
- **E-posta:**
  - Her otomasyonun bir adresi var: `<token>@in.milyonuse.com`.
  - Gelen e-posta sağlayıcısı postayı `POST /api/v1/hooks/inbound-mail`'e kendi bearer'ıyla (`INBOUND_MAIL_SECRET`) iletir.
  - `+etiket` ve görünen ad desteklenir. Message-ID ile tek seferlik.
- **Doğal dilden taslak:** `POST /automations/draft` (kural tabanlı, EN/TR) kişinin cümlesini bir yapılandırmaya çevirir ve ne anladığını söyler. Hiçbir şey kaydedilmez.
- **Öneriler (saatlik):** Kişi aynı şeyi bu ay üç farklı günde istediyse Onay Kutusuna bir otomasyon önerisi düşer. Öneri bir kez yapılır ve kişi "Kur" demeden hiçbir şey oluşmaz.
- **Onay Kutusu:** Tek yerde dört şey toplanır:
  - agent önerileri;
  - bütçesinde bekleyen çalıştırmalar;
  - onay bekleyen hafızalar;
  - otomasyonların uyarıları, bildirimleri ve önerileri.

  Öneriler toplu onaylanır ya da reddedilir. Her biri tek başına onaylanmış gibi aynı yoldan geçer ve o anki hâline göre yeniden kontrol edilir; biri reddedilirse diğerleri yine işlenir.
- **Çalıştırmalar:** `GET /runs` artık takım, agent ve otomasyon çalıştırmalarının hepsini gösterir; `teamId`, `automationId` ve `status` ile süzülür.
- **Web:**
  - `/app/automations`: liste (açık/kapalı anahtarı, tür, son sonuç, sonraki ve son çalışma) ve sihirbaz (kişinin cümlesi → taslak → form). Form: hedef, tür, istem, takvim, gün seçimi, monitor, hedef tarihi, zincir ve güvenlik. "Sınırlar ve güvenlik" bölümünde bütçe, günlük tavan, hata politikası, bildirim ve sessiz saatler var. Webhook'un adresi ve imza anahtarı bir kez gösterilir.
  - `/app/automations/[id]`: durum, şimdi çalıştır, dene (örnek girdiyle), adres ve yenileme, monitor sayaçları, çalıştırmalar, tetik geçmişi, sil.
  - `/app/runs`: tüm çalıştırmalar, duruma göre süzme.
  - `/app/inbox`: toplu onay ve red, hafıza onayı, uyarılar, öneriden otomasyon kurma.
  - Kenar menüde **Onay Kutusu** okunmamış sayısıyla (dakikada bir ve her sayfa değişiminde), **Otomasyonlar** ve **Çalıştırmalar** etkin. Metinler EN/TR.

## 2. Dosyalar
| Alan | Yol | Kaynak |
|---|---|---|
| Migration | `db/migrations/0013_automations.sql` | Yeni. DST yöntemi App-Milyonus 0063 (`agent_schedules`) |
| DB testleri | `db/src/automations.integration.test.ts` (13) | Yeni |
| Contracts | `packages/contracts/src/automations.ts`; `teams.ts` (`agentId`, `automationId`) | Yeni |
| Otomasyon modülü | `modules/automations/{automations.store,automations.service,automations.controller,automations.module,launcher,scheduler,hook-intake,inbox.service,draft}.ts` | Yeni |
| Takım motoru | `run-hooks.ts` (yeni), `run-engine.ts` (tek agent'lı çalıştırma, otomasyon politikası, `danger` önerileri, kancalar), `teams.store.ts`, `teams.service.ts` (`start(…, from)`, süzgeçler), `teams.controller.ts` (`GET /runs` süzgeçleri) | Genişletildi |
| Hata eşlemesi | `tenancy/database-error.ts` (`hintOf`, 5 yeni HINT) | Genişletildi |
| Cron | `cron.service.ts`: dakikalık `automations`, saatlik `suggestions` | Genişletildi |
| Env | `INBOUND_MAIL_DOMAIN`, `INBOUND_MAIL_SECRET`, `MONITOR_BATCH` | Yeni |
| Rotalar | `route-inventory.test.ts` (automations, inbox, hooks yüzeyleri), `docs/api/routes.md` | Yeniden üretildi |
| Web | `(app)/app/automations/{page,automations-list,automation-form}.tsx`, `automations/[automationId]/{page,automation-detail}.tsx`, `(app)/app/runs/{page,run-list}.tsx`, `(app)/app/inbox/{page,inbox-board}.tsx`, `sidebar.tsx`, i18n `app.automations`, `app.inbox`, `app.runList`, `tokens.css` | Yeni / genişletildi |
| Testler | `apps/api/src/automations.e2e.test.ts` (38), `modules/automations/draft.test.ts` (22), `hook-intake.test.ts` (13), `cron.test.ts` | Yeni / genişletildi |

## 3. Veritabanı — `0013_automations`
| Nesne | Kurallar ve HINT'ler |
|---|---|
| `app.automation_next(...)` | Saatlik, günlük, hafta içi, haftalık (günler) ve aylık (ay kısa ise ayın son günü). Yerel saat o günün anına çevrilir; ileri sarmada atlanan saat, sonraki ilk andır. |
| `automations` | Kişiye özel RLS (FORCE). Kişi başına en fazla 50 (`automation_limit`). Her tür neye ihtiyaç duyuyorsa onu ister: tam takvim, URL, hedef tarihi, adres ya da izlenen (`automation_invalid`). Tür değişmez. Geçersiz saat dilimi kayıtta reddedilir. `trusted` için `trusted_confirmed_at` zorunludur. Kendi kendini izleyemez (`automation_chain_loop`). Üst üste 3 hata otomasyonu kapatır ve nedenini yazar; yeniden açmak sayacı sıfırlar. Sonraki çalışma eklemede, takvim değişince ve yeniden açılınca hesaplanır. |
| `automation_triggers` | `(automation_id, dedupe_key)` benzersizdir: bir olay, bir çalıştırma. Zincir ≥3 ise ret (`automation_chain_too_deep`), zincirde kendisi varsa ret (`automation_chain_loop`). Kayıt değişmez (`automation_trigger_immutable`); yalnızca durum, neden ve çalıştırma kimliği bir kez yazılır. |
| `monitor_state` | Son hash, son alıntı, kontrol ve değişiklik sayaçları. |
| `runs` | `automation_id`, `unattended_policy` eklendi. Kimlik alanları değişmez (`guard_run` genişletildi). |
| `inbox_items` | Uyarı, bildirim ve öneri. `(member_id, dedupe_key)` tekildir; aynı uyarı ya da öneri bir kez düşer. Yalnızca okundu ve çözüldü alanları değişir. |
| Roller | Uygulama rolü yalnızca gereken sütunları güncelleyebilir. Platform rolü okuyabilir ve yalnızca `next_run_at`'i güncelleyebilir (sahiplenme). |

Guard temiz; 5 yeni HINT'in hepsi eşlendi.

## 4. API uç noktaları
| Yöntem | Yol | Not |
|---|---|---|
| GET | `/automations`, `/automations/:id` | Ayrıntıda tetikler, çalıştırmalar, monitor sayaçları |
| POST | `/automations/draft` | Cümleden yapılandırma; kaydetmez |
| POST | `/automations` | Idempotent. Webhook ya da e-posta ise adres ve imza anahtarı bir kez döner |
| PATCH / DELETE | `/automations/:id` | `trusted`'a geçiş `confirmTrusted` ister |
| POST | `/automations/:id/rotate-hook` | Yeni adres ve anahtar; eskisi hemen biter |
| POST | `/automations/:id/run`, `/test` | Idempotent, üye başına 10/dk. `test` kapalıyken de ve günlük tavanın dışında çalışır |
| GET | `/inbox`, `/inbox/count` | |
| POST | `/inbox/read`, `/inbox/items/:id/resolve` | |
| POST | `/inbox/proposals/confirm`, `/discard` | En fazla 50; her biri kendi yolundan |
| POST | `/hooks/:token` | Herkese açık; HMAC imzası, adres başına 120/dk |
| POST | `/hooks/inbound-mail` | Herkese açık; sağlayıcının bearer'ı, adres başına 300/dk |
| GET | `/runs?teamId=&automationId=&status=` | Tüm çalıştırmalar |

## 5. Testler — toplam **941** (F5 sonunda 851; **+90**), hepsi yeşil
| Paket | Test | F6'da eklenen |
|---|---|---|
| api | 576 | otomasyon e2e 38, taslak 22, hook-intake 13, rota ve HINT kontrolleri |
| db | 140 | otomasyonlar 13 |
| teambench / skills / poisonbench | 16 / 72 / 11 | — |
| security / memory / contracts / web | 53 / 42 / 21 / 10 | — |

**Kabul kriterleri (şartname §5):**
1. **09:00 yaz saati geçişinde de 09:00.** Berlin'de yaz saatinin son cumartesi 09:00'u (07:00Z) çalıştı; sonraki çalışma 08:00Z, yani kışın 09:00'u (e2e). DB testleri İstanbul, Berlin ve New York'u ileri ve geri geçişlerde kapsıyor. İstanbul 2016'dan beri yaz saati uygulamıyor; sabit UTC+3'te de 09:00 doğru. ✅
2. **Aynı webhook olayı iki kez gelirse tek çalıştırma.** Aynı teslimat kimliği ikinci kez `duplicate` döndü; kimlik olmadan aynı gövde de tekilleşti. Yalnızca bir tetik, bir çalıştırma ve bir model turu oldu. Aynı zamana iki zamanlayıcı geçişi de tek çalıştırma başlattı. ✅
3. **`safe_only`'de `email_send` asla çalışmaz; öneri Onay Kutusuna düşer.** Gmail bağlı agent'ın otomasyonu e-posta göndermek istedi; hiçbir posta gitmedi ve öneri Onay Kutusunda `danger`, geri alınamaz olarak göründü. Kişi Onay Kutusundan onaylayınca tam bir kez gönderildi. `trusted` altında da gönderilmedi, öneri oldu. ✅
4. **Monitor değişiklik yoksa çalıştırma başlatmaz.** İki kontrolde sayfa aynıydı: tetik yok, çalıştırma yok, sıfır model çağrısı. Fiyat değişince tek çalıştırma başladı; agent önceki ve yeni hâli çitli veri olarak gördü ve çalıştırma `third_party` kaynaklı işaretlendi. ✅
5. **Zincirlerde döngü engellenir.** Birbirini izleyen iki otomasyonun her biri bir kez çalıştı, üçüncü halka "döngü" uyarısıyla reddedildi. Dört halkalı zincirde dördüncü "üçten derin" diye reddedildi. Kendini izleme 409 aldı. ✅
6. **≥80 yeni test:** **90**. ✅

**Tarayıcı doğrulaması (Playwright, geliştirme modeli, gerçek kuyruk):**
- "Every Monday at 9 send me the market report" cümlesi taslağa çevrildi ("every Mon at 09:00") ve kaydedildi.
- Ayrıntı sayfasında "Dene" ile çalıştırma başladı ve çalıştırma sayfasında "Done" oldu.
- Webhook oluşturuldu; adres, e-posta ve imza anahtarı bir kez gösterildi.
- `/app/runs` ve `/app/inbox` açıldı.
- 390 px'te dört sayfada taşma yok, konsol hatası yok.

## 6. Şartnameden sapmalar
- **Migration numarası `0013_automations`.** 0011 ve 0012 önceki fazlara gitti.
- **Ayrı `automation_runs` tablosu yok.** Bağ `runs.automation_id` ve `automation_triggers.run_id` ile kuruluyor; bir tablo daha aynı bilgiyi iki kez tutardı.
- **`suggest` bir otomasyon türü değil.** Saatlik bir geçiş Onay Kutusuna öneri düşürüyor; kişi kabul ederse normal bir otomasyon kuruluyor. Öneri "user model" yerine kişinin son 30 gündeki yinelenen mesajlarından çıkıyor.
- **`channel` ve `file` tetikleri F7'ye kaldı.** Kanallar (Telegram, WhatsApp, Slack) F7'de gelince aynı tetik, kuyruk ve zincir yolunu kullanacak. Kanaldan onay da F7'de.
- **E-posta yalnızca otomasyonun kendi adresiyle geliyor.** Bağlı gelen kutusunda filtre (Gmail izleme) sonraki adım.
- **Monitor farkı hash ile algılanıyor**, anlamsal fark yok. Kişinin koşulu ("2000 TL altına düşerse") agent'a veriliyor; değişikliğin önemli olup olmadığına agent karar veriyor.
- **Bildirim tercihleri otomasyon başına** (Onay Kutusu / e-posta). Ayrı bir genel tercihler sayfası yok.
- **Bildirim zili kenar menüdeki Onay Kutusu öğesinde**, okunmamış sayısıyla. Ayrı bir üst çubuk yok.

## 7. Bilinen sınırlar / teknik borç
- **Canlı modelle otomasyon çalıştırması yapılmadı** (konteyner openrouter.ai'ye erişemiyor). Tüm akışlar deterministik modelle doğrulandı.
- **Gelen e-posta sağlayıcısı kurulmadı.** `in.milyonuse.com` için MX ve sağlayıcının iletme ayarı canlıya çıkışta yapılacak. `INBOUND_MAIL_SECRET` yoksa uç nokta 404 döner.
- **Monitor yalnızca sunucunun döndürdüğü HTML'i okuyor.** JavaScript ile çizilen sayfalar görülmez; tarayıcı tabanlı okuma sonraki bir adım.
- **Öneri sezgisi metni birebir eşleştiriyor.** Aynı isteğin farklı cümlelerle sorulması öneri üretmez.
- **Toplu onay sırayla çalışıyor** (en fazla 50). Uzun bir öneri listesi birkaç saniye sürebilir.
- **Monitor ve zamanlanmış geçiş dakikada en fazla `MONITOR_BATCH` (25) otomasyon alıyor.** Fazlası bir sonraki dakikaya kalır.

## 8. F7'ye devredilenler
- Kanal tetiği (`channel`): Telegram, WhatsApp ve Slack mesajı ya da komutu `AutomationLauncher.accept` ile tetik olur. Dış kaynak oldukları için çalıştırma `third_party` taint'iyle başlar.
- Onay Kutusunun kanaldan onayı: inline buton ve e-posta linki, `/inbox/proposals/confirm` ile aynı yoldan.
- Otomasyon bildirimlerinin kanallara gitmesi: `notify` listesine kanal eklenecek.

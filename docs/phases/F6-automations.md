# F6 — Otomasyonlar (Proaktif ve Reaktif / Deaktif)

**Amaç:** Agent'lar ve takımlar kullanıcı başında olmadan çalışır. Kimi kendi kendine (proaktif), kimi bir olay gelince ya da elle çağrılınca (reaktif / deaktif). Onay gereken her şey Onay Kutusuna ve kanallara düşer.

**Bağımlılık:** F5 · **Kaynak:** App-Milyonus `agent.schedules.ts` (DST-güvenli), `agent.notifications.ts`; Agent 5.5 `cron/schedule.py`, `proactive/*` · **Durum:** ✅ tamamlandı — [teslim raporu](../delivered/F6-delivered.md) (şartnameden sapmalar §6'da)

---

## 1. Otomasyon türleri
| Aile | Tür | Tetik | Örnek |
|---|---|---|---|
| Proaktif | `schedule` | Cron ya da doğal dil ("her pazartesi 09:00") | Haftalık pazar raporu |
| Proaktif | `monitor` | Periyodik kontrol + değişiklik algılama (hash ya da anlamsal fark) | "Bu ürün 2000 TL altına düşerse haber ver" |
| Proaktif | `goal` | Hedefe ulaşana ya da süre dolana kadar periyodik ilerleme | "Bu ay 20 nitelikli lead listesi çıkar" |
| Proaktif | `suggest` | User model + geçmiş run'lardan öneri (kullanıcı onaylarsa otomasyona dönüşür) | "Her cuma bunu soruyorsun, otomatikleştireyim mi?" |
| Reaktif | `webhook` | `POST /api/v1/hooks/:id` (HMAC imzalı) | Form gönderildi → takım işler |
| Reaktif | `email` | Gelen adres `x@in.milyonuse.com` ya da bağlı gelen kutusu filtresi | Fatura geldi → özetle, takvime ekle |
| Reaktif | `channel` | Telegram / WhatsApp / Slack mesajı ya da komutu (F7) | "/rapor" komutu |
| Reaktif | `file` | Dosya yükleme ya da bağlı Drive klasörü | CV klasörüne dosya düştü → analiz |
| Reaktif | `agent_event` | Bir run bitti / başarısız oldu, hafıza terfi etti, başka bir otomasyon | Araştırma bitti → içerik takımı başlar (zincir) |
| Deaktif | `manual` | "Şimdi çalıştır" düğmesi, API, kanal komutu | Kayıtlı iş akışı |

- **Ortak alanlar:** `enabled` (aktif / pasif), hedef (agent ya da takım), girdi şablonu, autonomy politikası (`safe_only` / `trusted`), sessiz saatler, saat dilimi, run başı bütçe, günlük tetik tavanı, hata politikası (yeniden dene / durdur / bildir), bildirim kanalları.

## 2. Motor
- **Tablolar** (`0011_automations.sql`):
  - `automations`
  - `automation_triggers`: tekillik anahtarı ile aynı olay iki kez çalışmaz.
  - `automation_runs`: `runs` tablosuna bağlı.
  - `monitor_state`: son hash ya da gözlem.
  - `inbox_items`
- **Sonraki çalışma zamanı:** SQL'de, saat dilimi ve yaz saati geçişleri hesaba katılarak hesaplanır (App-Milyonus 0063 yöntemi).
- **Zincirleme:** `agent_event` tetikleri döngü korumalıdır (derinlik ≤3, aynı zincirde aynı otomasyon bir kez çalışır).
- **Gözetimsiz güvenlik:**
  - Varsayılan `safe_only`: yalnızca safe tool'lar çalışır, gerisi öneri olur ve Onay Kutusuna düşer.
  - `trusted` yalnızca kullanıcı açarsa geçerlidir; açmak, ayrıntılı bir onay ekranından geçer.
  - Irreversible eylemler her zaman öneri olur.
- **Taint:** Webhook, e-posta ve kanal girdileri her zaman dış kaynaktır (T3), veri çitine sarılır.
- **Hata:** Üst üste 3 hata → otomasyon otomatik pasife geçer ve kullanıcıya bildirim gider.

## 3. Onay Kutusu (Inbox)
- Tüm bekleyen öneriler, takım run'larının `waiting_approval` durumları, hafıza onayları (T4) ve otomasyon uyarıları tek listede toplanır.
- Toplu onaylama ve reddetme; kanaldan onay (F7: Telegram inline buton, Slack buton, e-posta linki).

## 4. Web
- `(app)/automations`: "Yeni otomasyon" sihirbazı (doğal dil → yapılandırma önerisi → kullanıcı düzenler), liste (aktif / pasif anahtar), geçmiş run'lar, sonraki çalışma zamanı, test et.
- `(app)/runs`: Tüm run'lar (sohbet, takım, otomasyon). Filtre ve maliyet.
- `(app)/inbox`: Onay Kutusu.
- Bildirim zili: in-app bildirimler, tercihler.

## 5. Kabul kriterleri
1. İstanbul saat dilimindeki 09:00 zamanlaması yaz saati geçişinde de 09:00'da çalışır (test).
2. Aynı webhook olayı iki kez gelirse tek run çalışır.
3. `safe_only` politikasında `email_send` asla çalışmaz; öneri Onay Kutusuna düşer.
4. Monitor, değişiklik yoksa run başlatmaz (maliyet 0).
5. Zincirleme otomasyonlarda döngü engellenir.
6. ≥80 yeni test.

## 6. Teslim
`docs/delivered/F6-delivered.md`

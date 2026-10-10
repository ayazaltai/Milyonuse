# F4 — Agent Stüdyosu ve Skills

**Amaç:** Kullanıcı kendi uzman agent'larını kurar (ör. "Araştırmacı Ada", "Satış Asistanı Kaan"). Agent'lar deneyimden **skill** öğrenir; ama bir skill ancak tekrar oynatılıp kanıtlandıktan sonra aktif olur.

**Bağımlılık:** F3 · **Kaynak:** Agent 5.5 `skills/*`, `_bundled_skills/`

---

## 1. Agent tanımı (`0009_studio.sql`)
| Alan | Açıklama |
|---|---|
| `name`, `avatar`, `role_title` | Kimlik |
| `persona` | Ton, üslup, dil |
| `instructions` | Sistem talimatları. Org talimatlarının altında, güvenlik kurallarının altında. |
| `model_tier` | fast / balanced / deep |
| `tools` | İzin listesi (tool adları ve bağlantılar) |
| `memory_scope` | Hangi hafızayı okur ve yazar: user / agent / team |
| `autonomy` | ask / auto; gözetimsiz politika: `safe_only` / `trusted` |
| `budget` | Run başına token ve sandbox dakikası tavanı |
| `skills` | Atanmış skill'ler |

- `agent_versions`: Her kayıt değişmez bir anlık görüntüdür. Run'lar hangi sürümle çalıştığını kaydeder.
- **Şablonlar** (seed): Araştırmacı, Yazar / Editör, Veri Analisti, Kişisel Asistan (takvim + e-posta), Pazar İzleyici, Öğretmen, Yazılım Yardımcısı, Seyahat Planlayıcı. Her biri en ve tr.
- Web:
  - `(app)/agents`: galeri, oluştur, düzenle, test et (yan panelde canlı sohbet), sürüm geçmişi.
  - `/agent`'ta agent seçici.

## 2. Skills (prosedürel hafıza)
- `SKILL.md` biçimi: frontmatter (ad, açıklama, tetikleyiciler, gereken tool'lar) + gövde + ekler. Agent 5.5 ile uyumludur.
- 3 seviyeli açılım: seviye 0 dizin (prompt'ta), seviye 1 `SKILL.md`, seviye 2 ek dosyalar (yol kısıtlı).
- 41 hazır skill tek tek incelenir: alakasızlar elenir, kalanlar en ve tr'ye uyarlanır.
- **Kendini geliştirme döngüsü:**
  1. Başarılı, çok adımlı bir run'dan sonra agent `skill_propose` ile bir skill önerir.
  2. Scanner: injection, tehlikeli komut, sır sızıntısı. `danger` kararı hiçbir şekilde geçersiz kılınamaz.
  3. Staging: `skill_versions.state = staging`.
  4. **Replay gate:** Kaynak run'ın görevi, skill ile sandbox'ta yeniden oynatılır. Sonuç değerlendiriciden (model + kural) geçer ve `skill_runs` tablosuna kanıt olarak yazılır. (Agent 5.5'te bu kapı her şeyi kabul ediyordu.)
  5. Promote: kullanıcı onayı ya da `trusted` politikası.
- Skill'in kendi provenance'ı vardır. Revoke edilen bir kaynaktan türeyen skill de düşer.
- Web `(app)/skills`: liste, aç / kapa, kaynağını gör, sürümler, replay kanıtı.

## 3. Kabul kriterleri
1. Bir agent'ın sürümü değişince eski run'lar eski sürümü gösterir.
2. Replay'de başarısız olan skill aktif olamaz.
3. Zehirli bir web sayfasından öğrenilmiş skill, sayfa revoke edilince düşer.
4. ≥60 yeni test.

## 4. Teslim
`docs/delivered/F4-delivered.md`

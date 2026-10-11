# F4 — Agent Stüdyosu ve Skills · Teslim raporu

**Tarih:** 2026-10-11 · **Durum:** tamamlandı · **Şartname:** [F4-agent-studio-skills.md](../phases/F4-agent-studio-skills.md)

---

## 1. Eklenenler (özet)
- **Agent stüdyosu:** Kişi kendi agent'larını kurar: bir şablondan ya da sıfırdan.
  - Kimlik (ad, simge, rol) yerinde değişir.
  - Agent'ın *ne olduğu* her değiştiğinde **yeni bir sürüm** yazılır: persona, talimatlar, model düzeyi, araç izin listesi, hafıza kapsamı, özerklik, gözetimsiz politika, yanıt başına token ve sandbox bütçesi, beceriler.
  - Sürümü veritabanı numaralar; sürüm bir daha değişmez. Hiçbir şey değişmediyse sürüm yazılmaz.
  - Her yanıt, onu yazan sürümü taşır (`agent_messages.agent_version_id`). Eski yanıtlar eski sürümü göstermeye devam eder.
  - Agent silinmez, arşivlenir. Arşivdeki agent yeni tur almaz; konuşmaları kalır.
- **Şablonlar (8, en/tr):** Araştırmacı, Yazar/Editör, Veri Analisti, Kişisel Asistan (takvim + e-posta), Pazar İzleyici, Öğretmen, Yazılım Yardımcısı, Seyahat Planlayıcı.
  - Şablon yalnızca ilk sürüme kopyalanır; sonrasında agent'ı bağlamaz.
  - Şablonun becerileri kişinin kütüphanesine eklenir.
- **Agent'lı bir tur:**
  - **Model:** Turu, agent'ın düzeyindeki (Fast/Balanced/Deep) ilk sunulan model çalıştırır.
  - **Profil:** Ürünün kurallarının *altına* yazılır ve önbelleğe alınan önekin içinde durur. Kişinin metni sunucunun çit işaretlerini taklit edemez.
  - **Araçlar:** Yalnızca sürümün izin verdiği araçlar sunulur. Çekirdek araçlar her zaman vardır (ekleri okumak, hafıza, saat, `present`, beceriler). Bağlı bir uygulama, araç adıyla değil `connection:<sağlayıcı>` ile izin alır. Sandbox dakikası 0 olan agent kod çalıştıramaz.
  - **Özerklik:** `ask` olan agent, besteci Auto dese de Auto modda çalışmaz.
  - **Bütçe:** Yanıt başına token bütçesi, kurulumun tavanını asla aşmaz.
  - **Kendi hafızası:** Agent'ın kendi hafızası varsa (0011), kişinin hafızasını ve kendisininkini okur. İşinden öğrendiğini kendine yazar. Kişinin kendi hakkında söyledikleri kişide kalır.
- **Beceriler (prosedürel hafıza):**
  - **Biçim:** SKILL.md, Agent 5.5 ile uyumlu: `metadata.milyonusagentskill`, eski `metadata.milyonus` ve `requires_toolsets` okunur.
  - **Üç seviye:** Seviye 0, prompt'taki dizindir (ad, açıklama, ne zaman). Seviye 1 `skill_read`, seviye 2 `skill_file` (yol sınırlı).
  - **Kaynaklar:** İncelenmiş katalog (12; bkz. §6), kişinin yazdıkları ve agent'ların `skill_propose` ile önerdikleri.
  - **Tarayıcı:**
    - `danger` hiçbir şekilde kalmaz: yıkıcı komut, indirileni kabuğa bağlamak, sır sızdırmak, yazılmış bir sır, yüksek dereceli injection.
    - `caution` ancak kişi ısrar ederse kalır: ayrıcalık (sudo), kimlik bilgisi okumak, açılışta kalıcılık, gizlenmiş kod. Hiçbir politika onu kendi başına onaylayamaz.
    - Bir beceri doğası gereği talimattır, bu yüzden "imperative" sinyali sayılmaz.
  - **Öğrenilen beceri:** Görevi (turu başlatan mesaj), konuşması ve turun okuduğu her dış kaynakla birlikte `staging`'e girer.
- **Replay kapısı (kalıcı kuyrukta `skill_replay`):**
  - Bekleyen sürüm, kendi görevinde yeniden oynatılır. Turun araçları yalnızca okuyan ve iz bırakmayan araçlardır: hafıza, beceri önerme, kart ve bağlı uygulamalar yok.
  - Sonucu **kurallar** değerlendirir: gerçek yanıt, adım içinde bitmiş olması, araç hataları, sunulmayan araç denemesi, ret ve yanıtta injection.
  - Bir model bağlıysa **model ikinci kez okur.** Kurallar geçse bile model düşürebilir.
  - Karar `skill_runs`'a kanıt olarak eklenir; bu kayıt değiştirilemez.
  - Sürüm ancak geçen bir tekrar oynatma ve onayla `active` olur. Onay kişiden ya da güvenilir (`trusted`) bir agent'ın politikasından gelir; politika yalnızca `clean` beceriyi onaylayabilir.
  - Kuralı veritabanı da uygular. Yeni sürüm onaylanınca eskisi `superseded` olur.
- **Kaynak geri çekilince:** O kaynaktan öğrenilmiş beceri hafızayla aynı işlemde düşer (`revokeSource` → `revokeSkillsFrom`).
- **Web:**
  - `/app/agents`: galeri, şablonlar, sıfırdan oluşturma, arşivle/geri getir.
  - `/app/agents/[id]`: düzenleyici. Seçim kartları, araç ve beceri listeleri, bütçe, sürüm notu. Sürüm geçmişi ve yan panelde canlı **test sohbeti**; test sohbeti her zaman kayıtlı sürümle konuşur.
  - `/app/skills`: kütüphane, katalog, yazma diyaloğu (caution'da "yine de sakla"), Onayla/Reddet/Yeniden oynat. Ayrıntıda tarayıcı bulguları, kaynak (görev, okudukları, konuşma bağlantısı) ve tekrar oynatma kanıtı gösterilir. Bekleyen bir tekrar oynatma varken liste kendini yeniler.
  - `/agent`'ta **agent seçici:** "Kiminle" hapı, `?agent=` ile ön seçim. Seçilen agent'ın düzeyi modeli belirler.
  - Kenar menüde Agents ve Skills etkin. Metinler EN/TR.

## 2. Dosyalar
| Alan | Yol | Kaynak |
|---|---|---|
| Migration | `db/migrations/0010_studio.sql`, `0011_agent_memory.sql` | Yeni |
| DB testleri | `db/src/studio.integration.test.ts` (17) | Yeni |
| Paket | `packages/skills/src/{frontmatter,skill,scanner,catalogue,templates}.ts` (+ `skills.test.ts`) | Agent 5.5 `skills/{model,scanner}.py`, `_bundled_skills/` (incelendi) |
| Contracts | `packages/contracts/src/studio.ts`; `agent.ts` (`agentId`, `agentVersionId`); `memory.ts` (`agentId`) | Yeni / genişletildi |
| Stüdyo modülü | `modules/studio/{studio.store,studio.service,skills.service,skill-replay,replay-evaluator,skill.tools,studio.controller,skills.controller,studio.module}.ts` | Yeni |
| Turn loop | `agent/profile.ts` (yeni), `agent.service.ts`, `agent.store.ts` (`agentProfile`, `skillIndex`), `prompt.ts` (`milyonuse-2026-10.4`, kural 11: Skills, profil bölümü), `tools/tool.ts` (`agent`, `provider`), `development.model.ts` (skill kuralları) | Genişletildi |
| Hafıza | `memory.store.ts` (mercek: `lensOf`, kapsam), `memory.service.ts`, `memory.worker.ts` (birleştirme kapsam içinde), `tools/memory.tools.ts` | Genişletildi |
| Bağlantılar | `connections.service.ts`: her araç `provider` taşır | Genişletildi |
| Web | `(app)/app/agents/{page,studio-gallery}.tsx`, `agents/[agentId]/{page,agent-editor,test-chat}.tsx`, `(app)/app/skills/{page,skills-board}.tsx`, `agent/{agent-console,agent-parts,page}.tsx`, `sidebar.tsx`, i18n `app.studio`, `app.skills`, `tokens.css` | Yeni / genişletildi |
| Testler | `apps/api/src/studio.e2e.test.ts` (24), `modules/agent/profile.test.ts` (13), `modules/studio/replay-evaluator.test.ts` (12) | Yeni |

## 3. Veritabanı
| Tablo | Kurallar ve HINT'ler |
|---|---|
| `agents` | Kişiye özel RLS. Güncel sürüm kendi sürümlerinden biri olmalıdır (`agent_version_foreign`, ertelenmiş kısıt). Silme yetkisi yok; arşiv var. |
| `agent_versions` | Numarayı veritabanı verir; sürüm değişmez ve tek başına silinmez (`agent_version_immutable`). |
| `skills` | Kişi başına benzersiz ad. `bundled`, `user` ya da `learned`. |
| `skill_versions` | Yalnızca katalogdaki beceri `active` girer; diğerleri `staging`. `staging → active` için geçen bir tekrar oynatma (`skill_replay_required`) ve onay gerekir (`skill_approval_required`). `danger` asla `active` olmaz (`skill_danger`). İçerik ve kaynak mühürlüdür (`skill_version_immutable`). Durum yalnızca ileri gider (`skill_transition_invalid`). |
| `skill_runs` | Yalnızca eklenir (`skill_run_immutable`). |
| `memory_items` (0011) | `agent` kapsamlı bir hafıza, kişinin kendi agent'larından birini adlandırmalıdır. `team` kapsamı F5'e kadar reddedilir (`memory_scope_unknown`). |

Guard temiz; 9 yeni HINT'in hepsi eşlendi.

## 4. API uç noktaları (`agents.use`)
| Yöntem | Yol | Not |
|---|---|---|
| GET | `/agents` (`?archived=true`), `/agents/templates` (`?locale=tr`), `/agents/tools`, `/agents/:id`, `/agents/:id/versions` | |
| POST | `/agents` | Idempotent. Şablondan ya da sıfırdan |
| PATCH | `/agents/:id` | Kimlik yerinde; tanım değişirse yeni sürüm |
| POST | `/agents/:id/archive`, `/restore` | |
| GET | `/skills`, `/skills/catalogue`, `/skills/:id` | |
| POST | `/skills/bundled`, `/skills` | Idempotent. Yazılan beceri taranır ve bekletilir |
| PATCH | `/skills/:id` | Aç/kapa |
| POST | `/skills/versions/:id/approve` · `/reject` · `/replay` | |
| POST | `/agent/conversations` | Artık `agentId` alır |

## 5. Testler — toplam **773** (F3 sonunda 631; **+142**), hepsi yeşil
| Paket | Test | F4'te eklenen |
|---|---|---|
| api | 459 | studio e2e 24, profile 13, replay-evaluator 12 ve rota/HINT kontrolleri |
| db | 112 | studio 17 |
| skills | 67 | yeni paket |
| security / memory / poisonbench / contracts / web | 53 / 42 / 9 / 21 / 10 | — |

**Kabul kriterleri (şartname §3):**
1. Agent'ın sürümü değişince eski yanıtlar eski sürümü gösteriyor. e2e'de iki tur arasında persona değişiyor; konuşma görünümü `[v1, v2]` döndürüyor (DB testi de var). ✅
2. Tekrar oynatmada başarısız olan beceri aktif olamıyor. Boş yanıt ya da modelin "geçmedi" demesi başarısızlıktır; onay 409 ile reddediliyor. Veritabanı da `skill_replay_required` ile reddediyor. ✅
3. Bir web sayfasından öğrenilmiş beceri, sayfa geri çekilince düşüyor. `derived_from` sayfanın URL'sini taşıyor; `/memory/revocations` beceri sürümünü `revoked` yapıyor ve onay artık reddediliyor (e2e + DB). ✅
4. ≥60 yeni test: **142**. ✅

**Bulunup düzeltilen gerçek hatalar:**
- **`ulid[]` dizisi metin olarak geliyordu.** node-pg, domain tipinin dizisini çözemiyor. Agent sürümünün `skills` alanı `"{…}"` dizgesi olarak dönüyor ve her düzenlemeyi 422 ile düşürüyordu. Sorguda `::text[]` ile düzeltildi.
- **zod 4 `.partial()` varsayılanları dolduruyordu.** Bir alanı değiştiren PATCH, diğer bütün alanları varsayılana sıfırlayacaktı. Varsayılansız alan şeması (`agentDefinitionPatchSchema`) eklendi.
- **Tarayıcıda `caution` hiç oluşmuyordu.** "imperative" atlanınca orta dereceli sinyal kalmamıştı. Gerçek caution kalıpları eklendi.
- **Kenar menü:** `/app/agents` sayfasında hem "Agent" hem "Agents" etkin görünüyordu; eşleşme artık tam segmentle yapılıyor. `Checkbox` bileşeninin sınıfları (`checkline`, `check`) daha önce hiç biçimlenmemişti; biçimlendi.

**Tarayıcı doğrulaması (Playwright, geliştirme modeli, gerçek kuyruk):**
- Galeri → Araştırmacı şablonu → düzenleyici "Created". Persona değişince "Saved as version 2"; tekrar kaydedince "Nothing changed".
- Test sohbeti yanıt verdi.
- Becerilerde katalogdan ekleme ve SKILL.md yazma çalıştı. Bekletilen beceri kuyrukta gerçekten tekrar oynatıldı, Onayla düğmesi çıktı ve onaylandı. Ayrıntıda kanıt görünüyor.
- `rm -rf /` içeren beceri "danger: a destructive command" ile reddedildi.
- `/app/agent?agent=…` "With 🔎 Ada" hapını gösterdi.
- 390 px'te üç sayfada da taşma yok. Konsoldaki iki hata beklenen: reddin 422'si ve bu fazdan önce de olan `/favicon.ico` 404'ü.

## 6. 41 hazır becerinin incelemesi
Agent 5.5'in `_bundled_skills/` klasöründeki 41 beceri tek tek okundu.
- **16'sı tutuldu.** Bu ürünün araçlarına (web, sandbox'ta Python, dosya, belge okuma, e-posta ve takvim bağlantıları) göre yeniden yazılıp **12 beceride** birleştirildi.
- **Biri yeni yazıldı** (`meeting-scheduling`).
- **25'i elendi.** Agent'a terminal, sunucu ya da bulut erişimi verilmiyor; bu beceriler öğretecek araç olmadan yalnızca gürültü olurdu.

| Milyonuse becerisi | Agent 5.5 kaynağı | Karar |
|---|---|---|
| `cold-email` | cold-email | Uyarlandı (gönderim her zaman kart) |
| `outreach-sequence` | outreach-sequencing, linkedin-outreach | Birleştirildi |
| `lead-research` | lead-generation | Uyarlandı (yalnızca açık kaynak) |
| `email-deliverability` | email-deliverability | Uyarlandı |
| `data-analysis` | pandas-data, csv-data, jq-json, sqlite-basics | Birleştirildi (sandbox'ta Python) |
| `pdf-tables` | pdf-extract | Uyarlandı (`read_document` + sandbox) |
| `web-research` | web-scraping, rag-retrieval | Birleştirildi (`web_search` / `web_fetch` / `deep_research`; kazıma yok) |
| `text-extraction` | regex-guide | Uyarlandı |
| `clear-documents` | markdown-docs | Uyarlandı |
| `prompt-design` | prompt-engineering | Uyarlandı (ürün kuralları her zaman üstte) |
| `debugging` | debugging | Uyarlandı (`code_run` ile kanıt) |
| `meeting-scheduling` | — | Yeni |

**Elenenler (25):** aws-cli, bash-scripting, cron-scheduling, docker-basics, docker-compose, env-secrets, fastapi, ffmpeg-media, git-workflow, github-actions, github-cli, http-curl, imagemagick, kubernetes-kubectl, observability, playwright, postgres-psql, pytest-testing, python-uv, ripgrep-search, security-audit, ssh-remote, systemd-services, tar-archive, terraform.

Neden: hepsi bir kabuk, sunucu ya da bulut hesabı varsayıyor. `env-secrets` ve `security-audit` gibi bazıları sırları okumayı öğretiyor ve yeni tarayıcının caution/danger kalıplarına takılırdı. `playwright` ise F3'te ertelenen tarayıcı aracını gerektiriyor.

Katalogdaki her beceri testte ayrıştırılıyor ve `clean` taranıyor: katalog becerisi doğrudan `active` girdiği için içinde hiçbir bulgu olamaz.

## 7. Şartnameden sapmalar
- **Migration numaraları `0010_studio` ve `0011_agent_memory`:** Şartname `0009_studio` diyordu; 0009 F3'e gitti. 0011, agent kapsamlı hafızanın anahtarını ekler. 0010 önceki adımda push edildiği için değiştirilmedi (kural 6).
- **`memory_scope = team` yok.** Takımlar F5'te; 0011 bu kapsamı o zamana kadar reddeder.
- **Sandbox dakikası tek tek ölçülmüyor.** Yanıt başına bütçe şöyle uygulanıyor: 0 dakika kod aracını tamamen kaldırır. Kişinin günlük sandbox kotası (F3) zaten geçerli. Çalıştırma başına dakika sayacı, gözetimsiz çalışmalarla F6'da gelecek: orada anlamı var, çünkü onaylı bir eylem turun dışında çalışıyor.
- **Tekrar oynatma "sandbox'ta" değil, okuma-yalnız bir turda yapılıyor.** Beceri kod gerektiriyorsa `code_run` yine teklif edilmiyor, çünkü riski `caution` ve tekrar oynatma onay kartı açamaz. Kurallar bu durumu "sunulmayan araç denemesi" olarak not eder, başarısızlık saymaz. Agent'tan, yapacağını yazıya dökmesi istenir.
- **Becerilerin `db/seeds/skills/` tohumları yok.** Katalog `packages/skills` içinde koddur. Kişi ekledikçe kütüphanesine kopyalanır (şablonlar da aynı şekilde).
- **Test sohbeti akışsız.** Tek istekli `/messages` uç noktasını kullanır. Eylem önerirse "Agent'ta aç" bağlantısı verir; kartlar orada onaylanır.

## 8. Bilinen sınırlar / teknik borç
- **Model ikinci okuması canlı bir modelle denenmedi.** Bu konteyner openrouter.ai'ye erişemiyor. Kurallar ve sahte modelle (geçti/geçmedi) uçtan uca test edildi. Geliştirme modeli kural tabanlı olduğu için yerelde yalnızca kurallar değerlendirir.
- **Agent kapsamlı hafızanın birleştirmesi** yalnızca kendi kapsamında yapılıyor. Kişinin hafızasıyla agent'ın hafızası arasındaki çelişki işaretlenmez.
- **Agent seçici yalnızca yeni konuşmada.** Var olan bir konuşmanın agent'ı değiştirilemez; bu bilinçli bir tercih, çünkü yanıtların sürüm geçmişi tutarlı kalmalı.
- **Kural tarayıcısının yanlış pozitifleri** (F2'den beri): "sudo" kelimesini anlatan zararsız bir metin de caution olur. Kişi "yine de sakla" ile geçebilir.

## 9. F5'e devredilenler
- `AgentProfile` / `turnAgentOf`: takımdaki her üye bir agent sürümüyle çalışacak. Profil, araç süzgeci ve bütçe hazır.
- `memory_scope = team` ve `scope_ref`: 0011'deki tetikleyiciye takım dalı eklenecek.
- `unattendedPolicy` artık agent sürümünde. F6 otomasyonları RiskEngine'e `unattended: { policy }` olarak bunu verecek.

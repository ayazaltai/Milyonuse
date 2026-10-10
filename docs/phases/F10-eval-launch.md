# F10 — Değerlendirme ve Yayın

**Amaç:** Ölçülmüş kalite, ölçülmüş güvenlik, kontrollü yayın.

**Bağımlılık:** F0–F9

---

## 1. Değerlendirmeler
| Bench | İçerik | Hedef |
|---|---|---|
| **PoisonBench** (live) | Tek seferlik korpus (held-out) + 14+ çok adımlı senaryo + takım senaryoları | ASR %0 · meşru terfi %100 |
| **TaskBench** | 40 tek-agent görevi (araştırma, yazı, veri, dosya, tarayıcı) — Agent 5.5 `evaluation/` portu + genişletme | ≥ %85 başarı |
| **TeamBench** | 20 takım görevi (DAG, paralel, revizyon) | ≥ %80 başarı |
| **AutomationBench** | Zamanlama, yaz saati geçişi, tekillik, zincir, sessiz saatler | %100 |
| **Cost** | Görev başına kredi, p50 ve p95 | Plan fiyatlarıyla tutarlı |

- Sonuçlar `evals/results/<tarih>.json` dosyasına yazılır. Prompt sürümü ve model kayıtlarına bağlanır.

## 2. Sağlamlaştırma
- Yük testi: 500 eşzamanlı sohbet, 50 eşzamanlı takım run'ı (k6 ya da autocannon).
- Güvenlik incelemesi:
  - OWASP ASVS L2 kontrol listesi.
  - Prompt injection kırmızı takım günü.
  - Bağımlılık denetimi.
  - Sır taraması.
- Felaket kurtarma: Neon PITR geri yükleme tatbikatı.
- Erişilebilirlik denetimi (WCAG 2.2 AA).

## 3. Yayın
- Önizleme → kapalı beta (davet kodu) → açık beta → genel kullanıma açılış.
- Feature flag'ler (Vercel Edge Config).
- Durum sayfası; destek kanalı; yasal metinlerin son hâli (KVKK aydınlatma metni, açık rıza, ABD gizlilik metni).
- Analitik (onaya bağlı): kayıt → ilk görev → ilk takım → ilk otomasyon → ödeme hunisi.

## 4. Teslim
`docs/delivered/F10-delivered.md` + `docs/LAUNCH.md` (runbook).

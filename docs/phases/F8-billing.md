# F8 — Abonelik, Ödeme ve Onboarding

**Amaç:** Türkiye'de TL, ABD'de USD ile abonelik satılır. Kullanım krediyle ölçülür. Yeni kullanıcı 3 dakikada ilk takımını kurar.

**Bağımlılık:** F1 (ölçüm), F6 (plan özellikleri) · **Kaynak:** App-Milyonus `usage/*` modeli

---

## 1. Planlar (taslak — D-16)
| Plan | Fiyat (taslak) | Agent | Takım | Otomasyon | Kanal | Kredi / ay | Sandbox dk / ay |
|---|---|---|---|---|---|---|---|
| Free | 0 | 1 | — | 2 (yalnızca manuel ve schedule) | 1 | düşük | 0 |
| Pro | $20 / ₺ (yerel fiyat) | sınırsız | 3 | 25 | tümü | orta | 120 |
| Team Pro | $60 / ₺ | sınırsız | 15 | 100 | tümü | yüksek | 600 |

- Kesin fiyatlar, OpenRouter maliyet ölçümlerine göre (F1–F6 verisi) belirlenir.

## 2. Kapsam
- **Tablolar** (`0012_billing.sql`):
  - `plans`
  - `subscriptions`: durum makinesi trialing / active / past_due / canceled.
  - `billing_customers`
  - `billing_events`: sağlayıcı olayları, tekillik.
  - `credit_ledger`: **yalnızca ekleme**; bakiye SQL'de hesaplanır; negatife düşmesi tetikleyiciyle engellenir.
- **Kredi:** Model maliyeti (OpenRouter `usage.cost`) + sandbox dakikaları + embedding maliyeti → krediye çevrilir. Run öncesinde rezerve edilir, sonrasında kesinleştirilir (App-Milyonus `reserve_credits` yaklaşımı).
- **Ödeme:**
  - Stripe Checkout + Customer Portal + webhook (USD).
  - iyzico Abonelik API + webhook (TRY).
  - Sağlayıcı seçimi ülke ve para birimine göre yapılır. Her iki sağlayıcı da `PaymentPort` arkasındadır.
- **Kotalar:** Plan özellikleri SQL'de kontrol edilir (agent, takım ve otomasyon sayısı tetikleyicilerle). Aşımda açık bir hata ve "Yükselt" CTA'sı gösterilir.
- **Onboarding:** İlk girişte 3 soru (amaç, dil, ilgi alanı), önerilen takım şablonu, ilk görev ve ilk otomasyon önerisi.
- **Google ile giriş** (D-14).
- Fatura ve e-fatura (TR) entegrasyonu için ayrı karar: F8 başında.

## 3. Web
`(marketing)/pricing` gerçek planlar; `(app)/settings/billing`: plan, kullanım grafiği, faturalar, yükselt / düşür / iptal.

## 4. Kabul kriterleri
1. Aynı Stripe olayı iki kez gelirse tek kez işlenir.
2. Kredi bakiyesi eşzamanlı run'larda negatife düşmez (eşzamanlılık testi).
3. `past_due` aboneliği otomasyonları duraklatır, sohbeti Free sınırına indirir.
4. ≥50 yeni test.

## 5. Teslim
`docs/delivered/F8-delivered.md`

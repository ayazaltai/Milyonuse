# Delivery reports

Her faz kapanırken buraya `FX-delivered.md` yazılır. Rapor şablonu:

```markdown
# FX — <ad> · Teslim raporu

**Tarih:** YYYY-MM-DD · **Commit:** <sha> · **Durum:** tamamlandı / kısmi

## 1. Eklenenler (özet)
## 2. Dosyalar (yeni / değişen, alan alan)
## 3. Veritabanı (migration'lar, tablolar, tetikleyiciler, HINT'ler)
## 4. API uç noktaları
## 5. Web sayfaları
## 6. Testler (sayı, kapsam, nasıl çalıştırılır)
## 7. Şartnameden sapmalar ve gerekçeleri
## 8. Bilinen sınırlar / teknik borç
## 9. Sonraki faza devredilenler
## 10. Doğrulama (komutlar ve çıktılar)
```

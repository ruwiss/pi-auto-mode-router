# Auto Mode Router

Pi için geliştirilen bu eklenti, `/model` menüsüne **Auto Mode** isminde sanal bir model ekler.

Auto Mode seçildiğinde her yeni prompt için şu akış çalışır:

1. Prompt önce seçtiğiniz **analiz modeline** gönderilir.
2. Analiz sonucu promptun baskın olarak:
   - **frontend / UI tasarımı** mı
   - **logic / mantık** mı
   - **terminal / tek komut işi** mi
   olduğunu belirler.
3. Eklenti terminalde seçilen hedef modeli bildirir.
4. İstek o tur için ilgili hedef modele yönlendirilir.
5. Tur bitince aktif model tekrar **Auto Mode** durumuna döner.

## Neleri destekler?

- `/model` içinden seçilebilen sanal **Auto Mode** modeli
- `/auto-mode` ve `/auto` komutları
- Analiz modeli, frontend modeli ve logic modeli için tek ekranda çalışan overlay seçim diyaloğu
- Enter/Space ile açılan, tüm modelleri gösteren aramalı hızlı model picker
- Mevcut provider'lardan erişilebilir modellerin listelenmesi
- Her prompt için yeniden yönlendirme
- Tek başına terminal / git komutu isteklerinde analiz modelini doğrudan çalışma modeli olarak kullanma
- Footer status alanında `auto:armed`, `auto:frontend`, `auto:logic`, `auto:terminal` göstergeleri
- Global konfigürasyon dosyası: `~/.pi/agent/auto-mode-router.json`

## Komutlar

- `/auto-mode` → menü açar
- `/auto-mode on` → Auto Mode'u etkinleştirir
- `/auto-mode off` → Auto Mode'u kapatır
- `/auto-mode status` → mevcut durumu gösterir
- `/auto-mode config` → model seçimlerini değiştirir
- `/auto` → kısa alias

## Kurulum / kullanım

Eklenti global auto-discovery yoluna konulduğu için genelde sadece:

```bash
/reload
```

çalıştırmanız yeterlidir.

Sonra:

1. `/auto-mode config` ile overlay diyaloğunu açın
2. `↑↓` ile satır seçin, `Enter` veya `Space` ile aramalı model görünümünü açın
3. Model görünümünde yazmaya başlayarak filtreleyin, `↑↓` ile gezin, `Enter` ile seçin
4. Ana ekranda `Ctrl+S` ile kaydedin
5. `/model` içinden `auto/mode` seçin
6. Normal şekilde prompt yazmaya devam edin

## Mimari notlar

Bu eklenti pi dökümantasyonundaki şu mekanizmaları kullanır:

- `registerProvider()` ile sanal `auto/mode` modeli ekleme
- `model_select` ile Auto Mode aktivasyonu ve manuel moda dönüş
- `before_agent_start` ile prompt analizi ve tur bazlı model yönlendirme
- `agent_end` ile tekrar Auto Mode modeline geri dönüş
- `ctx.ui.custom()`, `SettingsList` ve `ctx.ui.notify()` ile tek ekranlı dialog / bildirim akışı
- `@mariozechner/pi-ai` içinden `complete()` ile analiz modeline hafif sınıflandırma çağrısı

## Not

Auto Mode yalnızca seçili analiz ve hedef modeller için kimlik bilgileri mevcutsa anlamlı çalışır. Model seçim ekranında bu yüzden sadece erişilebilir modeller gösterilir.

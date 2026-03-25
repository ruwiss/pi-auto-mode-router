# Auto Mode Router v2

Pi için geliştirilen bu eklenti, `/model` menüsüne **Auto Mode** isminde sanal bir model ekler.

## Yenilikler (v2)

### 🔄 Mid-Turn Model Geçişi
Artık tek bir prompt içinde hem tasarım hem logic çalışması gerektiğinde, model **çalışma sırasında** otomatik olarak değişir:

- **Dosya bazlı geçiş**: `.css`, `.html` gibi dosyalar yazılırken frontend modeline, `.ts`, `.py` gibi dosyalar yazılırken logic modeline otomatik geçiş yapılır
- **Tool bazlı geçiş**: Model, `switch_domain` tool'unu kullanarak kendi kararıyla domain değiştirebilir
- **Faz yönetimi**: Çoklu domain görevler alt görevlere (faz) ayrılır ve sırayla işlenir

### 📋 Görev Parçalama (Task Decomposition)
Analiz modeli artık "hem UI hem logic gerekiyor" durumunu tespit edip alt görevlere ayırır:

```
Prompt: "Bir todo uygulaması yap. Modern UI tasarla ve CRUD API'lerini implement et"

Analiz sonucu:
  Faz 1: [logic] CRUD API ve state yönetimi
  Faz 2: [frontend] Modern UI tasarımı ve styling
```

### 🤖 switch_domain Tool
Model, görev sırasında uzmanlık alanını değiştirmek istediğinde bu tool'u çağırır:

```
switch_domain({ domain: "frontend", reason: "API tamamlandı, şimdi UI tasarımına geçiyorum" })
```

## Nasıl Çalışır?

Auto Mode seçildiğinde her yeni prompt için şu akış çalışır:

1. Prompt önce seçtiğiniz **analiz modeline** gönderilir
2. Analiz sonucu promptun:
   - **Tek domain** mi (sadece frontend veya sadece logic)
   - **Çoklu domain** mi (hem frontend hem logic)
   olduğunu belirler
3. Tek domain ise: Uygun model seçilir ve görev başlar
4. Çoklu domain ise:
   - Alt görevler (fazlar) belirlenir
   - İlk fazın modeli seçilir
   - System prompt'a faz bilgileri ve geçiş talimatları eklenir
   - Model, `switch_domain` tool'u ile fazlar arası geçiş yapar
   - Dosya yazma/düzenleme sırasında dosya tipine göre otomatik geçiş de yapılır
5. Tur bitince durum güncellenir

## Desteklenen Özellikler

- `/model` içinden seçilebilen sanal **Auto Mode** modeli
- `/auto-mode` ve `/auto` komutları
- Analiz modeli, frontend modeli ve logic modeli için overlay seçim diyaloğu
- **Mid-Turn Geçiş** ayarı (açılıp kapatılabilir)
- Enter/Space ile açılan, tüm modelleri gösteren aramalı hızlı model picker
- Mevcut provider'lardan erişilebilir modellerin listelenmesi
- Her prompt için yeniden yönlendirme
- **Çoklu domain görev tespit ve parçalama**
- **`switch_domain` tool ile model-kararı domain geçişi**
- **Dosya uzantısına göre otomatik mid-turn geçiş**
- **Faz takibi ve ilerleme raporlama**
- Tek başına terminal / git komutu isteklerinde analiz modelini doğrudan kullanma
- Footer status alanında `auto:armed`, `auto:frontend`, `auto:logic`, `auto:terminal`, `auto:frontend [1/3]` göstergeleri
- Global konfigürasyon dosyası: `~/.pi/agent/auto-mode-router.json`
- Güvenlik: turda maksimum 6 mid-turn geçiş limiti

## Komutlar

- `/auto-mode` → menü açar
- `/auto-mode on` → Auto Mode'u etkinleştirir
- `/auto-mode off` → Auto Mode'u kapatır
- `/auto-mode status` → mevcut durumu gösterir (faz bilgileri dahil)
- `/auto-mode config` → model seçimlerini ve mid-turn ayarını değiştirir
- `/auto` → kısa alias
- `Alt+A` → Auto Mode aç/kapat (toggle)

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
4. **Mid-Turn Geçiş** ayarını açık/kapalı olarak seçin
5. Ana ekranda `Ctrl+S` ile kaydedin
6. `/model` içinden `auto/mode` seçin
7. Normal şekilde prompt yazmaya devam edin

## Dosya Domain Haritası

### Frontend olarak tanınan dosyalar
- `.css`, `.scss`, `.sass`, `.less`, `.styl` (stil dosyaları)
- `.html`, `.htm`, `.svg` (markup)
- Yol içinde `/styles/`, `/css/`, `/assets/`, `/theme`, `/components/ui/` geçen dosyalar

### Logic olarak tanınan dosyalar
- `.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.cs`, `.cpp`, `.c`, `.h`
- `.sql`, `.graphql`, `.json`, `.yaml`, `.toml`
- `.test.ts`, `.spec.ts` (test dosyaları)
- Yol içinde `/api/`, `/server/`, `/lib/`, `/utils/`, `/services/`, `/__tests__/` geçen dosyalar

### Karışık (Mixed) dosyalar — geçiş yapılmaz
- `.jsx`, `.tsx`, `.vue`, `.svelte` (hem UI hem logic içerebilirler)

## Örnek Senaryo

```
Kullanıcı: "Bir kullanıcı profil sayfası yap. Backend'de profil API'si olsun, 
            frontend'de modern bir kart tasarımı olsun"

Auto Mode akışı:
1. Analiz → Çoklu domain tespit edildi
2. Fazlar belirlendi:
   - Faz 1: [logic] Profil API endpoint'i ve veri modeli
   - Faz 2: [frontend] Profil kartı UI tasarımı
3. Logic model (ör: Claude Sonnet) ile API yazılır
4. Model switch_domain("frontend", "API tamamlandı, UI tasarımına geçiyorum") çağırır
5. Frontend model (ör: Gemini) ile UI tasarlanır
6. Status bar: auto:logic [1/2] → auto:frontend [2/2] → ✅ Tüm fazlar tamamlandı
```

## Mimari Notlar

Bu eklenti pi dokümantasyonundaki şu mekanizmaları kullanır:

- `registerProvider()` ile sanal `auto/mode` modeli ekleme
- `registerTool()` ile `switch_domain` tool kaydı
- `model_select` ile Auto Mode aktivasyonu ve manuel moda dönüş
- `input` event ile prompt analizi ve çoklu domain tespit
- `before_agent_start` ile system prompt'a faz talimatları ekleme
- `tool_call` event ile dosya tipine göre mid-turn otomatik geçiş
- `agent_end` ile faz durumu raporlama ve temizlik
- `ctx.ui.custom()`, `SettingsList` ve `ctx.ui.notify()` ile dialog / bildirim akışı
- `@mariozechner/pi-ai` içinden `complete()` ile analiz modeline sınıflandırma çağrısı
- `StringEnum` ile Google uyumlu enum parametreleri

## Not

- Auto Mode yalnızca seçili analiz ve hedef modeller için kimlik bilgileri mevcutsa anlamlı çalışır
- Mid-turn geçiş limiti turda maksimum 6 geçiş ile sınırlıdır (sonsuz döngü koruması)
- Mixed dosyalar (.tsx, .vue vb.) için otomatik dosya-bazlı geçiş yapılmaz; model switch_domain tool'unu kullanabilir
- Konfigürasyon v1'den v2'ye otomatik uyumludur, mevcut ayarlar korunur

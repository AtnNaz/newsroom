# Newsroom

Kendi sunucunuzda çalışan kişisel haber odası. Seçtiğiniz RSS/Atom kaynaklarını toplar, her haberi **yerel bir dil modeliyle ([Ollama](https://ollama.com))** okuyup özetler, başlığı dilinize çevirir, konusunu belirler ve **ilgi alanlarınıza göre** puanlar. Aynı olayı veren haberleri tek başlık altında birleştirir; her sabah en önemli haberlerden bir **günlük özet** hazırlar ve isterseniz e-postayla gönderir.

Geliştirici: [Ali Toprak Naz](https://github.com/AtnNaz) · Lisans: [PolyForm Noncommercial 1.0.0](LICENSE) (kişisel kullanım serbest, ticari kullanım izne tabi)

*A self-hosted news briefing: collects RSS/Atom feeds, summarizes and translates every story with a local LLM via Ollama, ranks by your interests, merges duplicate coverage and sends a daily digest by email. Turkish and English UI. Zero npm dependencies.*

- **Bugün:** günün özeti gazete düzeninde; modelin yazdığı kısa bir giriş paragrafı, ardından konulara göre bölümlenmiş en önemli olaylar. Önceki günlerin özetleri arşivde kalır.
- **Akış:** son haberler önem sırasına ya da yeniliğe göre; konuya göre süzme ve arama. Aynı olayı veren kaynaklar tek kartta "3 kaynak" olarak görünür.
- **Okuyucu:** çevrilmiş başlık, özet, etiketler, sayfadan çıkarılmış tam metin, olayı veren diğer kaynaklar ve haberin neden üstte olduğu (ilgi puanı, konu tercihi, kaynak sayısı, yaş).
- **Öğrenen sıralama:** ▲ / ▼ ile verdiğiniz geri bildirim ve kaydettiğiniz haberler, ilgili konu ve kaynakları sonraki sıralamalarda öne çıkarır ya da geri plana atar.
- **E-posta:** günlük özet istediğiniz saatte SMTP ile gönderilir (STARTTLS / TLS, tek dosyalık sade HTML).
- **Kaynaklar:** besleme adresi ya da yalnızca sitenin ana sayfası yeterli, besleme kendiliğinden bulunur. OPML içe/dışa aktarma. Kısa giriş veren beslemelerde haberin tam metni sayfadan çıkarılır.
- **Gizlilik:** haberler yalnızca sizin Ollama sunucunuza gönderilir; hiçbir bulut servisi, takip ya da analitik yoktur.

Hiçbir npm paketine ihtiyaç duymaz; yalnızca Node.js'in kendi modüllerini kullanır (veritabanı için yerleşik `node:sqlite`).

## Nasıl çalışır

```
kaynaklar ──► indir (ETag/Last-Modified) ──► yeni haberler ──► tam metin (sayfadan)
                                                                     │
günlük özet ◄── sıralama ◄── kümeleme ◄── Ollama: başlık, özet, konu, etiket, ilgi puanı
    │
    └──► web arayüzü · e-posta
```

1. Kaynaklar belirlediğiniz aralıkla (15 dk – 4 saat) yenilenir; değişmeyen beslemeler indirilmez.
2. Beslemede yalnızca kısa bir giriş varsa haber sayfası indirilip ana metin çıkarılır.
3. Model her haber için şemaya uygun JSON döndürür: başlık, 2-3 cümlelik özet, konu (18 sabit konudan biri), etiketler ve **her ilgi alanınız için ayrı ayrı 0-10 puan**. Haberin ilgi puanı en iyi eşleşmeden hesaplanır.
4. Aynı olayı anlatan haberler 48 saatlik pencerede birleştirilir: benzerlik modeli seçiliyse vektör benzerliğiyle, değilse çevrilmiş başlık ve etiketlerin örtüşmesiyle.
5. Sıralama puanı = ilgi puanı + geri bildirimden öğrenilen konu/kaynak eğilimi + olayı veren kaynak sayısı − haberin yaşı.
6. Özet saatinde son 24 saatin en yüksek puanlı olayları seçilir; kuyrukta bekleyen haber varsa en fazla 30 dakika beklenir.

## Gereksinimler

- Linux ya da macOS; sunucu kurulumu için systemd kullanan bir Linux dağıtımı veya Docker
- Node.js **22.13 veya üstü** (`node -v`)
- Ollama ve en az bir sohbet modeli (bkz. [Model seçimi](#model-seçimi)). Model olmadan da çalışır; o zaman özetler beslemenin kendi metninden alınır ve sıralama yalnızca yenilik ve geri bildirime dayanır.

## Kurulum

### Sunucuya (systemd)

```bash
git clone https://github.com/AtnNaz/newsroom.git
cd newsroom
sudo ./deploy/install.sh
```

Betik `newsroom` adında ayrıcalıksız bir sistem kullanıcısı oluşturur, uygulamayı `/opt/newsroom` klasörüne, ayarları `/etc/newsroom/config.json` dosyasına, veritabanını `/var/lib/newsroom` klasörüne koyar, sizden giriş şifresi ister ve servisi başlatır. Arayüz `http://sunucu-adresi:8077` adresinde açılır.

Güncellemek için:

```bash
cd newsroom && git pull && sudo ./deploy/install.sh
```

Servis kayıtları: `journalctl -u newsroom -f`

### Docker

```bash
git clone https://github.com/AtnNaz/newsroom.git
cd newsroom
echo "NEWSROOM_PASSWORD=uzun-bir-sifre" > .env
docker compose up -d
```

Ollama aynı makinede çalışıyorsa konteynerden `host.docker.internal:11434` adresiyle ulaşılır; bunun için Ollama'nın yalnızca 127.0.0.1'i değil bütün arayüzleri dinlemesi gerekir (`OLLAMA_HOST=0.0.0.0`). Ollama'yı da konteynerde çalıştırmak için `docker-compose.yml` içindeki `ollama` bölümünü açın.

### Elle

```bash
git clone https://github.com/AtnNaz/newsroom.git
cd newsroom
cp config.example.json config.json
npm start
```

`127.0.0.1` adresinde şifresiz açılır (yalnızca bu makineden erişilebilir). Başka cihazlardan erişmek için `config.json` içinde `"host": "0.0.0.0"` yapın ve önce `node bin/newsroom.js password` ile şifre belirleyin; şifre yoksa sunucu dış adreste başlamayı reddeder.

## İlk adımlar

1. **Kaynaklar** sayfasından besleme ekleyin (önerilenlerden birine tıklamak da olur) ya da elinizdeki OPML dosyasını içe aktarın.
2. **Ayarlar → Yapay zekâ** bölümünden analiz modelini seçin.
3. **Ayarlar → Okuma** bölümüne ilgi alanlarınızı her satıra bir konu olacak şekilde yazın; ne kadar belirgin olursa puanlar o kadar isabetli olur ("teknoloji" yerine "yerel LLM modelleri", "ev sunucuları ve Linux" gibi).
4. Birkaç dakika içinde Akış dolmaya başlar; analiz durumu sayfanın altındaki satırda görünür.

İlgi alanlarını ya da dili sonradan değiştirirseniz Ayarlar'daki **Son 2 günün haberlerini yeniden analiz et** düğmesiyle eski haberler yeni ölçüte göre puanlanır.

## Model seçimi

Her haber bir kez analiz edilir; günde birkaç yüz haber için orta sınıf bir ekran kartı yeterlidir.

| Model boyutu | Örnek | Hız (8 GB ekran kartı, haber başına) | Not |
|---|---|---|---|
| 3-4B | `qwen3:4b` | ~2-3 sn | Özet ve çeviri iyi; ilgi puanları dağınık olabilir |
| 7-12B | `gemma3:12b`, `qwen3:8b` | ~7-10 sn | **Önerilen.** Puanlar tutarlı, alakasız haberler 0 alır |
| 14B+ | `qwen3:14b` | ~15 sn+ | Daha iyi Türkçe, 8 GB belleğe sığmayabilir |

İsteğe bağlı **benzerlik modeli** aynı olayı farklı kelimelerle ya da farklı dillerde anlatan haberleri daha iyi birleştirir. Önerilen model çok dilli `bge-m3`'tür (1,2 GB); birleştirme eşiği onunla ölçülerek belirlendi:

```bash
ollama pull bge-m3
```

Düşünen (reasoning) modellerde düşünme kapatılarak çalıştırılır; destekleri yoksa istek kendiliğinden düşünme alanı olmadan tekrarlanır.

## E-posta

Ayarlar → E-posta bölümüne SMTP bilgilerinizi girip **Deneme e-postası gönder** ile denetleyin. Çoğu sağlayıcı için:

| Sağlayıcı | Sunucu | Port / güvenlik | Not |
|---|---|---|---|
| Gmail | `smtp.gmail.com` | 587 / STARTTLS | Hesap şifresi değil, [uygulama şifresi](https://myaccount.google.com/apppasswords) |
| Outlook / Hotmail | `smtp-mail.outlook.com` | 587 / STARTTLS | |
| Yandex | `smtp.yandex.com` | 465 / TLS | Uygulama şifresi |

SMTP şifresi veritabanında saklanır ve arayüze hiçbir zaman geri gönderilmez. STARTTLS seçiliyken sunucu şifrelemeyi desteklemiyorsa şifre gönderilmeden bağlantı kesilir.

## Ayarlar

Okuma tercihleri (dil, ilgi alanları, modeller, yenileme sıklığı, özet saati, e-posta) arayüzden değişir ve veritabanında durur. Kurulum ayarları `config.json` dosyasında ya da ortam değişkenlerindedir:

| Alan | Ortam değişkeni | Varsayılan | Açıklama |
|---|---|---|---|
| `host` | `NEWSROOM_HOST` | `127.0.0.1` | Dinlenecek adres |
| `port` | `NEWSROOM_PORT` | `8077` | |
| `dataDir` | `NEWSROOM_DATA_DIR` | `./data` | Veritabanı klasörü (ayar dosyasına göre) |
| `ollamaUrl` | `OLLAMA_URL` | `http://127.0.0.1:11434` | |
| `baseUrl` | `NEWSROOM_BASE_URL` | — | E-postadaki "Newsroom'da aç" bağlantısı |
| `passwordHash` | `NEWSROOM_PASSWORD_HASH` | — | scrypt özeti; `NEWSROOM_PASSWORD` düz şifreyi ortamdan alır |
| `trustProxy` | `NEWSROOM_TRUST_PROXY` | `false` | Ters vekil arkasında `X-Forwarded-*` başlıklarına güven |
| `allowPrivateNetworks` | `NEWSROOM_ALLOW_PRIVATE_NETWORKS` | `false` | Yerel ağdaki beslemelere izin ver (bkz. Güvenlik) |

Şifre önceliği: `NEWSROOM_PASSWORD` → `passwordHash` → `newsroom password` ile kaydedilen şifre.

## Komut satırı

```
newsroom serve              web arayüzü ve zamanlayıcı
newsroom password           giriş şifresini belirler (açık oturumlar kapanır)
newsroom add <adres>        kaynak ekler
newsroom import <opml>      OPML'deki kaynakları ekler
newsroom refresh            kaynakları bir kez yeniler ve kuyruğu işler
newsroom digest [--email]   bugünün özetini hazırlar, yazdırır, istenirse gönderir
```

systemd kurulumunda `newsroom` komutu kendiliğinden doğru kullanıcı ve ayar dosyasıyla çalışır (`sudo newsroom password`).

## Güvenlik

- Tek kullanıcılı şifre girişi; şifre scrypt ile saklanır. Oturum anahtarının veritabanında yalnızca SHA-256 özeti tutulur. Aynı adresten 15 dakikada 10 hatalı denemeden sonra giriş geçici olarak kapanır.
- Durum değiştiren istekler JSON gövde ister ve başka bir siteden geliyorsa (Origin) reddedilir; çerez `HttpOnly` ve `SameSite=Lax`.
- Sıkı içerik güvenlik politikası (yalnızca kendi betikleri), haber metni sayfaya hiçbir zaman HTML olarak basılmaz.
- Besleme içindeki bağlantılar başkasının elinde olduğu için Newsroom varsayılan olarak **yerel ağ adreslerine istek göndermez** (127.0.0.1, 10.x, 192.168.x, 169.254.169.254, Tailscale aralığı…); yönlendirmelerde her adım yeniden denetlenir. Kendi ağınızdaki bir beslemeyi okumak için `allowPrivateNetworks` açılabilir.
- Haber metni modele "veri" olarak verilir; içindeki yönergeler yok sayılır ve çıktı sabit bir JSON şemasıyla sınırlıdır.
- systemd servisi ayrıcalıksız kullanıcıyla, yalnızca veri klasörüne yazabilecek şekilde sıkılaştırılmış çalışır.
- İnternete açacaksanız HTTPS sağlayan bir ters vekil (Caddy, nginx) ya da Tailscale arkasında çalıştırın ve `trustProxy` ayarını açın.

## Veri ve yedekleme

Her şey tek bir SQLite dosyasındadır: `/var/lib/newsroom/newsroom.db` (Docker'da `/data`). Haberler belirlediğiniz süre (7-90 gün) sonra silinir; kaydettikleriniz ve günlük özetler kalır. Yedek almak için:

```bash
sudo sqlite3 /var/lib/newsroom/newsroom.db ".backup /yedek/newsroom.db"
```

## Geliştirme

```bash
npm test
```

Testler internete çıkmaz: beslemeler, haber sayfaları, Ollama ve SMTP yerel sahte sunuculardır.

```
bin/newsroom.js     komut satırı
src/feeds.js        RSS/Atom/RDF ayrıştırıcı ve besleme keşfi
src/html.js         haber sayfasından ana metin çıkarma
src/http.js         güvenli indirme (boyut sınırı, yerel ağ engeli, karakter kümesi)
src/pipeline.js     indir → tam metin → analiz → kümele
src/analyze.js      model istemi, JSON şeması, çıktı doğrulama
src/cluster.js      aynı olayı bulma
src/rank.js         sıralama ve geri bildirim
src/digest.js       günlük özet
src/smtp.js         bağımlılıksız SMTP istemcisi
src/server.js       HTTP API ve statik dosyalar
public/             arayüz (bağımlılıksız, TR/EN)
```

## Lisans

[PolyForm Noncommercial 1.0.0](LICENSE). Kişisel, eğitim ve kâr amacı gütmeyen kullanım serbesttir; ticari kullanım için iletişime geçin.

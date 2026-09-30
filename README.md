# HueFL — Hue for Linux

Sterowanie lampami Philips Hue z zasobnika systemowego. Tauri 2 (Rust + webview
systemowy) + TypeScript, lokalne API mostka (CLIP v2), bez chmury Signify poza
opcjonalnym discovery.

## Wymagania systemowe

Dziala na Ubuntu 22.04+ (i innych dystrybucjach z webkit2gtk-4.1). Do budowania:

```bash
sudo apt install build-essential curl wget file pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
  libpulse-dev   # synchronizacja z muzyka (feature sync-audio)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust (stable)
```

Do tego Node.js 20+ i npm.

`libayatana-appindicator3` jest tym, przez co dziala tray. Na GNOME potrzebne
jest jeszcze rozszerzenie AppIndicator/KStatusNotifierItem — bez niego ikona
po prostu sie nie pojawi (Ubuntu ma je domyslnie; KDE, XFCE, Cinnamon maja to
natywnie).

Do discovery przez mDNS przydaje sie `avahi-daemon` (jest domyslnie na
wiekszosci desktopow). Bez niego aplikacja spada na `discovery.meethue.com`.

## Uruchomienie

```bash
npm install
npm run tauri dev
```

Pierwsze uruchomienie kompiluje zaleznosci Rusta — to potrwa kilka minut.

Build dystrybucyjny (`.deb` i AppImage w `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

## Parowanie

Przy pierwszym starcie otwiera sie okno konfiguracji. Klikasz "Szukaj
mostkow", nacisasz okragly przycisk na mostku i w ciagu ~30 s klikasz
"Sparuj". Klucz aplikacji laduje w `~/.config/huefl/config.json`
(uprawnienia 600).

## Jak to jest zbudowane

```
src/
  main.tsx             start Reacta i rdzenia
  App.tsx              widoki (glowny / parowanie / Opcje) i dialog zamykania
  core/app.ts          rdzen: stan Hue, polaczenie z mostkiem, preferencje, sync traya
  core/useAppState.ts  stan rdzenia jako stan Reacta (useSyncExternalStore)
  components/          pasek tytulu, karty pokoi, suwaki, dialog zamykania
  components/ui/       komponenty shadcn/ui (generowane: npx shadcn add ...)
  views/               HomeView, PairingView, OptionsView + zakladki Opcji
  lib/theme.ts         motyw: system / ciemny / jasny
  i18n.ts              tlumaczenia (t, tPlural)
  locales/en.json      katalog tekstow — wspolny dla TS i Rusta
  hue/client.ts        API mostka: discovery, parowanie, zasoby, reconnect SSE
  hue/model.ts         surowe zasoby CLIP v2 -> model dla UI
  queue.ts             scalanie i limitowanie komend
  store.ts             ustawienia: parowanie + preferencje (I/O po stronie Rust)
  types.ts             model danych
src-tauri/src/
  hue.rs               transport: HTTPS z pinowaniem certyfikatu, SSE, discovery
  config.rs            odczyt/zapis config.json wg XDG
  tray.rs              ikona i menu w zasobniku, akcje menu obslugiwane natywnie
  i18n.rs              tlumaczenia po stronie Rust (ten sam en.json)
  sync/                synchronizacja: entertainment/ (REST, DTLS, protokol),
                       audio/ (przechwytywanie, analiza), screen/ (X11, strefy),
                       effects, smoothing,
                       readiness (checklista), manager (sesja, sprzatanie)
  window.rs            chowanie/pokazywanie okna z zachowaniem pozycji
  lib.rs               start aplikacji, rejestracja komend, obsluga zamykania okna
```

UI: React + Tailwind v4 + shadcn/ui (Radix). Okno nie ma natywnej ramki
(`decorations: false`) — pasek tytulu jest wlasny (`TitleBar.tsx`). Zamkniecie
okna (X albo Alt+F4) pyta, czy schowac do traya, czy zakonczyc; wybor mozna
zapamietac i zmienic w Opcjach → General.

Logika zyje w TypeScripcie w jednym webview. Okno nigdy nie jest niszczone —
zamkniecie je chowa albo konczy cala aplikacje. Rust robi to, czego webview nie umie: wlasna
weryfikacje TLS, dostep do plikow, `avahi-browse` — oraz tray.

Tray jest w Rust, bo WebKitGTK usypia JS w ukrytym oknie: menu obslugiwane
przez webview przestaje reagowac, gdy aplikacja siedzi w zasobniku. JS
przekazuje stan do traya komenda `set_tray_state`, a akcje menu (pokaz okno,
zakoncz, wlacz/wylacz pokoj) Rust wykonuje sam, wysylajac komendy prosto do
mostka. Ograniczenie: zmiany zrobione poza aplikacja przy schowanym oknie
trafiaja do menu dopiero po pokazaniu okna.

## Wersje jezykowe

Teksty sa w `src/locales/en.json` (na razie tylko angielski). Nowy jezyk:
dodaj `src/locales/<kod>.json` z tymi samymi kluczami i zarejestruj go w
`catalogs` w `src/i18n.ts`. Liczba mnoga idzie przez `Intl.PluralRules`
(`.one`, `.few`, `.many`, `.other`). Tray (Rust) na razie uzywa zawsze
angielskiego — do dodania przekazanie locale z UI.

### Trzy rzeczy, ktore maja tu znaczenie

**Tray na Linuksie nie zglasza klikniecia w ikone.** Ayatana AppIndicator
przekazuje wylacznie akcje z menu. Stad menu jest podpinane od razu przy
tworzeniu ikony, a przywracanie okna to pozycja "Pokaz okno", nie lewy klik.

**Mostek nie da sie zweryfikowac normalnym TLS.** Certyfikat ma w CN
identyfikator mostka zamiast hostname, nie ma SAN, a root Signify nie jest
nigdzie publikowany. `src-tauri/src/hue.rs` robi wiec TOFU: przy pierwszym
polaczeniu zapamietuje SHA-256 certyfikatu i przy kolejnych porownuje. Model
jak w SSH — pierwsze parowanie zrob w sieci, ktorej ufasz. Odcisk ma ten sam
format co w wersji na Electrobunie, wiec istniejacy `config.json` dziala dalej.

**Mostek ma limity komend** — okolo 10/s na lampe i 1/s na grupe. Suwak
jasnosci generuje znacznie wiecej zdarzen, dlatego `CommandQueue` trzyma tylko
najswiezszy stan dla kazdego zasobu i wysyla go z ograniczona czestotliwoscia.
Stan w UI aktualizuje sie optymistycznie, a prawde i tak przynosi eventstream.

Zamiast odpytywania w petli aplikacja subskrybuje `/eventstream/clip/v2`
(SSE) — kazda zmiana, takze zrobiona z aplikacji Philipsa czy przelacznika
Dimmer, dociera tu natychmiast. Reconnect ma narastajacy backoff do 30 s.

## Logi

Historia akcji i zdarzen jest w Opcje → Logs (filtr poziomu, wyszukiwanie,
"Copy" do zgloszen bledow) oraz na dysku jako JSON Lines:
`~/.local/state/huefl/huefl.log` (uprawnienia 600, rotacja przy 1 MB do
`huefl.log.1`). Logi trzyma Rust (`src-tauri/src/logs.rs`) — JS w ukrytym
oknie bywa uspiony, a akcje traya dzieja sie tylko po stronie Rusta. Logger TS
(`src/core/log.ts`) wysyla wpisy paczkami i wycina klucze (`applicationKey`,
`clientKey`, naglowek `hue-application-key`).

Logowane sa m.in.: start aplikacji (wersja, system, stan parowania), kazde
laczenie z mostkiem (czas, liczba pokoi/lamp, firmware), bledy HTTP z trescia
odpowiedzi, stan strumienia zdarzen, akcje uzytkownika (przelaczniki; suwaki
raz, po puszczeniu), wyslane komendy z czasem (poziom debug), akcje traya,
parowanie oraz nieprzechwycone bledy JS ze stack trace.

## Synchronizacja swiatel (Sync)

Zakladka **Sync** strumieniuje kolory do lamp w czasie rzeczywistym przez Hue
Entertainment API: szyfrowany strumien DTLS 1.2 (PSK) na UDP 2100, ~50
pakietow/s, format HueStream v2. Zwykle komendy REST sa na to za wolne (~10/s).

Wymagania (aplikacja sprawdza je sama i pokazuje jako checkliste): mostek v2,
klucz strumienia (`clientKey`, powstaje przy parowaniu), lampy kolorowe
obslugujace strumien i **obszar Entertainment** (sync area). Obszar mozna
utworzyc w aplikacji (kreator: przeznaczenie, lampy, rozmieszczenie) albo w
aplikacji Philips Hue — to te same zasoby mostka.

Tryby:
- **Ambient** — paleta plynie po lampach od lewej do prawej.
- **Music** — dzwiek systemowy (monitor domyslnego wyjscia; jego dokladna nazwe
  podaje serwer — nie `@DEFAULT_MONITOR@`, ktore na pipewire-pulse 0.3.48
  wskazywalo mikrofon) albo mikrofon przez PulseAudio/PipeWire; FFT, pasma bas/srodek/gora, wykrywanie
  beatu. Style: Pulse, Spectrum. Tryb bezpieczny (domyslnie wlaczony)
  ogranicza blyski do 3/s (WCAG 2.3.1). Wymaga PulseAudio albo PipeWire z
  pipewire-pulse (samo ALSA / czysty JACK nie wystarcza — aplikacja to wykrywa
  i mowi wprost). Zmiana wyjscia w trakcie (np. na sluchawki) i restart serwera
  dzwieku sa obslugiwane: przechwytywanie przelacza sie / wraca samo.
- **Screen** — lampy biora kolory z ekranu, kazda z czesci najblizszej jej
  pozycji w obszarze (x → poziomo, wysokosc z → pionowo). X11 + MIT-SHM
  (czysty Rust, `x11rb`), ~25 klatek/s, ok. 5% jednego rdzenia CPU. Czarne pasy
  filmow sa pomijane, kolory lekko nasycane, tryb bezpieczny dziala tez tu.
  Wayland: jeszcze nie (wymaga portalu xdg-desktop-portal) — aplikacja to mowi.

Caly silnik dziala w Rust (`src-tauri/src/sync/`), bo JS w schowanym oknie jest
usypiany, a synchronizacja ma dzialac z traya. Po zatrzymaniu lampy wracaja do
stanu sprzed startu (Opcje → Sync). W czasie strumienia mostek ignoruje zwykle
komendy, wiec kontrolki pokoju sa wtedy zablokowane.

Testy na zywo (zmieniaja swiatla / nagrywaja dzwiek, dlatego `--ignored`):

```bash
cd src-tauri
cargo test --lib live_stream_rainbow -- --ignored --nocapture   # 5 s teczy
cargo test --lib live_overview -- --ignored --nocapture         # checklista
cargo test --lib live_capture -- --ignored --nocapture          # 2 s dzwieku
cargo test --lib live_screen -- --ignored --nocapture           # 1 s ekranu
cargo test --lib live_stream_screen -- --ignored --nocapture    # 5 s ekran -> lampy
```

## Autostart

`~/.config/autostart/huefl.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=HueFL
Exec=huefl
Icon=huefl
Terminal=false
X-GNOME-Autostart-enabled=true
```

(`Exec` po instalacji paczki `.deb`; dla AppImage podaj pelna sciezke do pliku.)

Aplikacja startuje cicho do traya, jesli mostek jest juz sparowany; okno
pokazuje sie tylko przy pierwszym uruchomieniu.

## Co mozna dolozyc

- Sceny (`/clip/v2/resource/scene` + PUT `recall`) — mostek juz je ma,
  brakuje tylko pozycji w menu.
- Kolor dla lamp RGB: `color.xy` z korekta do gamutu lampy (`color.gamut`).
- Skroty globalne (`tauri-plugin-global-shortcut`) na wlacz/wylacz.
- Strefy obok pokoi — `zone` mapuje sie tak samo jak `room`.
- Jedna instancja (`tauri-plugin-single-instance`) — ponowne uruchomienie
  pokazuje okno zamiast drugiej ikony w trayu.

## Zgłaszanie błędów

Opcje → About → **Report a bug**: opis i — jeśli użytkownik
zaznaczy — cały log z dysku (bieżący plik i poprzedni po rotacji) oraz informacje o systemie (dystrybucja,
jądro, pulpit, serwer dźwięku, model mostka; bez nazwy komputera i użytkownika).
Całe zgłoszenie jest widoczne w podglądzie przed wysłaniem. Klucze mostka są
usuwane z treści po wartości (`src-tauri/src/report.rs`, `scrub`).

Wysyłka (przycisk **Send**) jest ustawiana przy budowaniu. Build bez adresu
serwera na razie niczego nie wysyła:

```bash
HUEFL_REPORT_URL=https://example.com/reports \
HUEFL_REPORT_TOKEN=opcjonalny-token \
npm run tauri build
```

Aplikacja wysyła `POST` z JSON-em (`BugReport` w `src/core/report.ts`, pole
`schema: 1`) i nagłówkiem `Authorization: Bearer <token>`, jeśli token podano.
Serwer odpowiada kodem 2xx i `{"id": "…"}` — identyfikator pokazuje się
użytkownikowi. Limit: 5 MB na zgłoszenie, 15 s na odpowiedź.

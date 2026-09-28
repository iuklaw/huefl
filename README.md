# Hue Tray

Sterowanie lampami Philips Hue z zasobnika systemowego. Tauri 2 (Rust + webview
systemowy) + TypeScript, lokalne API mostka (CLIP v2), bez chmury Signify poza
opcjonalnym discovery.

## Wymagania systemowe

Dziala na Ubuntu 22.04+ (i innych dystrybucjach z webkit2gtk-4.1). Do budowania:

```bash
sudo apt install build-essential curl wget file pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
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
"Sparuj". Klucz aplikacji laduje w `~/.config/hue-tray/config.json`
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
`~/.local/state/hue-tray/hue-tray.log` (uprawnienia 600, rotacja przy 1 MB do
`hue-tray.log.1`). Logi trzyma Rust (`src-tauri/src/logs.rs`) — JS w ukrytym
oknie bywa uspiony, a akcje traya dzieja sie tylko po stronie Rusta. Logger TS
(`src/core/log.ts`) wysyla wpisy paczkami i wycina klucze (`applicationKey`,
`clientKey`, naglowek `hue-application-key`).

Logowane sa m.in.: start aplikacji (wersja, system, stan parowania), kazde
laczenie z mostkiem (czas, liczba pokoi/lamp, firmware), bledy HTTP z trescia
odpowiedzi, stan strumienia zdarzen, akcje uzytkownika (przelaczniki; suwaki
raz, po puszczeniu), wyslane komendy z czasem (poziom debug), akcje traya,
parowanie oraz nieprzechwycone bledy JS ze stack trace.

## Autostart

`~/.config/autostart/hue-tray.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Hue Tray
Exec=hue-tray
Icon=hue-tray
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

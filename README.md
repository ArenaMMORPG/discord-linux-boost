# Discord Linux Boost (`discord-linux-boost`)

**Native Discord Linux (Wayland + PipeWire + NVIDIA/AMD) Complete Fix & Boost Suite**  
*(Scroll down for [Русская документация](#-русская-документация--полный-технический-разбор))*

Fixes the notorious bugs in the official **native Linux Discord client** (`discord_voice.node` & `discord_utils.node`), while keeping full compatibility with **Vencord** (and stock Discord) and surviving auto-updates (`app-1.0.xxx`).

---

## What This Fixes

| # | Bug in Official Linux Discord | Root Cause | Fix Applied by `discord-linux-boost` |
|---|---|---|---|
| **1** | **Complete silence on Screen Share (Go Live)** | WirePlumber saves `"mute":true` for `Input/Audio:application.name:discord_capture` in `~/.local/state/wireplumber/stream-properties`. In addition, Chromium's `speech-dispatcher` (`sd_dummy`) opens an uncorked stream that outputs `0 bytes/s`, blocking `PulseAudioController::ReadAvailable()`'s `MIN` loop. | Automatically unmutes `discord_capture` in WirePlumber state & live `pactl`, and sets `DisableAutoSpawn` for `speech-dispatcher`. |
| **2** | **Screen Share audio stutter / buffer desync / "helicopter `krrrr` sound"** | In `discord_voice.node`, `PulseAudioController::MonitorSinkInput()` (`0x470bb2`) calls `pa_stream_connect_record(stream, NULL, NULL, 0)` with `attr = NULL` and `flags = 0`. On `pipewire-pulse`, `attr = NULL` sets **`fragsize = 384000` bytes (2.0 seconds!)** and **`node.latency = 96000/48000` (2.0s)**, buffering audio for 2 seconds and dumping giant **`65536`-byte (`341.33 ms` = 34 frames)** bursts every `341 ms` instead of `10 ms` frames. | Binary-patches `MonitorSinkInput` (`0x470ba9..0x470be5`) to pass `pa_buffer_attr { fragsize = 1920 }` and `PA_STREAM_ADJUST_LATENCY (0x2000)`. PipeWire sets `node.latency = 480/48000` (`10 ms`) and delivers exact `1920`-byte (`10 ms`) chunks every `10 ms`. |
| **3** | **KDE Wayland *"Global Shortcuts Requested"* popup & broken Push-to-Talk keys (`F13–F24`, `UNK197`, `Numpad *`)** | Under Wayland, `discord_utils.node` (`0x8bd58`) queries `org.freedesktop.portal.GlobalShortcuts`, triggering a modal dialog on every startup/keybind change and dropping non-standard keycodes. | Binary-patches `discord_utils.node` (`48 8d 3d 48 f4 08 00` → `e9 19 04 00 00 66 90`) to jump directly into the native X11/XWayland (`XInput2`) listener. Zero popups, all keys work globally. |
| **4** | **Incoming stream video frame-jumping (`+1/-1` frame bounce jitter on NVIDIA Wayland)** | Enabling `AcceleratedVideoDecodeLinuxZeroCopyGL` on NVIDIA Wayland (`nvidia-vaapi-driver` / NVDEC) causes EGL image presentation race conditions (out-of-order frames). Also, forcing `callBitRate` on incoming connections breaks WebRTC receiver BWE. | Enables hardware NVDEC/NVENC/VAAPI (`AcceleratedVideoDecodeLinuxGL`, `AcceleratedVideoEncoder`, `VaapiVideoEncoder`) while explicitly disabling `AcceleratedVideoDecodeLinuxZeroCopyGL`, and restricts bitrate boosts to **outgoing** streams only. |
| **5** | **64 kbps Mono audio & blurry screen shares** | Discord defaults voice encoding to `channels = 1`, `64 kbps` and allows video bitrate floor (`encodingVideoMinBitRate`) to drop to `150 kbps`. | Hooks `setTransportOptions` in `discord_voice/index.js` to unlock **Stereo 160 kbps Opus** and **4–12 Mbps** outgoing video bitrate. |
| **6** | **Patches wiped on Discord updates (`app-1.0.xxx`)** | Discord's Linux updater unpacks new versions into `~/.config/discord/app-1.0.xxx/`. | Runs as a lightweight Electron main-process preloader before Vencord (`app.asar`), automatically patching newly downloaded `app-1.0.xxx` versions on startup and in the background, plus blocking Sentry/Science telemetry. |

---

## Quick Install (Works with Discord + Vencord or Stock Discord)

```bash
git clone git@github.com:ArenaMMORPG/discord-linux-boost.git
cd discord-linux-boost
chmod +x install.sh uninstall.sh
./install.sh
```
*(Or via HTTPS: `git clone https://github.com/ArenaMMORPG/discord-linux-boost.git`)*

After running `./install.sh`, **quit Discord completely** from the system tray (`killall Discord`) and start it again.

### Uninstall / Restore Original Files
```bash
./uninstall.sh
```

---

## Technical Deep Dive (English)

### 1. Why Screen Share Audio Stuttered on PipeWire (`fragsize = 384000` vs `1920`)
In `discord_voice.node`, microphone capture (`webrtc::AudioDeviceLinuxPulse::InitRecording` at `0xa84a13`–`0xa84b09`) properly configures `pa_buffer_attr.fragsize = 1920` (10 ms at 48 kHz stereo S16LE) and `flags |= PA_STREAM_ADJUST_LATENCY (0x2000)`.

However, in Discord's Linux Soundshare implementation (`discord::media::soundshare::PulseAudioController::MonitorSinkInput` at `0x470910`), the developers wrote:
```c
pa_stream_connect_record(stream, NULL, NULL, 0);
```
Disassembly of `discord_voice.node` (`0x470ba9`–`0x470bb2`):
```asm
  470ba9: 4c 89 f7                mov    %r14,%rdi              ; stream
  470bac: 31 f6                   xor    %esi,%esi              ; dev = NULL
  470bae: 31 d2                   xor    %edx,%edx              ; attr = NULL  <-- BUG!
  470bb0: 31 c9                   xor    %ecx,%ecx              ; flags = 0    <-- BUG!
  470bb2: e8 59 05 e2 ff          call   291110 <pa_stream_connect_record@plt>
```
When `pa_stream_connect_record` is called with `attr = NULL` and `flags = 0` on `pipewire-pulse`:
- `pipewire-pulse` assigns `pulse.attr.fragsize = 384000` bytes (**2.0 seconds**) and `node.latency = 96000/48000` (**2.0 seconds**).
- Whenever a stream starts or uncorks, `pipewire-pulse` buffers for **2.0 seconds** and then delivers audio to `OnSamplesReady` in giant **`65,536`-byte (`341.33 ms` = 34 frames of 10 ms)** bursts every `341.33 ms` (~3 times per second, or every ~20 frames at 60 fps).
- For `341 ms`, `AudioDevice::Impl::OnSamples` sends 0 audio packets, and then blasts 34 frames (340 ms of audio) in `< 0.5 ms` into WebRTC's `AudioSendStream`, starving and overflowing the viewer's WebRTC NetEq jitter buffer 3 times per second.

#### Our 60-Byte Machine Code Patch (`0x470ba9`..`0x470be5`):
We replace the `attr = NULL, flags = 0` call and the adjacent no-op debug log call with a RIP-relative pointer to an embedded 20-byte `pa_buffer_attr` struct (`{ -1, -1, -1, -1, 1920 }`) and `PA_STREAM_ADJUST_LATENCY (0x2000)`:
```asm
  470ba9: 4c 89 f7                mov    %r14,%rdi              ; stream
  470bac: 31 f6                   xor    %esi,%esi              ; dev = NULL
  470bae: 48 8d 15 1b 00 00 00    lea    0x1b(%rip),%rdx        ; &pa_buffer_attr at 0x470bd0
  470bb5: b9 00 20 00 00          mov    $0x2000,%ecx           ; PA_STREAM_ADJUST_LATENCY
  470bba: e8 51 05 e2 ff          call   291110 <pa_stream_connect_record@plt>
  470bbf: 85 c0                   test   %eax,%eax
  470bc1: 78 75                   js     470c38                 ; error handler
  470bc3: eb 20                   jmp    470be5                 ; continue
  470bc5..470bcf: 90 (x11)        nop
  470bd0..470be3:                 ffffffff ffffffff ffffffff ffffffff 80070000
                                  ; pa_buffer_attr { maxlength=-1, tlength=-1, prebuf=-1, minreq=-1, fragsize=1920 }
```
Result in `pactl list source-outputs`:
- **Before:** `node.latency = "96000/48000"`, `pulse.attr.fragsize = "384000"` (341 ms / 64 KB bursts)
- **After:** `node.latency = "480/48000"`, `pulse.attr.fragsize = "1920"` (exact 10 ms / 1920 B real-time frames)

---

# 🇷🇺 Русская документация — Полный технический разбор

Этот репозиторий решает главные проблемы **нативного клиента Discord на Linux (Wayland + PipeWire + NVIDIA/AMD)** и работает поверх связки **Нативный Discord + Vencord** (а также на чистом Discord без Vencord).

## Какие проблемы решает

### 1. Полное отсутствие звука на демонстрации экрана (стриме)
Когда на стриме в Linux Discord вообще нет звука, виноваты две вещи:
1. **Скрытый мут `discord_capture` в WirePlumber:**
   Discord захватывает звук игр через `pipewire-pulse`, создавая потоки `application.name = "discord_capture"`. Так как они имеют класс `Stream/Input/Audio`, при муте входных устройств WirePlumber навсегда сохраняет в `~/.local/state/wireplumber/stream-properties`:
   ```ini
   Input/Audio:application.name:discord_capture={"channelVolumes":[1.000000, 1.000000], "mute":true, ...}
   ```
   Из-за этого каждый новый стрим создаётся с `Mute: yes`, и PipeWire отдаёт в стрим тишину.
2. **Фантомный поток `speech-dispatcher-dummy` (`sd_dummy`):**
   Chromium автоматически запускает демон `speech-dispatcher`, который держит открытым поток `sd_dummy` в состоянии `Corked: no`, но передаёт `0 байт/с`. Поскольку `PulseAudioController::ReadAvailable()` считает `MIN` по всем не-corked потокам, `sd_dummy` намертво блокирует микшер стрима.

**Решение:** `install.sh` и `discord-boost.js` автоматически снимают мут с `discord_capture` в конфиге WirePlumber и через `pactl`, а также отключают автозапуск `speech-dispatcher` (`DisableAutoSpawn`).

---

### 2. Лаги, треск («кррррр» / вертолёт) и рассинхрон звука на стриме («2 разных буфера разного размера»)
- **Симптомы:** Зрители на стриме слышат периодический рассинхрон и дребезжание/треск звука примерно 3 раза в секунду (каждые ~20 кадров при 60 fps), особенно при запуске игры и браузера или при нажатии Mute/Unmute.
- **Первопричина в машинном коде `discord_voice.node`:**
  В модуле микрофона (`webrtc::AudioDeviceLinuxPulse::InitRecording`) разработчики передают `fragsize = 1920` байт (`10 мс`) и флаг `PA_STREAM_ADJUST_LATENCY (0x2000)`.
  Но в функции захвата звука стрима `PulseAudioController::MonitorSinkInput` (`0x470ba9`–`0x470bb2`) они вызвали:
  ```c
  pa_stream_connect_record(stream, NULL, NULL, 0);
  ```
  передав `attr = NULL` и `flags = 0`!
  Когда в `pipewire-pulse` передаётся `attr = NULL`, PipeWire назначает потоку `discord_capture`:
  - **`pulse.attr.fragsize = 384000` байт (2.0 секунды!)**
  - **`node.latency = 96000/48000` (2.0 секунды!)** (в то время как у самой игры, например Dota 2, буфер `1024/44100` ≈ `23 мс` — буквально два буфера разного размера).
  Из-за этого при старте или пробуждении (uncork) любого аудиопотока `pipewire-pulse` сначала копит буфер до **2.0 секунд**, а затем сливает аудио в Discord не каждые `10 мс` по `1920` байт, а гигантскими пачками по **`65536` байт (`341.33 мс` = 34 фрейма за раз)** раз в `341.33 мс`. На стороне зрителей джиттер-буфер WebRTC NetEq каждые `341 мс` сначала голодает без пакетов, а затем получает залп из 34 фреймов за `< 0.5 мс`.
- **Решение:** 60-байтный бинарный патч `MonitorSinkInput` (`0x470ba9`..`0x470be5`), передающий `pa_buffer_attr { maxlength=-1, tlength=-1, prebuf=-1, minreq=-1, fragsize=1920 }` и флаг `PA_STREAM_ADJUST_LATENCY (0x2000)`. Теперь `pipewire-pulse` ставит `node.latency = 480/48000` (`10 мс`) и `fragsize = 1920`, отдавая ровно по 1 фрейму каждые `10 мс`.

---

### 3. Окно KDE Wayland «Global Shortcuts Requested» и неработающие бинды (`F19`, `UNK197`, `NumPad *`, `CapsLock`)
- **Первопричина:** Под Wayland модуль `discord_utils.node` (`0x8bd58`) обращается к D-Bus порталу `org.freedesktop.portal.GlobalShortcuts`, из-за чего KDE Plasma показывает модальное окно при каждом старте и не пропускает нестандартные клавиши.
- **Решение:** В `discord_utils.node` по смещению `0x8bd58` инструкция `48 8d 3d 48 f4 08 00` заменяется на `e9 19 04 00 00 66 90` (`jmp 0x8c176` — переход сразу на нативный X11/XWayland `XInput2` слушатель). Окно портала больше никогда не всплывает, а любые хоткеи работают глобально.

---

### 4. Дёргание видео при просмотре чужих стримов («кадр вперёд — кадр назад») и разблокировка GPU + Stereo 160 kbps Opus + 12 Mbps NVENC
- **Первопричина:** На драйверах NVIDIA под Wayland (`nvidia-vaapi-driver`) фича `AcceleratedVideoDecodeLinuxZeroCopyGL` вызывает гонку синхронизации EGL-буферов между декодером NVDEC и композитором KWin (кадры N и N+1 выводятся не по порядку). А принудительное завышение `callBitRate` на входящих соединениях ломает оценку полосы пропускания (BWE) при просмотре стримов друзей.
- **Решение:**
  1. Активируется полное аппаратное ускорение GPU (`ignore-gpu-blocklist`, `enable-gpu-rasterization`, `AcceleratedVideoDecodeLinuxGL`, `AcceleratedVideoEncoder`, `VaapiVideoEncoder`, `WebRTCPipeWireCapturer`, отключение фонового троттлинга рендерера), но `AcceleratedVideoDecodeLinuxZeroCopyGL` явно заносится в `--disable-features`.
  2. В `discord_voice/index.js` (`setTransportOptions`) включается **Stereo 160 kbps Opus** и повышается битрейт кодирования видео до **10–12 Мбит/с** строго для **исходящего** стрима (`encodingVideoBitRate` / `encodingVideoMaxBitRate`), не затрагивая входящие потоки.

---

## Установка (одной командой)

```bash
git clone git@github.com:ArenaMMORPG/discord-linux-boost.git
cd discord-linux-boost
chmod +x install.sh uninstall.sh
./install.sh
```

Скрипт автоматически:
1. Скопирует [`discord-boost.js`](./discord-boost.js) в `~/.config/Vencord/discord-boost.js`.
2. Снимет мут с `discord_capture` в WirePlumber и отключит `speech-dispatcher` (`sd_dummy`).
3. Сгенерирует `resources/app.asar` так, чтобы сначала запускался `discord-boost.js`, а сразу за ним — твой **Vencord** (`patcher.js`) или оригинальный `_app.asar`.
4. Пропатчит `discord_voice.node`, `discord_utils.node` и `discord_voice/index.js` (с сохранением оригиналов `.orig`).
5. При будущих обновлениях Discord (`app-1.0.xxx`) прелоадер сам автоматически пропатчит новую версию на лету.

> **Важно:** После первого запуска `./install.sh` полностью закрой Discord из трея (`killall Discord`) и запусти заново, чтобы обновлённый C++ модуль `discord_voice.node` загрузился в оперативную память (`Ctrl+R` перезагружает только JS, но не выгружает `.node` бинарники из RAM).

# Dolly Guitar Tuner

A real-time, browser-based guitar tuner built as a Progressive Web App (PWA). Uses the YIN pitch detection algorithm to accurately detect string frequencies from your microphone and provides visual feedback to help you tune your guitar.

## Features

- **Real-time pitch detection** using the YIN algorithm for accurate frequency analysis
- **Auto-detect mode** — automatically identifies which string you're playing
- **String lock mode** — tap a string button to lock tuning to a specific string
- **Visual cents gauge** with color-coded feedback (flat/in-tune/sharp)
- **PWA support** — installable on mobile devices and works offline
- **Mobile-first design** with a dark theme optimized for stage/practice use

## Tech Stack

- **Backend:** ASP.NET Core (.NET 10.0) — serves static files
- **Frontend:** Vanilla HTML, CSS, and JavaScript (no frameworks)
- **Audio:** Web Audio API with a custom YIN pitch detection implementation
- **PWA:** Service Worker with cache-first strategy + Web App Manifest

## Prerequisites

- [.NET 10.0 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) or later
- A modern browser with Web Audio API support (Chrome, Firefox, Safari, Edge)
- HTTPS is required in production for microphone access

## Getting Started

```bash
# Clone the repository
git clone https://github.com/your-username/GuitarTuner.git
cd GuitarTuner

# Run the app
dotnet run
```

The app will open at `https://localhost:5001` (or `http://localhost:5000`).

## Usage

1. Click **Start Tuning** to grant microphone access and begin listening.
2. Play an open string on your guitar.
3. The tuner displays the detected note, frequency, and how many cents sharp or flat you are.
4. Tune until the gauge needle is centered and the status reads **"In Tune!"**

### String Lock Mode

By default the tuner auto-detects the closest string. Tap any string button (E2, A2, D3, G3, B3, E4) to lock to that string. Tap it again to return to auto-detect.

## Supported Strings (Standard Tuning)

| String | Note | Frequency |
|--------|------|-----------|
| 6      | E2   | 82.41 Hz  |
| 5      | A2   | 110.00 Hz |
| 4      | D3   | 146.83 Hz |
| 3      | G3   | 196.00 Hz |
| 2      | B3   | 246.94 Hz |
| 1      | E4   | 329.63 Hz |

## How It Works

1. **Microphone capture** — Audio is captured via the MediaStream API with echo cancellation, noise suppression, and auto gain control disabled for a clean signal.
2. **FFT analysis** — An `AnalyserNode` with an FFT size of 4096 provides high-resolution frequency data.
3. **YIN algorithm** — A custom implementation performs autocorrelation-based pitch detection with parabolic interpolation for sub-sample accuracy.
4. **Cents calculation** — The deviation from the target note is calculated as `1200 * log2(detected / target)` and displayed on the gauge.
5. **Smoothing** — An exponential moving average (60/40 blend) stabilizes the needle for a readable display.

## Project Structure

```
GuitarTuner/
├── Program.cs                  # ASP.NET Core entry point
├── GuitarTuner.csproj          # .NET project file
├── GuitarTuner.slnx            # Solution file
├── Properties/
│   └── launchSettings.json     # Dev server configuration
└── wwwroot/
    ├── index.html              # Main page
    ├── app.js                  # Tuner logic & YIN algorithm
    ├── style.css               # Dark-theme styling
    ├── sw.js                   # Service Worker (offline cache)
    └── manifest.json           # PWA manifest
```

## Building for Production

```bash
dotnet publish -c Release -o ./publish
```

The `wwwroot` folder can also be served as purely static files from any web server (nginx, Apache, etc.) without the .NET backend.

## License

This project is provided as-is for personal and educational use.

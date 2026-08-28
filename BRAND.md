# imogen brand

This is the reference for imogen's visual identity: the mark, color tokens, type,
naming, and how each surface (web, iOS, Android, CLI) is expected to use them. Web
(`packages/web`) is canonical — every token here is copied from
`packages/web/src/styles.css` and the icon files in `packages/web/public/icons/`, not
the other way around. When the brand needs to change, change web first, then this file,
then the other platforms.

This is a reference, not marketing copy. If it disagrees with the code, the code that
ships is probably right and this file is stale — fix the file.

## The mark

An aperture cut through a print: a lens and a photograph in one shape, on a dark tile.
The master is [`brand/imogen-mark.svg`](brand/imogen-mark.svg), copied geometrically
from `packages/web/public/icons/icon.svg`. It is a 64×64 rounded square
(`#17191c`, `rx="14"`) with a rounded square aperture cut out by a ring mask
(`#e39b5c`) and a solid center dot in the same color. The mark always sits on its own
dark tile — it does not have a "light mode" variant; it is treated as a fixed logotype,
not a themed UI element.

Renditions derived from the master, one per platform's asset pipeline:

| Platform | File(s) | Notes |
| --- | --- | --- |
| Web | `packages/web/public/icons/icon.svg` | Favicon, `apple-touch-icon`, PWA manifest icon (`purpose: any`). |
| Web | `packages/web/public/icons/maskable.svg` | PWA manifest icon (`purpose: maskable`) — same shape, safe-zone padding for OS icon masking. |
| Web (inline) | `packages/web/src/components/Wordmark.tsx` | Mark + wordmark for in-app chrome (nav, login). No background tile — sits transparent on the app's own surface, so its aperture fill uses `var(--color-safelight)` instead of a fixed hex, and it themes with light/dark mode. |
| iOS | `App/Resources/Assets.xcassets/ImogenMark.imageset` | In-app mark. |
| iOS | `App/Resources/Assets.xcassets/AppIcon.appiconset` | Home screen icon, rasterized per iOS size requirements. |
| Android | `app/src/main/res/drawable/ic_imogen_mark.xml` | In-app mark, vector drawable. |
| Android | `app/src/main/res/drawable/ic_launcher_foreground.xml` | Adaptive icon foreground layer. |

If the master's geometry or fills change, update every rendition above to match.

## Color tokens

Source: `packages/web/src/styles.css` `@theme` block (`:root` for light, `.dark` for
dark). imogen's chrome is deliberately achromatic — photographs are the only saturated
thing on screen — so every token below is a neutral except the one accent.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `paper` | `#FBFAF7` | `#101113` | Page background. |
| `surface` | `#FFFFFF` | `#17191C` | Cards, raised panels. Also the mark's tile color. |
| `sunken` | `#F2F0EA` | `#0A0B0C` | Recessed areas (inputs, wells). |
| `ink` | `#191713` | `#F2F3F4` | Primary text. |
| `muted` | `#6E6A62` | `#9096A0` | Secondary text, icons. |
| `line` | `#E4E0D6` | `#262A2F` | Borders, dividers. |
| `safelight` (accent) | `#B4622A` | `#E39B5C` | Focus rings, selection state, active navigation mark. Small scale only — never a large fill. |

Dark mode is never pure black: pure black clips against a photograph's own blacks and
makes every image look like it's floating in a hole. `sunken` is the darkest tone used,
and it still sits above `#000`.

**Why the accent is dimmed in light mode.** `#E39B5C` (the dark-mode value, and the
mark's fixed fill) fails contrast against the light paper background. `#B4622A` is a
darkened variant of the same hue, chosen so the accent still passes as legible text/icon
contrast in light mode. The mark itself is unaffected — it's a fixed asset on a fixed
dark tile, not a themed token, so it always uses `#E39B5C` regardless of app theme.

Theme selection (web): a stored preference in `localStorage['imogen:theme']`, defaulting
to `prefers-color-scheme` when unset, applied by toggling a `.dark` class on `<html>`
before first paint (`packages/web/public/theme.js`) to avoid a flash of the wrong theme.

## Typography

- **Archivo** (variable, display/UI face) — `packages/web/public/fonts/archivo-latin.woff2`.
  The wordmark expands the width axis (`font-variation-settings: "wdth" 112`, weight
  600, `letter-spacing: -0.015em`) so it reads as exhibition signage rather than body
  text. Body/UI text uses the default width axis.
- **IBM Plex Mono** (`Plex Mono` family in CSS) — `packages/web/public/fonts/plex-mono-latin.woff2`.
  Used for data: file names, hashes, timestamps, technical values — never prose.

## Naming and tagline

- Write it lowercase: **imogen**, never "Imogen" or "IMOGEN", including at the start of
  a sentence or in a title. (npm package scope `@imogen/*` and the GitHub org name are
  the exception — those are identifiers, not brand text.)
- Tagline template: **"Your photo library, on your own server[, on your phone / from
  the command line]"** — extend the base line with the surface only where it adds
  information (a mobile app screen, a CLI `--help` banner); the web app and README use
  the base line alone: "Your photo library, on your own server."

## Per-surface guidance

- **Web** — canonical. Every token and asset above is sourced from here; other
  surfaces conform to web, not the reverse.
- **iOS / Android** — native widgets stay native (system list rows, native nav
  chrome, system typography where the platform expects it); the tokens above apply to
  the app's own custom-drawn surfaces (backgrounds, accent, the mark). Both currently
  use the dark-mode accent (`#E39B5C`) and dark/light backgrounds close to web's paper
  values; aligning them fully to web's tokens (including adding the light-mode accent
  dim, `#B4622A`) is separate, tracked work — not yet done as of this writing.
- **Android dynamic color** — an intentional, deliberate exception to the fixed
  palette: on Android 12+ (`Build.VERSION_CODES.S`), the app derives its Material You
  color scheme from the user's wallpaper (`dynamicLightColorScheme` /
  `dynamicDarkColorScheme`) instead of the fixed accent, matching platform convention.
  This is opt-in-by-default platform-native behavior, not a brand deviation to fix.
- **Android launcher background** — intended to be `#17191C` (the mark's own tile
  color), so the launcher icon and the mark's home tile match. **Discrepancy found:**
  as of this writing `imogen-android`'s `launcher_background` is `#1B1A18`, not yet
  `#17191C` — open alignment work, not a documentation error.
- **CLI / TUI** — dark-only, no light mode (a terminal is dark by convention and
  imogen's CLI doesn't try to detect or offer otherwise). It borrows web's dark tokens:
  accent `#E39B5C`, muted `#9096A0`, border/line `#262A2F`. It also defines one
  surface-local color with no web equivalent, `#E07A5F`, used only for destructive/
  confirm prompts — this does not need a web counterpart because web has no destructive
  action needing this stark a treatment.
  **Discrepancy found:** `imogen-cli/src/tui/ui.rs` currently hardcodes `ACCENT` as
  `#E0A162` (not `#E39B5C`) and its border color inline as `#2A2D32` (not `#262A2F`).
  These are close but not equal to the canonical dark tokens — likely hand-tuned
  independently rather than sourced from a shared token set. `MUTED` (`#9096A0`) and
  the destructive color (`#E07A5F`) already match exactly. Reconciling `ACCENT` and the
  border color to the canonical values is open work, not yet done as of this writing.

## Known gaps (deliberate, for now)

- **No raster `favicon.ico` fallback on web.** `packages/web/index.html` links only
  `icons/icon.svg` as `icon` and `apple-touch-icon`; the PWA manifest
  (`packages/web/vite.config.ts`) lists only SVG icons. Every current target renders
  SVG favicons/touch icons correctly; this is a known gap for older browsers, accepted
  rather than fixed for now.
- **No raster mipmap fallback on Android.** `ic_imogen_mark.xml` and
  `ic_launcher_foreground.xml` are vector drawables with no accompanying raster
  mipmaps for legacy density buckets. Same tradeoff as above, accepted for now.

# Brand

## The mark

Asynchronous progress: work that keeps moving without the room. Two rounded bars
climb left to right like rows of work picked up in sequence. Where the third row
would sit the bar is gone, reduced to a dot that has already arrived at the next
step. The missing bar is the standup that is not held, the dot is the progress
that happened anyway. All three sit on one rising diagonal at an even eight unit
rhythm on a 32 unit grid, so it reads as a staircase, not a chart, and the dot
holds at 16px.

## The accent

Burnt orange: `#f2703a` on dark, `#b8451a` on light. The app neutrals are cool
greys, so a warm accent separates from the chrome rather than blending into it,
and sits far from the indigo every other tracker uses. Both clear WCAG AA.

## Usage

```tsx
import { Logo, Wordmark } from '../brand';

<Logo />                        // 32px square, brand accent, named
<Logo size={16} title={null} /> // decorative, beside text that names it
<Wordmark size={24} className="mb-7" />
```

`Logo` paints in `currentColor`, defaulting to `--brand-accent`. `Wordmark`
carries the accessible name for the pair, so the name is spoken once.

`tokens.css` defines `--brand-accent`, `--brand-accent-foreground`,
`--brand-accent-muted`, `--brand-accent-ring` and `--brand-font-display`, and is
imported from `src/index.css`.

## The type

Inter 4.1, under the SIL Open Font License 1.1, self-hosted from `fonts/` with
the licence beside the files. A font served from a third party would put an
outside request on every page load, which is an availability and a privacy
dependency, so the files are served from our own origin instead.

`fonts.css` declares the faces and is imported at the top of `tokens.css`. Only
the three weights the interface sets are shipped, 400, 500 and 600, with no
italic because nothing sets one, and each file is cut to the Latin range the
product renders. That is 54 KB for the three, against 340 KB for the upstream
full-Unicode cuts and 352 KB for the variable font, which is why these are
static subsets rather than one variable file.

Every face is `font-display: swap`, and `--brand-font-display` keeps its system
fallbacks after `'Inter'`, so a font that loads slowly or not at all still
leaves readable text. Nothing is preloaded: the faces are declared in the
render-blocking stylesheet that is already in the initial HTML, so the browser
finds them before first paint anyway, and the built filenames are content
hashed, so a hand-written preload would go stale on the next build.

To change a weight, add the cut to `fonts/` and declare it in `fonts.css`. The
files are subsets of the upstream release, so regenerate them with `pyftsubset`
rather than editing them.

## The social card

`public/og.png` is checked in and rebuilt by `generate-og.py`, which sets the
lettering in the vendored Inter files and draws the mark from the same
rectangles as `Logo.tsx`, so the card cannot drift from the wordmark.

```bash
cd frontend && python3 src/brand/generate-og.py
```

## Assets

`public/`: `favicon.svg`, `favicon.ico`, `favicon-16.png`, `favicon-32.png`,
`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`,
`site.webmanifest`, `og.png` (1200x630), `github-app-logo.png` (200x200, see
`docs/github-app.md`).

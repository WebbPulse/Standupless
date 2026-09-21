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

## Assets

`public/`: `favicon.svg`, `favicon.ico`, `favicon-16.png`, `favicon-32.png`,
`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`,
`site.webmanifest`, `og.png` (1200x630).

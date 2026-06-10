# SMASH TV

**▶ Live: <https://anish.thite.site/smash-tv/>**

A CRT-style channel that plays every video from
[`archive.org/details/@anish_thite`](https://archive.org/details/@anish_thite)
back-to-back. No backend, just three files.

Deep links work: append `?v=<archive-identifier>&t=<seconds>` to share a
specific timestamp, e.g.
`https://anish.thite.site/smash-tv/?v=smash-gameplay-20260515-001950-20260608-062152&t=42`
(the in-app **SHARE** button copies that URL for you).

## Deployment

Hosted on GitHub Pages from the `main` branch of
[`anishthite/smash-tv`](https://github.com/anishthite/smash-tv).
Every push redeploys; build takes ~30s.

## Run

Any static server works. Easiest:

```
cd smash-tv
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` via `file://` will also work in most browsers,
but autoplay + fetch behave more predictably under `http://`.)

## Controls

- `→` next channel
- `←` previous channel
- `space` play/pause
- `m` mute
- `f` fullscreen
- `s` toggle shuffle

Click anywhere (or press any key) once on load — that gesture unmutes
the video and dismisses the boot screen, per browser autoplay policy.

## How it works

1. On first load, paginate `archive.org/services/search/v1/scrape` for
   `uploader:anish*thite* AND mediatype:movies` and cache the
   identifier list in `localStorage` for 6 hours (~2.4k items).
2. Just before each video plays, hit `/metadata/<id>` to find the best
   MP4 derivative (prefers `.ia.mp4` — h.264, small).
3. Stream from `archive.org/download/<id>/<file>` into a single
   `<video>` element. On `ended`, advance.

## Tweaks

- Change `UPLOADER_QUERY` in `app.js` to point at a different account.
- Set `state.shuffle = false` (or press `s`) for chronological order.
- CRT scanline/vignette/static styling is in `styles.css` — delete
  `.scanlines` / `.vignette` / `.static` if you want a clean look.

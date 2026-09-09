# Terminal screenshots

Four blocks in the README are images rather than text, because they are output
nobody copies. **Every command a reader would paste stays as text**, so it can
be selected, and so a search for it finds something.

| Snippet | Replaces | In |
|---|---|---|
| `1-you` | Paul sending | the opening demo |
| `2-marie` | Marie's session reacting | the opening demo |
| `3-peers` | `crosstalk peers` | Usage |
| `4-tasks` | `crosstalk tasks` | What the room keeps |

## Making them

Open the link, **Export Image → Save SVG**, then run it through the slimmer:

```
bun scripts/slim-svg.ts assets/1-you-dark.svg
```

ray.so embeds every font it offers rather than the ones it used: eleven
families, of which the image references one. That is 85% of a 1.3 MB export.
Stripping the unused faces takes it to about 190 KB with no visible change.

The `.txt` files here are the source, so a snippet can be regenerated without
retyping it, and `titles.json` holds the window title for each.

Settings are baked into the links: no background, 16px padding, plaintext (so
nothing is syntax-coloured as if it were C#), the sunset theme, and a window
title in the shape Claude Code writes, `<task> — node ‹ claude`. The only
difference within a pair is `darkMode`.

## Why a pair

ray.so bakes the text colour into the image, and a transparent SVG of dark grey
text vanishes on a dark README. The same `<picture>` swap the logo uses puts the
right one in front of the right reader:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/3-peers-dark.svg">
  <img src="assets/3-peers-light.svg" alt="crosstalk peers, showing marie online with two sessions">
</picture>
```

The `alt` matters more than usual here: it is the only thing a screen reader,
or anyone with images off, will get. Describe what the output says, not that it
is a screenshot.

## Keeping them true

Nothing tests an image. The prose in this README is checked against the code by
`test/e2e.sh`, and these four are not, so they will go stale silently. If the
CLI's output changes, regenerate from the `.txt` here rather than editing a
screenshot.

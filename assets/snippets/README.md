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

Open the link, screenshot, save as `assets/<name>-light.png` and
`assets/<name>-dark.png`. The `.txt` files here are the source, so a snippet can
be regenerated without retyping it.

Settings baked into the links: no background, `Terminal` title, 32px padding.
The only difference between the pair is `darkMode`.

## Why a pair

ray.so bakes the text colour into the image, and a transparent PNG of dark grey
text vanishes on a dark README. The same `<picture>` swap the logo uses puts the
right one in front of the right reader:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/3-peers-dark.png">
  <img src="assets/3-peers-light.png" alt="crosstalk peers, showing marie online with two sessions">
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

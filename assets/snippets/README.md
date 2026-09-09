# Terminal screenshots

Four blocks in the README are images rather than text, because they are output
nobody copies. **Every command a reader would paste stays as text**, so it can
be selected, and so a search for it finds something.

| Snippet | Shows | In |
|---|---|---|
| `1-you` | Paul sending | the opening demo |
| `2-marie` | Marie's session reacting | the opening demo |
| `3-peers` | asking who is working on what | Usage |
| `4-tasks` | asking what is left on the list | What the room keeps |

## Making them

```
bun scripts/render-snippets.ts
```

That reads every `.txt` here, wraps it in a Claude Code window, and writes eight
2x PNGs to `assets/`. The `.txt` files are the source, so a snippet can be
regenerated without retyping it, and `titles.json` holds the window title for
each.

The window chrome is not in the `.txt`. The renderer appends it, so all four
stay identical, and so a change to it is one edit rather than four.

## Why not SVG

ray.so exports SVG, and it looks sharper. But a ray.so SVG is a `foreignObject`
wrapping real HTML, and the browser lays that HTML out at the *reader's* zoom
level while the SVG frame stays the size it was exported at. Zoom in on GitHub
and the text overflows the frame and is clipped mid-word. A raster cannot
reflow, so PNG at 2x is the format that survives contact with a reader.

## Why a pair

The text colour is baked into the image, so a light snippet is unreadable on a
dark README. The same `<picture>` swap the logo uses puts the right one in front
of the right reader:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/3-peers-dark.png">
  <img src="assets/3-peers-light.png" alt="asking what marie is working on, and the agent reporting her two sessions" width="629">
</picture>
```

The `alt` matters more than usual here: it is the only thing a screen reader, or
anyone with images off, will get. Describe what the output says, not that it is
a screenshot.

## Keeping them true

Nothing tests an image. The prose in this README is checked against the code by
`test/e2e.sh`, and these four are not, so they will go stale silently. If the
CLI's output changes, edit the `.txt` here and re-render.

## The font, and why it is Menlo

Claude Code's input field is a pair of `─` rules, read off a live session:

```
────────────────────────────────────────────
❯ Try "fix lint errors"
────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
```

For those rules to be unbroken, `─` has to be exactly one cell wide. Measured in
a canvas against `x` at the same size:

| Font | `─` width |
|---|---|
| Menlo, Monaco, Courier New, Andale Mono | 1.000 |
| SF Mono, JetBrains Mono, Consolas | 1.417 |

So the renderer asks for Menlo, which is also what a Mac terminal running Claude
Code looks like. To check a new glyph, measure ten of it against ten `x` the same
way.

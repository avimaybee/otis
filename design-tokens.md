# Otis design tokens

Status: approved visual baseline, revised for Avi's compact UI and Codex-style question direction on 2026-10-07. Owner: Avi. These recipes are the implementation target, not evidence of production completion.
Visual direction: calm and precise, charcoal canvas, one muted yellow "Highlighter" accent.

This file is the single source of truth for how Otis looks. It replaces the color table (section 5), the radius and spacing values, and any conflicting visual rule in `design.md`. `design.md` still owns behavior, layout logic, states and acceptance review. `product.md` owns behavior. If two documents disagree on a visual value, this file wins.

Migration note, 2026-10-07: apply these values to their existing CSS/component owners and update enforcement/stories together. `text-xs` now means 12 / 16 px metadata; use the new `text-nav` token for 13 / 18 px navigation and technical detail. Remove duplicate gap owners and invisible action-row space rather than layering overrides. These documentation changes do not modify runtime CSS or claim the UI migration complete.

---

## 0. Rules for agents (read first)

1. Every color, size, radius and spacing value in UI code comes from this file. Do not invent values.
2. If a value you need is not defined here, stop and ask. Do not pick something that "looks right".
3. No hex literals, `rgb()`, `hsl()` or arbitrary pixel colors in components. Colors come from semantic Tailwind classes (`bg-card`, `text-muted-foreground`, `border-highlight`). Hex values live only in `globals.css`.
4. No parallel TypeScript palette object. CSS variables are the only token store.
5. Use shadcn components as the base. Override with the recipes in section 8, never with ad hoc classes.
6. In shadcn, `accent` means a neutral hover surface (`#2C2C2C`). It is not the brand color. The brand color is called `highlight`. Never put yellow behind a class named `accent`.
7. Run `scripts/check-design.sh` (section 11) before declaring any UI task done. A build that passes but fails this check is not done.
8. Compare the rendered screen to section 12 at real viewport sizes. Passing tests do not prove visual fidelity.

---

## 1. Design intent

- The conversation owns the screen. The transcript is on the canvas with no container, user messages are a quiet fill, and the composer is a single soft surface.
- Hierarchy comes from type size, spacing and alignment. Not from borders, cards or color.
- Color is nearly absent. One accent, used sparingly, marks the places where the eye should land.
- Precision means every value is on the 4 px grid and every component uses the same few radii.

---

## 2. References and compact production scale

The original [approved reference](docs/design/approved-reference.png) remains the charcoal/Highlighter composition reference. Avi's 2026-10-07 direction supersedes its former density scaling: compact, structured controls and conversation spacing, with readable body text. Use sections 5–8 for production dimensions; do not scale the miniature or restore the old 24 px turn gaps, 280 px sidebar or inflated control rows.

The [Codex question reference](plans/qa/2026-10-07-codex-question-reference.png) owns the question-panel composition: numbered suggestions, a separate answer field with Send/Skip, and ordinary chat underneath. The [interactive Otis study](plans/qa/otis-compact-question-preview.html) and its [recorded geometry](plans/qa/2026-10-07-study-geometry.json) make the compact direction concrete. They are proposal evidence, not production components or backend verification. Existing colors, fonts and highlight rules remain authoritative here.

---

## 3. Color tokens

Dark only for v1. Set `color-scheme: dark`. Do not ship a light theme.

### 3.1 Neutrals and shadcn mapping

| Token (shadcn variable) | Value | Use |
|---|---|---|
| `--background` | `#181818` | Conversation canvas, page background |
| `--foreground` | `#F3F3F3` | Primary text |
| `--card` | `#242424` | Composer, user bubble, selected sidebar row |
| `--card-foreground` | `#F3F3F3` | Text on card |
| `--popover` | `#303030` | Menus, dropdowns, tooltips (needs separation) |
| `--popover-foreground` | `#F3F3F3` | Text in popovers |
| `--primary` | `#F3F3F3` | Default buttons (not send) |
| `--primary-foreground` | `#181818` | Text on default buttons |
| `--secondary` | `#242424` | Secondary buttons |
| `--secondary-foreground` | `#F3F3F3` | Text on secondary |
| `--muted` | `#242424` | Muted surfaces |
| `--muted-foreground` | `#A8A8A8` | Secondary text, placeholders, Working line |
| `--accent` | `#2C2C2C` | Neutral hover surface, disabled send button |
| `--accent-foreground` | `#F3F3F3` | Text on hover surface |
| `--destructive` | `#FF9C9C` | Failure and destructive text, always with a label or icon |
| `--destructive-foreground` | `#181818` | Text on a destructive fill (rare) |
| `--border` | `#383838` | Separators, necessary edges |
| `--input` | `#383838` | Input borders |
| `--ring` | `#D8D8D8` | Focus ring (neutral, never yellow) |
| `--sidebar` | `#141414` | Sidebar background |
| `--sidebar-foreground` | `#F3F3F3` | Sidebar text on selected row |
| `--sidebar-accent` | `#242424` | Selected sidebar row fill |
| `--sidebar-accent-foreground` | `#F3F3F3` | Text on selected row |
| `--sidebar-border` | `#383838` | Sidebar separators |
| `--sidebar-ring` | `#D8D8D8` | Sidebar focus ring |
| `--sidebar-hover` (custom) | `#1D1D1D` | Hover fill on unselected sidebar rows |
| `--subtle` (custom) | `#8C8C8C` | Compact metadata, timestamps, disabled icons |

### 3.2 Highlight and status (custom)

| Token | Value | Use |
|---|---|---|
| `--highlight` | `#E2D86B` | The only accent. See section 4. |
| `--highlight-foreground` | `#181818` | Content on a highlight fill |
| `--highlight-hover` | `#EDE47E` | Send hover |
| `--highlight-pressed` | `#CFC55F` | Send pressed |
| `--warning` | `#E5A36B` | Attention. Always with an icon or text. Muted orange, so it never competes with highlight. |
| `--success` | `#9DCCAF` | Confirmed outcome, only when useful |

### 3.3 Contrast (measured targets)

| Pair | Ratio |
|---|---|
| `#F3F3F3` on `#181818` | about 16:1 |
| `#A8A8A8` on `#242424` | about 6.5:1 |
| `#8C8C8C` on `#242424` | about 4.6:1 (minimum for text) |
| `#E2D86B` on `#181818` | about 12:1 |
| `#181818` on `#E2D86B` | about 12:1 |

Do not use `--subtle` for anything the person needs to read to act. Use `--muted-foreground`.

---

## 4. Highlight rules

`highlight` is used in exactly these five places and nowhere else:

1. The 2 px left bar on the selected sidebar row.
2. The 8 px dot on a Working line.
3. The lead status pill for `warm` and `hot` (1 px border and text in highlight, transparent fill).
4. The main-chat send button (32 px desktop / 36 px mobile circle, highlight fill, dark icon).
5. Links (highlight text with a permanent 1 px underline, 2 px offset).

Never use highlight for: focus rings, large fills, backgrounds behind text, headings, icons other than the send arrow, charts, gradients, glows, selection color, or hover washes.

Rules that follow:
- A default (white) `Button` is allowed alongside the send button. At most one highlight-filled control is visible at a time. Question Send uses the neutral primary Button recipe; choices and question framing use no highlight.
- Status pills for other states are neutral: `new`, `cold`, `lost`, `deprioritized` use a 1 px `border` pill with `text-muted-foreground`. `won` uses `text-success`. `hot` is the `warm` pill plus a 6 px leading highlight dot.
- Send button states: empty composer uses `bg-accent text-subtle` (neutral, not yellow). With valid content it becomes highlight. While a run is active the same slot becomes Stop (section 8.9).

---

## 5. Typography

Three approved families (maximum three faces across the product):
1. **UI and prose**: Instrument Sans, self-hosted variable font (`@fontsource-variable/instrument-sans`, include the `latin` and `latin-ext` subsets). Fallback: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`. Used at weights 400 and 500 only.
2. **Wordmark and empty-state title**: Bricolage Grotesque, self-hosted variable font (`@fontsource-variable/bricolage-grotesque`, include the `latin` and `latin-ext` subsets). Fallback: `system-ui, sans-serif`. Used strictly at weight 600 in these two places only.
3. **Technical detail only**: Geist Mono, self-hosted variable font (`@fontsource-variable/geist-mono`, include the `latin` and `latin-ext` subsets) at 13 px (`text-nav font-mono`). Fallback: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`. Used for inspectable tool output and raw IDs; never business prose.

Latin-ext is required for Romanian `ș ț` (comma-below `U+0219`/`U+021B`) and Hungarian `ő ű` (double acute `U+0151`/`U+0171`). Verify them in the rendered UI.

| Role | Size / line height | Weight | Tailwind class | Use |
|---|---|---|---|---|
| Body | 16 / 24 | 400 | `text-base` | Messages, chat and answer inputs |
| UI | 14 / 20 | 500 | `text-sm` | Buttons, menu items, form labels, settings rows |
| Navigation | 13 / 18 | 400 | `text-nav` | Sidebar rows, quiet model controls |
| Meta | 12 / 16 | 400 | `text-xs` | Working line, pills, timestamps, section labels |
| Title | 20 / 26 | 500 (600 empty title only) | `text-xl` | Sign-in title, empty state, rare screen titles |
| Detail | 13 / 18 | 400 | `text-nav font-mono` | Technical tool inspectables, raw IDs |

Rules:
- Weights are 400 and 500 in general UI and prose. Weight 600 is permitted strictly on the wordmark and the empty-state title. No other 600, no 700, no `font-bold`.
- The only sizes allowed in the app are the five above. No `text-lg`, `text-2xl` or larger, no arbitrary `text-[Npx]`.
- Sentence case everywhere. No all-caps, no tracked uppercase labels. Body letter-spacing stays 0; use -0.01em on the 20 px titles only.
- Prose measure at 16 px in the 760 px column is closer to ~90 characters. Short replies don't hit it, and Otis keeps answers short so replies stay readable without narrowing the column.
- Use `tabular-nums` for money, counts and times (`font-variant-numeric: tabular-nums`).
- No monospace for business content. Monospace only inside inspectable technical detail.
- Body color is `text-foreground`. Secondary is `text-muted-foreground`. Metadata is `text-subtle`.

---

## 6. Spacing, sizing, radius, borders, elevation, motion

### 6.1 Spacing

4 px spacing grid. Allowed steps: 4, 8, 12, 16, 24, 32, 48 (Tailwind `1, 2, 3, 4, 6, 8, 12`). Other spacing values require a documented recipe. Selected-row `pl-[14px]` compensates for its 2 px border; icon sizes, typography and radii have their own tables. No textarea margin that silently inflates the composer.

| Where | Value |
|---|---|
| Transcript side gutter (mobile) | 16 |
| Author to content | 4 to 8 |
| Paragraph gap inside a message | 12 |
| Gap between message groups | 16 |
| Section gap | 32 |
| Working line to the answer | 8 |
| Question panel to ordinary composer | 8 |
| Question panel internal groups | 8 |
| Composer to bottom edge | 16 plus safe-area inset |

One parent owns each gap. Use `gap-*` on the parent, not margins on children. A run group owns the 8 px Working-to-answer gap; the transcript owns the 16 px between-turn gap. Hidden message actions reserve no row height or extra turn gap.

### 6.2 Sizes

| Thing | Value |
|---|---|
| Top bar height | 48 px |
| Sidebar width | 248 px |
| Sidebar row / action height | 32 px |
| Transcript and composer column | max 760 px, centered |
| Detail panel | 384 px (360 to 440), only when opened |
| Icon button (desktop) | 32 px visual |
| Pointer target | At least 24 x 24 px; coarse-pointer controls at least 32 x 32 px, with larger nonoverlapping reach where space permits |
| Small action icon button (copy, edit) | 28 px, 16 px icon |
| Idle composer surface | 56 px desktop; 76 px narrow mobile with integrated controls wrapping; grows to 6 input lines then scrolls |
| Send, mic, stop | 32 px desktop / 36 px mobile circle; 16 / 18 px icon respectively |
| Working disclosure row | 24 px |
| Question choice row | 32 px desktop / 36 px mobile; grows for wrapped text |
| Question panel | Content-sized; common short question about 220 px; long content scrolls within a max-height of min(320px, 45dvh) |
| Icons | Lucide, 18 px (16 px in 32 px buttons), stroke 2, `currentColor` |

### 6.3 Radius

| Token | Value | Use |
|---|---|---|
| `rounded-sm` | 4 px | Checkboxes, tiny elements |
| `rounded-md` | 8 px | Buttons, inputs, small controls |
| `rounded-lg` | 12 px | Menus, popovers, tooltips |
| `rounded-xl` | 16 px | Dialogs, sheets |
| `rounded-2xl` | 20 px | Composer, user bubble |
| `rounded-full` | pill | Status pill, send, mic, stop, avatars, Working dot |

The selected sidebar row has no radius. Rows are full-bleed.

### 6.4 Borders and elevation

- Borders are 1 px, `border-border`. Use a border only where it separates regions or marks a focus or input edge. No border on messages, the composer, user bubbles or sidebar rows.
- No shadows, except `shadow-popover` on menus and popovers: `0 8px 24px rgb(0 0 0 / 0.4), 0 2px 6px rgb(0 0 0 / 0.3)`.
- No gradients, glass, blur, glow, or colored shadows anywhere.
- At most two floating layers at once. A third means a dialog.

### 6.5 Focus

Keyboard focus is `outline: 2px solid var(--ring); outline-offset: 2px` on every interactive element. Never remove it. Never color it yellow.

### 6.6 Motion

- Duration 120 to 180 ms, `ease-out`. Use it for opening, closing, expanding and state changes that need explanation.
- No bounce, shimmer, pulse, typewriter effects, or entrance animations on messages.
- Respect `prefers-reduced-motion` (no transitions).

---

## 7. Layout and breakpoints

| Name | Width | Behavior |
|---|---|---|
| base | 360 and up | Full-screen chat, 16 px gutters, history in a drawer |
| `nav` | 900 and up | Persistent 248 px sidebar, drawer removed |
| `detail` | 1280 and up | Detail panel may sit beside the chat if the chat keeps at least 600 px |

Sidebar width is not a breakpoint. Collapse the sidebar before squeezing the chat.

Mobile drawer: width `min(320px, 86vw)`, dimmed backdrop, focus trapped while open, closes by backdrop, Close, Escape and Back.

Use `h-dvh` for the shell. Never `h-screen` or `100vh`. The transcript is the main conversation scroller. History and bounded long-question content may scroll inside their regions. The complete composer dock, including an open question panel, sits in layout above the safe area and keyboard and has one measured height owner.

---

## 8. Component recipes

Copy these class strings. Do not restyle them.

### 8.1 App shell
```
h-dvh bg-background text-foreground flex
```

### 8.2 Sidebar
```
Container: w-[248px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-2
Section label: px-4 py-2 text-xs text-subtle
Row: flex h-8 w-full items-center truncate px-4 text-nav text-muted-foreground hover:bg-sidebar-hover
Selected row: border-l-2 border-highlight bg-sidebar-accent pl-[14px] text-sidebar-accent-foreground
```
Rows are full-bleed with no radius, no card, no border. Long titles truncate. The header block (workspace name and New chat) sits above the rows and is separated from the chat list by a 1 px `border-sidebar-border` line.

### 8.3 Top bar
```
flex h-12 items-center gap-2 border-b border-border px-4
Title: truncate text-sm font-medium
Workspace subtitle: text-xs text-subtle
```

### 8.4 Transcript column
```
Scroller: flex-1 overflow-y-auto
Column: mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4
Run group (Working + answer): flex flex-col gap-2
```

### 8.5 Assistant message (no container)
```
text-base text-foreground [&>p+p]:mt-3
```
Sits directly on the canvas. No bubble, no avatar per paragraph, no border.

### 8.6 User message
```
ml-auto w-fit max-w-[85%] rounded-2xl bg-card px-3 py-2 text-base text-card-foreground nav:max-w-[80%]
```
A single-line message renders as a pill. A multi-line message keeps the 20 px radius.

### 8.7 Working line
```
Row: flex min-h-6 items-center gap-2 text-xs text-muted-foreground
Dot: size-2 shrink-0 rounded-full bg-highlight
Chevron (disclosure): size-4 text-subtle
```
Finished label: `Worked · 2 steps`. While running, the label shows the real current activity ("Searching Kerning", "Saving the visit"). The dot is static. Expanded steps use `text-xs`, with 8 px between steps. Only successful writes show Undo.

### 8.8 Status pill
```
inline-flex h-[22px] items-center rounded-full border border-highlight px-2 text-xs text-highlight
```
Neutral variant: `border-border text-muted-foreground`. Won: `border-border text-success`.

### 8.9 Composer
```
Wrapper: mx-auto w-full max-w-[760px] px-4 pb-4
Surface: grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-2xl bg-card py-2 pr-2 pl-3 nav:flex nav:min-h-[56px]
Textarea: max-h-36 min-h-6 min-w-0 flex-1 resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground
Placeholder text: Message Otis
Mic: grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground nav:size-8
Send (has content): grid size-9 shrink-0 place-items-center rounded-full bg-highlight text-highlight-foreground hover:bg-highlight-hover active:bg-highlight-pressed nav:size-8
Send (empty): grid size-9 shrink-0 place-items-center rounded-full bg-accent text-subtle nav:size-8
Stop (run active, no valid follow-up): grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground nav:size-8
Quiet model/effort control: min-w-0 truncate text-nav text-muted-foreground; inline on desktop, one integrated 20 px row on narrow mobile
```
Send icon is Lucide `ArrowUp`, 16 px desktop / 18 px mobile, stroke 2. Stop icon is a 12 px filled square. Give Send and Stop different `aria-label`s ("Send", "Stop"). No border on the composer. Keep the actual model/effort controls quiet, bounded and server-confirmed; `/model`, `/thinking` and overflow remain available. No separate toolbar strip or chip collection. A mobile wrap is part of the same surface, not an extra panel. Valid follow-ups use Send while work runs, with Stop still reachable in overflow. Hide unavailable controls. Optional footer: `text-xs text-subtle`, centered, one sentence at most; it must not appear/disappear on send and move the input.

### 8.10 Message actions (copy, edit)
```
Button: grid size-7 place-items-center rounded-md text-subtle hover:bg-accent hover:text-foreground
Icon: size-4
Visibility: opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100
```
Timestamps and actions show on hover or focus, with a reachable touch/menu equivalent. An invisible toolbar is out of flow and reserves no 32 px action row. Position it without overlapping message text; preserve keyboard access and stable layout. Persistent timestamps under every message are not allowed. Date separators mark real date changes (`text-xs text-subtle`, centered).

### 8.11 shadcn overrides
| Component | Rule |
|---|---|
| Button default | `h-8 px-3 text-sm font-medium rounded-md`, white fill; mobile primary action may use `h-9` |
| Button secondary | `bg-secondary`, no border |
| Button ghost | transparent, `hover:bg-accent` |
| Button outline | 1 px `border-border`, transparent |
| Button destructive | transparent, `text-destructive`, label required |
| Input, Textarea | `h-9 rounded-md border-input bg-transparent text-base` (16 px always, iOS zooms the page on focus below 16 px), focus is the neutral ring |
| Dialog | `rounded-xl bg-popover`, padding 24, no yellow |
| DropdownMenu, Popover | `rounded-lg bg-popover shadow-popover p-1`, items `h-8 rounded-md px-2 text-sm` |
| Tooltip | `rounded-lg bg-popover text-xs` |
| Sheet (mobile drawer) | `bg-sidebar`, `w-[min(320px,86vw)]` |
| Toast | Not used for business mutations. Copy confirmations only. |

### 8.12 Question panel

Use one production shadcn-based panel above the ordinary composer, in the same 760 px column and measured dock. This is the specific exception to the old ban on question framing; assistant messages remain unboxed.

```
Dock: flex flex-col gap-2
Panel: flex max-h-[min(320px,45dvh)] flex-col gap-2 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-3
Header: flex items-center justify-between gap-2 text-xs text-muted-foreground
Question: text-base text-foreground
Choices: flex flex-col gap-1
Choice: flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent nav:min-h-8
Choice number: grid size-6 shrink-0 place-items-center rounded-sm bg-accent text-xs text-muted-foreground
Answer surface: flex items-end gap-2 rounded-lg border border-input bg-transparent p-2
Answer textarea: min-h-6 min-w-0 flex-1 resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground
Skip: existing ghost Button, h-8
Send answer: existing neutral primary Button, h-8; mobile h-9
```

Use sentence-case “Question”, close, server-supplied numbered choices and an editable answer. Selected choices use a neutral accent fill and an explicit selected indicator/accessible state. Free text takes precedence. Question Send submits only this panel's immutable question target; the ordinary composer never inherits it. Skip defers, close hides, and the original pending question remains reopenable. Keep the answer mic absent until voice carries the same target through transcription and resume. Long questions/options wrap without truncating their meaning; the bounded panel scroll must leave ordinary chat reachable. See [design section 6](design.md#6-streaming-working-and-questions) for state and recovery behavior.

Do not add shadcn Card, Badge or Alert wrappers around transcript content. Do not use shadcn `Card` for messages.

---

## 9. `globals.css` (complete, copy as is)

```css
@import "tailwindcss";
@import "tw-animate-css";

:root {
  color-scheme: dark;

  --background: #181818;
  --foreground: #F3F3F3;
  --card: #242424;
  --card-foreground: #F3F3F3;
  --popover: #303030;
  --popover-foreground: #F3F3F3;
  --primary: #F3F3F3;
  --primary-foreground: #181818;
  --secondary: #242424;
  --secondary-foreground: #F3F3F3;
  --muted: #242424;
  --muted-foreground: #A8A8A8;
  --accent: #2C2C2C;
  --accent-foreground: #F3F3F3;
  --destructive: #FF9C9C;
  --destructive-foreground: #181818;
  --border: #383838;
  --input: #383838;
  --ring: #D8D8D8;

  --sidebar: #141414;
  --sidebar-foreground: #F3F3F3;
  --sidebar-primary: #F3F3F3;
  --sidebar-primary-foreground: #181818;
  --sidebar-accent: #242424;
  --sidebar-accent-foreground: #F3F3F3;
  --sidebar-border: #383838;
  --sidebar-ring: #D8D8D8;
  --sidebar-hover: #1D1D1D;

  --subtle: #8C8C8C;
  --highlight: #E2D86B;
  --highlight-foreground: #181818;
  --highlight-hover: #EDE47E;
  --highlight-pressed: #CFC55F;
  --warning: #E5A36B;
  --success: #9DCCAF;

  --radius: 0.5rem;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-hover: var(--sidebar-hover);
  --color-subtle: var(--subtle);
  --color-highlight: var(--highlight);
  --color-highlight-foreground: var(--highlight-foreground);
  --color-highlight-hover: var(--highlight-hover);
  --color-highlight-pressed: var(--highlight-pressed);
  --color-warning: var(--warning);
  --color-success: var(--success);

  --font-sans: "Instrument Sans Variable", "Instrument Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-wordmark: "Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif;
  --font-mono: "Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 20px;

  --text-xs: 0.75rem;
  --text-xs--line-height: 1rem;
  --text-nav: 0.8125rem;
  --text-nav--line-height: 1.125rem;
  --text-sm: 0.875rem;
  --text-sm--line-height: 1.25rem;
  --text-base: 1rem;
  --text-base--line-height: 1.5rem;
  --text-xl: 1.25rem;
  --text-xl--line-height: 1.625rem;
  --text-xl--letter-spacing: -0.01em;

  --shadow-popover: 0 8px 24px rgb(0 0 0 / 0.4), 0 2px 6px rgb(0 0 0 / 0.3);

  --breakpoint-nav: 56.25rem;
  --breakpoint-detail: 80rem;
}

@layer base {
  * {
    @apply border-border;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  html {
    -webkit-text-size-adjust: 100%;
    -webkit-font-smoothing: antialiased;
  }
  body {
    @apply bg-background font-sans text-base text-foreground;
  }
  :focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  a {
    color: var(--highlight);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
    }
  }
}
```

Note: `a` styling above applies to prose links only. Buttons and nav items built from anchors must reset it (`no-underline text-inherit`).

---

## 10. shadcn setup

- `components.json`: style `new-york`, `baseColor` `neutral`, `cssVariables` true, Tailwind v4, icon library `lucide`.
- After running `shadcn add`, do not accept regenerated color variables. `globals.css` above is authoritative. Re-apply it if the CLI changes it.
- Keep `<html class="dark">` fixed. There is no theme switcher.
- Do not edit generated shadcn component files for color. Fix color by changing the variable. Edit component files only to apply the sizes and radii in section 8.11.

---

## 11. Enforcement script

Save as `scripts/check-design.sh` and run it in CI and before every UI task is declared done. It fails on drift.

```bash
#!/usr/bin/env bash
set -u
fail=0
SRC="src"

check () {
  local label="$1" pattern="$2" extra="${3:-}"
  local out
  out=$(grep -rEn --include='*.tsx' --include='*.ts' --include='*.jsx' --include='*.css' \
    --exclude='globals.css' --exclude-dir=node_modules $extra "$pattern" "$SRC" 2>/dev/null)
  if [ -n "$out" ]; then
    echo "FAIL: $label"; echo "$out"; echo; fail=1
  fi
}

check "hex or rgb color literal outside globals.css" '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\('
check "banned font weights" 'font-(semibold|bold|extrabold|black|thin|light)'
check "banned text sizes" 'text-(lg|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b|text-\[[0-9.]+(px|rem)\]'
check "banned shadows" 'shadow-(xs|sm|md|lg|xl|2xl|inner)\b|drop-shadow|blur-'
check "gradients" 'bg-gradient|from-|via-|to-[a-z]+-[0-9]'
check "off-system palette classes" '(bg|text|border|ring|fill|stroke)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-[0-9]'
check "100vh or h-screen" 'h-screen|100vh|min-h-screen'
check "uppercase or tracking utilities" '\buppercase\b|tracking-(wide|wider|widest)'
check "yellow used through the accent token" 'bg-accent.*highlight|highlight.*bg-accent'

exit $fail
```

---

## 12. Visual review checklist

Check the rendered screen, not the code, at 360 x 800, 390 x 844, about 900, 1280 and 1440 px.

1. The transcript column is at most 760 px wide and centered. Composer and transcript share the same left and right edges.
2. Body text is 16 px Instrument Sans, not a system fallback. `ș ț ő ű` render correctly.
3. Assistant text has no container. User messages are right-aligned, one `#242424` fill, 20 px radius, 8 / 12 px padding.
4. Gap between message groups is 16 px, Working-to-answer 8 px, paragraph gap 12 px. Hidden actions reserve no row height.
5. Idle composer surface is 56 px desktop / 76 px narrow mobile, placeholder "Message Otis"; quiet controls wrap inside the same surface when necessary. Growth follows actual input content.
6. Main Send is a 32 px desktop / 36 px mobile circle. Highlight fill when there is content, neutral when empty; question Send is neutral.
7. Selected sidebar row is a full-bleed `#242424` row with a 2 px yellow bar. Unselected rows have no fill, border or radius.
8. Yellow appears only in the five places in section 4.
9. Timestamps and copy/edit icons appear on hover or focus, with a usable touch/menu equivalent, without invisible layout inflation.
10. No page-level horizontal scroll. Focus rings visible and neutral. Reduced motion honored.
11. `scripts/check-design.sh` exits 0.
12. Desktop sidebar is 248 px, rows 32 px, header 48 px. Navigation is 13 / 18 px; metadata 12 / 16 px.
13. Question panel and main composer align. Closing/Skip does not rotate through older questions; main chat remains independent. Long question text wraps and stays keyboard-accessible.

Reject and fix any screen that reads like a scaffold: a health badge above a centered card, a technical welcome panel, a stretched empty transcript, a dashboard grid, bordered ordinary message cards, or a separate toolbar strip. The explicit question panel and integrated quiet model/effort controls follow sections 8.12 and 8.9.

---

## 13. Voice tokens (UI copy and agent replies)

Otis is a sharp hype-man with real energy, in a calm interface. The UI stays quiet. The energy lives in the words, and only when something real happened.

Rules:
- Default tone is fast and flat for routine logging. Energy fires on real events: a lead warms up, an offer goes out, a big pitch day, a deal closes.
- Never hype a status Otis has not confirmed. Inferred status changes are questions.
- Short sentences. Contractions. One idea per reply.
- No em-dashes. No emoji. At most one exclamation mark per reply.
- Banned phrases: "Great question", "Absolutely", "I'd be happy to", "Let me know if", "Certainly", "As an AI".
- Never claim real-world experience. Never say "I'll remind you" until a reminder is committed.
- Replies match the user's language. Drafts match the lead's language.
- System UI (buttons, settings, errors) uses sentence case, verb-first labels, no "please", no "successfully", no terminal punctuation on labels.

Reference lines:
- Warm signal: "Eyes lit up at 3,500? That's a warm lead. Mark it warm?"
- Big day: "Six pitches before lunch. That's a day."
- Dispute: "You said 3,500, Hunor logged 3,600. Which one's live?"
- Undo: "Gone. Price is back to 5,300."
- Failure: "Draft failed, my side. Try again?"
- Nothing due: "Nothing due. Go sell something."
- Romanian: "Restaurantul 2 e cald acum. Oferta până vineri?"

---

## 14. Forbidden, in one list

- Hex colors or palette objects in components
- Any accent other than `highlight`, or highlight outside the five places
- Font weights 600 or 700 (outside the wordmark and empty-state title at 600), sizes outside the five in section 5, all-caps labels
- Cards, borders or shadows around messages, rows or the composer
- A separate composer toolbar strip or model chip collection; quiet integrated model/effort controls follow section 8.9
- Persistent timestamps and action icons under every message
- Gradients, glow, glass, blur, bounce, shimmer, typewriter effects
- `100vh`, `h-screen`
- Dead controls (Plus menu, camera, location) before the feature works
- Em-dashes in copy, emoji in copy

# Otis design tokens

Status: approved baseline. Owner: Avi.
Visual direction: calm and precise, charcoal canvas, one muted yellow "Highlighter" accent.

This file is the single source of truth for how Otis looks. It replaces the color table (section 5), the radius and spacing values, and any conflicting visual rule in `design.md`. `design.md` still owns behavior, layout logic, states and acceptance review. `product.md` owns behavior. If two documents disagree on a visual value, this file wins.

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

## 2. Reference mockup and scale rule

The approved mockup was a miniature at a 12 px body size. Production uses a 16 px body size, so values were scaled by about 1.33 and snapped to the 4 px grid. Proportions are preserved. When in doubt, the proportions below win.

| Element | Mockup (miniature) | Production |
|---|---|---|
| Body and sidebar row text | 12 px | 16 px / 24 px |
| Working line, pill text | 11 px | 13 px / 18 px |
| Sidebar row padding | 5 / 12 px | 8 px vertical, 16 px horizontal (row height 40 px) |
| Selected row accent bar | 2 px | 2 px |
| Sidebar bottom separator | 0.5 px | 1 px |
| Message area padding | 12 px | 16 px |
| Working dot | 6 px | 8 px |
| Working line gap, bottom margin | 6 px | 8 px |
| Status pill | 0 6 px padding, 0.5 px border, radius 8 | height 22 px, 8 px horizontal padding, 1 px border, fully round |
| User bubble padding | 5 / 11 px | 8 px vertical, 16 px horizontal |
| User bubble radius | 14 px | 20 px |
| Composer padding | 8 / 8 / 8 / 12 px | 8 px top, right, bottom, 16 px left |
| Composer radius | 14 px | 20 px |
| Send button | 24 px circle, 14 px icon | 36 px circle, 18 px icon |
| Gap between message groups | 10 px (compressed for the mock) | 24 px |

Layout of the reference, top to bottom: sidebar block with a selected row, a hairline, a Working line with yellow dot, assistant text with an inline pill, a right-aligned user bubble, the composer with a yellow send button.

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
4. The send button (36 px circle, highlight fill, dark icon).
5. Links (highlight text with a permanent 1 px underline, 2 px offset).

Never use highlight for: focus rings, large fills, backgrounds behind text, headings, icons other than the send arrow, charts, gradients, glows, selection color, or hover washes.

Rules that follow:
- A default (white) `Button` is allowed alongside the send button. At most one highlight-filled control is visible at a time.
- Status pills for other states are neutral: `new`, `cold`, `lost`, `deprioritized` use a 1 px `border` pill with `text-muted-foreground`. `won` uses `text-success`. `hot` is the `warm` pill plus a 6 px leading highlight dot.
- Send button states: empty composer uses `bg-accent text-subtle` (neutral, not yellow). With valid content it becomes highlight. While a run is active the same slot becomes Stop (section 8.9).

---

## 5. Typography

One family: Inter, self-hosted as a variable font (`@fontsource-variable/inter`, include the `latin` and `latin-ext` subsets). Fallback: `system-ui, "Segoe UI", Roboto, sans-serif`. Latin-ext is required for Romanian `ș ț` and Hungarian `ő ű`. Verify them in the rendered UI.

| Role | Size / line height | Weight | Tailwind class | Use |
|---|---|---|---|---|
| Body | 16 / 24 | 400 | `text-base` | Messages, composer, sidebar rows, headers |
| UI | 14 / 20 | 500 | `text-sm` | Buttons, menu items, form labels, settings rows |
| Meta | 13 / 18 | 400 | `text-xs` | Working line, pills, timestamps, section labels |
| Title | 20 / 26 | 500 | `text-xl` | Sign-in title, empty state, rare screen titles |

Rules:
- Weights are 400 and 500 only. No 600, no 700, no `font-semibold`, no `font-bold`.
- The only sizes allowed in the app are the four above. No `text-lg`, `text-2xl` or larger, no arbitrary `text-[Npx]`.
- Sentence case everywhere. No all-caps, no tracked uppercase labels, no letter-spacing changes.
- Prose measure is 60 to 70 characters, enforced by the 760 px column.
- Use `tabular-nums` for money, counts and times (`font-variant-numeric: tabular-nums`).
- No monospace for business content. Monospace only inside inspectable technical detail.
- Body color is `text-foreground`. Secondary is `text-muted-foreground`. Metadata is `text-subtle`.

---

## 6. Spacing, sizing, radius, borders, elevation, motion

### 6.1 Spacing

4 px grid. Allowed steps: 4, 8, 12, 16, 24, 32, 48 (Tailwind `1, 2, 3, 4, 6, 8, 12`). Not allowed: 5, 6, 10, 14, 18, 20 and arbitrary values, except the two documented in the recipes (`pl-[14px]` on the selected sidebar row, `my-1.5` on the composer textarea).

| Where | Value |
|---|---|
| Transcript side gutter (mobile) | 16 |
| Author to content | 4 to 8 |
| Paragraph gap inside a message | 12 |
| Gap between message groups | 24 |
| Section gap | 32 |
| Working line to the answer | 8 |
| Composer to bottom edge | 16 plus safe-area inset |

One parent owns each gap. Use `gap-*` on the parent, not margins on children.

### 6.2 Sizes

| Thing | Value |
|---|---|
| Top bar height | 52 px |
| Sidebar width | 280 px (260 to 300 allowed) |
| Sidebar row height | 40 px |
| Transcript and composer column | max 760 px, centered |
| Detail panel | 384 px (360 to 440), only when opened |
| Icon button (desktop) | 36 px visual |
| Touch hit area | 44 x 44 px minimum (pad the hit area, keep the visual size) |
| Small action icon button (copy, edit) | 32 px, 16 px icon |
| Composer min height | 52 px, grows to 6 lines then scrolls |
| Send, mic, stop | 36 px circle, 18 px icon |
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
| `nav` | 900 and up | Persistent 280 px sidebar, drawer removed |
| `detail` | 1280 and up | Detail panel may sit beside the chat if the chat keeps at least 600 px |

Sidebar width is not a breakpoint. Collapse the sidebar before squeezing the chat.

Mobile drawer: width `min(320px, 86vw)`, dimmed backdrop, focus trapped while open, closes by backdrop, Close, Escape and Back.

Use `h-dvh` for the shell. Never `h-screen` or `100vh`. The transcript is the only vertical scroller. The composer sits in layout above the safe area and the keyboard.

---

## 8. Component recipes

Copy these class strings. Do not restyle them.

### 8.1 App shell
```
h-dvh bg-background text-foreground flex
```

### 8.2 Sidebar
```
Container: w-[280px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-2
Section label: px-4 py-2 text-xs text-subtle
Row: flex h-10 w-full items-center truncate px-4 text-base text-muted-foreground hover:bg-sidebar-hover
Selected row: border-l-2 border-highlight bg-sidebar-accent pl-[14px] text-sidebar-accent-foreground
```
Rows are full-bleed with no radius, no card, no border. Long titles truncate. The header block (workspace name and New chat) sits above the rows and is separated from the chat list by a 1 px `border-sidebar-border` line.

### 8.3 Top bar
```
flex h-[52px] items-center gap-2 border-b border-border px-4
Title: truncate text-base font-medium
Workspace subtitle: text-xs text-subtle
```

### 8.4 Transcript column
```
Scroller: flex-1 overflow-y-auto
Column: mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6
```

### 8.5 Assistant message (no container)
```
text-base text-foreground [&>p+p]:mt-3
```
Sits directly on the canvas. No bubble, no avatar per paragraph, no border.

### 8.6 User message
```
ml-auto w-fit max-w-[85%] rounded-2xl bg-card px-4 py-2 text-base text-card-foreground nav:max-w-[80%]
```
A single-line message renders as a pill. A multi-line message keeps the 20 px radius.

### 8.7 Working line
```
Row: mb-2 flex items-center gap-2 text-xs text-muted-foreground
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
Surface: flex min-h-[52px] items-end gap-1 rounded-2xl bg-card py-2 pr-2 pl-4
Textarea: my-1.5 max-h-36 min-h-6 flex-1 resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground
Placeholder text: Message Otis
Mic: grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground
Send (has content): grid size-9 shrink-0 place-items-center rounded-full bg-highlight text-highlight-foreground hover:bg-highlight-hover active:bg-highlight-pressed
Send (empty): grid size-9 shrink-0 place-items-center rounded-full bg-accent text-subtle
Stop (run active): grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground
```
Send icon is Lucide `ArrowUp`, 18 px, stroke 2. Stop icon is a 12 px filled square. Give Send and Stop different `aria-label`s ("Send", "Stop"). No border on the composer. No toolbar row inside it. No model dropdowns or chips in it. The model lives behind `/model` and a quiet overflow option. No Plus button until a working attachment action exists. Optional footer line below the composer: `text-xs text-subtle`, centered, one sentence at most.

### 8.10 Message actions (copy, edit)
```
Button: grid size-8 place-items-center rounded-md text-subtle hover:bg-accent hover:text-foreground
Icon: size-4
Visibility: opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100
```
Timestamps and actions show on hover or focus, and always on touch. Persistent timestamps under every message are not allowed. Date separators mark real date changes (`text-xs text-subtle`, centered).

### 8.11 shadcn overrides
| Component | Rule |
|---|---|
| Button default | `h-9 px-4 text-sm font-medium rounded-md`, white fill |
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

  --font-sans: "Inter Variable", "Inter", system-ui, "Segoe UI", Roboto, sans-serif;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 20px;

  --text-xs: 0.8125rem;
  --text-xs--line-height: 1.125rem;
  --text-sm: 0.875rem;
  --text-sm--line-height: 1.25rem;
  --text-base: 1rem;
  --text-base--line-height: 1.5rem;
  --text-xl: 1.25rem;
  --text-xl--line-height: 1.625rem;

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
2. Body text is 16 px Inter, not a system fallback. `ș ț ő ű` render correctly.
3. Assistant text has no container. User messages are right-aligned, one `#242424` fill, 20 px radius, 8 / 16 px padding.
4. Gap between message groups is 24 px. Paragraph gap is 12 px.
5. The empty composer is 52 px tall, one line, no toolbar row, placeholder "Message Otis".
6. Send is a 36 px circle. Highlight fill when there is content, neutral when empty.
7. Selected sidebar row is a full-bleed `#242424` row with a 2 px yellow bar. Unselected rows have no fill, border or radius.
8. Yellow appears only in the five places in section 4.
9. Timestamps and copy/edit icons appear on hover or focus only (always on touch).
10. No page-level horizontal scroll. Focus rings visible and neutral. Reduced motion honored.
11. `scripts/check-design.sh` exits 0.

Reject and fix any screen that reads like a scaffold: a health badge above a centered card, a technical welcome panel, a stretched empty transcript, a dashboard grid, bordered message cards, or a toolbar inside the composer.

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
- Font weights 600 or 700, sizes outside the four in section 5, all-caps labels
- Cards, borders or shadows around messages, rows or the composer
- A toolbar, model chips or dropdowns inside the composer
- Persistent timestamps and action icons under every message
- Gradients, glow, glass, blur, bounce, shimmer, typewriter effects
- `100vh`, `h-screen`
- Dead controls (Plus menu, camera, location) before the feature works
- Em-dashes in copy, emoji in copy

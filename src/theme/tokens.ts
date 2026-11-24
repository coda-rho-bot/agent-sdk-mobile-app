/**
 * Design tokens for the Letta mobile example.
 *
 * Everything visual in the app resolves through these tokens — components never
 * use raw hex values or ad-hoc font sizes. The palette is built on a neutral
 * official brand pair (ink #202020 on mist #C9CDD1) with the brand primary blue
 * (#3939BD) as the single action accent. See docs/design-doc.md §2.
 */

export type ThemeName = "light" | "dark";

export interface Palette {
  /** App background — slightly warm paper (light) / near-black (dark). */
  bg: string;
  /** Cards, sheets, composer. */
  surface: string;
  /** Hairline borders. Use with StyleSheet.hairlineWidth. */
  surfaceEdge: string;
  /** Primary text. */
  ink: string;
  /** Secondary text: metadata, timestamps. */
  ink2: string;
  /** Tertiary text: placeholders, disabled. */
  ink3: string;
  /** The one action accent (lightened for dark). */
  accent: string;
  /** Running / connected / success. Status dots and words only. */
  run: string;
  /** Reconnecting / pending approval. */
  wait: string;
  /** Errors, destructive actions, deny. */
  danger: string;
  /** Fill for user message bubbles. */
  bubble: string;
  /** Pressed-state overlay for touchables. */
  pressed: string;
}

export const palettes: Record<ThemeName, Palette> = {
  light: {
    bg: "#FBFBFA",
    surface: "#FFFFFF",
    surfaceEdge: "#E7E8E5",
    ink: "#202020",
    ink2: "#5A5E63",
    ink3: "#8B9096",
    accent: "#004F50",
    run: "#1B7F5C",
    wait: "#A66A16",
    danger: "#B4362B",
    bubble: "#EFF0ED",
    pressed: "rgba(32,32,32,0.06)",
  },
  dark: {
    bg: "#161618",
    surface: "#1E1E21",
    surfaceEdge: "#2C2C31",
    ink: "#ECEDEF",
    ink2: "#A2A6AC",
    ink3: "#6E7176",
    accent: "#8CE3E2",
    run: "#3ECf95",
    wait: "#E3A33A",
    danger: "#E8604F",
    bubble: "#26262B",
    pressed: "rgba(236,237,239,0.08)",
  },
};

/**
 * Agent avatar colors — solid, saturated, picked deterministically from the
 * agent id so an agent always wears the same one. The avatar itself is a
 * "bloop": one glossy sphere, no initials (docs/design-doc.md §2.6).
 */
export const bloopColors: readonly string[] = [
  "#4B6FE8", // blue
  "#E8823C", // orange
  "#3FA88E", // teal
  "#7B5CE6", // violet
  "#E0A93B", // amber
  "#57A867", // green
  "#C0607F", // rose
  "#2F8FD0", // sky
  "#B85C3C", // rust
  "#9B59C4", // purple
  "#D4746A", // coral
  "#3D8F73", // pine
];

/** The app's own mark: a deep-teal bloop on light teal (Angus Software brand). */
export const brandMark = { bloop: "#004F50", field: "#9CF1F0" } as const;

export const type = {
  display: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5, lineHeight: 34 },
  title: { fontSize: 20, fontWeight: "600", lineHeight: 26 },
  body: { fontSize: 16, fontWeight: "400", lineHeight: 23 },
  bodyEm: { fontSize: 16, fontWeight: "600", lineHeight: 22 },
  sub: { fontSize: 13, fontWeight: "400", lineHeight: 18 },
  micro: {
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.4,
    lineHeight: 14,
    textTransform: "uppercase",
  },
} as const;

export type TypeToken = keyof typeof type;

/** Monospace stack for paths, model handles, raw tool I/O. */
export const monoFamily = { ios: "Menlo", android: "monospace", default: "monospace" };

/** 4pt grid. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  gutter: 20,
  xl: 24,
  section: 28,
  xxl: 36,
} as const;

export const radius = {
  row: 12,
  bubble: 18,
  bubbleTail: 4,
  sheet: 24,
  chip: 999,
} as const;

/**
 * Motion spec — one spring family so the whole app shares one personality.
 * Reduced-motion swaps springs for 80ms fades (see useMotion()).
 */
export const motion = {
  /** Pressed states, dot changes. */
  micro: { duration: 120 },
  /** Row insert/remove, capsule count changes, send↔stop morph. */
  move: { damping: 26, stiffness: 300 },
  /** Bottom sheets. */
  sheet: { damping: 28, stiffness: 260 },
  /** Streaming/typing indicator loop. */
  breathe: { duration: 1600, scaleTo: 1.06 },
  /** Streaming text caret pulse. */
  caret: { duration: 600 },
} as const;

export const hit = { minTarget: 44 } as const;

/**
 * Theme context: resolves the system color scheme + the user's chosen theme
 * into a token palette. Components call useTheme() and never touch raw hex.
 *
 * Themes come from the Angus theming library's catalog (auto-generated);
 * "angus" is the house default. Selection persists in AsyncStorage.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";

import { themeCatalog } from "./catalog";
import { palettes, type Palette, type ThemeName } from "./tokens";

const THEME_KEY = "letta.theme";
const THEME_MODE_KEY = "letta.themeMode";
const THEME_LIGHT_KEY = "letta.themeLight";
const THEME_DARK_KEY = "letta.themeDark";

/** User's mode preference — explicit light/dark, or follow the system. */
export type ThemeModePref = "system" | "light" | "dark";

interface Theme {
  name: ThemeName;
  /** Theme selected for the light mode ("angus", "nord", …). */
  lightThemeId: string;
  /** Theme selected for the dark mode. */
  darkThemeId: string;
  /** The theme active for the CURRENT mode (convenience for consumers). */
  themeId: string;
  /** User's light/dark/system preference (persists). */
  modePref: ThemeModePref;
  colors: Palette;
  /** Change the light-mode theme (persists). */
  setLightThemeId: (id: string) => void;
  /** Change the dark-mode theme (persists). */
  setDarkThemeId: (id: string) => void;
  /** Change the mode preference (persists). */
  setModePref: (mode: ThemeModePref) => void;
}

const ThemeContext = createContext<Theme>({
  name: "light",
  lightThemeId: "angus",
  darkThemeId: "angus",
  themeId: "angus",
  modePref: "system",
  colors: palettes.light,
  setLightThemeId: () => {},
  setDarkThemeId: () => {},
  setModePref: () => {},
});

function resolveColors(themeId: string, mode: ThemeName): Palette {
  const entry = themeCatalog[themeId];
  if (!entry) return palettes[mode];
  const exact = entry[mode];
  if (exact) return exact;
  // Single-mode theme (e.g. gruvbox-light picked while in dark mode): it is
  // a deliberate look — apply it to both modes.
  const other = entry[mode === "light" ? "dark" : "light"];
  return other ?? palettes[mode];
}

export function ThemeProvider({
  children,
  /** Force a scheme (used by the /gallery screen to render both themes side by side). */
  force,
}: {
  children: ReactNode;
  force?: ThemeName;
}) {
  const system = useColorScheme();
  // Two theme selections — one per mode — mirroring the Angus theming
  // library's ThemeSettings (lightColorTheme + darkColorTheme). In system
  // mode the OS setting flips between the user's two picks.
  const [lightThemeId, setLightThemeIdState] = useState("angus");
  const [darkThemeId, setDarkThemeIdState] = useState("angus");
  const [modePref, setModePrefState] = useState<ThemeModePref>("system");
  const [loaded, setLoaded] = useState(false);

  // Load the persisted selections once.
  useEffect(() => {
    void Promise.all([
      AsyncStorage.getItem(THEME_KEY),
      AsyncStorage.getItem(THEME_LIGHT_KEY),
      AsyncStorage.getItem(THEME_DARK_KEY),
      AsyncStorage.getItem(THEME_MODE_KEY),
    ])
      .then(([legacyId, lightId, darkId, mode]) => {
        // Migrate the single-selection era: seed both picks from it once.
        if (legacyId && themeCatalog[legacyId]) {
          if (!lightId && themeCatalog[legacyId]) setLightThemeIdState(legacyId);
          if (!darkId && themeCatalog[legacyId]) setDarkThemeIdState(legacyId);
        }
        if (lightId && themeCatalog[lightId]) setLightThemeIdState(lightId);
        if (darkId && themeCatalog[darkId]) setDarkThemeIdState(darkId);
        if (mode === "light" || mode === "dark" || mode === "system") setModePrefState(mode);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const setLightThemeId = (id: string) => {
    setLightThemeIdState(id);
    void AsyncStorage.setItem(THEME_LIGHT_KEY, id).catch(() => {});
  };

  const setDarkThemeId = (id: string) => {
    setDarkThemeIdState(id);
    void AsyncStorage.setItem(THEME_DARK_KEY, id).catch(() => {});
  };

  const setModePref = (mode: ThemeModePref) => {
    setModePrefState(mode);
    void AsyncStorage.setItem(THEME_MODE_KEY, mode).catch(() => {});
  };

  // Explicit preference wins; system follows the OS setting.
  const name: ThemeName = force ?? (modePref === "system" ? (system === "dark" ? "dark" : "light") : modePref);
  const activeId = name === "dark" ? darkThemeId : lightThemeId;
  const value = useMemo<Theme>(
    () => ({
      name,
      lightThemeId,
      darkThemeId,
      themeId: activeId,
      modePref,
      colors: resolveColors(activeId, name),
      setLightThemeId,
      setDarkThemeId,
      setModePref,
    }),
    [name, lightThemeId, darkThemeId, modePref],
  );
  // Wait for the persisted theme before first paint so the app never flashes
  // the default palette when a custom theme is selected.
  if (!loaded) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

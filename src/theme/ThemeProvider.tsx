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

interface Theme {
  name: ThemeName;
  /** Selected catalog theme id ("angus", "nord", …). */
  themeId: string;
  colors: Palette;
  /** Change the catalog theme (persists). */
  setThemeId: (id: string) => void;
}

const ThemeContext = createContext<Theme>({
  name: "light",
  themeId: "angus",
  colors: palettes.light,
  setThemeId: () => {},
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
  const [themeId, setThemeIdState] = useState("angus");
  const [loaded, setLoaded] = useState(false);

  // Load the persisted selection once.
  useEffect(() => {
    void AsyncStorage.getItem(THEME_KEY)
      .then((v) => {
        if (v && themeCatalog[v]) setThemeIdState(v);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const setThemeId = (id: string) => {
    setThemeIdState(id);
    void AsyncStorage.setItem(THEME_KEY, id).catch(() => {});
  };

  const name: ThemeName = force ?? (system === "dark" ? "dark" : "light");
  const value = useMemo<Theme>(
    () => ({ name, themeId, colors: resolveColors(themeId, name), setThemeId }),
    [name, themeId],
  );
  // Wait for the persisted theme before first paint so the app never flashes
  // the default palette when a custom theme is selected.
  if (!loaded) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

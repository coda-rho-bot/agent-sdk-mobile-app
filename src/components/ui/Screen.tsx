/**
 * Screen scaffold: token background, safe areas, and the app's standard
 * header (back affordance, display or compact title, optional status sub-row).
 * Screens own their headers for full design control — the router chrome is off.
 */
import { router } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../../theme/ThemeProvider";
import { space } from "../../theme/tokens";
import { Text } from "./Text";
import { Touchable } from "./Touchable";

export function Screen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      {children}
    </View>
  );
}

interface HeaderProps {
  title: string;
  /** Leading slot between back affordance and title — e.g. an avatar. */
  leading?: ReactNode;
  /** Large editorial title (list screens) vs compact (chat). */
  large?: boolean;
  /** Sub-row under the title, e.g. agent identity + status. */
  subtitle?: ReactNode;
  back?: boolean;
  /** Right-side actions. */
  trailing?: ReactNode;
}

export function Header({ title, large, subtitle, back, leading, trailing }: HeaderProps) {
  return (
    <View style={[styles.header, large && styles.headerLarge]}>
      <View style={styles.headerRow}>
        {back ? (
          <Touchable
            accessibilityLabel="Back"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.back}
          >
            <Text role="title" ink={2}>
              ‹
            </Text>
          </Touchable>
        ) : null}
        {leading}
        <View style={styles.titleBlock}>
          <Text role={large ? "display" : "bodyEm"} numberOfLines={1}>
            {title}
          </Text>
          {subtitle}
        </View>
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: space.gutter, paddingVertical: space.md },
  headerLarge: { paddingTop: space.lg, paddingBottom: space.lg },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  back: { paddingHorizontal: space.xs, minWidth: 32, alignItems: "flex-start" },
  titleBlock: { flex: 1, gap: 2 },
  trailing: { flexDirection: "row", alignItems: "center", gap: space.sm },
});

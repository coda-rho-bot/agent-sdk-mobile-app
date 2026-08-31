/**
 * Root layout: gesture root → theme → navigation stack.
 * Router chrome is disabled; screens render their own headers (Screen/Header)
 * so the design system owns every pixel.
 */
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Notifications from "expo-notifications";

import { ProfilesProvider, useProfiles } from "../lib/profiles/ProfilesContext";
import { configureNotifications, ensureChannel } from "../lib/notificationPoster";
import { startBackgroundPollingForProfile, stopBackgroundPolling } from "../lib/backgroundPolling";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";

/**
 * Root-level background polling lifecycle. The AppState listener lives here
 * (not in the chat screen) so backgrounding from ANY screen polls every
 * conversation whose notification mode resolves to ALL_MESSAGES.
 */
function BackgroundPollingLifecycle() {
  const { activeProfile } = useProfiles();
  const profileRef = useRef(activeProfile);
  profileRef.current = activeProfile;

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        void startBackgroundPollingForProfile(profileRef.current);
      } else if (state === "active") {
        void stopBackgroundPolling();
      }
    });
    return () => {
      sub.remove();
      void stopBackgroundPolling();
    };
  }, []);

  return null;
}

function ThemedStack() {
  const { name, colors } = useTheme();
  return (
    <>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      />
    </>
  );
}

export default function RootLayout() {
  // Configure notifications once at app startup.
  useEffect(() => {
    void (async () => {
      await configureNotifications();
      await ensureChannel();
    })();
    // Navigate to the conversation when a notification is tapped.
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const conversationId = response.notification.request.content.data?.conversationId as string | undefined;
      if (conversationId) {
        // Use router.push with the conversation ID — the chat screen
        // accepts conversationId as a search param.
        // We need to also pass agentId/agentName for the notification
        // to resolve the title. For now, just navigate with the ID.
        const router = require("expo-router").router;
        router.push({
          pathname: "/chat",
          params: { conversationId },
        });
      }
    });
    return () => sub.remove();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ProfilesProvider>
          <BackgroundPollingLifecycle />
          <BottomSheetModalProvider>
            <ThemedStack />
          </BottomSheetModalProvider>
        </ProfilesProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

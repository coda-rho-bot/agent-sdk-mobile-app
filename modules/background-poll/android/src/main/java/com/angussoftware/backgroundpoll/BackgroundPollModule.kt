package com.angussoftware.backgroundpoll

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge for the native background run-completion poller.
 *
 * Why native: JS timers (setTimeout/setInterval) never fire in backgrounded
 * RN contexts — the main context pauses timers on host pause, and headless
 * task contexts (react-native-background-actions) don't drive them at all on
 * the bridgeless runtime. Polling in Kotlin with its own foreground service
 * is immune to both.
 */
class BackgroundPollModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BackgroundPoll")

    AsyncFunction("startPolling") { options: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("No React context available")
      val intent = Intent(context, BackgroundPollService::class.java).apply {
        putExtra("conversations", options["conversations"] as? String ?: "[]")
        putExtra("baseUrl", options["baseUrl"] as? String ?: "https://api.letta.com")
        putExtra("token", options["token"] as? String ?: "")
        putExtra("pollStartedAt", (options["pollStartedAt"] as? Number)?.toLong() ?: System.currentTimeMillis())
        val notified = (options["notifiedRunIds"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
        putStringArrayListExtra("notifiedRunIds", ArrayList(notified))
        putExtra("pollIntervalMs", (options["pollIntervalMs"] as? Number)?.toLong() ?: 20_000L)
        putExtra("avatarShape", options["avatarShape"] as? String ?: "circle")
      }
      // Replace any previous polling instance.
      context.stopService(Intent(context, BackgroundPollService::class.java))
      context.startForegroundService(intent)
    }

    AsyncFunction("setVisibleConversation") { conversationId: String? ->
      BackgroundPollService.reportVisibleConversation(conversationId)
    }

    // Incrementally arm/disarm a one-shot MOBILE_ONLY watch on the live
    // poller (send-time arm — covers leaving the conversation screen while
    // the app stays foreground). Returns false when the poller isn't
    // running; the JS caller then falls back to a full start.
    AsyncFunction("armOneShot") { specJson: String ->
      BackgroundPollService.armOneShot(specJson)
    }

    AsyncFunction("disarmOneShot") { conversationId: String ->
      BackgroundPollService.disarmOneShot(conversationId)
      null
    }

    // True when the live poller still holds an armed one-shot for this
    // conversation — the JS carry-over consults it to avoid re-pushing
    // specs that already fired (retired natively).
    AsyncFunction("isOneShotArmed") { conversationId: String ->
      BackgroundPollService.isOneShotArmed(conversationId)
    }

    // Clear any posted notifications for a conversation the user just opened
    // (they're about to see everything live — the card is stale).
    AsyncFunction("clearConversationNotifications") { conversationId: String ->
      appContext.reactContext?.let {
        BackgroundPollService.clearConversationNotifications(it, conversationId)
      }
    }

    AsyncFunction("stopPolling") {
      val context = appContext.reactContext
      context?.stopService(Intent(context, BackgroundPollService::class.java))
    }
  }
}

package com.angussoftware.backgroundpoll

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground service that REST-polls a conversation's runs and posts a
 * notification when a run started by another client completes.
 *
 * Everything is native (Kotlin + HttpURLConnection): no JS timers, no
 * long-lived sockets. Each poll opens a fresh connection, so OEM socket
 * reaping for backgrounded apps can't starve it — as long as the process
 * is alive (which the foreground service guarantees), polling works.
 */
class BackgroundPollService : Service() {

  private data class ConversationSpec(
    val conversationId: String,
    val agentId: String,
    val title: String,
    val agentName: String = "Agent",
    /** One-shot: notify the next turn-boundary completion, then retire. */
    val onlyLocalRun: Boolean = false,
  )

  private var scheduler: ScheduledExecutorService? = null
  private val notifiedRunIds: MutableSet<String> = HashSet()
  /** Notification avatar shape: "circle" (default), "squircle", or "square". */
  private var avatarShape = "circle"
  /** Run id -> first-seen wall clock, for runs whose reply text is still lagging. */
  private val pendingContent = mutableMapOf<String, Long>()
  private var conversations: List<ConversationSpec> = emptyList()
  /** conversationId → spec, for O(1) sweep filtering. */
  private val watched = ConcurrentHashMap<String, ConversationSpec>()
  /** agentId → profile-picture bitmap, fetched once per service lifetime. */
  private val avatarCache = HashMap<String, Bitmap>()
  /** agentId → messaging Person (avatar + name), built once per service lifetime. */
  private val personCache = HashMap<String, Person>()
  private var baseUrl: String = ""
  private var token: String = ""
  private var pollStartedAt: Long = 0L
  private var pollIntervalMs: Long = 20_000L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      // Null intent = sticky restart after process death. Restore the
      // persisted watch state — if none, there is nothing to watch.
      val restored = restorePersistedState()
      if (!restored) {
        Log.i(TAG, "sticky restart with no persisted state — stopping")
        stopSelf()
        return START_NOT_STICKY
      }
      startForeground(FGS_NOTIFICATION_ID, buildFgsNotification())
      Log.i(TAG, "sticky restart restored convs=${conversations.size}")
      scheduleSweeps()
      return START_REDELIVER_INTENT
    }
    conversations = parseConversations(intent.getStringExtra("conversations"))
    watched.clear()
    for (c in conversations) watched[c.conversationId] = c
    baseUrl = intent.getStringExtra("baseUrl") ?: "https://api.letta.com"
    token = intent.getStringExtra("token") ?: ""
    pollStartedAt = intent.getLongExtra("pollStartedAt", System.currentTimeMillis())
    pollIntervalMs = intent.getLongExtra("pollIntervalMs", 20_000L)
    val newShape = intent.getStringExtra("avatarShape") ?: "circle"
    if (newShape != avatarShape) {
      // Icon caches (person, shortcut) hold masked bitmaps — a shape change
      // must invalidate them so the next notification renders the new mask.
      avatarShape = newShape
      personCache.clear()
      try {
        ShortcutManagerCompat.removeAllDynamicShortcuts(this)
      } catch (_: Exception) {}
    }
    // Seed dedup with run IDs the JS stream already notified. Synchronized:
    // the poll thread reads/writes this set under the same lock — an
    // unsynchronized clear/addAll here can corrupt dedup (duplicate
    // notifications) when a re-start lands between poll sweeps.
    // REDELIVER reconciliation: a redelivered intent (process death) carries
    // the ORIGINAL pollStartedAt (old runs stay eligible) but a STALE dedup
    // seed — merge the persisted set so runs the dead instance already
    // notified don't re-fire. For fresh enumeration starts pollStartedAt is
    // now, so the merged old IDs are excluded by the time window anyway.
    synchronized(notifiedRunIds) {
      notifiedRunIds.clear()
      notifiedRunIds.addAll(intent.getStringArrayListExtra("notifiedRunIds") ?: ArrayList())
      try {
        val saved = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getStringSet("notifiedRunIds", null)
        if (saved != null) notifiedRunIds.addAll(saved)
      } catch (_: Exception) {}
    }

    if (conversations.isEmpty() || token.isEmpty()) {
      Log.e(TAG, "no conversations or token — stopping")
      stopSelf()
      return START_NOT_STICKY
    }

    persistState()

    startForeground(FGS_NOTIFICATION_ID, buildFgsNotification())
    Log.i(TAG, "polling started convs=${conversations.size} interval=${pollIntervalMs}ms seeded=${notifiedRunIds.size}")

    scheduleSweeps()
    return START_REDELIVER_INTENT
  }

  private fun scheduleSweeps() {
    scheduler?.shutdownNow()
    scheduler = Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "bg-run-poll").apply { isDaemon = true }
    }.also {
      it.scheduleWithFixedDelay({ pollOnce() }, 0L, pollIntervalMs, TimeUnit.MILLISECONDS)
    }
  }

  /**
   * Persist watch state so a sticky restart (process killed, service
   * re-delivered) restores the exact watch list instead of silently dying.
   * Written on every explicit startPolling. One-shot (onlyLocalRun) specs
   * are excluded — they are per-turn and must not survive a process death.
   * notifiedRunIds are persisted from the poll thread's adds (best-effort,
   * last-write-wins on the shared prefs editor).
   */
  private fun persistState() {
    try {
      val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
      val arr = JSONArray()
      for (spec in watched.values) if (!spec.onlyLocalRun) arr.put(specToJson(spec))
      prefs.edit()
        .putString("specs", arr.toString())
        .putString("baseUrl", baseUrl)
        .putString("token", token)
        .putLong("pollStartedAt", pollStartedAt)
        .putLong("pollIntervalMs", pollIntervalMs)
        .putString("avatarShape", avatarShape)
        .apply()
    } catch (e: Exception) {
      Log.w(TAG, "persist failed: ${e.message}")
    }
  }

  /** Restore from persistState — false when nothing persisted. */
  private fun restorePersistedState(): Boolean {
    return try {
      val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
      val specsJson = prefs.getString("specs", null) ?: return false
      token = prefs.getString("token", "") ?: ""
      if (token.isEmpty()) return false
      baseUrl = prefs.getString("baseUrl", "https://api.letta.com") ?: "https://api.letta.com"
      pollStartedAt = prefs.getLong("pollStartedAt", 0L)
      pollIntervalMs = prefs.getLong("pollIntervalMs", 20_000L)
      avatarShape = prefs.getString("avatarShape", "circle") ?: "circle"
      conversations = parseConversations(specsJson)
      watched.clear()
      for (c in conversations) watched[c.conversationId] = c
      // Dedup: restored from prefs (the live set), NOT the redelivered
      // intent's stale seed.
      synchronized(notifiedRunIds) {
        notifiedRunIds.clear()
        notifiedRunIds.addAll(prefs.getStringSet("notifiedRunIds", emptySet()) ?: emptySet())
      }
      conversations.isNotEmpty()
    } catch (e: Exception) {
      Log.w(TAG, "restore failed: ${e.message}")
      false
    }
  }

  private fun specToJson(spec: ConversationSpec): JSONObject {
    return JSONObject()
      .put("conversationId", spec.conversationId)
      .put("agentId", spec.agentId)
      .put("title", spec.title)
      .put("agentName", spec.agentName)
      .put("onlyLocalRun", spec.onlyLocalRun)
  }

  /** Persist the dedup set (called under the notifiedRunIds lock). */
  private fun persistNotifiedRunIds() {
    try {
      getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        .edit()
        .putStringSet("notifiedRunIds", HashSet(notifiedRunIds))
        .apply()
    } catch (_: Exception) {}
  }

  /**
   * User swiped the app away: the process dies with the service. Keep the
   * service scheduled — START_REDELIVER_INTENT restarts it with the null
   * intent path restoring persisted state. Without this override the
   * default behavior stops the service on task removal.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    Log.i(TAG, "task removed — service persists via redelivery")
    super.onTaskRemoved(rootIntent)
  }

  /** conversations extra: JSON array [{"conversationId":"...","agentId":"...","title":"..."}] */
  private fun parseConversations(json: String?): List<ConversationSpec> {
    if (json.isNullOrEmpty()) return emptyList()
    return try {
      val arr = JSONArray(json)
      (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        parseSpecObject(o)
      }
    } catch (e: Exception) {
      Log.e(TAG, "bad conversations JSON: ${e.message}")
      emptyList()
    }
  }

  /** Parse a single spec object (shared by array parsing and armOneShot). */
  private fun parseSpecObject(o: JSONObject): ConversationSpec? {
    val cid = o.optString("conversationId")
    if (cid.isEmpty()) return null
    return ConversationSpec(
      cid,
      o.optString("agentId"),
      o.optString("title").ifEmpty { "Conversation" },
      o.optString("agentName").ifEmpty { "Agent" },
      o.optBoolean("onlyLocalRun", false),
    )
  }

  /** Parse a single spec from its JSON encoding (one object, not an array). */
  private fun parseOneSpec(json: String): ConversationSpec? {
    return try {
      parseSpecObject(JSONObject(json))
    } catch (e: Exception) {
      Log.e(TAG, "bad spec JSON: ${e.message}")
      null
    }
  }

  /**
   * Turn-end notification semantics: agentic turns spawn a chain of runs —
   * one user-message run, then one approval run per tool round. Mid-turn
   * approval runs have status "completed" but stop_reason "requires_approval";
   * the run that actually ENDS the turn has stop_reason "end_turn" (or an
   * error/limit reason). Notify only on those turn-boundary runs — one
   * notification per turn, content = the agent's final reply.
   *
   * Cost model: ONE unfiltered /v1/runs sweep per cycle regardless of how
   * many conversations are watched — run objects carry conversation_id, so
   * the watched-set filter is client-side. Polling cost stays flat as the
   * watched set grows.
   */
  private fun pollOnce() {
    var notifications = 0
    try {
      val body = httpGet("$baseUrl/v1/runs?limit=$SWEEP_LIMIT")
      val runs = JSONArray(body) // newest first
      for (i in 0 until runs.length()) {
        val run = runs.optJSONObject(i) ?: continue
        val id = run.optString("id")
        val convId = run.optString("conversation_id")
        if (id.isEmpty() || convId.isEmpty()) continue
        if (convId == visibleConversationId) continue // user is viewing it — the UI already shows it live
        val spec = watched[convId] ?: continue // not a watched conversation
        val status = run.optString("status")
        if (status != "completed" && status != "failed" && status != "cancelled") continue
        val stopReason = run.optString("stop_reason")
        if (stopReason == "requires_approval") continue // mid-turn
        val completedAt = parseIso(run.optString("completed_at"))
        // Only runs finishing after polling began (5s margin for clock skew).
        if (completedAt != null && completedAt < pollStartedAt - 5_000L) continue
        // The user is viewing this conversation — the turn already played out
        // live in front of them. CONSUME the run so it doesn't fire when they
        // leave the screen (the "queued notification" bug). One-shot specs
        // retire too: the turn they were armed for has ended.
        if (convId == visibleConversationId) {
          synchronized(notifiedRunIds) { notifiedRunIds.add(id) }
          if (spec.onlyLocalRun) watched.remove(convId)
          continue
        }
        // The turn completed while the user was on that screen (they left
        // before this sweep ran): it already played out live — consume it,
        // don't notify retroactively. 5s margin absorbs clock skew.
        val visUntil = visibleUntil[convId]
        if (completedAt != null && visUntil != null && completedAt <= visUntil + 5_000L) {
          synchronized(notifiedRunIds) { notifiedRunIds.add(id) }
          if (spec.onlyLocalRun) watched.remove(convId)
          continue
        }
        val isNew: Boolean
        synchronized(notifiedRunIds) {
          isNew = notifiedRunIds.add(id)
          if (isNew && notifiedRunIds.size > 500) notifiedRunIds.clear()
          if (isNew) persistNotifiedRunIds()
        }
        if (!isNew) continue
        val reply = findLatestAssistantText(convId, run.optString("created_at"))?.let { truncate(it) }
        val trigger = if (reply != null) null else findUserTrigger(runs, convId)?.let { truncate(it) }
        val content = reply ?: trigger
        if (content == null) {
          // The messages endpoint lags writes: the reply is often not visible
          // yet when the sweep fires seconds after turn end. Defer — retry on
          // the next sweeps before falling back to the generic text.
          val first = pendingContent[id] ?: System.currentTimeMillis().also { pendingContent[id] = it }
          if (System.currentTimeMillis() - first < CONTENT_WAIT_MS && notifications < 3) continue
          pendingContent.remove(id)
        } else {
          pendingContent.remove(id)
        }
        val fallback = if (status == "completed") "Run complete" else "Run ended with an error"
        Log.i(TAG, "turn ended (run ${id.takeLast(8)}, $status/$stopReason) conv=${convId.takeLast(8)} — posting notification")
        postCompletionNotification(spec, content ?: fallback)
        notifications++
        // One-shot watch (MOBILE_ONLY with a local run in flight): the turn
        // this spec was registered for just ended — retire it so the poller
        // stops watching this conversation.
        if (spec.onlyLocalRun) {
          watched.remove(convId)
          Log.i(TAG, "one-shot spec retired conv=${convId.takeLast(8)}")
        }
        if (notifications >= 3) break // don't storm on catch-up sweeps
      }
    } catch (e: Exception) {
      // Transient network/API errors — retry next cycle.
      Log.w(TAG, "sweep failed: ${e.message}")
    }
    Log.d(TAG, "sweep done ($notifications notified)")
  }

  /**
   * The agent's final reply: newest assistant_message dated at/after the
   * run's start. The messages endpoint returns newest-first; content is a
   * plain string or a content-block array (API shape varies).
   */
  private fun findLatestAssistantText(conversationId: String, runCreatedAtIso: String): String? {
    return try {
      val body = httpGet("$baseUrl/v1/conversations/$conversationId/messages?limit=10")
      val msgs = JSONArray(body)
      val runStart = parseIso(runCreatedAtIso)
      for (i in 0 until msgs.length()) {
        val m = msgs.optJSONObject(i) ?: continue
        if (m.optString("message_type") != "assistant_message") continue
        val date = parseIso(m.optString("date"))
        // Skip replies that predate this run (previous turns).
        if (runStart != null && date != null && date < runStart) continue
        val text = extractContentText(m.opt("content")) ?: continue
        return text
      }
      null
    } catch (e: Exception) {
      Log.w(TAG, "assistant fetch failed conv=${conversationId.takeLast(8)}: ${e.message}")
      null
    }
  }

  /** Walk the run list (newest first, cross-conversation) for the latest
   * user-role initial message in the given conversation. */
  private fun findUserTrigger(runs: JSONArray, conversationId: String): String? {
    for (i in 0 until runs.length()) {
      val run = runs.optJSONObject(i) ?: continue
      if (run.optString("conversation_id") != conversationId) continue
      val msgs = run.optJSONObject("request_config")?.optJSONArray("initial_messages") ?: continue
      if (msgs.length() == 0) continue
      val first = msgs.optJSONObject(0) ?: continue
      if (first.optString("role") != "user") continue
      val text = extractContentText(first.opt("content")) ?: continue
      return text
    }
    return null
  }

  /** Content can be a plain string or a content-block array; skip system-reminder blocks. */
  private fun extractContentText(content: Any?): String? {
    return when (content) {
      is String -> content.takeIf { it.isNotBlank() }
      is JSONArray -> (0 until content.length())
        .mapNotNull { i -> content.optJSONObject(i)?.optString("text")?.takeIf { it.isNotEmpty() } }
        .filterNot { it.startsWith("<system") }
        .joinToString(" ")
        .takeIf { it.isNotBlank() }
      else -> null
    }
  }

  /** Single-line clamp for the notification body. */
  private fun truncate(text: String): String {
    val oneLine = text.replace('\n', ' ').trim()
    return if (oneLine.length <= 120) oneLine else oneLine.take(119) + "…"
  }

  private fun httpGet(url: String): String {
    val conn = URL(url).openConnection() as HttpURLConnection
    try {
      conn.connectTimeout = 10_000
      conn.readTimeout = 15_000
      conn.requestMethod = "GET"
      conn.setRequestProperty("Authorization", "Bearer $token")
      conn.setRequestProperty("Accept", "application/json")
      val code = conn.responseCode
      if (code != 200) {
        throw RuntimeException("HTTP $code")
      }
      return conn.inputStream.bufferedReader().use(BufferedReader::readText)
    } finally {
      conn.disconnect()
    }
  }

  private fun parseIso(iso: String?): Long? {
    if (iso.isNullOrEmpty()) return null
    val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
    fmt.timeZone = TimeZone.getTimeZone("UTC")
    return try {
      // "2026-08-31T11:52:06.624Z" — truncate fractional seconds + Z.
      val prefix = if (iso.length >= 19) iso.substring(0, 19) else iso
      fmt.parse(prefix)?.time
    } catch (e: Exception) {
      null
    }
  }

  private fun buildFgsNotification(): Notification {
    ensureChannels()
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, FGS_CHANNEL_ID)
        .setContentTitle("Agents Chat")
        .setContentText("Checking for completed runs")
        .setSmallIcon(applicationInfo.icon)
        .setOngoing(true)
        .build()
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
        .setContentTitle("Agents Chat")
        .setContentText("Checking for completed runs")
        .setSmallIcon(applicationInfo.icon)
        .setOngoing(true)
        .build()
    }
  }

  /**
   * The agent's profile picture as a Bitmap, fetched once per agent per
   * service lifetime and cached. Returns null when the agent has no picture
   * or anything fails — the notification then uses the default app icon.
   */
  private fun avatarFor(spec: ConversationSpec): Bitmap? {
    avatarCache[spec.agentId]?.let { return it }
    // Disk cache first — survives app restarts, so the first notification
    // after a reboot already carries the agent picture.
    val disk = loadAvatarFromDisk(spec.agentId)
    if (disk != null) {
      avatarCache[spec.agentId] = disk
      // Refresh from the network in the background; the cached copy renders now.
      scheduler?.submit { fetchAvatarFromNetwork(spec) }
      return disk
    }
    return fetchAvatarFromNetwork(spec)
  }

  /**
   * Profile picture masked to the configured notification shape: circle
   * (default — matches the app's rounded avatars), squircle, or the raw
   * square. Masked copies only — the fetch/disk cache keeps raw bitmaps so
   * a shape change applies without a refetch. A separate small cache keyed
   * by agentId+shape avoids re-masking on every notification.
   */
  private val maskedIconCache = HashMap<String, Bitmap>()
  private fun maskedAvatarFor(spec: ConversationSpec): Bitmap? {
    val key = "${spec.agentId}:$avatarShape"
    maskedIconCache[key]?.let { return it }
    val raw = avatarFor(spec) ?: return null
    val masked = when (avatarShape) {
      "square" -> raw
      "squircle" -> maskToSuperellipse(raw)
      else -> maskToCircle(raw)
    }
    maskedIconCache[key] = masked
    return masked
  }

  /** Circular mask via Porter-Duff destination-in — the standard approach. */
  private fun maskToCircle(src: Bitmap): Bitmap {
    val size = minOf(src.width, src.height)
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(out)
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    // Center-crop to the square canvas first, then punch the circle.
    val offX = (src.width - size) / 2
    val offY = (src.height - size) / 2
    paint.shader = android.graphics.BitmapShader(src, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP)
    val matrix = android.graphics.Matrix()
    matrix.setTranslate(-offX.toFloat(), -offY.toFloat())
    paint.shader.setLocalMatrix(matrix)
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    return out
  }

  /**
   * Squircle (superellipse n=4) mask — the "continuously rounded" shape
   * modern launchers use. Built as a Path: parametric superellipse points
   * stitched with line segments (smooth at icon sizes).
   */
  private fun maskToSuperellipse(src: Bitmap): Bitmap {
    val size = minOf(src.width, src.height)
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(out)
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    val offX = (src.width - size) / 2
    val offY = (src.height - size) / 2
    paint.shader = android.graphics.BitmapShader(src, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP)
    val matrix = android.graphics.Matrix()
    matrix.setTranslate(-offX.toFloat(), -offY.toFloat())
    paint.shader.setLocalMatrix(matrix)
    val n = 4.0
    val half = size / 2.0
    val path = android.graphics.Path()
    var first = true
    val steps = 96
    for (i in 0 until steps) {
      val theta = 2.0 * Math.PI * i / steps
      // |cos|^(-2/n)-style parametric superellipse: x = a·sign(cos)|cos|^(2/n)
      val ct = Math.cos(theta)
      val st = Math.sin(theta)
      val x = half * Math.signum(ct) * Math.pow(Math.abs(ct), 2.0 / n) + half
      val y = half * Math.signum(st) * Math.pow(Math.abs(st), 2.0 / n) + half
      if (first) { path.moveTo(x.toFloat(), y.toFloat()); first = false }
      else path.lineTo(x.toFloat(), y.toFloat())
    }
    path.close()
    canvas.drawPath(path, paint)
    return out
  }

  private fun avatarFile(agentId: String): File {
    val dir = File(filesDir, "avatars")
    if (!dir.exists()) dir.mkdirs()
    return File(dir, "$agentId.png")
  }

  private fun loadAvatarFromDisk(agentId: String): Bitmap? {
    return try {
      val f = avatarFile(agentId)
      if (!f.exists()) return null
      BitmapFactory.decodeFile(f.absolutePath)
    } catch (e: Exception) {
      null
    }
  }

  private fun fetchAvatarFromNetwork(spec: ConversationSpec): Bitmap? {
    return try {
      val body = httpGet("$baseUrl/v1/agents/${spec.agentId}/profile-picture")
      val dataUrl = JSONObject(body).optString("data_url")
      val b64 = dataUrl.substringAfter("base64,", "")
      if (b64.isEmpty()) return null
      val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
      val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      if (bmp != null) {
        avatarCache[spec.agentId] = bmp
        try {
          java.io.FileOutputStream(avatarFile(spec.agentId)).use { out ->
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
          }
        } catch (e: Exception) {
          Log.w(TAG, "avatar disk write failed: ${e.message}")
        }
        Log.d(TAG, "avatar loaded for agent ${spec.agentId.takeLast(8)} (${bytes.size}B)")
      }
      bmp
    } catch (e: Exception) {
      Log.d(TAG, "no avatar for agent ${spec.agentId.takeLast(8)}: ${e.message}")
      null
    }
  }

  /**
   * The agent as a messaging Person: profile picture when available, else the
   * system's initial-letter avatar. Cached per service lifetime.
   */
  private fun personFor(spec: ConversationSpec): Person {
    personCache[spec.agentId]?.let { return it }
    // The Person is the AGENT (like a WhatsApp contact); the conversation
    // title renders from the channel header. Both being the title showed
    // "two different conversation titles" whenever vintages diverged.
    val builder = Person.Builder().setName(spec.agentName).setKey(spec.agentId)
    maskedAvatarFor(spec)?.let { builder.setIcon(IconCompat.createWithBitmap(it)) }
    return builder.build().also { personCache[spec.agentId] = it }
  }

  /**
   * Conversation channel for the spec: a channel linked (via
   * setConversationId) to a dynamic shortcut carrying the agent avatar.
   * This is the Android 11+ "conversation notification" mechanism — Samsung's
   * shade renders the shortcut's avatar on the collapsed row's left side
   * (like Google Messages), instead of the app launcher icon. Returns the
   * channel id to notify on.
   */
  /** Push/refresh the long-lived conversation shortcut (label = current title). */
  private fun pushConversationShortcut(spec: ConversationSpec) {
    val deepLink = Uri.parse(
      "agents-chat://chat?conversationId=${spec.conversationId}&agentId=${spec.agentId}&agentName=${Uri.encode(spec.agentName)}&title=${Uri.encode(spec.title)}"
    )
    val intent = Intent(Intent.ACTION_VIEW, deepLink).setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val iconRes = resources.getIdentifier("notif_transparent", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    val avatar = maskedAvatarFor(spec)
    val shortcut = ShortcutInfoCompat.Builder(this, spec.conversationId)
      .setShortLabel(spec.title)
      .setLongLabel(spec.title)
      .setCategories(setOf("android.shortcut.conversation"))
      .setIcon(
        avatar?.let { IconCompat.createWithBitmap(it) }
          ?: IconCompat.createWithResource(this, iconRes)
      )
      .setIntent(intent)
      .setLongLived(true)
      .build()
    try {
      ShortcutManagerCompat.pushDynamicShortcut(this, shortcut)
    } catch (e: Exception) {
      Log.w(TAG, "shortcut push failed conv=${spec.conversationId.takeLast(8)}: ${e.message}")
    }
  }

  private fun ensureConversationChannel(spec: ConversationSpec, avatar: Bitmap?): String {
    val channelId = "conv-${spec.conversationId.hashCode()}"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return CONVERSATIONS_CHANNEL_ID
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    val existing = nm.getNotificationChannel(channelId)
    if (existing != null) {
      // Renamed conversation: BOTH the channel name and the conversation
      // SHORTCUT label are frozen at first creation, and One UI renders the
      // shortcut label as the conversation header — a stale label plus a
      // current spec.title shows two different titles in one notification.
      // Refresh both: channel name/description (mutable fields) and a
      // re-pushed shortcut with the current label.
      if (existing.name != spec.title) {
        existing.name = spec.title
        existing.description = "Run completions for ${spec.title}"
        nm.createNotificationChannel(existing)
        pushConversationShortcut(spec)
      }
      return channelId
    }

    pushConversationShortcut(spec)
    val channel = NotificationChannel(channelId, spec.title, NotificationManager.IMPORTANCE_HIGH)
      .apply {
        description = "Run completions for ${spec.title}"
        // parentChannelId = the preexisting "conversations" channel;
        // conversationId = the shortcut id (links the channel to the shortcut).
        setConversationId(CONVERSATIONS_CHANNEL_ID, spec.conversationId)
      }
    try {
      nm.createNotificationChannel(channel)
    } catch (e: Exception) {
      // Samsung validates ordering strictly (parent + shortcut must have
      // settled). The shortcut is now pushed — the next notify succeeds. Until
      // then, fall back to the generic channel so the notification still posts.
      Log.w(TAG, "conversation channel failed: ${e.message}")
      return CONVERSATIONS_CHANNEL_ID
    }
    return channelId
  }

  private fun postCompletionNotification(spec: ConversationSpec, bodyText: String) {
    ensureChannels()
    val deepLink = Uri.parse(
      "agents-chat://chat?conversationId=${spec.conversationId}&agentId=${spec.agentId}&agentName=${Uri.encode(spec.agentName)}&title=${Uri.encode(spec.title)}"
    )
    val intent = Intent(Intent.ACTION_VIEW, deepLink).setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pending = PendingIntent.getActivity(
      this, spec.conversationId.hashCode(), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    // Conversation-style notification: Android renders the person's avatar
    // (profile picture, or initial-letter circle without one) on the LEFT —
    // same as SMS/WhatsApp rows. The transparent small icon keeps any
    // leftover app-badge invisible.
    val avatar = maskedAvatarFor(spec)
    val channelId = ensureConversationChannel(spec, avatar)
    val person = personFor(spec)
    // One UI's collapsed row renders the LARGE icon as its left-side image;
    // without it the row falls back to the small (app) icon. Set both the
    // person avatar (expanded layout) and the large icon (collapsed row).
    // Platform Notification.Builder (not Compat): setSmallIcon(Icon) — needed
    // for the per-agent app-bar icon — exists only on the platform builder.
    // MessagingStyle/Person are platform APIs since 24; we're 26+.
    val smallIcon = if (avatar != null) {
      android.graphics.drawable.Icon.createWithBitmap(avatar)
    } else {
      val resId = resources.getIdentifier("ic_launcher_foreground", "mipmap", packageName)
        .takeIf { it != 0 }
        ?: resources.getIdentifier("ic_launcher_foreground", "drawable", packageName)
          .takeIf { it != 0 }
        ?: applicationInfo.icon
      android.graphics.drawable.Icon.createWithResource(packageName, resId)
    }
    val platformPerson = person.toAndroidPerson()
    val style = Notification.MessagingStyle(platformPerson)
      .addMessage(Notification.MessagingStyle.Message(bodyText, System.currentTimeMillis(), platformPerson))
    val notification =
      Notification.Builder(this, channelId)
        .setSmallIcon(smallIcon)
        .setContentIntent(pending)
        .setAutoCancel(true)
        .setShortcutId(spec.conversationId)
        .setLargeIcon(avatar)
        .setStyle(style)
        .build()
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(spec.conversationId.hashCode(), notification)
  }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    // High-importance alert channel — matches the JS-side poster's channel id.
    if (nm.getNotificationChannel(CONVERSATIONS_CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          CONVERSATIONS_CHANNEL_ID, "Conversation activity", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "Run completions and agent activity" }
      )
    }
    // Silent persistent channel for the foreground-service notification.
    if (nm.getNotificationChannel(FGS_CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          FGS_CHANNEL_ID, "Background polling", NotificationManager.IMPORTANCE_MIN
        ).apply { description = "Keeps run-completion checks running while backgrounded" }
      )
    }
  }

  override fun onDestroy() {
    scheduler?.shutdownNow()
    scheduler = null
    Log.i(TAG, "polling stopped")
    instance = null
    super.onDestroy()
  }

  companion object {
    const val TAG = "BG-POLL"
    /** Live service instance — enables incremental arm/disarm without a full restart. */
    @Volatile
    private var instance: BackgroundPollService? = null

    /**
     * Incrementally arm a one-shot watch on the LIVE service instance (no
     * restart, no re-enumeration). Called by the module when a local run
     * starts in a MOBILE_ONLY conversation — the send-time arm is what
     * covers the "user leaves the conversation screen while the app stays
     * foreground" gap: the chat session tears down on unmount, so JS-side
     * delivery dies, and no AppState change fires to trigger enumeration.
     * Returns false when the service isn't running (caller falls back to a
     * full start via startPolling).
     */
    fun armOneShot(specJson: String): Boolean {
      val svc = instance ?: return false
      val spec = svc.parseOneSpec(specJson) ?: return false
      // Don't clobber a regular (ALL_MESSAGES) watch with a one-shot.
      val existing = svc.watched[spec.conversationId]
      if (existing != null && !existing.onlyLocalRun) {
        Log.i(TAG, "arm conv=${spec.conversationId.takeLast(8)} skipped — regular watch active")
        return true
      }
      svc.watched[spec.conversationId] = spec
      Log.i(TAG, "one-shot armed at send time conv=${spec.conversationId.takeLast(8)}")
      return true
    }

    /** Disarm a one-shot spec (send failed — nothing to watch for). */
    fun disarmOneShot(conversationId: String) {
      val svc = instance ?: return
      val existing = svc.watched[conversationId]
      if (existing?.onlyLocalRun == true) {
        svc.watched.remove(conversationId)
        Log.i(TAG, "one-shot disarmed conv=${conversationId.takeLast(8)}")
      }
    }

    /**
     * True when the live service still holds an armed one-shot spec for this
     * conversation (false when retired, disarmed, or service not running).
     * The JS carry-over consults this so a spec that already fired (native
     * retirement) is NOT re-pushed on re-enumeration — re-pushing a retired
     * spec would make a MOBILE_ONLY conversation notify on any EXTERNAL run
     * (the poller can't distinguish client identity).
     */
    fun isOneShotArmed(conversationId: String): Boolean {
      val svc = instance ?: return false
      return svc.watched[conversationId]?.onlyLocalRun == true
    }

    /** How long a completed run may wait for lagging reply text before the generic fallback posts. */
    const val CONTENT_WAIT_MS = 30_000L
    /** The conversation currently on screen — notifications for it are suppressed. */
    @Volatile
    var visibleConversationId: String? = null
    /**
     * Per-conversation wall clock of when the user LAST left that screen —
     * runs completing before this stamp played out in front of the user and
     * must be consumed even if the next sweep runs after they left (the
     * leave-before-sweep window that fired retroactive notifications).
     */
    private val visibleUntil = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /** Visibility transition recorder — called by the module on every change. */
    fun reportVisibleConversation(conversationId: String?) {
      val previous = visibleConversationId
      if (previous != null && previous != conversationId) {
        visibleUntil[previous] = System.currentTimeMillis()
      }
      visibleConversationId = conversationId
    }

    /** Cancel posted notifications for a conversation (user opened it). */
    fun clearConversationNotifications(context: android.content.Context, conversationId: String) {
      NotificationManagerCompat.from(context).cancel(conversationId.hashCode())
    }
    const val FGS_NOTIFICATION_ID = 93001
    const val PREFS_NAME = "bg_poll_state"
    const val FGS_CHANNEL_ID = "background_polling"
    const val CONVERSATIONS_CHANNEL_ID = "conversations"
    /** Runs fetched per sweep — one request covers every watched conversation. */
    const val SWEEP_LIMIT = 50
  }
}

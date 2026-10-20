package expo.modules.transferservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Foreground service (type dataSync) that keeps LocalDrop's process alive while a file transfer
 * runs in the background, shows an ongoing progress notification, and holds a partial wake lock
 * plus a Wi-Fi lock so the CPU / radio are not put to sleep mid-transfer.
 *
 * The transfer itself still runs in the React Native JS runtime; this service only provides the
 * process priority, the notification and the locks.
 */
class TransferForegroundService : Service() {

  companion object {
    const val CHANNEL_PROGRESS = "localdrop_transfer_progress"
    const val CHANNEL_RESULT = "localdrop_transfer_result"
    const val NOTIFICATION_ID = 4101
    const val RESULT_NOTIFICATION_ID = 4102

    const val ACTION_START = "expo.modules.transferservice.START"
    const val ACTION_CANCEL = "expo.modules.transferservice.CANCEL"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"

    /** Safety net so a leaked lock can never drain the battery forever. */
    private const val WAKELOCK_TIMEOUT_MS = 12L * 60L * 60L * 1000L

    /**
     * While running, emit a "tick" to JS this often. React Native pauses JS timers when the app
     * is in the background, but native events keep flowing, so JS waits are woken by these.
     */
    private const val TICK_INTERVAL_MS = 200L

    /** JS asked for the service to run. Guards the start()/stop() race (stop before onStartCommand). */
    @Volatile
    var wanted = false

    @Volatile
    var instance: TransferForegroundService? = null

    /** Receives "cancel" (notification button) and "timeout" (Android 15 dataSync time limit). */
    @Volatile
    var actionListener: ((String) -> Unit)? = null

    /** Receives (level, message) so native events reach the app's Diagnostics log. */
    @Volatile
    var logListener: ((String, String) -> Unit)? = null

    fun log(level: String, message: String) {
      when (level) {
        "error" -> Log.e("LocalDropTransfer", message)
        "warn" -> Log.w("LocalDropTransfer", message)
        else -> Log.i("LocalDropTransfer", message)
      }
      try {
        logListener?.invoke(level, message)
      } catch (_: Exception) {
        // JS runtime may be gone
      }
    }

    fun ensureChannels(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_PROGRESS) == null) {
        val ch = NotificationChannel(
          CHANNEL_PROGRESS,
          "File transfer progress",
          NotificationManager.IMPORTANCE_LOW
        )
        ch.description = "Shows progress while LocalDrop sends or receives files"
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
      }
      if (nm.getNotificationChannel(CHANNEL_RESULT) == null) {
        val ch = NotificationChannel(
          CHANNEL_RESULT,
          "File transfer results",
          NotificationManager.IMPORTANCE_DEFAULT
        )
        ch.description = "Tells you when a transfer finished or failed"
        nm.createNotificationChannel(ch)
      }
    }

    private fun launchPendingIntent(ctx: Context): PendingIntent? {
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
      return PendingIntent.getActivity(
        ctx,
        0,
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }

    private fun newBuilder(ctx: Context, channel: String): Notification.Builder {
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(ctx, channel)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(ctx)
      }
    }

    /** A normal (dismissable) notification, e.g. "Transfer complete" / "Transfer failed". */
    fun showResult(ctx: Context, title: String, text: String, success: Boolean) {
      ensureChannels(ctx)
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val b = newBuilder(ctx, CHANNEL_RESULT)
        .setSmallIcon(
          if (success) android.R.drawable.stat_sys_download_done
          else android.R.drawable.stat_notify_error
        )
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(Notification.BigTextStyle().bigText(text))
        .setAutoCancel(true)
      launchPendingIntent(ctx)?.let { b.setContentIntent(it) }
      nm.notify(RESULT_NOTIFICATION_ID, b.build())
      log("info", "result notification posted: success=$success notificationsEnabled=${nm.areNotificationsEnabled()}")
    }

    fun clearResult(ctx: Context) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.cancel(RESULT_NOTIFICATION_ID)
    }
  }

  private var isForeground = false
  private var updateFailureLogged = false
  private val handler = Handler(Looper.getMainLooper())
  private val tickRunnable = object : Runnable {
    override fun run() {
      if (!isForeground) return
      try {
        actionListener?.invoke("tick")
      } catch (_: Exception) {
        // JS side may be gone
      }
      handler.postDelayed(this, TICK_INTERVAL_MS)
    }
  }
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    ensureChannels(this)
    log("info", "service created")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_CANCEL) {
      // Notification "Cancel" button. JS performs the actual cancel and then calls stop().
      log("warn", "cancel action received (foreground=$isForeground)")
      try {
        actionListener?.invoke("cancel")
      } catch (_: Exception) {
        // JS side may be gone
      }
      if (!isForeground) stopSelf()
      return START_NOT_STICKY
    }

    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "LocalDrop"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Transferring files…"

    try {
      val notification = buildProgressNotification(title, text, null, -1)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      isForeground = true
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      log(
        "info",
        "startForeground ok (api=${Build.VERSION.SDK_INT}, notificationsEnabled=${nm.areNotificationsEnabled()})"
      )
    } catch (e: Exception) {
      // e.g. started from the background on a newer Android: give up quietly, the transfer
      // simply runs without background protection.
      log("error", "startForeground failed: ${e.javaClass.simpleName}: ${e.message}")
      stopSelf()
      return START_NOT_STICKY
    }

    acquireLocks()
    handler.removeCallbacks(tickRunnable)
    handler.postDelayed(tickRunnable, TICK_INTERVAL_MS)

    // stop() may have been called before the service finished starting.
    if (!wanted) {
      log("info", "stop was requested before start finished; shutting down")
      shutdown()
    }
    return START_NOT_STICKY
  }

  /** Android 15+: dataSync services get ~6 h per 24 h. Must stop quickly or the app is killed. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    log("warn", "onTimeout fgsType=$fgsType (Android dataSync time limit)")
    try {
      actionListener?.invoke("timeout")
    } catch (_: Exception) {
      // ignore
    }
    try {
      showResult(
        this,
        "Transfer is no longer protected",
        "Android limits background transfers. Open LocalDrop to keep it running.",
        false
      )
    } catch (_: Exception) {
      // ignore
    }
    shutdown()
  }

  fun update(title: String, text: String, subText: String?, progress: Int) {
    if (!isForeground) return
    try {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.notify(NOTIFICATION_ID, buildProgressNotification(title, text, subText, progress))
    } catch (e: Exception) {
      if (!updateFailureLogged) {
        updateFailureLogged = true
        log("error", "notification update failed: ${e.javaClass.simpleName}: ${e.message}")
      }
    }
  }

  fun shutdown() {
    log("info", "shutdown (foreground=$isForeground)")
    handler.removeCallbacks(tickRunnable)
    releaseLocks()
    if (isForeground) {
      stopForeground(Service.STOP_FOREGROUND_REMOVE)
      isForeground = false
    }
    stopSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacks(tickRunnable)
    releaseLocks()
    isForeground = false
    if (instance === this) instance = null
    log("info", "service destroyed")
    super.onDestroy()
  }

  private fun buildProgressNotification(
    title: String,
    text: String,
    subText: String?,
    progress: Int
  ): Notification {
    val b = newBuilder(this, CHANNEL_PROGRESS)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_PROGRESS)

    if (!subText.isNullOrBlank()) b.setSubText(subText)
    if (progress in 0..100) b.setProgress(100, progress, false) else b.setProgress(0, 0, true)
    launchPendingIntent(this)?.let { b.setContentIntent(it) }

    val cancelIntent = PendingIntent.getService(
      this,
      1,
      Intent(this, TransferForegroundService::class.java).setAction(ACTION_CANCEL),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    @Suppress("DEPRECATION")
    b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelIntent)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      @Suppress("DEPRECATION")
      b.setPriority(Notification.PRIORITY_LOW)
    }
    return b.build()
  }

  private fun acquireLocks() {
    try {
      if (wakeLock?.isHeld != true) {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LocalDrop:transfer").apply {
          setReferenceCounted(false)
          acquire(WAKELOCK_TIMEOUT_MS)
        }
        log("info", "wake lock acquired")
      }
    } catch (e: Exception) {
      log("error", "wake lock failed: ${e.javaClass.simpleName}: ${e.message}")
    }
    try {
      if (wifiLock?.isHeld != true) {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
          @Suppress("DEPRECATION")
          WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifiLock = wm.createWifiLock(mode, "LocalDrop:transfer").apply {
          setReferenceCounted(false)
          acquire()
        }
        log("info", "wifi lock acquired (mode=$mode)")
      }
    } catch (e: Exception) {
      log("error", "wifi lock failed: ${e.javaClass.simpleName}: ${e.message}")
    }
  }

  private fun releaseLocks() {
    if (wakeLock?.isHeld == true || wifiLock?.isHeld == true) log("info", "releasing locks")
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (_: Exception) {
      // ignore
    }
    wakeLock = null
    try {
      if (wifiLock?.isHeld == true) wifiLock?.release()
    } catch (_: Exception) {
      // ignore
    }
    wifiLock = null
  }
}

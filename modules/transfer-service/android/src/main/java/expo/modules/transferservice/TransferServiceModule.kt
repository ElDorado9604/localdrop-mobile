package expo.modules.transferservice

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TransferServiceModule : Module() {

  private fun appCtx(): Context {
    return appContext.reactContext?.applicationContext
      ?: throw Exception("React context is not available")
  }

  override fun definition() = ModuleDefinition {
    Name("TransferService")

    Events("onAction", "onLog")

    OnCreate {
      TransferForegroundService.logListener = { level, message ->
        try {
          sendEvent("onLog", mapOf("level" to level, "message" to message))
        } catch (_: Exception) {
          // JS runtime is gone
        }
      }
      TransferForegroundService.actionListener = { action ->
        try {
          sendEvent("onAction", mapOf("action" to action))
        } catch (_: Exception) {
          // JS runtime is gone
        }
      }
    }

    OnDestroy {
      TransferForegroundService.logListener = null
      TransferForegroundService.actionListener = null
    }

    /**
     * Start the foreground service. Returns false when Android refuses (for example the app is
     * in the background) — the transfer still runs, just without background protection.
     */
    AsyncFunction("start") { title: String, text: String ->
      val ctx = appCtx()
      TransferForegroundService.wanted = true
      TransferForegroundService.clearResult(ctx)
      val intent = Intent(ctx, TransferForegroundService::class.java).apply {
        action = TransferForegroundService.ACTION_START
        putExtra(TransferForegroundService.EXTRA_TITLE, title)
        putExtra(TransferForegroundService.EXTRA_TEXT, text)
      }
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          ctx.startForegroundService(intent)
        } else {
          ctx.startService(intent)
        }
        TransferForegroundService.log("info", "start requested")
        true
      } catch (e: Exception) {
        TransferForegroundService.wanted = false
        TransferForegroundService.log(
          "error",
          "start refused by Android: ${e.javaClass.simpleName}: ${e.message}"
        )
        false
      }
    }

    /** progress: 0..100, or -1 for an indeterminate bar. */
    AsyncFunction("update") { title: String, text: String, subText: String?, progress: Int ->
      TransferForegroundService.instance?.update(title, text, subText, progress)
      Unit
    }

    AsyncFunction("stop") {
      TransferForegroundService.wanted = false
      TransferForegroundService.log(
        "info",
        "stop requested (serviceRunning=${TransferForegroundService.instance != null})"
      )
      val svc = TransferForegroundService.instance
      if (svc != null) {
        svc.shutdown()
      } else {
        val ctx = appCtx()
        try {
          ctx.stopService(Intent(ctx, TransferForegroundService::class.java))
        } catch (_: Exception) {
          // ignore
        }
      }
      Unit
    }

    AsyncFunction("isRunning") {
      TransferForegroundService.instance != null
    }

    /** Dismissable "complete / failed" notification. */
    AsyncFunction("showResult") { title: String, text: String, success: Boolean ->
      TransferForegroundService.showResult(appCtx(), title, text, success)
      Unit
    }

    /** JSON string: network, interfaces, permissions, power state. */
    AsyncFunction("getEnvironment") {
      EnvironmentSnapshot.collect(appCtx())
    }

    /** Start logging network changes (idempotent). */
    AsyncFunction("startNetworkWatch") {
      NetworkWatcher.start(appCtx())
      Unit
    }

    AsyncFunction("isIgnoringBatteryOptimizations") {
      val ctx = appCtx()
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    /** Opens the system "Allow LocalDrop to run in the background?" dialog. */
    AsyncFunction("requestIgnoreBatteryOptimizations") {
      val ctx = appCtx()
      val intent = Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:${ctx.packageName}")
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        (appContext.currentActivity ?: ctx).startActivity(intent)
        TransferForegroundService.log("info", "battery optimization dialog opened")
        true
      } catch (e: Exception) {
        TransferForegroundService.log(
          "error",
          "battery optimization dialog failed: ${e.javaClass.simpleName}: ${e.message}"
        )
        false
      }
    }
  }
}

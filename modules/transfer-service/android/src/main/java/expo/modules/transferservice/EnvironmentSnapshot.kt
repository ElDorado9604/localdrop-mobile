package expo.modules.transferservice

import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.ConcurrentHashMap

/** Collects a diagnostics snapshot (network, interfaces, permissions, power) as a JSON string. */
object EnvironmentSnapshot {

  private fun transportNames(caps: NetworkCapabilities?): JSONArray {
    val arr = JSONArray()
    if (caps == null) return arr
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) arr.put("WIFI")
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) arr.put("CELLULAR")
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) arr.put("ETHERNET")
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) arr.put("BLUETOOTH")
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) arr.put("VPN")
    return arr
  }

  private fun addrs(lp: LinkProperties?): JSONArray {
    val arr = JSONArray()
    lp?.linkAddresses?.forEach { la -> la.address?.hostAddress?.let { arr.put(it) } }
    return arr
  }

  @Suppress("DEPRECATION")
  private fun allNetworks(cm: ConnectivityManager): Array<Network> = cm.allNetworks

  fun collect(ctx: Context): String {
    val out = JSONObject()
    out.put("sdk", Build.VERSION.SDK_INT)
    out.put("device", "${Build.MANUFACTURER} ${Build.MODEL}")

    try {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      out.put("batteryExempt", pm.isIgnoringBatteryOptimizations(ctx.packageName))
      out.put("powerSave", pm.isPowerSaveMode)
    } catch (_: Exception) {
    }
    try {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      out.put("notificationsEnabled", nm.areNotificationsEnabled())
    } catch (_: Exception) {
    }
    try {
      out.put(
        "airplane",
        Settings.Global.getInt(ctx.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) == 1
      )
    } catch (_: Exception) {
    }
    try {
      val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      out.put("wifiEnabled", wm.isWifiEnabled)
      if (wm.isWifiEnabled) {
        // Link details of the Wi-Fi network we are a client of (SSID is hidden without location).
        @Suppress("DEPRECATION")
        val info = wm.connectionInfo
        if (info != null && info.linkSpeed > 0) {
          out.put("wifiLinkMbps", info.linkSpeed)
          out.put("wifiRssi", info.rssi)
          out.put("wifiFreqMhz", info.frequency)
        }
      }
    } catch (_: Exception) {
    }

    // Every network Android currently knows about (Wi-Fi without internet included).
    val networks = JSONArray()
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val active = cm.activeNetwork
      for (n in allNetworks(cm)) {
        val caps = cm.getNetworkCapabilities(n)
        val lp = cm.getLinkProperties(n)
        val o = JSONObject()
        o.put("transports", transportNames(caps))
        o.put("internet", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
        o.put("validated", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true)
        o.put("active", active != null && active == n)
        o.put("iface", lp?.interfaceName ?: "")
        o.put("addrs", addrs(lp))
        networks.put(o)
      }
    } catch (e: Exception) {
      out.put("networkError", "${e.javaClass.simpleName}: ${e.message}")
    }
    out.put("networks", networks)

    // Raw interfaces with an IPv4 address (also shows hotspot interfaces such as ap0 / swlan0).
    val ifaces = JSONArray()
    try {
      NetworkInterface.getNetworkInterfaces()?.toList()?.forEach { ni ->
        if (!ni.isUp || ni.isLoopback) return@forEach
        val v4 = JSONArray()
        ni.inetAddresses?.toList()?.forEach { a ->
          if (a is Inet4Address) a.hostAddress?.let { v4.put(it) }
        }
        if (v4.length() > 0) {
          val o = JSONObject()
          o.put("name", ni.name)
          o.put("ipv4", v4)
          ifaces.put(o)
        }
      }
    } catch (e: Exception) {
      out.put("interfaceError", "${e.javaClass.simpleName}: ${e.message}")
    }
    out.put("interfaces", ifaces)

    // Every permission the app declares, split by granted / not granted.
    val granted = JSONArray()
    val denied = JSONArray()
    try {
      val pkg = ctx.packageName
      val info: PackageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.packageManager.getPackageInfo(
          pkg,
          PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong())
        )
      } else {
        @Suppress("DEPRECATION")
        ctx.packageManager.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS)
      }
      val names = info.requestedPermissions ?: emptyArray()
      val flags = info.requestedPermissionsFlags ?: IntArray(0)
      for (i in names.indices) {
        val short = names[i].removePrefix("android.permission.")
        val ok = i < flags.size && (flags[i] and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0
        if (ok) granted.put(short) else denied.put(short)
      }
    } catch (e: Exception) {
      out.put("permissionError", "${e.javaClass.simpleName}: ${e.message}")
    }
    val perms = JSONObject()
    perms.put("granted", granted)
    perms.put("denied", denied)
    out.put("permissions", perms)

    return out.toString()
  }
}

/** Logs every network appearing / changing / disappearing, via the service log bridge. */
object NetworkWatcher {
  private var callback: ConnectivityManager.NetworkCallback? = null
  private val lastSeen = ConcurrentHashMap<String, String>()

  private fun describe(caps: NetworkCapabilities): String {
    val t = ArrayList<String>()
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) t.add("WIFI")
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) t.add("CELLULAR")
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) t.add("ETHERNET")
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) t.add("VPN")
    val internet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    return "${t.joinToString("+")} internet=$internet validated=$validated"
  }

  private fun emit(key: String, text: String) {
    if (lastSeen.put(key, text) != text) TransferForegroundService.log("info", text)
  }

  @Synchronized
  fun start(ctx: Context) {
    if (callback != null) return
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val cb = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          emit("a$network", "net: available id=$network")
        }

        override fun onLost(network: Network) {
          val id = network.toString()
          lastSeen.keys.removeAll { it.substring(1) == id }
          TransferForegroundService.log("info", "net: lost id=$network")
        }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
          emit("c$network", "net: id=$network ${describe(caps)}")
        }

        override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
          val a = lp.linkAddresses.mapNotNull { it.address?.hostAddress }.joinToString(",")
          emit("l$network", "net: id=$network iface=${lp.interfaceName} addrs=[$a]")
        }
      }
      cm.registerNetworkCallback(NetworkRequest.Builder().build(), cb)
      callback = cb
      TransferForegroundService.log("info", "net: watcher started")
    } catch (e: Exception) {
      TransferForegroundService.log(
        "error",
        "net: watcher failed: ${e.javaClass.simpleName}: ${e.message}"
      )
    }
  }
}

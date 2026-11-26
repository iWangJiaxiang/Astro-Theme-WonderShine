package wang.jiaxiang.studio.updates

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.HttpsURLConnection

@InvokeArg
class DownloadArgs {
    lateinit var version: String
    lateinit var name: String
    lateinit var sha256: String
    var size: Long = 0
    var automatic: Boolean = false
    lateinit var progress: Channel
}

private fun unmetered(context: Context): Boolean {
    val service = context.getSystemService(ConnectivityManager::class.java)
    return service.getNetworkCapabilities(service.activeNetwork)
        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
}

private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

@Suppress("DEPRECATION")
private fun verifyApk(context: Context, file: File, version: String) {
    val pm = context.packageManager
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val installed = pm.getPackageInfo(context.packageName, flags)
    val update = pm.getPackageArchiveInfo(file.path, flags) ?: error("INVALID_APK")
    fun versionCode(info: PackageInfo) = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    fun signers(info: PackageInfo) = (if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures)
        ?.map { it.toCharsString() }?.toSet().orEmpty()
    check(update.packageName == installed.packageName && update.versionName == version && versionCode(update) > versionCode(installed)) { "INVALID_APK" }
    val expected = signers(installed)
    check(expected.isNotEmpty() && signers(update) == expected) { "INVALID_APK" }
}

class InstallResult : BroadcastReceiver() {
    companion object { internal val waiting = ConcurrentHashMap<Int, Invoke>() }

    @Suppress("DEPRECATION")
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                try {
                    requireNotNull(confirmation)
                    context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (_: Exception) { waiting.remove(id)?.reject("INSTALL_FAILED") }
            }
            PackageInstaller.STATUS_SUCCESS -> waiting.remove(id)?.resolve()
            PackageInstaller.STATUS_FAILURE_ABORTED -> waiting.remove(id)?.reject("CANCELLED")
            else -> waiting.remove(id)?.reject("INSTALL_FAILED")
        }
    }
}

@TauriPlugin
class StudioUpdatePlugin(private val host: Activity) : Plugin(host) {
    private val worker = Executors.newSingleThreadExecutor()
    private val cache get() = File(host.cacheDir, "studio-update")
    private fun task(invoke: Invoke, fallback: String, action: () -> Unit) {
        worker.execute {
            try { action() } catch (e: Exception) {
                invoke.reject(when (e.message) {
                    "METERED", "INVALID_APK" -> e.message
                    else -> fallback
                })
            }
        }
    }

    @Command
    fun unmetered(invoke: Invoke) { invoke.resolveObject(unmetered(host)) }

    @Command
    fun download(invoke: Invoke) = task(invoke, "DOWNLOAD_FAILED") {
        val args = invoke.parseArgs(DownloadArgs::class.java)
        require(Regex("""(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)""").matches(args.version))
        require(Regex("""android-[A-Za-z0-9._-]+\.apk""").matches(args.name))
        require(Regex("[0-9a-f]{64}").matches(args.sha256) && args.size in 1L..Int.MAX_VALUE.toLong())
        cache.mkdirs()
        val ready = File(cache, args.sha256 + ".apk")
        val hash = MessageDigest.getInstance("SHA-256")
        fun valid(file: File): Boolean {
            if (!file.isFile || file.length() != args.size) return false
            file.inputStream().buffered().use { stream ->
                val buffer = ByteArray(65536)
                while (true) {
                    val n = stream.read(buffer)
                    if (n < 0) break
                    hash.update(buffer, 0, n)
                }
            }
            return hex(hash.digest()) == args.sha256
        }
        if (!valid(ready)) {
            if (args.automatic && !unmetered(host)) error("METERED")
            val partial = File(cache, "download.part")
            val url = URL("https://github.com/" + BuildConfig.REPOSITORY + "/releases/download/studio-v" + args.version + "/" + args.name)
            val connection = url.openConnection() as HttpsURLConnection
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            try {
                check(connection.responseCode == 200)
                connection.inputStream.buffered().use { input ->
                    partial.outputStream().buffered().use { output ->
                        val buffer = ByteArray(65536)
                        var received = 0L
                        var last = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            received += count
                            check(received <= args.size) { "INVALID_APK" }
                            output.write(buffer, 0, count)
                            hash.update(buffer, 0, count)
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - last >= 200 || received == args.size) {
                                if (args.automatic && !unmetered(host)) error("METERED")
                                args.progress.sendObject(received)
                                last = now
                            }
                        }
                        check(received == args.size && hex(hash.digest()) == args.sha256) { "INVALID_APK" }
                    }
                }
                verifyApk(host, partial, args.version)
                check(partial.renameTo(ready))
            } finally { connection.disconnect(); partial.delete() }
        } else { verifyApk(host, ready, args.version) }
        cache.listFiles()?.filter { it != ready }?.forEach { it.delete() }
        invoke.resolve()
    }

    @Command
    fun install(invoke: Invoke) = task(invoke, "INSTALL_FAILED") {
        val args = invoke.getArgs()
        val digest = args.getString("sha256")
        require(Regex("[0-9a-f]{64}").matches(digest))
        val apk = File(cache, digest + ".apk")
        verifyApk(host, apk, args.getString("version"))
        if (Build.VERSION.SDK_INT >= 26 && !host.packageManager.canRequestPackageInstalls()) {
            host.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + host.packageName)))
            invoke.reject("PERMISSION")
            return@task
        }
        val installer = host.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(host.packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val callback = PendingIntent.getBroadcast(host, id, Intent(host, InstallResult::class.java), PendingIntent.FLAG_UPDATE_CURRENT or mutable)
                InstallResult.waiting[id] = invoke
                session.commit(callback.intentSender)
            }
        } catch (e: Exception) {
            InstallResult.waiting.remove(id)
            installer.abandonSession(id)
            throw e
        }
    }
}

package expo.modules.safstream

import android.net.Uri
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedOutputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class SafStreamModule : Module() {
  private val streams = ConcurrentHashMap<String, OutputStream>()

  override fun definition() = ModuleDefinition {
    Name("SafStream")

    /**
     * Open a writable OutputStream for a SAF document URI.
     * Returns a streamId used for subsequent write/close/abort calls.
     */
    AsyncFunction("open") { documentUri: String ->
      val context = appContext.reactContext
        ?: throw Exception("React context is not available")

      val uri = Uri.parse(documentUri)
      // "wt" = truncate + write (fresh file from createFileAsync)
      val raw = context.contentResolver.openOutputStream(uri, "wt")
        ?: throw Exception("Could not open OutputStream for $documentUri")

      val stream: OutputStream = BufferedOutputStream(raw, 256 * 1024)
      val id = UUID.randomUUID().toString()
      streams[id] = stream
      id
    }

    /**
     * Append raw bytes to an open stream.
     * Expo bridges Uint8Array → ByteArray.
     */
    AsyncFunction("write") { streamId: String, data: ByteArray ->
      val stream = streams[streamId]
        ?: throw Exception("Stream not open: $streamId")
      stream.write(data)
      data.size
    }

    /**
     * Append base64-decoded bytes (fallback path).
     */
    AsyncFunction("writeBase64") { streamId: String, base64: String ->
      val stream = streams[streamId]
        ?: throw Exception("Stream not open: $streamId")
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      stream.write(bytes)
      bytes.size
    }

    AsyncFunction("close") { streamId: String ->
      val stream = streams.remove(streamId) ?: return@AsyncFunction
      try {
        stream.flush()
      } finally {
        stream.close()
      }
    }

    /**
     * Close the stream and optionally delete the partial SAF document.
     */
    AsyncFunction("abort") { streamId: String, documentUri: String? ->
      val stream = streams.remove(streamId)
      try {
        stream?.close()
      } catch (_: Exception) {
        // ignore
      }

      if (!documentUri.isNullOrBlank()) {
        try {
          val context = appContext.reactContext
          context?.contentResolver?.delete(Uri.parse(documentUri), null, null)
        } catch (_: Exception) {
          // ignore delete failures
        }
      }
    }
  }
}

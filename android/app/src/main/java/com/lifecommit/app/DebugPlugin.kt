package com.lifecommit.app

import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.io.File

@CapacitorPlugin(name = "DebugPlugin")
class DebugPlugin : Plugin() {

    companion object {
        private const val TAG = "LifeCommitDebug"
    }

    /**
     * EncryptedSharedPreferences에서 Capacitor SQLite가 저장한 passphrase를 읽어온다.
     * CapacitorSQLite.java의 setSharedPreferences()와 동일한 설정을 사용해야 한다.
     */
    private fun getStoredPassphrase(): String {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        val prefs = EncryptedSharedPreferences.create(
            context,
            "sqlite_encrypted_shared_prefs",   // Capacitor SQLite가 사용하는 이름
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )

        return prefs.getString("secret", "") ?: ""
    }

    @PluginMethod
    fun exportDatabase(call: PluginCall) {
        try {
            val dbFile = context.getDatabasePath("lifecommitSQLite.db")
            if (!dbFile.exists()) {
                call.reject("Database file does not exist yet.")
                return
            }

            // WAL 모드 데이터 병합을 위해 체크포인트 실행 시도
            val walFile = File(dbFile.absolutePath + "-wal")
            val hasWal = walFile.exists() && walFile.length() > 0

            // 저장된 암호화 키 가져오기
            val passphrase = getStoredPassphrase()
            if (passphrase.isEmpty()) {
                call.reject("Encryption passphrase not found in SharedPreferences.")
                return
            }

            Log.d(TAG, "Passphrase length: ${passphrase.length}, WAL exists: $hasWal")

            // 내보낼 평문 DB 파일 준비
            val exportDir = File(context.cacheDir, "debug_exports")
            if (!exportDir.exists()) {
                exportDir.mkdirs()
            }
            val dateStr = java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.getDefault()).format(java.util.Date())
            val plaintextFile = File(exportDir, "lifecommit_${dateStr}.db")
            // 이전 내보내기 파일이 있으면 삭제
            if (plaintextFile.exists()) {
                plaintextFile.delete()
            }

            // SQLCipher 네이티브 라이브러리 로드
            System.loadLibrary("sqlcipher")

            // 1) 빈 평문 DB 파일 생성
            SQLiteDatabase.openOrCreateDatabase(
                plaintextFile.absolutePath,
                "",    // 빈 패스워드 = 평문
                null,
                null
            ).close()
            Log.d(TAG, "Empty plaintext DB created: ${plaintextFile.length()} bytes")

            // 2) 암호화된 원본 DB를 passphrase로 열기 (READWRITE 필수 — ATTACH/export에 필요)
            val encryptedDb = SQLiteDatabase.openDatabase(
                dbFile.absolutePath,
                passphrase,
                null,
                SQLiteDatabase.OPEN_READWRITE,
                null
            )
            Log.d(TAG, "Encrypted DB opened successfully")

            // WAL 체크포인트 강제 실행
            try {
                encryptedDb.rawExecSQL("PRAGMA wal_checkpoint(FULL)")
                Log.d(TAG, "WAL checkpoint completed")
            } catch (e: Exception) {
                Log.w(TAG, "WAL checkpoint skipped: ${e.message}")
            }

            // DB 버전 보존
            val version = encryptedDb.version
            Log.d(TAG, "DB version: $version")

            // 3) 평문 DB를 'plaintext' 별칭으로 ATTACH
            val attachStmt = encryptedDb.compileStatement(
                "ATTACH DATABASE ? AS plaintext KEY ''"
            )
            attachStmt.bindString(1, plaintextFile.absolutePath)
            attachStmt.execute()
            attachStmt.close()
            Log.d(TAG, "Plaintext DB attached")

            // 4) 암호화 DB → 평문 DB로 전체 데이터 복사
            encryptedDb.rawExecSQL("SELECT sqlcipher_export('plaintext')")
            Log.d(TAG, "sqlcipher_export completed")

            // 5) 버전 설정 및 정리
            encryptedDb.rawExecSQL("PRAGMA plaintext.user_version = $version")
            encryptedDb.rawExecSQL("DETACH DATABASE plaintext")
            encryptedDb.close()

            Log.d(TAG, "Decrypted DB size: ${plaintextFile.length()} bytes")

            // FileProvider를 통한 공유 URI 획득
            val authority = "${context.packageName}.fileprovider"
            val fileUri = FileProvider.getUriForFile(context, authority, plaintextFile)

            // ACTION_SEND 인텐트 실행
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "application/octet-stream"
                putExtra(Intent.EXTRA_STREAM, fileUri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            val chooser = Intent.createChooser(shareIntent, "Share LifeCommit Database (Decrypted)")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

            context.startActivity(chooser)

            Log.d(TAG, "Decrypted database exported successfully")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to export decrypted database", e)
            call.reject("Failed to export database: ${e.message}", e)
        }
    }
}

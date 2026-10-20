package com.lifecommit.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * GPS 좌표, 화면 텍스트, 답장/알림 본문 등 민감한 데이터를 DB에 반영되기 전까지
 * 임시로 스테이징하는 캐시는 평문 SharedPreferences(XML)에 저장하면 안 된다.
 * Android Keystore로 보호되는 EncryptedSharedPreferences로 통일해서 사용한다.
 */
object SecurePrefs {
    fun get(context: Context, name: String): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        return EncryptedSharedPreferences.create(
            context,
            name,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
}

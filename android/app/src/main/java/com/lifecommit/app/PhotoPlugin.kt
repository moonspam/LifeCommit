package com.lifecommit.app

import android.Manifest
import android.content.ContentUris
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.content.ContentResolver
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "PhotoPlugin",
    permissions = [
        Permission(
            alias = "photo",
            strings = [Manifest.permission.READ_EXTERNAL_STORAGE]
        ),
        Permission(
            alias = "photo_api33",
            strings = [Manifest.permission.READ_MEDIA_IMAGES]
        )
    ]
)
class PhotoPlugin : Plugin() {

    private fun getAlias(): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            "photo_api33"
        } else {
            "photo"
        }
    }

    @PluginMethod
    fun hasPhotoPermission(call: PluginCall) {
        val granted = getPermissionState(getAlias()) == com.getcapacitor.PermissionState.GRANTED
        val ret = JSObject().apply {
            put("granted", granted)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun getRecentPhotos(call: PluginCall) {
        if (getPermissionState(getAlias()) != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias(getAlias(), call, "photoCallback")
            return
        }
        fetchRecentPhotos(call)
    }

    @PermissionCallback
    private fun photoCallback(call: PluginCall) {
        if (getPermissionState(getAlias()) == com.getcapacitor.PermissionState.GRANTED) {
            fetchRecentPhotos(call)
        } else {
            call.reject("Photo permission not granted")
        }
    }

    // MediaStore를 조회하여 최근 촬영/저장된 사진 목록 쿼리
    private fun fetchRecentPhotos(call: PluginCall) {
        val afterTimestamp = call.longArg("afterTimestamp") ?: 0L
        val limit = call.getInt("limit") ?: 100
        val offset = call.getInt("offset") ?: 0

        val resolver = context.contentResolver
        val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_ADDED
        )

        // MediaStore의 DATE_ADDED는 초(seconds) 단위이므로 타임스탬프를 1000으로 나누어 비교
        val selection = "${MediaStore.Images.Media.DATE_ADDED} > ?"
        val selectionArgs = arrayOf((afterTimestamp / 1000).toString())
        // DATE_ADDED는 초 단위라 같은 초에 찍힌 여러 사진(연사 등)이 흔하다. 이 컬럼만으로
        // 정렬하면 페이지마다 동순위 행의 순서가 안정적이지 않아 OFFSET 페이지네이션이
        // 경계에서 행을 건너뛰거나 중복시킬 수 있으므로, _ID를 보조 정렬 키로 추가한다.
        val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} DESC, ${MediaStore.Images.Media._ID} DESC"

        val cursor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val queryArgs = android.os.Bundle().apply {
                putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
                putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
                putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sortOrder)
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selectionArgs)
            }
            resolver.query(uri, projection, queryArgs, null)
        } else {
            resolver.query(uri, projection, selection, selectionArgs, "$sortOrder LIMIT $limit OFFSET $offset")
        }
        val photoList = JSArray()

        cursor?.use {
            val idColumn = it.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameColumn = it.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val dateColumn = it.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)

            while (it.moveToNext()) {
                val id = it.getLong(idColumn)
                val name = it.getString(nameColumn)
                val dateSec = it.getLong(dateColumn)

                val contentUri = ContentUris.withAppendedId(uri, id)

                val entry = JSObject().apply {
                    put("id", id.toString())
                    put("photoUri", contentUri.toString())
                    put("fileName", name)
                    put("timestamp", dateSec * 1000L) // 초 단위를 ms 단위로 복원
                }
                photoList.put(entry)
            }
        }

        val result = JSObject().apply {
            put("photos", photoList)
        }
        call.resolve(result)
    }

    // 특정 이미지 URI를 시스템 갤러리 앱으로 여는 메서드
    @PluginMethod
    fun openPhoto(call: PluginCall) {
        val photoUriStr = call.getString("photoUri")
        if (photoUriStr.isNullOrEmpty()) {
            call.reject("photoUri is required")
            return
        }

        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(Uri.parse(photoUriStr), "image/*")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to open photo: ${e.message}", e)
        }
    }
}

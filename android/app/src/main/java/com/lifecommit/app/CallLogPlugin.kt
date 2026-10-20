package com.lifecommit.app

import android.Manifest
import android.content.ContentResolver
import android.database.Cursor
import android.os.Build
import android.net.Uri
import android.provider.CallLog
import android.provider.ContactsContract
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "CallLogPlugin",
    permissions = [
        Permission(
            alias = "callLog",
            strings = [Manifest.permission.READ_CALL_LOG]
        ),
        Permission(
            alias = "sms",
            strings = [Manifest.permission.READ_SMS]
        ),
        Permission(
            alias = "contacts",
            strings = [Manifest.permission.READ_CONTACTS]
        )
    ]
)
class CallLogPlugin : Plugin() {

    @PluginMethod
    fun hasCallLogPermission(call: PluginCall) {
        val granted = getPermissionState("callLog") == com.getcapacitor.PermissionState.GRANTED
        val ret = JSObject().apply {
            put("granted", granted)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun hasSmsPermission(call: PluginCall) {
        val granted = getPermissionState("sms") == com.getcapacitor.PermissionState.GRANTED
        val ret = JSObject().apply {
            put("granted", granted)
        }
        call.resolve(ret)
    }

    // 기기 내 전체 주소록 연락처 조회 (READ_CONTACTS 권한 필요)
    @PluginMethod
    fun listContacts(call: PluginCall) {
        if (getPermissionState("contacts") != com.getcapacitor.PermissionState.GRANTED) {
            val ret = JSObject().apply {
                put("contacts", JSArray())
            }
            call.resolve(ret)
            return
        }

        val contactsList = JSArray()
        try {
            val resolver: ContentResolver = context.contentResolver
            val uri: Uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
            val projection = arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER
            )
            val cursor: Cursor? = resolver.query(uri, projection, null, null, null)
            cursor?.use {
                val nameIndex = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numberIndex = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (it.moveToNext()) {
                    val name = if (nameIndex >= 0) it.getString(nameIndex) ?: "" else ""
                    val phone = if (numberIndex >= 0) it.getString(numberIndex) ?: "" else ""
                    val entry = JSObject().apply {
                        put("name", name)
                        put("phone", phone)
                    }
                    contactsList.put(entry)
                }
            }
        } catch (e: Exception) {
            // 권한 미부여 또는 오류 시 예외 없이 빈 배열 반환
        }

        val result = JSObject().apply {
            put("contacts", contactsList)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun getCallLogs(call: PluginCall) {
        if (getPermissionState("callLog") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("callLog", call, "callLogCallback")
            return
        }
        fetchCallLogs(call)
    }

    @PermissionCallback
    private fun callLogCallback(call: PluginCall) {
        if (getPermissionState("callLog") == com.getcapacitor.PermissionState.GRANTED) {
            fetchCallLogs(call)
        } else {
            call.reject("READ_CALL_LOG permission not granted")
        }
    }

    @PluginMethod
    fun getSms(call: PluginCall) {
        if (getPermissionState("sms") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsCallback")
            return
        }
        fetchSms(call)
    }

    @PermissionCallback
    private fun smsCallback(call: PluginCall) {
        if (getPermissionState("sms") == com.getcapacitor.PermissionState.GRANTED) {
            fetchSms(call)
        } else {
            call.reject("READ_SMS permission not granted")
        }
    }

    // 안드로이드 CallLog 시스템 DB에서 통화 기록 조회
    private fun fetchCallLogs(call: PluginCall) {
        val afterTimestamp = call.longArg("afterTimestamp") ?: 0L
        val limit = call.getInt("limit") ?: 100
        val offset = call.getInt("offset") ?: 0

        val resolver: ContentResolver = context.contentResolver
        val uri: Uri = CallLog.Calls.CONTENT_URI
        val projection = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.TYPE,
            CallLog.Calls.DURATION,
            CallLog.Calls.DATE
        )
        val selection = "${CallLog.Calls.DATE} > ?"
        val selectionArgs = arrayOf(afterTimestamp.toString())
        // DATE만으로 정렬하면 같은 타임스탬프를 공유하는 여러 통화가 있을 때 페이지마다
        // 순서가 안정적이지 않아 OFFSET 페이지네이션이 경계에서 행을 건너뛰거나
        // 중복시킬 수 있다. _ID를 보조 정렬 키로 추가해 전체 순서를 고정한다.
        val sortOrder = "${CallLog.Calls.DATE} DESC, ${CallLog.Calls._ID} DESC"

        val cursor: Cursor? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
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
        val callList = JSArray()

        cursor?.use {
            val idIndex = it.getColumnIndex(CallLog.Calls._ID)
            val numberIndex = it.getColumnIndex(CallLog.Calls.NUMBER)
            val nameIndex = it.getColumnIndex(CallLog.Calls.CACHED_NAME)
            val typeIndex = it.getColumnIndex(CallLog.Calls.TYPE)
            val durationIndex = it.getColumnIndex(CallLog.Calls.DURATION)
            val dateIndex = it.getColumnIndex(CallLog.Calls.DATE)

            while (it.moveToNext()) {
                val entry = JSObject()
                val id = it.getString(idIndex)
                val number = it.getString(numberIndex)
                val name = it.getString(nameIndex)
                val typeInt = it.getInt(typeIndex)
                val duration = it.getLong(durationIndex)
                val date = it.getLong(dateIndex)

                // 통화 유형 매핑
                val callTypeStr = when (typeInt) {
                    CallLog.Calls.INCOMING_TYPE -> "INCOMING"
                    CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
                    CallLog.Calls.MISSED_TYPE -> "MISSED"
                    CallLog.Calls.REJECTED_TYPE -> "REJECTED"
                    else -> "INCOMING"
                }

                entry.put("id", id)
                entry.put("phoneNumber", number)
                entry.put("contactName", if (name.isNullOrEmpty()) null else name)
                entry.put("callType", callTypeStr)
                entry.put("durationSec", duration)
                entry.put("timestamp", date)
                entry.put("resolvedTag", null)
                callList.put(entry)
            }
        }

        val result = JSObject().apply {
            put("calls", callList)
        }
        call.resolve(result)
    }

    // 안드로이드 SMS 시스템 DB에서 문자 수발신 기록 조회
    private fun fetchSms(call: PluginCall) {
        val afterTimestamp = call.longArg("afterTimestamp") ?: 0L
        val limit = call.getInt("limit") ?: 100
        val offset = call.getInt("offset") ?: 0

        val resolver: ContentResolver = context.contentResolver
        val uri: Uri = Uri.parse("content://sms")
        val projection = arrayOf(
            "_id",
            "address",
            "body",
            "type", // 1: 수신(INBOX), 2: 발신(SENT)
            "date"
        )
        val selection = "date > ?"
        val selectionArgs = arrayOf(afterTimestamp.toString())
        // date만으로 정렬하면 같은 타임스탬프를 공유하는 여러 문자가 있을 때 페이지마다
        // 순서가 안정적이지 않아 OFFSET 페이지네이션이 경계에서 행을 건너뛰거나
        // 중복시킬 수 있다. _id를 보조 정렬 키로 추가해 전체 순서를 고정한다.
        val sortOrder = "date DESC, _id DESC"

        val cursor: Cursor? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
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
        val smsList = JSArray()

        cursor?.use {
            val idIndex = it.getColumnIndex("_id")
            val addressIndex = it.getColumnIndex("address")
            val bodyIndex = it.getColumnIndex("body")
            val typeIndex = it.getColumnIndex("type")
            val dateIndex = it.getColumnIndex("date")

            while (it.moveToNext()) {
                val entry = JSObject()
                val id = it.getString(idIndex)
                val address = it.getString(addressIndex)
                val body = it.getString(bodyIndex)
                val typeInt = it.getInt(typeIndex)
                val date = it.getLong(dateIndex)

                val smsTypeStr = when (typeInt) {
                    1 -> "INBOX"
                    2 -> "SENT"
                    else -> "INBOX"
                }

                val contactName = getContactNameByPhoneNumber(context, address)

                entry.put("id", id)
                entry.put("address", address)
                entry.put("contactName", contactName)
                entry.put("body", body)
                entry.put("type", smsTypeStr)
                entry.put("timestamp", date)
                entry.put("resolvedTag", null)
                smsList.put(entry)
            }
        }

        val result = JSObject().apply {
            put("messages", smsList)
        }
        call.resolve(result)
    }

    // 전화번호를 기반으로 기기 내 주소록에서 이름을 매핑하는 헬퍼 메서드
    private fun getContactNameByPhoneNumber(context: android.content.Context, phoneNumber: String?): String? {
        if (phoneNumber.isNullOrEmpty()) return null
        try {
            val uri = Uri.withAppendedPath(
                android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                Uri.encode(phoneNumber)
            )
            val projection = arrayOf(android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME)
            val cursor = context.contentResolver.query(uri, projection, null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    val nameIndex = it.getColumnIndex(android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME)
                    return it.getString(nameIndex)
                }
            }
        } catch (e: Exception) {
            // READ_CONTACTS 권한이 없는 경우 예외 처리
        }
        return null
    }
}

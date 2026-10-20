package com.lifecommit.app

import com.getcapacitor.PluginCall

/**
 * PluginCall.getLong returns null unless the JSON value is already a Long, i.e. for every number that fits in an Int
 * (epoch 0, small seqs). Use this for any integer argument.
 */
fun PluginCall.longArg(name: String): Long? = (data.opt(name) as? Number)?.toLong()

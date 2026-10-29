import os from "os"
import fetch from 'node-fetch'
import { printRed } from "./colorOut.js";
import { bindMiguFetch, noteMiguFailure } from "./egress.js";

function getLocalIPv(ver = 4) {
  const ips = []
  const inter = os.networkInterfaces()
  // console.dir(inter, { depth: null })
  for (let net in inter) {

    // console.dir(net, { depth: null })
    // console.log()
    for (let netPort of inter[net]) {
      // netPort = inter[net][netPort]
      // console.dir(netPort, { depth: null })
      if (netPort.family === `IPv${ver}`) {
        // console.dir(netPort, { depth: null })
        ips.push(netPort.address)
      }
    }
  }
  // console.log()
  // console.dir(ips, { depth: null })
  return ips
}

async function fetchUrl(url, opts = {}, timeout = 6000) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort()
  }, timeout);
  const bound = await bindMiguFetch(url)
  if (bound.silent) {
    clearTimeout(timeoutId)
    return undefined
  }
  const res = await fetch(url, {
    ...opts,
    signal: controller.signal,
    ...(bound.agent ? { agent: bound.agent } : {}),
  })
    .then(r => {
      clearTimeout(timeoutId);
      return r.json()
    })
    .catch(async err => {
      clearTimeout(timeoutId);
      if (bound.address) await noteMiguFailure(bound.address)
      if (!timedOut) {
        printRed(`请求失败 [${err?.code || err?.name || 'ERROR'}]: ${String(url).substring(0, 80)}`)
      }
    })

  return res
}

export {
  getLocalIPv, fetchUrl
}

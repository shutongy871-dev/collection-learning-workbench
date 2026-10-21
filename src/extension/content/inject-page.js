/**
 * inject-page.js —— 运行在页面主世界（MAIN world），通用网络透传器
 *
 * 不按具体接口名过滤（平台接口名会变），统一：
 *   - 捕获所有 JSON GET 响应（读）
 *   - 捕获所有非 GET 请求（写）
 * “哪些响应是收藏数据”交给控制面大脑判断，本文件长期稳定、平台无关。
 *
 * 维护环形缓冲，响应 ISOLATED world 的 replay，解决监听晚注册丢消息。
 * 只读不拦不改编，页面请求自然携带 a_bogus 等签名。
 */
(() => {
  const TAG = "__collection_agent_net__";
  const INJECT_VERSION = "2026-10-11a";
  const BUFFER_LIMIT = 40;
  const HARD_CAP = 200_000; // 单条读响应硬上限（字符）

  const buffer = [];

  const emit = (phase, payload) => {
    try {
      const envelope = { __agent: TAG, phase, capturedAt: Date.now(), ...payload };
      buffer.push(envelope);
      if (buffer.length > BUFFER_LIMIT) buffer.shift();
      window.postMessage(envelope, "*");
    } catch { /* ignore */ }
  };

  const asString = (body) => {
    if (typeof body === "string") return body.slice(0, 4000);
    if (body instanceof URLSearchParams) return body.toString().slice(0, 4000);
    return null;
  };

  const isApi = (url) => /\/aweme\/v\d+\/|\/collects\/|listcollection/i.test(url);

  const LIST_KEYS = ["aweme_list", "awemes", "collects_list", "collects"];

  /** 结构化裁剪：只缩短列表数组（保留完整对象），绝不断开 JSON 文本 */
  const capJson = (data, keep) => {
    if (!data || typeof data !== "object") return data;
    const out = Array.isArray(data) ? data.slice(0, keep) : { ...data };
    let truncated = Array.isArray(data) && data.length > keep;
    for (const k of LIST_KEYS) {
      if (Array.isArray(out[k])) {
        truncated ||= out[k].length > keep;
        out[k] = out[k].slice(0, keep);
      }
    }
    // 现阶段仍有限长缓冲；显式标明不完整，服务端禁止据此推导“未分类”。
    out._agent_truncated = truncated;
    if (JSON.stringify(out).length <= HARD_CAP) return out;
    // 仍超限：退化为最小骨架（ID+文案），保证合法可用
    for (const k of LIST_KEYS) {
      if (Array.isArray(out[k])) {
        out[k] = out[k].slice(0, keep).map((a) => ({
          aweme_id: a.aweme_id ?? a.id,
          collects_id: a.collects_id,
          name: a.name,
          total: a.total ?? a.aweme_count,
          desc: typeof a.desc === "string" ? a.desc.slice(0, 200) : "",
          text_extra: Array.isArray(a.text_extra)
            ? a.text_extra.slice(0, 8).map((t) => ({ hashtag_name: t.hashtag_name }))
            : [],
          author: { nickname: a.author?.nickname ?? "" },
          video: { duration: a.video?.duration ?? 0 }
        }));
      }
    }
    out._agent_truncated = true;
    return out;
  };

  // replay：把缓冲全部补发给后注册的监听
  window.addEventListener("message", (event) => {
    if (event.data?.__agent === TAG && event.data.cmd === "replay") {
      for (const envelope of buffer) {
        window.postMessage({ ...envelope, replay: true }, "*");
      }
    }
  });

  // hook fetch
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = async function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
      const method = (args[1]?.method ?? "GET").toUpperCase();

      if (method !== "GET" && isApi(url)) {
        emit("write", { url, method, body: asString(args[1]?.body) });
      }

      const response = await origFetch.apply(this, args);
      try {
        const ct = response.headers.get("content-type") ?? "";
        if (ct.includes("json") && isApi(url)) {
          const data = await response.clone().json();
          emit("read", { url, status: response.status, v: INJECT_VERSION, data: capJson(data, 12) });
        }
      } catch { /* ignore */ }
      return response;
    };
  }

  // hook XMLHttpRequest
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const Patched = function () {
      const xhr = new OrigXHR();
      let method = "GET";
      let url = "";

      const origOpen = xhr.open;
      xhr.open = function (m, u, ...rest) {
        method = (m ?? "GET").toUpperCase();
        url = u;
        return origOpen.call(this, m, u, ...rest);
      };
      const origSend = xhr.send;
      xhr.send = function (body) {
        if (method !== "GET" && isApi(url)) {
          emit("write", { url, method, body: asString(body) });
        }
        return origSend.call(this, body);
      };
      xhr.addEventListener("load", () => {
        try {
          const ct = xhr.getResponseHeader("content-type") ?? "";
          if (ct.includes("json") && isApi(url) && xhr.responseText) {
            emit("read", {
              url,
              status: xhr.status,
              v: INJECT_VERSION,
              data: capJson(JSON.parse(xhr.responseText), 12)
            });
          }
        } catch { /* ignore */ }
      });
      return xhr;
    };
    Patched.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = Patched;
  }
})();

/**
 * 可复用的零依赖 CDP 客户端库（Node 22+）
 * 关键设计：等待全部放在 Node 侧，页面侧只做「瞬时求值」。
 * 原因：隐藏/后台标签页会被 Chromium 密集节流（setTimeout 最坏降到 ~60s/次），
 *      任何在页面里 await sleep 的探针都会假死超时。
 */
export async function connect({ port = 9222, urlFilter = 'music.apple.com' } = {}) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = pages.find((p) => (p.url || '').includes(urlFilter)) || pages[0];
  if (!page) throw new Error(`没有匹配 "${urlFilter}" 的 page 目标`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej, timer } = pending.get(m.id);
      clearTimeout(timer);
      pending.delete(m.id);
      m.error ? rej(new Error(`CDP error: ${JSON.stringify(m.error)}`)) : res(m.result);
    }
  });

  const send = (method, params = {}, timeoutMs = 30000) => {
    const id = ++seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP 超时: ${method}`)); }
      }, timeoutMs);
      pending.set(id, { res, rej, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evalJs = async (expression, { awaitPromise = false, userGesture = true } = {}) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture, includeCommandLineAPI: true,
    });
    if (r.exceptionDetails) {
      return { __exc: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
    }
    const v = r.result?.value;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  };

  return {
    page: { title: page.title, url: page.url, id: page.id },
    send, evalJs,
    bringToFront: async () => { try { await send('Page.enable'); await send('Page.bringToFront'); } catch {} },
    close: () => { try { ws.close(); } catch {} },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

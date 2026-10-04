export function consumeTokenFragment(location = globalThis.location, history = globalThis.history) {
  const fragment = new URLSearchParams((location.hash ?? '').replace(/^#/, ''));
  const token = fragment.get('token');
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return token;
}

export function createApiClient({ origin, token, fetchImpl = fetch }) {
  if (!origin || !token) throw new TypeError('工作台地址或会话令牌缺失');
  const base = new URL(origin);
  const url = (path) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new TypeError('API路径必须是本机绝对路径');
    const resolved = new URL(path, base);
    if (resolved.origin !== base.origin) throw new TypeError('拒绝向其他来源发送会话请求');
    return resolved.toString();
  };
  async function request(path, { method = 'GET', body } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    const init = { method, headers, cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await fetchImpl(url(path), init);
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) {
      const dto = data?.error ?? { code: 'http_error', message: `请求失败（${response.status}）` };
      const error = new Error(dto.message ?? '请求失败'); Object.assign(error, dto, { status: response.status }); throw error;
    }
    return data;
  }
  async function upload(kind, file) {
    const response = await fetchImpl(url(`/api/assets?kind=${encodeURIComponent(kind)}`), {
      method: 'POST', cache: 'no-store', body: file,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name ?? `${kind}.bin`) },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) { const dto=data?.error??{code:'http_error',message:`上传失败（${response.status}）`};const error=new Error(dto.message);Object.assign(error,dto,{status:response.status});throw error; }
    return data.asset;
  }
  async function waitJob(jobId, { signal, interval = 180 } = {}) {
    while (true) {
      if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
      const { job } = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
        if (job.state === 'succeeded') return job;
        const error = new Error(job.error?.message ?? (job.state === 'cancelled' ? '任务已取消' : '任务失败'));
        Object.assign(error, job.error ?? {}, { job, cancelled: job.state === 'cancelled' }); throw error;
      }
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('操作已取消', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, interval);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
  async function download(path) {
    const response = await fetchImpl(url(path), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!response.ok) { const data = await response.json().catch(() => null); const dto=data?.error??{code:'http_error',message:`下载失败（${response.status}）`};const error=new Error(dto.message);Object.assign(error,dto,{status:response.status});throw error; }
    return response.blob();
  }
  return { request, upload, waitJob, download };
}

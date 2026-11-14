export type Files = Record<string, string>;

export function loadRxc(bytes: BufferSource) {
  let x: any;
  let files: Files = {};
  const enc = new TextEncoder(), dec = new TextDecoder();
  const put = (b: Uint8Array) => {
    const p = x.rx_alloc(b.length + 4);
    new DataView(x.memory.buffer).setUint32(p, b.length, true);
    new Uint8Array(x.memory.buffer).set(b, p + 4);
    return p;
  };
  const env = {
    rx_read(ptr: number, len: number) {
      const f = dec.decode(new Uint8Array(x.memory.buffer, ptr, len));
      return f in files ? put(enc.encode(files[f])) : 0;
    },
  };
  const module = new WebAssembly.Module(bytes);
  const fresh = () => (x = new WebAssembly.Instance(module, { env }).exports);
  fresh();
  return (method: string, params: any, fs: Files = {}) => {
    files = fs;
    try {
      const req = enc.encode(JSON.stringify({ method, params }));
      const p = x.rx_alloc(req.length);
      new Uint8Array(x.memory.buffer).set(req, p);
      const out = x.rx_call(p, req.length);
      const n = new DataView(x.memory.buffer).getUint32(out, true);
      const text = dec.decode(new Uint8Array(x.memory.buffer, out + 4, n));
      x.rx_free(out, n + 4);
      return JSON.parse(text);
    } catch (e) {
      // a panic traps and leaves the instance unusable
      fresh();
      throw e;
    }
  };
}

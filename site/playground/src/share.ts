export type State = { files: Record<string, string>; active: string; preset?: string };

const b64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encode(state: State) {
  const json = new TextEncoder().encode(JSON.stringify({ f: state.files, a: state.active }));
  return "code=" + b64(await pipe(json, new CompressionStream("deflate-raw")));
}

export async function decode(hash: string): Promise<State | undefined> {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get("code");
  if (!code) return params.get("example") ? ({ preset: params.get("example")! } as State) : undefined;
  try {
    const s = JSON.parse(new TextDecoder().decode(await pipe(unb64(code), new DecompressionStream("deflate-raw"))));
    return { files: s.f, active: s.a ?? "main.rx" };
  } catch {
    return undefined;
  }
}

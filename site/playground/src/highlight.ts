import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("xml", xml);

export const highlight = (code: string, language: "javascript") => hljs.highlight(code, { language, ignoreIllegals: true }).value;

const RX_KEYWORDS = new Set(
  "source|component|action|effect|export|default|import|pure|from|if|else|for|in|await|loading|errored|fallback|guess|affects|refresh|latest|pending?|peek|pre|deferred|key|draft|let|try|catch|throw|error|fn|type|on|portal|onFlush|until|server|client|return|true|false|null|rejects".split("|"),
);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A light colouring of .rx for the editor's backdrop: comments, strings, keywords, :=, tags. */
export function highlightRx(src: string) {
  const TOKEN = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(:=)|(<\/?[A-Za-z][\w.-]*)|([A-Za-z_$][\w$]*\??)|([^"`/<:A-Za-z_$]+|.)/gs;
  let out = "";
  for (const m of src.matchAll(TOKEN)) {
    const [t, comment, str, assign, tag, word] = m;
    if (comment) out += `<span class="hl-c">${esc(t)}</span>`;
    else if (str) out += `<span class="hl-s">${esc(t)}</span>`;
    else if (assign) out += `<span class="hl-w">${esc(t)}</span>`;
    else if (tag) out += `<span class="hl-t">${esc(t)}</span>`;
    else if (word) out += RX_KEYWORDS.has(t) ? `<span class="hl-k">${esc(t)}</span>` : esc(t);
    else out += esc(t);
  }
  return out;
}

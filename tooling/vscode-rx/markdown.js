// ```rx blocks in VS Code's Markdown preview. The preview highlights fences with highlight.js and colours its classes
// from the theme, so .rx gets a highlight.js language: TypeScript's (with its JSX), plus the words .rx adds. The
// editor side is a TextMate injection (syntaxes/rx.markdown.tmLanguage.json) that embeds the full .rx grammar.
const hljs = require("highlight.js/lib/core");
const typescript = require("highlight.js/lib/languages/typescript");

/** The words .rx adds to TypeScript's: the ones syntaxes/rx.tmLanguage.json highlights (spec/07). */
const RX_KEYWORDS = [
  "source", "component", "action", "pure", "server", "client", "fn", "error", "context", "use", "provide", "pre",
  "latest", "peek", "pending", "guess", "affects", "refresh", "errored", "loading", "fallback", "portal",
  "deferred", "key", "rejects", "fails", "effect",
];

hljs.registerLanguage("rx", h => {
  const lang = typescript(h);
  lang.name = "ReactiveScript";
  lang.aliases = ["reactivescript"];
  lang.keywords = { ...lang.keywords, keyword: [...new Set([...lang.keywords.keyword, ...RX_KEYWORDS])] };
  return lang;
});

const isRx = lang => /^(rx|reactivescript)$/i.test((lang ?? "").trim().split(/\s+/)[0] ?? "");

/** `extendMarkdownIt` for the preview: ```rx fences go through the rx language; every other fence to the preview's
 *  own highlighter, as before. */
function extendMarkdownIt(md) {
  const previous = md.options.highlight;
  md.options.highlight = (code, lang, attrs) => {
    if (isRx(lang)) {
      try { return `<div>${hljs.highlight(code, { language: "rx", ignoreIllegals: true }).value}</div>`; } catch {}
    }
    return previous ? previous(code, lang, attrs) : "";
  };
  return md;
}

module.exports = { extendMarkdownIt, hljs };

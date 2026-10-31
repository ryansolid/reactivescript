// The pinned upstream checker, module loader and compiler. tsx/rx/ is the only part of this package that imports the
// upstream checkout (package.json "#rx/*" -> reactivescript-ref/*, i.e. ../ref); boundary.test.ts enforces that.
export { parseProgram, parseStmts, parseDeclarations, viewStart, ParseError, type JsDecl } from "#rx/src/parse.ts";
export { check, checkWithSignature, checkModules, type ModSig } from "#rx/src/check.ts";
export { CheckError, type Diagnostic } from "#rx/src/errors.ts";
export { loadModules, joinPath, singleModule, type ModuleSet } from "#rx/src/modules.ts";
export { printSignature } from "#rx/src/signature.ts";
export { compile, compileModules } from "#rx/compile/emit.ts";
export { lowerViews, STRING_RENDERER, type Target } from "#rx/compile/jsx.ts";

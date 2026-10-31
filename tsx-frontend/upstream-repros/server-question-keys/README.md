Expected frame (and the reference interpreter's frame): `number/string/a,b/a`.
Compiled at reactivescript aa85cbde (ref/compile/rt.ts serverRef keys questions as `name:` + `args.map(fmt).join(",")`)
the questions `load(1)`/`load("1")` and `first("a,b","c")`/`first("a","b,c")` share flights.
Run by `tsx/server-identities.test.ts` ("server loader keys preserve wire argument types…", compiled leg) and by
`node --experimental-strip-types --conditions=browser --conditions=development scripts/run-rx-repro.ts upstream-repros/server-question-keys`.

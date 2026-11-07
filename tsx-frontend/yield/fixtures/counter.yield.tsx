import { $event, $memo, $signal, component, view } from "solid-yield";

export default component(function* Counter() {
  const [count, setCount] = yield* $signal(0);
  const doubled = yield* $memo(function* () {
    return (yield* count) * 2;
  });
  const increment = $event(function* () {
    yield* setCount((yield* count) + 1);
  });
  return view(function* () {
    return <button onClick={yield* increment}>{yield* doubled}</button>;
  });
});

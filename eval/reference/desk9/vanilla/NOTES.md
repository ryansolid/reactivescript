# desk9 reference: vanilla TypeScript + DOM

Grades 0: hidden 77/77, overlap 38/38, fuzz 0/20 (`--r9`; also 0/60 on seeds 21-80). 1019 lines, no packages.

- One `AbortController` per page, child signals per selection/load; every answer checks its signal.
- `Register<T>`: server value as last stated plus in-flight writes over it; a read counts only if asked after the last
  server statement. `IssueFacts` holds one per issue and field, shared by rows and detail.
- Pending posts and label changes live on the page, laid over every reload.

Differs from the React reference: two accepted writes to one field show the one the server answered last (React keeps
the newest started). No hidden test separates them; the fuzz allowance for newest-started lasts only until the next
write starts. To settle in the round 15 prereg.

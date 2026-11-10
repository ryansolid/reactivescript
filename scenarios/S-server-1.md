# S-server-1 — A page streamed: two boundaries, a failure sent, a panic redacted

Rules exercised: SV-1, SV-2, SV-5; H-12, R-f-4, R-f-10.

## Modules

```rx
-- module: ./api.d.rx
export error NotFound
export pure fn fetchUser(id: number) rejects(NotFound)
export pure fn fetchPosts(id: number)
```

```rx
-- module: ./profile.rx
import { fetchUser, fetchPosts } from "./api"
export source id := 7
export user = await fetchUser(id)
export posts = await fetchPosts(id)
```

## Program

```rx
import { NotFound } from "./api"
import { user, posts } from "./profile.rx"
export default component App() {
  count = len(posts) > 2 ? fail("db password is hunter2") : len(posts)

  <main>
    <h1>Profile</h1>{" "}
    {errored fallback(e: NotFound) { <p>{e.message}</p> } {
      {loading fallback { <p>loading user</p> } { <p>{user.name}</p> }}
    }}
    {" "}
    {errored fallback(e) { <p>error: {e.message}</p> } {
      {loading fallback { <p>loading posts</p> } { <p>{count} posts</p> }}
    }}
  </main>
}
```

The questions live in a module, so they are module state (MO-1b) — per
request on the server (SV-4). Two boundaries, each with its own skeleton. `user` can fail only with
`NotFound` (its declaration says so, MO-8), which its boundary takes;
`posts` with `Error`; `count` panics (`fail` is a JS throw, R-f-3),
which only the untyped boundary takes (R-f-10).

## Frames

| instant | action                    | frame                                                     |
| ------- | ------------------------- | --------------------------------------------------------- |
| 0       | mount                     | `Profile loading user loading posts`                      |
| 1       | reject user NotFound("no user 7") | `Profile no user 7 loading posts`                    |
| 2       | resolve posts [1, 2, 3]   | `Profile no user 7 error: db password is hunter2`    |

## Server frames

| instant | action                    | frame                                                     |
| ------- | ------------------------- | --------------------------------------------------------- |
| 0       | mount                     | `Profile loading user loading posts`                      |
| 1       | reject user NotFound("no user 7") | `Profile no user 7 loading posts`                    |
| 2       | resolve posts [1, 2, 3]   | `Profile no user 7 error: Internal Server Error`     |

The shell is the mount's frame (SV-1); each landing streams its boundary.
The `NotFound` is a failure: it is sent with its fields and its boundary
renders its message (SV-5). The panic is not: the server sends Solid's
generic error in its place, and the boundary shows that — the message
never leaves the server. A second request for the page, rendered at the same
time, has its own `profile.rx`: these landings are not its landings, and
its stream stays at the shell.

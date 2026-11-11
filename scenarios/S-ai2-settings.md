# S-ai2-settings — a settings page across five modules

Rules exercised: R-1, R-6, R-f-1..6, R-f-8, ST-5, AC-1, AC-3, AC-4, AC-5,
AC-7, H-5, H-7, H-9, H-11, H-12, RG-1b, RG-1c, RG-4c, RG-7b, RG-7c, E-4,
W-3, W-4, MO-1b, MO-2a, MO-6c, MO-7.

## Program

file: ../examples/ai2/settings/main.rx

## Frames

| instant | action | frame | effect / probe verdicts |
| ------- | ------ | ----- | ----------------------- |
| 0 | mount | `Settings [comfortable] Loading settings…` | `pending? settings`: no verdict (first load) |
| 1 | reject "loadSettings:" "network down" | `Settings [comfortable] Could not load settings: network down Retry` | — |
| 2 | handler `retryLoad()` | `Settings [comfortable] Could not load settings: network down Retry` | re-ask is quiet |
| 3 | resolve "loadSettings:" {"name":"Ann","theme":"light","density":"compact"} | `Saved: Ann · light · compact Profile [compact] Display name 3/20 Appearance [compact] Theme: light light dark Toggle density Preview: light / compact Save` | `pending? settings` false |
| 4 | handler `draftName := ""` | `Saved: Ann · light · compact Profile [compact] Display name 0/20 Display name is required Appearance [compact] Theme: light light dark Toggle density Preview: light / compact Save` | — |
| 5 | handler `draftName := "Bartholomew the Magnificent"` | `Saved: Ann · light · compact Profile [compact] Display name 27/20 Display name must be at most 20 characters, not 27 Appearance [compact] Theme: light light dark Toggle density Preview: light / compact Save` | — |
| 6 | handler `draftName := "Bea"; draftTheme := "dark"` | `Saved: Ann · light · compact Profile [compact] Display name 3/20 Appearance [compact] Theme: dark light dark Toggle density Preview: dark / compact Save` | — |
| 7 | handler `save(draft)` | `Saved: Bea · dark · compact (saving…) Profile [compact] Display name 3/20 Appearance [compact] Theme: dark light dark Toggle density Preview: dark / compact Save` | `pending? settings` true (affects) |
| 8 | reject "saveSettings:{"name":"Bea","theme":"dark","density":"compact"}" "quota exceeded" | `Saved: Ann · light · compact Save failed: quota exceeded Profile [compact] Display name 3/20 Appearance [compact] Theme: dark light dark Toggle density Preview: dark / compact Save` | `pending? settings` false |
| 9 | handler `draftDensity := "comfortable"` | `Saved: Ann · light · compact Save failed: quota exceeded Profile [comfortable] Display name 3/20 Appearance [comfortable] Theme: dark light dark Toggle density Preview: dark / comfortable Save` | — |
| 10 | handler `save(draft)` | `Saved: Bea · dark · comfortable (saving…) Save failed: quota exceeded Profile [comfortable] Display name 3/20 Appearance [comfortable] Theme: dark light dark Toggle density Preview: dark / comfortable Save` | `pending? settings` true |
| 11 | (flush) | `Saved: Bea · dark · comfortable (saving…) Profile [comfortable] Display name 3/20 Appearance [comfortable] Theme: dark light dark Toggle density Preview: dark / comfortable Save` | `pending? settings` true |
| 12 | resolve "saveSettings:{"name":"Bea","theme":"dark","density":"comfortable"}" {"name":"Bea","theme":"dark","density":"comfortable"} | `Saved: Bea · dark · comfortable Profile [comfortable] Display name 3/20 Appearance [comfortable] Theme: dark light dark Toggle density Preview: dark / comfortable Save` | `pending? settings` false |

Why, one line per instant:

- **0.** `if settings` reads the pending `await loadSettings()` (R-1). The `loading` boundary is armed, so it catches the reader and its fallback goes up with the mount frame (H-5). The fallback's `Panel` has no `density` provision above it, so it shows the default `comfortable` (RG-7b).
- **1.** The rejection is an `Error` value (R-6, R-f-8). It reaches the `if settings` reader, and the root `errored` shows its fallback with `e.message` (H-12). The Panel there still uses the density default.
- **2.** `retryLoad` runs `refresh settings`, a quiet re-ask (AC-4). An `errored` region showing its fallback stays there until a value replaces the error (H-12, "the error stays the display through a retry"), so the frame does not change.
- **3.** The fresh flight under the same key lands a value. It replaces the error, so the `errored` region leaves its fallback (H-12). `if settings` is truthy, so the branch mounts and `SettingsForm` seeds its three draft sources from `peek(props.initial.*)` (E-4). The form provides `density = draftDensity` (`compact`), so both Panels inside it show `[compact]` (RG-7b; Panel's children are evaluated in the form's region, RG-4c). `Appearance` and `ThemePicker` read `use theme` = `draftTheme` (`light`).
- **4.** An empty name makes `validate(draft)` fail with `NameRequired`. The `catch` turns that into its message, so `if nameError` opens the message branch (R-f-4, RG-1). The counter reads `0/20`.
- **5.** 27 characters fails with `NameTooLong(27)`. `nameError` goes from one truthy string to another, so the branch is kept and the narrowed binding updates (RG-1b, RG-1c).
- **6.** Two writes in one handler are one instant (W-3). The name is valid again, so `nameError` is "" and the branch closes. The ThemePicker label and the Preview both show the theme through the context. The saved line does not move.
- **7.** `save` guesses `settings := draft`, clears `saveError` in an `onFlush` run of its own (EF-8; nothing to clear yet), then `affects settings` and awaits. The guess's readers form a lane and show at once (H-11, H-7). `pending? settings` is true because of `affects` (AC-5, H-9). The form is not recreated (the `if` goes truthy→truthy) and its draft does not change.
- **8.** The rejection throws at the `await`. The `catch` writes `saveError` inside the still-open change (AC-7). At the end of the body the guess on `settings` is corrected to the unchanged truth (Ann), and that commits in one frame with the error message (H-11, AC-1). The draft is local to the form, so it keeps Bea/dark.
- **9.** A plain local write changes the `density` provision, so both Panels and the Preview update. Nothing else moves.
- **10.** A new key (the density differs) means a new flight. The `settings` guess shows now (H-11). `pending? settings` is true. The old error is still up: its clear is registered with `onFlush`, not written by this run.
- **11.** The `onFlush` run is a change of its own and commits at once, while the save is still out (EF-8, S-flush-1): the "Save failed" branch closes.
- **12.** The answer is written as the truth (`settings := saved`), equal to the guess, so it confirms silently. The plain `saveError := ""` is the truth for that source too, so it does not revert to "quota exceeded". The change commits, and `pending? settings` is false.

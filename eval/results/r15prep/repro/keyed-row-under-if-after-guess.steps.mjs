export default [["start", async () => {}], ["load", p => p.evaluate(() => globalThis.__flights.land("fetchChecklist:2", [{ id: 21, text: "one", done: false }]))], ["go", p => p.locator('[data-testid="go"]').click()],
  ["accept", p => p.evaluate(() => globalThis.__flights.land("addItem:2,two", { id: 24, text: "two", done: false }))]];

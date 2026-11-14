// A fake backend: each person answers after a delay; an unknown id rejects with NotFound.
const people = { 1: { name: "Ann", role: "engineer" }, 2: { name: "Bo", role: "designer" } };

export class NotFound extends Error {
  constructor(id) { super(`no person ${id}`); this.name = "NotFound"; }
}

export async function fetchPerson(id) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const person = people[id];
  if (!person) throw new NotFound(id);
  return person;
}

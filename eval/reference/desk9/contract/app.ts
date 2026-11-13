// The desk's data module: each source calls the backend in src/api.js and projects its answer onto the declared shape.
// The overlay shows writes still out over the answers they change.
import type { Answer, Overlay, Result, Sources } from './app.contract.d.ts';
import * as api from './src/api.js';

export const grants = '';

type IssueList = Result<'fetchIssues'>;
type Detail = Result<'fetchIssue'>;
type Comments = Result<'fetchComments'>;
type Labels = Result<'fetchLabels'>;
type Settings = Result<'loadSettings'>;

const sources: Sources = {
  fetchIssues: async ([filter]): Promise<IssueList> => {
    const rows = await api.fetchIssues(filter as 'open' | 'closed');
    return { loaded: true, rows: rows.map((r) => ({ id: r.id, title: r.title, assignee: r.assignee })) };
  },
  fetchIssue: async ([id]): Promise<Detail> => {
    const d = await api.fetchIssue(id);
    return d ? { found: true, title: d.title, body: d.body } : { found: false, title: '', body: '' };
  },
  fetchComments: async ([id]): Promise<Comments> =>
    (await api.fetchComments(id)).map((c) => ({ author: c.author, text: c.text, sending: false })),
  fetchLabels: async ([id]): Promise<Labels> => api.fetchLabels(id),
  search: async ([q]) => (await api.search(q)).map((h) => ({ id: h.id, name: h.name })),
  fetchItem: async ([id]) => {
    const item = await api.fetchItem(id);
    return item ? { found: true, name: item.name, blurb: item.blurb } : { found: false, name: '', blurb: '' };
  },
  loadSettings: async (): Promise<Settings> => {
    const s = await api.loadSettings();
    return { name: s.name, theme: s.theme, density: s.density, saving: false };
  },
  assign: async ([id, user]) => {
    const r = await api.assign(id, user);
    return { id: r.id, assignee: r.assignee };
  },
  renameIssue: async ([id, title]) => {
    const r = await api.renameIssue(id, title);
    return { id: r.id, title: r.title };
  },
  closeIssue: async ([id]) => ({ id: (await api.closeIssue(id)).id }),
  addComment: async ([id, author, text]) => {
    const c = await api.addComment(id, author, text);
    return { author: c.author, text: c.text };
  },
  addLabel: async ([id, label]) => api.addLabel(id, label),
  removeLabel: async ([id, label]) => api.removeLabel(id, label),
  saveSettings: async ([name, theme, density]) => {
    const s = await api.saveSettings({ name, theme: theme as 'light' | 'dark', density: density as 'comfortable' | 'compact' });
    return { name: s.name, theme: s.theme, density: s.density };
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);

// The writes still out, over the answers they change. A write whose reply landed before the answer was asked is in the
// answer already (`answered`), so only the others are laid over it, in the order the runner gives them.
export const overlay: Overlay = (source, args, answer, writes) => {
  const out = writes.filter((w) => !w.answered);
  const id = args[0];
  switch (source) {
    case 'fetchIssues': {
      let rows = (answer as IssueList).rows;
      for (const w of out) {
        const issue = w.args[0] as number;
        if (w.source === 'assign') rows = rows.map((r) => (r.id === issue ? { ...r, assignee: w.args[1] as string } : r));
        if (w.source === 'renameIssue') rows = rows.map((r) => (r.id === issue ? { ...r, title: w.args[1] as string } : r));
        if (w.source === 'closeIssue' && id === 'open') rows = rows.filter((r) => r.id !== issue);
      }
      return { ...(answer as IssueList), rows };
    }
    case 'fetchIssue': {
      const detail = answer as Detail;
      let title = detail.title;
      for (const w of out) if (w.source === 'renameIssue' && w.args[0] === id) title = w.args[1] as string;
      return detail.found ? { ...detail, title } : undefined;
    }
    case 'fetchComments': {
      const rows = [...(answer as Comments)];
      for (const w of out) {
        if (w.source !== 'addComment' || w.args[0] !== id) continue;
        rows.push({ author: w.args[1] as string, text: w.args[2] as string, sending: w.reply === undefined });
      }
      return rows;
    }
    case 'fetchLabels': {
      let shown = answer as Labels;
      for (const w of out) {
        if (w.args[0] !== id) continue;
        const label = w.args[1] as string;
        if (w.source === 'addLabel' && !shown.includes(label)) shown = [...shown, label];
        if (w.source === 'removeLabel') shown = shown.filter((l) => l !== label);
      }
      return shown;
    }
    case 'loadSettings': {
      let shown = answer as Settings;
      for (const w of out) {
        const reply = w.reply as { name: string; theme: string; density: string } | undefined;
        const [name, theme, density] = w.args as string[];
        shown = reply ? { ...shown, ...reply, saving: false } : { ...shown, name, theme, density, saving: true };
      }
      return shown;
    }
  }
  return undefined;
};

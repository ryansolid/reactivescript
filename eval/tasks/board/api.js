import { flight } from "./flights.js";

export const fetchCards = column => flight("fetchCards", [column]);
export const moveCard = (id, column, index) => flight("moveCard", [id, column, index]);
export const renameCard = (id, title) => flight("renameCard", [id, title]);
export const addCard = (column, title) => flight("addCard", [column, title]);
export const archiveCard = id => flight("archiveCard", [id]);
export const fetchChecklist = id => flight("fetchChecklist", [id]);
export const toggleItem = (cardId, itemId, done) => flight("toggleItem", [cardId, itemId, done]);
export const addItem = (cardId, text) => flight("addItem", [cardId, text]);
export const fetchArchived = () => flight("fetchArchived", []);
export const restoreCard = id => flight("restoreCard", [id]);

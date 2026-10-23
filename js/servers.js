import { api } from './api.js';
import { toastOk, toastErr } from './toast.js';

export async function loadServers() {}
export function filterServers() {}
export async function leaveServer(guildId) { return api.leaveServer(guildId); }
export async function resetServer(guildId) { return api.resetServer(guildId); }
export function svPage() {}
export async function refreshSingleServer() {}
